// config.go — the remote feature-flag channel (migration 071_app_flags.sql).
//
// One endpoint: GET /config/flags. It answers "which overrides apply to THIS
// device?" — the bucketing, the version floor and the kill switch are all
// resolved here, server-side, and the client receives a flat map of booleans it
// cannot get wrong.
//
// Bucketing lives on the server on purpose. A percentage rolled out by client
// code is a percentage that cannot be hotfixed: if the bucketing itself is
// wrong, the only devices that could correct it are the ones already running
// the bad code. Resolving here means the dial always works, whatever the client
// believes.
//
// UNAUTHENTICATED, AND THAT IS CORRECT
// ------------------------------------
// The flag names are already in the shipped binary, and the response reveals
// nothing about the user — only what this build+device should do. Requiring a
// token would be worse than useless: the client fetches this during boot, and
// lib/api.ts bounces a user to onboarding when a token refresh fails, so a
// config fetch that could take the auth path could log a user out over a flag
// lookup. Identity here is the device id, which lib/api.ts already sends on
// every request as X-Device-Id.
package routes

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"net/http"
	"strconv"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/redisx"
)

// How long a client may serve this answer from its own cache. Short enough that
// a kill switch reaches the fleet within the quarter hour, long enough that boot
// is not gated on a network round trip. See lib/remoteFlags.ts, which caps
// staleness independently — a client that cannot reach us falls back to its
// compiled defaults rather than trusting an old "on" forever.
const flagsTTLSec = 900

func RegisterConfig(mux *http.ServeMux) {
	mux.HandleFunc("GET /config/flags", configFlags)
}

type flagRow struct {
	key        string
	killed     bool
	rolloutPct int
	minBuild   *int
}

// bucketOf maps (key, deviceID) to a stable 0..99.
//
// The key is mixed in so a device is not correlated across flags — otherwise
// every 1% rollout would land on the same unlucky devices, and one cohort would
// absorb the risk of every experiment.
//
// The value depends on nothing but its inputs, so raising rollout_pct is
// monotone: a device inside 10% is still inside 25%. Lowering it removes
// devices in the reverse order they were added, which is what an operator
// backing out expects.
func bucketOf(key, deviceID string) int {
	if deviceID == "" {
		// No device id (a pre-X-Device-Id client, or a stripped proxy) cannot be
		// bucketed stably. Bucket 100 is outside every percentage including 100%
		// — such a caller only ever gets a flag that is fully rolled out via
		// min_build/kill semantics, never a partial canary it would flap in and
		// out of on every request.
		return 100
	}
	sum := sha256.Sum256([]byte(key + ":" + deviceID))
	return int(binary.BigEndian.Uint32(sum[:4]) % 100)
}

// resolve computes the override for one row, or (false, false) for "no opinion".
func resolve(row flagRow, deviceID string, build int) (value bool, has bool) {
	// The kill switch outranks everything, including a 100% rollout.
	if row.killed {
		return false, true
	}
	// A build that cannot handle the flag never gets it, at any percentage.
	if row.minBuild != nil && build < *row.minBuild {
		return false, true
	}
	if row.rolloutPct <= 0 {
		return false, true
	}
	if row.rolloutPct >= 100 {
		return true, true
	}
	return bucketOf(row.key, deviceID) < row.rolloutPct, true
}

func configFlags(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	deviceID := r.Header.Get("X-Device-Id")

	// Rate limited by device so a client stuck in a retry loop cannot hammer the
	// table. redisx.Consume fails OPEN, which is the right direction here: a
	// Redis outage must not be able to withhold a kill switch.
	limitKey := deviceID
	if limitKey == "" {
		limitKey = authClientIP(r)
	}
	if rl := redisx.Consume(ctx, "cfgflags:"+limitKey, 60, 60); !rl.Allowed {
		httpx.Err(w, 429, "Too many config requests", map[string]any{"retryAfter": rl.ResetInSec})
		return
	}

	// Absent/garbage build parses to 0, which fails every min_build floor. That
	// is the safe direction: an unidentifiable client gets no new behaviour.
	build, _ := strconv.Atoi(r.URL.Query().Get("build"))

	rows, err := loadFlagRows(ctx)
	if err != nil {
		// The channel is unavailable, so we have no opinion to give. An empty
		// map means "use your compiled defaults" — never an implicit enable.
		httpx.JSON(w, 200, map[string]any{"v": 1, "flags": map[string]bool{}, "killed": []string{}, "ttlSec": 60})
		return
	}

	flags := map[string]bool{}
	killed := []string{}
	for _, row := range rows {
		if row.killed {
			killed = append(killed, row.key)
		}
		if v, has := resolve(row, deviceID, build); has {
			flags[row.key] = v
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"v": 1, "flags": flags, "killed": killed, "ttlSec": flagsTTLSec,
	})
}

func loadFlagRows(ctx context.Context) ([]flagRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	// SysPool: app-wide operational config belongs to no user, so binding one
	// would be meaningless. The table carries no RLS for the same reason.
	rows, err := db.SysPool.Query(ctx,
		`SELECT key, killed, rollout_pct, min_build FROM app_flags`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []flagRow{}
	for rows.Next() {
		var f flagRow
		if err := rows.Scan(&f.key, &f.killed, &f.rolloutPct, &f.minBuild); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}
