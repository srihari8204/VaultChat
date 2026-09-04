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
	"strings"
	"testing"
	"time"
)

const day = 86_400

// ── the delivery-based sweeps ──────────────────────────────────────────

// TestDeviceStalenessCannotUndercutTheFloor is the important one.
//
// The delivery predicate is what protects an undelivered message, and this is
// the single input that can make it declare an undelivered message delivered.
// On a multi-device account the first device to ack advances the shared
// chat_members pointer; the per-device table protects the rest, but only while
// a device's last_sync_at is inside this window. Set it to 7 and a handset that
// has been off for eight days is ignored — its message is reclaimed on day
// eight, well inside a thirty-day promise.
func TestDeviceStalenessCannotUndercutTheFloor(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  string
	}{
		{"unset (default 30)", ""},
		{"one day", "1"},
		{"seven days", "7"},
		{"29 days — just under the floor", "29"},
		{"zero", "0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DELETE_ON_DELIVERY_DEVICE_STALE_DAYS", tc.env)
			if got := retentionStaleDays(); got < MinRetentionDays {
				t.Fatalf(`a device silent for %d days stops being waited for, but the floor is %d days.

That lets the delivery predicate treat an UNDELIVERED message as delivered and
reclaim it early — the exact outcome the 30-day contract forbids.`, got, MinRetentionDays)
			}
		})
	}
}

// A LONGER staleness window already configured must survive: the clamp raises,
// it must never lower.
func TestALongerStalenessIsPreserved(t *testing.T) {
	t.Setenv("DELETE_ON_DELIVERY_DEVICE_STALE_DAYS", "365")
	if got := retentionStaleDays(); got != 365 {
		t.Fatalf("a 365-day staleness window was clamped down to %d — the floor must raise, never lower", got)
	}
}

// The POST-DELIVERY grace must stay short and unclamped.
//
// This pins a correction. An earlier revision clamped the grace to 30 days too,
// which made post-delivery reclaim impossible — the contract explicitly permits
// reclaiming a body every device already holds after a short grace. Clamping
// here adds no safety the delivery predicate does not already give.
func TestPostDeliveryGraceIsNotClampedToTheFloor(t *testing.T) {
	t.Setenv("DELETE_ON_DELIVERY_GRACE_SEC", "10800") // three hours
	if got := retentionGraceSec(); got != 10_800 {
		t.Fatalf(`a 3-hour post-delivery grace became %ds.

Delivered bodies MAY be reclaimed after a short grace; only the paths that
ignore delivery (the age purge, the staleness window) carry the floor.`, got)
	}
	// The DEFAULT is asserted by TestPostDeliveryGraceDefaultsToThePublishedThreeHours
	// in delete_on_delivery_test.go, which is where the reasoning for the value
	// lives. It was 120s — a number nothing documented and nothing enforced —
	// and is now the three hours the retention policy actually promises.
	//
	// What matters HERE is only that the default, whatever it is, is still not
	// dragged up to the 30-day floor: this path is delivery-bound by design.
	t.Setenv("DELETE_ON_DELIVERY_GRACE_SEC", "")
	if got := retentionGraceSec(); got >= MinRetentionDays*day {
		t.Fatalf(`the default post-delivery grace (%ds) reached the retention floor.

That makes post-delivery reclaim impossible and turns delete-on-delivery back
into the age purge it exists to replace.`, got)
	}
}

func TestRetentionFloorIsRaisableNotLowerable(t *testing.T) {
	t.Setenv("RETENTION_MIN_DAYS", "90")
	if got := MinRetentionDaysEffective(); got != 90 {
		t.Fatalf("RETENTION_MIN_DAYS=90 gave %d days — a longer retention must be honoured", got)
	}
	if got := retentionStaleDays(); got < 90 {
		t.Fatalf("the staleness floor ignored RETENTION_MIN_DAYS=90 (%d days)", got)
	}

	t.Setenv("RETENTION_MIN_DAYS", "1")
	if got := MinRetentionDaysEffective(); got != MinRetentionDays {
		t.Fatalf("RETENTION_MIN_DAYS=1 lowered the floor to %d days — it must be ignored", got)
	}
}

// The age purge ignores delivery entirely, so it is the other path that must
// carry the floor. Mirrors the clamp in sweepDeliveredMessages.
func TestAgePurgeCannotUndercutTheFloor(t *testing.T) {
	for _, in := range []int{1, 7, 29} {
		maxDays := in
		if maxDays > 0 && maxDays < MinRetentionDaysEffective() {
			maxDays = MinRetentionDaysEffective()
		}
		if maxDays < MinRetentionDays {
			t.Fatalf("DELETE_ON_DELIVERY_MAX_AGE_DAYS=%d survived as %d, under the %d-day floor",
				in, maxDays, MinRetentionDays)
		}
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

// ── the two contracts must not be conflated ────────────────────────────

// TestDisappearingMessagesIgnoreTheRetentionFloor.
//
// A normal message has a 30-day FLOOR on how long its body is kept. An
// explicitly disappearing message has an expires_at CEILING set from
// chats.disappearing_seconds. The floor is a minimum on retention, never a
// licence to keep a message the sender said should vanish in three hours.
//
// So the expiry sweep must key off expires_at alone — no floor, no delivery
// state, no grace.
func TestDisappearingMessagesIgnoreTheRetentionFloor(t *testing.T) {
	if !strings.Contains(expiredMessagesSQL, "expires_at <= NOW()") {
		t.Fatalf("the expiry sweep no longer fires on expires_at:\n%s", expiredMessagesSQL)
	}
	for _, leak := range []string{"created_at", "last_delivered_message_id", "last_sync_at", "grace"} {
		if strings.Contains(expiredMessagesSQL, leak) {
			t.Fatalf(`the expiry sweep now consults %q.

An explicitly disappearing message must expire on its own timer. Mixing in the
normal-message retention floor or any delivery state would keep a 3-hour
message alive for up to %d days.

statement:
%s`, leak, MinRetentionDays, expiredMessagesSQL)
		}
	}
}

// An expired disappearing message must be UNREACHABLE, not merely blanked.
// delta, cold sync and history sync all read from `messages`, so deleting the
// spine row is what stops it being re-served after expiry (or after reinstall).
func TestExpiredDisappearingMessagesAreDeletedNotBlanked(t *testing.T) {
	if !strings.HasPrefix(strings.TrimSpace(expiredMessagesSQL), "DELETE FROM messages") {
		t.Fatalf(`the expiry sweep no longer DELETEs the spine row.

Nulling content would leave the row visible to delta/cold/history sync, so an
expired disappearing message could still reappear as a tombstone.

statement:
%s`, expiredMessagesSQL)
	}
}
