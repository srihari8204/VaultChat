// delete_on_delivery_test.go — the delivery predicate is the ONLY thing that
// protects an undelivered message from permanent destruction.
//
// WHY THESE EXIST
//
// Every other reclaim path in this package is clock-bound and therefore sits
// behind MinRetentionDays, which retention_floor_test.go pins. This one is
// deliberately EXEMPT from that floor (see retentionGraceSec) — the whole point
// of delete-on-delivery is to reclaim a body minutes after every device has it,
// not thirty days later. That exemption is correct, and it means the clock
// protects nothing here. What protects an undelivered message is three SQL
// clauses, and nothing outside this file would fail if one of them were
// deleted: the statement would still compile, still run, and quietly null the
// content of messages that were never delivered to anybody.
//
// So the statement itself is the contract, and these assert it directly.
//
// Pure tests: no database, no network. They run on every `go test ./...`.
package jobs

import (
	"strings"
	"testing"
)

// ── the three load-bearing clauses ─────────────────────────────────────

func TestDeliveredSweepKeepsItsThreeSafetyClauses(t *testing.T) {
	for _, c := range []struct {
		name, needle, whatBreaks string
	}{
		{
			name:   "the chat still has another member",
			needle: "SELECT 1 FROM chat_members o",
			whatBreaks: `Without it, a chat whose other members have all LEFT satisfies
"nobody is behind this message" trivially — NOT EXISTS over an empty set is TRUE —
so every message in it is reclaimed on the next tick.`,
		},
		{
			name:   "no member's account pointer is behind the message",
			needle: "cm.last_delivered_message_id IS NULL OR cm.last_delivered_message_id < m2.id",
			whatBreaks: `This is the actual "has it been delivered?" test. Without it the
sweep reclaims on age alone, which is precisely the unconditional purge this
model exists to avoid.`,
		},
		{
			name:   "no active DEVICE of any member is behind it",
			needle: "cdd.last_delivered_message_id IS NULL OR cdd.last_delivered_message_id < m2.id",
			whatBreaks: `On a multi-device account the FIRST device to ack advances the
shared chat_members pointer. Without the per-device check, the body is destroyed
while a second handset has never received it — and that handset has no other
source, because the server copy is what it was waiting for.`,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			if !strings.Contains(deliveredMessagesSQL, c.needle) {
				t.Fatalf(`delete-on-delivery lost a safety clause: %s

Missing: %s

%s`, c.name, c.needle, c.whatBreaks)
			}
		})
	}
}

// The staleness window is what stops a retired handset pinning history forever,
// but it is applied to user_sync_devices — a device that HAS synced recently
// must still be waited for. If the join stopped filtering on last_sync_at the
// sweep would either wait on dead devices forever or ignore live ones.
func TestDeliveredSweepBoundsDeviceWaitingByLastSync(t *testing.T) {
	if !strings.Contains(deliveredMessagesSQL, "usd.last_sync_at > NOW() - ($3 || ' days')::interval") {
		t.Fatal(`the per-device check no longer bounds how long it waits on a silent device.

Either every retired handset now pins its account's history on the server
indefinitely, or (if the clause was dropped entirely) devices are no longer
consulted at all and a second handset loses messages it never received.`)
	}
}

// ── the verb ───────────────────────────────────────────────────────────

// Reclaiming a delivered body and expiring a disappearing message are different
// promises and MUST stay different statements. Unifying them has an obvious
// appeal — both "remove the message" — and would be wrong in both directions.
func TestDeliveredSweepBlanksTheBodyAndKeepsTheSpine(t *testing.T) {
	if !strings.Contains(deliveredMessagesSQL, "SET content = NULL") {
		t.Fatal("delete-on-delivery must NULL content, not remove the row")
	}
	if strings.Contains(deliveredMessagesSQL, "DELETE FROM messages") {
		t.Fatal(`delete-on-delivery is DELETEing the spine row.

That is the disappearing-message behaviour, not this one. The message must stay
in the timeline with its id, sender and timestamp — recipients have it locally
and reply to it; removing the row breaks reply threading and re-opens the id for
a cold-sync gap. Only the body is reclaimed here.`)
	}
	// The twin: expiry DOES delete, and must keep doing so, or an expired
	// disappearing message is re-served from `messages` on the next delta.
	if !strings.Contains(expiredMessagesSQL, "DELETE FROM messages") {
		t.Fatal("disappearing-message expiry must DELETE the row, not blank it")
	}
}

func TestDeliveredSweepIsIdempotentAndBatched(t *testing.T) {
	if !strings.Contains(deliveredMessagesSQL, "m2.content IS NOT NULL") {
		t.Fatal(`without this the sweep re-writes rows it already blanked, every tick,
forever — each one a new heap tuple and a WAL record for no change at all.`)
	}
	if !strings.Contains(deliveredMessagesSQL, "m2.deleted_at IS NULL") {
		t.Fatal("deleted messages must not be rewritten by the sweep")
	}
	if !strings.Contains(deliveredMessagesSQL, "ctid IN (") || !strings.Contains(deliveredMessagesSQL, "LIMIT $2") {
		t.Fatal(`the sweep is unbatched: one UPDATE would hold row locks and emit a
single WAL burst scaling with the whole backlog. Batch by ctid like the others.`)
	}
}

// ── the defaults an operator inherits ──────────────────────────────────

// The flag alone must produce the DOCUMENTED behaviour. Anyone enabling this
// reads "we delete your message within three hours of it reaching your device"
// and sets one variable; the default has to be that promise, not a value that
// happens to be smaller.
func TestPostDeliveryGraceDefaultsToThePublishedThreeHours(t *testing.T) {
	t.Setenv("DELETE_ON_DELIVERY_GRACE_SEC", "")
	if got := retentionGraceSec(); got != 3*60*60 {
		t.Fatalf("post-delivery grace defaults to %ds; the published promise is 3h (%ds)", got, 3*60*60)
	}
}

// THE knob that can destroy an undelivered message. It ignores delivery state
// entirely, so it must stay off unless somebody deliberately asks for it — and
// even then it cannot go under the floor (pinned in retention_floor_test.go).
func TestUnconditionalAgePurgeIsOffByDefault(t *testing.T) {
	t.Setenv("DELETE_ON_DELIVERY_MAX_AGE_DAYS", "")
	if got := envInt("DELETE_ON_DELIVERY_MAX_AGE_DAYS", 0); got != 0 {
		t.Fatalf(`the unconditional age purge defaults to %d days — it must default to OFF.

Unlike the delivery sweep, this statement does not consult delivery at all. With
it on, a message nobody ever received is destroyed purely because it got old,
which is the one outcome the retention model forbids.`, got)
	}
}

// The age purge and the delivery sweep are different statements for a reason;
// the age purge must never grow a delivery predicate (it would then be a
// duplicate of the sweep) and the sweep must never grow an age-only path.
func TestAgePurgeStaysSeparateFromTheDeliverySweep(t *testing.T) {
	if strings.Contains(deliveredMessagesSQL, "MAX_AGE") {
		t.Fatal("the delivery sweep must not consult the age purge's knob")
	}
}
