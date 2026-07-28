// Package redisx — shared Redis client + the fixed-window rate limiter,
// byte-compatible with Node's rateLimit.js (same rl:{key} buckets, same
// fail-open semantics, same {allowed, remaining, resetInSec} result).
package redisx

import (
	"context"
	"fmt"
	"os"
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
