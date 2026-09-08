// Package redisx — shared Redis client + the fixed-window rate limiter,
// byte-compatible with Node's rateLimit.js (same rl:{key} buckets, same
// fail-open semantics, same {allowed, remaining, resetInSec} result).
package redisx

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

var Client *redis.Client

func Connect() {
	Client = redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%s", envOr("REDIS_HOST", "127.0.0.1"), envOr("REDIS_PORT", "6379")),
		Password: os.Getenv("REDIS_PASS"),
	})
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

// Reset mirrors rateLimit.reset.
func Reset(ctx context.Context, key string) {
	if Client != nil {
		Client.Del(ctx, "rl:"+key)
	}
}
