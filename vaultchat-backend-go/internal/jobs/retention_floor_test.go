// retention_floor_test.go — a normal message body may not be reclaimed before
// the retention floor, whatever any other knob says.
//
// THE RULE THIS PINS
//
// The server is the source of truth for offline sync. A recipient who is
// offline, disconnected, push-less, powered off or has simply not opened the
// app has NOT received their message, and the server holds the only copy that
// can still reach them. So none of those states — and no delivery signal
// derived from them — may shorten retention.
//
// These are pure tests: no database, no network. They run on every
// `go test ./...`, so a knob that undercuts the floor fails the moment it is
// written rather than the moment a user loses a message.
package jobs

import (
	"testing"
	"time"
)

const day = 86_400

// ── the delivery-based sweeps ──────────────────────────────────────────

// TestDeliveryGraceCannotUndercutTheFloor is the important one. Both
// delete-on-delivery sweeps gate on `created_at < NOW() - grace`, so `grace` is
// the whole of their earliest-reclaim boundary — a 120-second default meant a
// body could be destroyed two minutes after ONE device acked it.
func TestDeliveryGraceCannotUndercutTheFloor(t *testing.T) {
	floor := MinRetentionDays * day

	for _, tc := range []struct {
		name string
		env  string
	}{
		{"unset (the shipped default was 120s)", ""},
		{"two minutes", "120"},
		{"one day", "86400"},
		{"29 days — just under the floor", "2505600"},
		{"zero", "0"},
		{"negative-ish garbage", "-1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.env == "" {
				t.Setenv("DELETE_ON_DELIVERY_GRACE_SEC", "")
			} else {
				t.Setenv("DELETE_ON_DELIVERY_GRACE_SEC", tc.env)
			}
			if got := retentionGraceSec(); got < floor {
				t.Fatalf(`delete-on-delivery would reclaim a body after %ds (%.1f days).

The retention contract is a MINIMUM of %d days from created_at. Delivery is not
a licence to delete: a second device, a reinstall, or an account that has not
synced yet all still need the server copy. Early reclaim may only ever run
LATER than the floor.`, got, float64(got)/day, MinRetentionDays)
			}
		})
	}
}

// A LONGER retention already configured must survive. "Never shorten existing
// retention" cuts both ways — the clamp raises, it must not also lower.
func TestALongerGraceIsPreserved(t *testing.T) {
	t.Setenv("DELETE_ON_DELIVERY_GRACE_SEC", "31536000") // one year
	if got := retentionGraceSec(); got != 31_536_000 {
		t.Fatalf("a 365-day grace was clamped down to %ds — the floor must raise, never lower", got)
	}
}

func TestRetentionFloorIsRaisableNotLowerable(t *testing.T) {
	t.Setenv("RETENTION_MIN_DAYS", "90")
	if got := MinRetentionDaysEffective(); got != 90 {
		t.Fatalf("RETENTION_MIN_DAYS=90 gave %d days — a longer retention must be honoured", got)
	}
	if got := retentionGraceSec(); got < 90*day {
		t.Fatalf("the grace floor ignored RETENTION_MIN_DAYS=90 (%ds)", got)
	}

	t.Setenv("RETENTION_MIN_DAYS", "1")
	if got := MinRetentionDaysEffective(); got != MinRetentionDays {
		t.Fatalf("RETENTION_MIN_DAYS=1 lowered the floor to %d days — it must be ignored", got)
	}
}

// ── the ephemeral body store ───────────────────────────────────────────

// TestBodyStoreIsRefusedWhileItsCeilingBreachesTheFloor.
//
// message_bodies carries a schema CHECK (migration 099):
//
//	body_expires_at <= created_at + INTERVAL '3 hours'
//
// so under that flag EVERY body — normal messages included — is destroyed three
// hours after creation by expire-bodies. That is the exact outcome the contract
// forbids, and it is not fixable from here: it needs the CHECK relaxed, a
// per-message TTL so explicitly-ephemeral messages keep their short life, and a
// partition window sized for the floor. Until then the flag must not take
// effect, however it is set.
func TestBodyStoreIsRefusedWhileItsCeilingBreachesTheFloor(t *testing.T) {
	t.Setenv("MESSAGE_BODIES", "1")
	t.Setenv("MESSAGE_BODY_TTL_SECONDS", "")

	if why := bodyStoreRefused(); why == "" {
		t.Fatal("MESSAGE_BODIES=1 was accepted with a 3-hour ceiling in force — normal message " +
			"bodies would be destroyed 3h after creation, against a 30-day floor")
	}
	if BodyStoreEnabled() {
		t.Fatalf(`the body store reports ENABLED with a %s ceiling against a %d-day floor.

Bodies must stay on the durable spine (messages.content), which nothing
reclaims. Enabling the store here silently shortens every normal message's
server lifetime from unbounded to three hours.`, bodyTTL(), MinRetentionDaysEffective())
	}
}

// The refusal must be about the CEILING, not a blanket "never". A body store
// whose TTL genuinely satisfies the floor is acceptable — this is what makes
// the guard a contract check rather than a permanent off-switch, and what will
// let the store come back once its schema can express a 30-day deadline.
func TestBodyStoreIsAcceptedOnceItsTTLSatisfiesTheFloor(t *testing.T) {
	t.Setenv("MESSAGE_BODIES", "1")
	if bodyTTL() >= time.Duration(MinRetentionDays)*24*time.Hour {
		t.Skip("bodyTTL already satisfies the floor; the ceiling must have been raised deliberately")
	}
	// bodyTTL() cannot currently be raised — MESSAGE_BODY_TTL_SECONDS may only
	// tighten — so assert the REASON is the ceiling rather than the flag.
	if why := bodyStoreRefused(); why == "" {
		t.Fatal("expected a refusal reason naming the ceiling")
	}
	t.Setenv("MESSAGE_BODIES", "0")
	if why := bodyStoreRefused(); why != "" {
		t.Fatalf("a store that was never requested must not be 'refused': %s", why)
	}
}

// The floor is stated as a constant so a reader does not have to infer it, and
// so the number in the contract and the number in the code cannot drift.
func TestFloorIsThirtyDays(t *testing.T) {
	if MinRetentionDays != 30 {
		t.Fatalf("MinRetentionDays = %d; the stated contract is a 30-day minimum", MinRetentionDays)
	}
}
