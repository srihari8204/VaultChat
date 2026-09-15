// Package redisx — shared Redis client + the fixed-window rate limiter,
// byte-compatible with Node's rateLimit.js (same rl:{key} buckets, same
// fail-open semantics, same {allowed, remaining, resetInSec} result).
package redisx

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

var Client *redis.Client

// Connect builds the shared client. Two ways in, and the URL form wins.
//
// REDIS_URL is what every managed provider actually hands you — a single
// rediss://user:pass@host:port/db string. redis.ParseURL understands all of it,
// including turning the rediss:// scheme into a real TLS config, so a managed
// endpoint needs one variable rather than five and cannot be half-configured.
//
// The discrete REDIS_HOST/PORT/PASS form is kept because it is what the compose
// stack sets, and dropping it would break every existing deployment. REDIS_TLS=1
// turns TLS on for that path, which matters because this client previously had
// NO TLS support at all: the only way to reach it was plaintext on a loopback
// binding. DigitalOcean Managed Valkey refuses plaintext outright, so without
// this the adapter, the presence keys and the rate limiter all fail closed at
// connect time — and the socket layer's fail-open behaviour would quietly hide
// it as "degraded" rather than reporting a misconfiguration.
func Connect() {
	if raw := os.Getenv("REDIS_URL"); raw != "" {
		opt, err := redis.ParseURL(raw)
		if err != nil {
			// Deliberately fatal. A malformed URL here means no adapter, no
			// shared presence and no distributed limiter, and every one of
			// those fails open — the process would look healthy while silently
			// running as an isolated node.
			log.Fatalf("[redisx] REDIS_URL is not a valid redis URL: %v", err)
		}
		Client = redis.NewClient(opt)
		log.Printf("[redisx] connected via REDIS_URL (tls=%t db=%d)", opt.TLSConfig != nil, opt.DB)
		return
	}

	opt := &redis.Options{
		Addr:     fmt.Sprintf("%s:%s", envOr("REDIS_HOST", "127.0.0.1"), envOr("REDIS_PORT", "6379")),
		Password: os.Getenv("REDIS_PASS"),
		DB:       envInt("REDIS_DB", 0),
	}
	if os.Getenv("REDIS_TLS") == "1" {
		// ServerName is left to the dialer, which derives it from Addr. That is
		// correct for a managed endpoint reached by its own hostname and is the
		// only form that verifies the certificate chain.
		opt.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	Client = redis.NewClient(opt)
	log.Printf("[redisx] connected to %s (tls=%t db=%d)", opt.Addr, opt.TLSConfig != nil, opt.DB)
}

func envInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Printf("[redisx] %s=%q is not an integer, using %d", k, v, def)
		return def
	}
	return n
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

type RateResult struct {
	Allowed    bool
	Remaining  int64
	ResetInSec int64
}

// ── ConsumeSecure — the limiter that may not fail open ──────────────────
//
// AUDIT F11: Consume fails OPEN when Redis is missing or erroring. That is a
// reasonable trade for "you are sending broadcast comments too fast"; it is not
// one for PIN guessing. With Redis down, the five-attempt MPIN limit simply
// stopped existing, and a six-digit PIN falls in minutes to an attacker who
// notices — the outage of a cache is not supposed to be an authentication
// bypass.
//
// So security-sensitive callers use this instead: Redis when it is there, and
// an in-process limiter when it is not. Never unlimited.
//
// ponytail: the fallback is per-process, so with N replicas an attacker gets
// N × limit during a Redis outage — bounded and small, versus unbounded before.
// If this service ever runs more than one replica in anger, make the fallback a
// shared store rather than widening the limit.

type memBucket struct {
	count   int64
	resetAt time.Time
}

var (
	memMu      sync.Mutex
	memBuckets = map[string]*memBucket{}
	memSweepAt time.Time
)

// consumeInProcess is the fallback. Same window semantics as the Redis path:
// first hit starts the window, the window is not extended by later hits.
func consumeInProcess(key string, limit, windowSec int64) RateResult {
	now := time.Now()
	memMu.Lock()
	defer memMu.Unlock()

	// Opportunistic sweep so a long-lived process cannot accumulate dead keys.
	if now.After(memSweepAt) {
		for k, b := range memBuckets {
			if now.After(b.resetAt) {
				delete(memBuckets, k)
			}
		}
		memSweepAt = now.Add(time.Minute)
	}

	b := memBuckets[key]
	if b == nil || now.After(b.resetAt) {
		b = &memBucket{resetAt: now.Add(time.Duration(windowSec) * time.Second)}
		memBuckets[key] = b
	}
	b.count++
	rem := limit - b.count
	if rem < 0 {
		rem = 0
	}
	return RateResult{
		Allowed:    b.count <= limit,
		Remaining:  rem,
		ResetInSec: int64(time.Until(b.resetAt).Seconds()) + 1,
	}
}

