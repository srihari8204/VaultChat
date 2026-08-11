// shopbook_limits.go — SHOP BOOK pagination and rate limiting (P2).
//
// Two things every list endpoint here was missing.
//
// PAGINATION. Everything returned a hardcoded LIMIT with no way to ask for the
// next page — so a shop with two thousand orders had 1,900 of them
// unreachable, and the ones it could see cost a full scan to sort. Cursor
// paging (keyset, not OFFSET) keeps page 40 as cheap as page 1 and cannot skip
// or repeat a row when one is inserted mid-scroll.
//
// RATE LIMITING. The expensive endpoints — cross-shop product search, nearby
// discovery — were open at whatever rate a client cared to ask. The limiter is
// the same Redis bucket the rest of VaultChat uses, and it FAILS OPEN: if
// Redis is down, shops keep trading. A rate limiter that takes the shop
// offline when the cache does is worse than none.
package routes

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

// sbPageLimit reads ?limit=, bounded. The ceiling is a memory guard, not a
// policy: a client asking for 10,000 rows gets 100 and a next-cursor.
func sbPageLimit(r *http.Request, def, max int) int {
	n, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// sbCursor reads ?cursor= — an opaque RFC3339 timestamp from the previous
// page's `nextCursor`. Opaque to the client, but deliberately not encrypted:
// it identifies a position in a list the caller is already authorised to read,
// so obscuring it would buy nothing and complicate debugging.
func sbCursor(r *http.Request) (time.Time, bool) {
	v := r.URL.Query().Get("cursor")
	if v == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// sbNextCursor returns the cursor for the following page, or "" when the page
// came back short — which is how a client knows it has reached the end without
// a second request that returns nothing.
func sbNextCursor(rows int, limit int, last time.Time) string {
	if rows < limit {
		return ""
	}
	return last.Format(time.RFC3339Nano)
}

// ── rate limiting ─────────────────────────────────────────────────

// sbRateLimit consumes one token for (bucket, user). Returns false and writes
// a 429 when the caller is over. Fails OPEN — see the file comment.
func sbRateLimit(w http.ResponseWriter, r *http.Request, bucket string, limit int64, windowSec int64) bool {
	uid := httpx.UserFrom(r).ID
	if uid == "" {
		return true // unauthenticated requests never reach these routes
	}
	res := redisx.Consume(r.Context(), fmt.Sprintf("sb:%s:%s", bucket, uid), limit, windowSec)
	if res.Allowed {
		return true
	}
	retry := res.ResetInSec
	if retry <= 0 {
		retry = windowSec
	}
	w.Header().Set("Retry-After", strconv.FormatInt(retry, 10))
	httpx.Err(w, http.StatusTooManyRequests,
		"You are searching a bit too fast — try again in a moment",
		map[string]any{"code": "rate_limited", "retryAfter": retry})
	return false
}

// The buckets, and why each number is what it is. All are per user per minute.
const (
	// Cross-shop ILIKE over every approved catalog. Even with the trigram
	// index this is the most expensive read in Shop Book.
	sbRateSearch = 30
	// Discovery runs on every map pan; generous, but not unbounded.
	sbRateNearby = 60
	// Writes that create financial records. A human cannot legitimately place
	// twenty orders a minute, and a loop can.
	sbRateWrite = 20
)
