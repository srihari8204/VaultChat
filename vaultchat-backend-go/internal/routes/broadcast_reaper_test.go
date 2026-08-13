package routes

import (
	"os"
	"testing"
	"time"
)

// The reaper exists because broadcast_one_active_per_host is a UNIQUE index over
// the non-terminal statuses:
//
//	CREATE UNIQUE INDEX broadcast_one_active_per_host
//	    ON broadcast_sessions (host_id) WHERE status IN ('starting','live')
//
// so one wedged row locks its host out of broadcasting forever. The thresholds
// are the whole safety argument, and both can be got wrong in a way that is
// invisible until it costs someone a live stream — which is what these pin down.

func TestStartingThresholdIsShortEnoughToBeUseful(t *testing.T) {
	os.Unsetenv("BROADCAST_STARTING_STALE")
	got := reapStartingAfter()
	// A session leaves 'starting' when egress reports EGRESS_ACTIVE, normally
	// within seconds. A threshold measured in hours would leave the host locked
	// out for that long, which is the bug rather than the fix.
	if got > time.Hour {
		t.Fatalf("starting threshold %s is too long — the host stays locked out that whole time", got)
	}
	// ...but not so short that a slow egress start gets killed mid-activation
	// and the host sees their own stream reaped from under them.
	if got < 5*time.Minute {
		t.Fatalf("starting threshold %s is too short — a slow egress start would be reaped as dead", got)
	}
}

func TestLiveThresholdIsFarBeyondAnyRealBroadcast(t *testing.T) {
	os.Unsetenv("BROADCAST_LIVE_STALE")
	got := reapLiveAfter()
	// THE DANGEROUS DIRECTION. A host with no viewers is still legitimately
	// broadcasting, and nothing in the database distinguishes that from a missed
	// terminal webhook. Reaping 'live' on a short timer would cut off real
	// streams — strictly worse than the lockout being fixed.
	if got < 6*time.Hour {
		t.Fatalf("live threshold %s is short enough to cut off a real broadcast", got)
	}
	// The two must not collapse into each other: 'starting' is unambiguous and
	// 'live' is not, so treating them alike would mean one of them is wrong.
	if got <= reapStartingAfter() {
		t.Fatalf("live threshold %s must be far longer than starting %s", got, reapStartingAfter())
	}
}

func TestThresholdsAreOverridableAndRejectGarbage(t *testing.T) {
	t.Setenv("BROADCAST_STARTING_STALE", "20m")
	if got := reapStartingAfter(); got != 20*time.Minute {
		t.Fatalf("override ignored: got %s, want 20m", got)
	}
	t.Setenv("BROADCAST_LIVE_STALE", "24h")
	if got := reapLiveAfter(); got != 24*time.Hour {
		t.Fatalf("override ignored: got %s, want 24h", got)
	}

	// An unparseable or non-positive override must fall back to the default, not
	// to zero. A zero interval would match EVERY non-terminal row on the next
	// tick and end every live broadcast on the platform at once — the single
	// worst outcome this file could produce, and a plausible typo.
	for _, bad := range []string{"", "soon", "15", "-5m", "0s"} {
		t.Setenv("BROADCAST_STARTING_STALE", bad)
		if got := reapStartingAfter(); got != defaultStartingStaleMinutes*time.Minute {
			t.Fatalf("garbage %q produced %s instead of the default", bad, got)
		}
		t.Setenv("BROADCAST_LIVE_STALE", bad)
		if got := reapLiveAfter(); got != defaultLiveStaleHours*time.Hour {
			t.Fatalf("garbage %q produced %s instead of the default", bad, got)
		}
	}
}

func TestSweepRunsOftenEnoughToUnlockPromptly(t *testing.T) {
	// The lockout lasts until the NEXT sweep after the threshold, so the real
	// worst case is threshold + interval. Keeping the interval well under the
	// starting threshold stops the sweep cadence dominating that sum.
	os.Unsetenv("BROADCAST_STARTING_STALE")
	if broadcastReapInterval >= reapStartingAfter() {
		t.Fatalf("sweep interval %s is not shorter than the starting threshold %s",
			broadcastReapInterval, reapStartingAfter())
	}
	// And not so frequent that it becomes a pointless wakeup on a healthy system,
	// where it matches nothing every single time.
	if broadcastReapInterval < time.Minute {
		t.Fatalf("sweep interval %s is wastefully frequent", broadcastReapInterval)
	}
}
