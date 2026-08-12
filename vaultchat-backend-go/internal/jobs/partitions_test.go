// partitions_test.go — the body-retention deadline, and the one property that
// must hold no matter how the server is configured.
//
// These are pure (no database), so they run on every `go test ./...` rather
// than only where CALL_TEST_DB is set. The DB-backed half — the CHECK
// constraint and the partition helper — lives in
// internal/routes/message_bodies_test.go beside the other gated route tests.
package jobs

import (
	"os"
	"testing"
	"time"
)

// The hard ceiling. A body may live for LESS than this; it may never live for
// more, whatever MESSAGE_BODY_TTL_SECONDS says.
const hardCap = 3 * time.Hour

func TestBodyTTLNeverExceedsHardCap(t *testing.T) {
	// Every one of these is a plausible operator mistake or a hostile value: a
	// day, a year, "no really keep it", an overflow-shaped number. None of them
	// may widen the retention window, because the guarantee the product makes
	// is an upper bound, not a default.
	for _, v := range []string{
		"", "0", "-1", "notanumber",
		"10801",               // one second over
		"86400",               // a day
		"31536000",            // a year
		"9223372036854775807", // int64 max
	} {
		t.Setenv("MESSAGE_BODY_TTL_SECONDS", v)
		if got := bodyTTL(); got > hardCap {
			t.Fatalf("MESSAGE_BODY_TTL_SECONDS=%q produced TTL %v, which exceeds the %v hard cap", v, got, hardCap)
		}
	}
}

func TestBodyTTLHonoursAShorterWindow(t *testing.T) {
	// The knob only tightens. This is what lets the rollout start conservative
	// and step down to three hours without a migration.
	t.Setenv("MESSAGE_BODY_TTL_SECONDS", "600")
	if got := bodyTTL(); got != 10*time.Minute {
		t.Fatalf("bodyTTL() = %v, want 10m", got)
	}
}

func TestBodyTTLDefaultsToHardCap(t *testing.T) {
	os.Unsetenv("MESSAGE_BODY_TTL_SECONDS")
	if got := bodyTTL(); got != hardCap {
		t.Fatalf("bodyTTL() = %v, want %v with no env set", got, hardCap)
	}
}

// The deadline is a pure function of the message's SERVER-generated created_at.
//
// This is the anti-extension property from the spec: a retry, an edit, a
// reconnect and a resend all recompute the deadline, and every one of them must
// land on the SAME instant as the original insert. Deriving it from
// time.Now() at call time — the obvious implementation — would silently push
// the deadline forward on every retry, so a message that kept failing to
// deliver would live on the server indefinitely. That is the bug this test
// exists to prevent, and it cannot be caught by inspection once the function
// is called from four places.
func TestBodyExpiresAtIsPinnedToCreatedAt(t *testing.T) {
	os.Unsetenv("MESSAGE_BODY_TTL_SECONDS")
	created := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	want := created.Add(hardCap) // 13:00, not now+3h

	first := BodyExpiresAt(created)
	if !first.Equal(want) {
		t.Fatalf("BodyExpiresAt(10:00) = %v, want %v", first, want)
	}

	// Simulate the edit-at-10:10 case from the spec: same created_at, later
	// wall clock, same answer.
	time.Sleep(2 * time.Millisecond)
	if again := BodyExpiresAt(created); !again.Equal(want) {
		t.Fatalf("recomputed deadline drifted to %v; a retry/edit must not extend retention past %v", again, want)
	}
}

func TestBodyExpiresAtRejectsClockGamesViaShorterTTL(t *testing.T) {
	// Even with a deliberately short window the deadline stays anchored to
	// created_at, so an old message does not get a fresh lease when the config
	// changes under it.
	t.Setenv("MESSAGE_BODY_TTL_SECONDS", "60")
	created := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	if got := BodyExpiresAt(created); !got.Equal(created.Add(time.Minute)) {
		t.Fatalf("BodyExpiresAt = %v, want %v", got, created.Add(time.Minute))
	}
}
