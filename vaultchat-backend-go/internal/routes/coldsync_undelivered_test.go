// coldsync_undelivered_test.go — a fresh install must not re-download history.
//
// An empty local database is not a licence to hand back everything the account
// has ever received. A reinstall was pulling the full history (measured: 277
// messages for a real account) purely because the client had no cursor — wasted
// bandwidth, and server-side exposure of old ciphertext to a client that has no
// key for it.
//
// The discriminator is chat_members.last_delivered_message_id, the account's
// per-chat delivery high-water mark. At or below it = already delivered =
// HISTORY. Above it = still PENDING and must arrive, or reinstalling would
// silently drop messages in flight.
//
// These pin WHERE the filter lives and, more importantly, what it must never do.
package routes

import (
	"strings"
	"testing"
)

func TestColdSyncReturnsOnlyUndelivered(t *testing.T) {
	src := mustRead(t, "chats.go")

	fn := src[strings.Index(src, "func chatsDelta("):]
	if i := strings.Index(fn, "\nfunc "); i > 0 {
		fn = fn[:i]
	}

	// The flag must be set only on the unrecognised-device path, not on any
	// since=0 request — otherwise a client could ask for a full history dump
	// simply by sending cursor=0.
	if !strings.Contains(fn, "coldStart := false") {
		t.Fatal("chatsDelta has no coldStart flag — the undelivered-only filter cannot be gated")
	}
	set := strings.Index(fn, "coldStart = true")
	known := strings.Index(fn, "noteSyncDevice(ctx, user.ID, deviceID, true)")
	if set < 0 || known < 0 || set < known {
		t.Error("coldStart must be set INSIDE the !noteSyncDevice branch, so a recognised " +
			"device (or a hand-crafted since=0) cannot trigger a history dump")
	}

	// The filter itself.
	if !strings.Contains(fn, "cm.last_delivered_message_id IS NULL OR m.id > cm.last_delivered_message_id") {
		t.Fatal("cold start does not filter on the delivery high-water mark — a fresh " +
			"install will re-download the account's entire history")
	}

	// PENDING MUST STILL ARRIVE. A NULL mark means nothing was ever acked for
	// that chat, so everything in it is still pending; dropping the NULL arm
	// would silently lose a new member's first messages.
	if !strings.Contains(fn, "cm.last_delivered_message_id IS NULL OR") {
		t.Error("the NULL arm is missing: a chat that has never been acked would " +
			"return nothing, losing genuinely pending messages")
	}

	// It must be a per-ROW comparison, not a single floor. The delta cursor is
	// global while the delivery mark is per chat; one number cannot express both.
	if strings.Contains(fn, "since = maxDelivered") || strings.Contains(fn, "since = delivered") {
		t.Error("a single global floor cannot represent per-chat delivery marks")
	}

	// Incremental sync must be untouched: the filter is cold-start only.
	if !strings.Contains(fn, "if coldStart {") {
		t.Error("the filter must be gated on coldStart, or existing devices doing " +
			"an incremental sync would also be filtered")
	}
}

// The cap and the undelivered filter are independent protections; neither may
// quietly replace the other.
func TestColdSyncCapStillApplies(t *testing.T) {
	src := mustRead(t, "chats.go")
	if !strings.Contains(src, "coldSyncFloor(ctx, user.ID, capN)") {
		t.Error("the message cap was removed; it is the backstop for an account whose " +
			"pending set is itself enormous")
	}
	if !strings.Contains(src, "cold sync capped to") {
		t.Error("the capped-path log line is gone — it is the only server-side evidence " +
			"that the cap engaged")
	}
}