// ConsumeSecure is Consume for endpoints where "allow everything" is the wrong
// answer to an outage — PIN and recovery-answer verification. It never fails
// open: if Redis cannot answer, an in-process limiter does.
func ConsumeSecure(ctx context.Context, key string, limit int64, windowSec int64) RateResult {
	if Client == nil {
		return consumeInProcess(key, limit, windowSec)
	}
	k := "rl:" + key
	count, err := Client.Incr(ctx, k).Result()
	if err != nil {
		return consumeInProcess(key, limit, windowSec)
	}
	if count == 1 {
		Client.Expire(ctx, k, time.Duration(windowSec)*time.Second)
	}
	ttl, ttlErr := Client.TTL(ctx, k).Result()
	reset := windowSec
	if ttlErr == nil && ttl >= 0 {
		reset = int64(ttl.Seconds())
	}
	rem := limit - count
	if rem < 0 {
		rem = 0
	}
	return RateResult{Allowed: count <= limit, Remaining: rem, ResetInSec: reset}
}

// Consume mirrors rateLimit.consume: INCR + EXPIRE-on-first, fail-OPEN when
// Redis is unavailable (Node's deliberate trade-off — keep it).
func Consume(ctx context.Context, key string, limit int64, windowSec int64) RateResult {
	open := RateResult{Allowed: true, Remaining: limit, ResetInSec: windowSec}
	if Client == nil {
		return open
	}
	k := "rl:" + key
	count, err := Client.Incr(ctx, k).Result()
	if err != nil {
		return open
	}
	if count == 1 {
		Client.Expire(ctx, k, time.Duration(windowSec)*time.Second)
	}
	ttl, err := Client.TTL(ctx, k).Result()
	reset := windowSec
	if err == nil && ttl >= 0 {
		reset = int64(ttl.Seconds())
	}
	rem := limit - count
	if rem < 0 {
		rem = 0
	}
	return RateResult{Allowed: count <= limit, Remaining: rem, ResetInSec: reset}
}

// ConsumeBy is Consume with a weight: it charges n units to the bucket instead
// of 1. Request-counting alone is the wrong meter for a bulk endpoint — five
// /contacts/match calls a minute is five calls, but it is also 25,000 phone
// hashes a minute (36M/day), which is enough to walk a meaningful slice of the
// ~10^10 phone keyspace from a single account. Charge the hashes, not the call.
//
// Same fail-OPEN behaviour as Consume, deliberately: a Redis outage must not
// lock real users out of contact discovery.
func ConsumeBy(ctx context.Context, key string, n, limit, windowSec int64) RateResult {
	open := RateResult{Allowed: true, Remaining: limit, ResetInSec: windowSec}
	if Client == nil || n <= 0 {
		return open
	}
	k := "rl:" + key
	count, err := Client.IncrBy(ctx, k, n).Result()
	if err != nil {
		return open
	}
	if count == n { // first charge in this window
		Client.Expire(ctx, k, time.Duration(windowSec)*time.Second)
	}
	ttl, err := Client.TTL(ctx, k).Result()
	reset := windowSec
	if err == nil && ttl >= 0 {
		reset = int64(ttl.Seconds())
	}
	rem := limit - count
	if rem < 0 {
		rem = 0
	}
	return RateResult{Allowed: count <= limit, Remaining: rem, ResetInSec: reset}
}

// Reset mirrors rateLimit.reset.
func Reset(ctx context.Context, key string) {
	if Client != nil {
		Client.Del(ctx, "rl:"+key)
	}
}

// ── A small expiring key/value store ────────────────────────────────────
//
// The limiter owns the "rl:" keyspace and never hands a value back, so the
// MSG91 OTP flow — which must hold the provider's request id from send until
// verify — had nothing here to use.
//
// These deliberately report errors instead of failing open like Consume does.
// The trade Consume makes ("a cache outage must not lock users out") is the
// WRONG one for this: a request id that was never stored means the code the
// user is about to receive can never be verified, so the honest move is to
// fail the send and let them retry, not to send an SMS into the void.
func SetEx(ctx context.Context, key, val string, ttlSec int64) error {
	if Client == nil {
		return fmt.Errorf("redisx: no client")
	}
	return Client.Set(ctx, key, val, time.Duration(ttlSec)*time.Second).Err()
}

// GetKey returns "" with a nil error when the key is absent or expired — an
// expiry is a normal outcome here, not a fault, and every caller has to handle
// "gone" anyway.
func GetKey(ctx context.Context, key string) (string, error) {
	if Client == nil {
		return "", fmt.Errorf("redisx: no client")
	}
	v, err := Client.Get(ctx, key).Result()
	if err == redis.Nil {
		return "", nil
	}
	return v, err
}

// DelKey is best-effort: it is used to burn a single-use token after it has
// already been accepted, and by then the caller has nothing useful to do with
// a failure except let the TTL finish the job.
func DelKey(ctx context.Context, key string) {
	if Client != nil {
		Client.Del(ctx, key)
	}
}
