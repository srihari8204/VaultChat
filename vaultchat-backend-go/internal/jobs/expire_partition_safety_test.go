// expire_partition_safety_test.go — the expiry sweep must delete EXPIRED
// bodies and nothing else.
//
// This pins a bug that destroyed user data and that every other test passed
// straight through. The sweep batched with `WHERE ctid IN (SELECT ctid FROM
// message_bodies …)`. ctid is unique within a HEAP, not within a PARTITIONED
// table, and every partition starts numbering at page 0 — so ctid (0,1) exists
// in every hour that has ever held a body. The TID of one expired row therefore
// matched a row in EVERY partition, and the sweep deleted bodies that were
// still inside their three-hour window.
//
// The consequence is not storage churn. It is a recipient who was offline
// losing a message the retention promise said would still be waiting.
//
// Two tests, because they fail for different reasons:
//   - the pure one runs on every `go test ./...` and catches a reintroduction
//     the moment it is written
//   - the DB one proves the BEHAVIOUR against a real partitioned table, which
//     is the only thing that can prove the fix rather than the spelling
package jobs

import (
	"context"
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
)

// ── pure: always runs ─────────────────────────────────────────────────

func TestExpireBodiesIsNotBatchedByCtid(t *testing.T) {
	if strings.Contains(expireBodiesSQL, "ctid") {
		t.Fatalf(`the expiry sweep batches message_bodies by ctid again.

message_bodies is PARTITIONED. ctid is only unique within one partition, so a
TID collected from one hour's partition also matches a row in every other
hour's partition — including bodies that have NOT expired. That deletes user
data inside the retention window.

Batch by (message_id, created_at): it is the PRIMARY KEY and contains the
partition key, so it names exactly one row across the whole set.

statement:
%s`, expireBodiesSQL)
	}

	// The positive half. Without it, deleting the ctid clause entirely — and
	// thereby dropping the batch bound — would still satisfy the check above.
	if !strings.Contains(expireBodiesSQL, "(message_id, created_at) IN") {
		t.Fatalf("the expiry sweep no longer batches by the (message_id, created_at) primary key:\n%s", expireBodiesSQL)
	}

	// The predicate itself. A sweep that stopped filtering on the deadline
	// would empty the table, which is the opposite failure and just as bad.
	if !strings.Contains(expireBodiesSQL, "body_expires_at <= NOW()") {
		t.Fatalf("the expiry sweep no longer filters on body_expires_at:\n%s", expireBodiesSQL)
	}
}

// ── DB-backed: the behaviour ──────────────────────────────────────────

// TestExpireBodiesSparesNonExpiredInOtherPartitions builds the exact collision
// the bug needed — two rows sharing a ctid in DIFFERENT partitions, one past
// due and one not — and runs the real sweep over it.
//
// Getting both rows onto the same ctid is the whole trick: each row goes into a
// freshly created partition, so each is that partition's first tuple. The
// created_at values are in the future purely to reach empty partitions; the
// CHECK constraint only bounds the UPPER side (expires <= created + 3h), so a
// future created_at with a past deadline is legal.
func TestExpireBodiesSparesNonExpiredInOtherPartitions(t *testing.T) {
	// DB_SYSTEM_USER is part of the gate, not optional garnish. Every seed
	// below goes through db.SysPool, which aliases Pool when that variable is
	// unset (internal/db/db.go) — so the INSERT runs as the ordinary app role
	// and RLS refuses it:
	//
	//   seed: ERROR: new row violates row-level security policy for table
	//         "message_bodies" (SQLSTATE 42501)
	//
	// That reads like a product bug and is not one: nothing under test has run
	// at that point. Its sibling in internal/db/syspool_test.go already gates
	// on both; this one did not, so a developer with CALL_TEST_DB set and no
	// BYPASSRLS role got a red failure where an honest skip belongs.
	if os.Getenv("CALL_TEST_DB") != "1" || os.Getenv("DB_SYSTEM_USER") == "" {
		t.Skip("set CALL_TEST_DB=1, DB_* and DB_SYSTEM_USER (a BYPASSRLS role) to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("db: %v", err)
	}

	const expiredID, liveID = -900001, -900002
	cleanup := func() {
		_, _ = db.SysPool.Exec(ctx,
			`DELETE FROM message_bodies WHERE message_id IN ($1, $2)`, expiredID, liveID)
	}
	cleanup()
	defer cleanup()

	// Both partitions must exist before the insert, or the rows are rejected
	// rather than landing where the collision needs them.
	for _, h := range []string{"5 hours", "6 hours"} {
		if _, err := db.SysPool.Exec(ctx,
			`SELECT vc_message_bodies_ensure_partition(NOW() + $1::INTERVAL)`, h); err != nil {
			t.Fatalf("ensure partition +%s: %v", h, err)
		}
	}

	if _, err := db.SysPool.Exec(ctx,
		`INSERT INTO message_bodies (message_id, chat_id, created_at, content, body_expires_at)
		 VALUES ($1, gen_random_uuid(), NOW() + INTERVAL '5 hours', 'expired', NOW() - INTERVAL '1 minute'),
		        ($2, gen_random_uuid(), NOW() + INTERVAL '6 hours', 'live',    NOW() + INTERVAL '3 hours')`,
		expiredID, liveID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Confirm the collision is real, otherwise this test proves nothing: a
	// future partition layout that separated the ctids would make it pass
	// whether or not the bug was present.
	var ctidExpired, ctidLive string
	if err := db.SysPool.QueryRow(ctx,
		`SELECT (SELECT ctid::text FROM message_bodies WHERE message_id = $1),
		        (SELECT ctid::text FROM message_bodies WHERE message_id = $2)`,
		expiredID, liveID).Scan(&ctidExpired, &ctidLive); err != nil {
		t.Fatalf("read ctids: %v", err)
	}
	if ctidExpired != ctidLive {
		t.Skipf("no ctid collision to test (%s vs %s) — partitions were not both empty", ctidExpired, ctidLive)
	}

	sweepExpiredBodies(ctx)

	var expiredGone, liveSurvives bool
	if err := db.SysPool.QueryRow(ctx,
		`SELECT NOT EXISTS (SELECT 1 FROM message_bodies WHERE message_id = $1),
		            EXISTS (SELECT 1 FROM message_bodies WHERE message_id = $2)`,
		expiredID, liveID).Scan(&expiredGone, &liveSurvives); err != nil {
		t.Fatalf("verify: %v", err)
	}

	if !expiredGone {
		t.Error("the past-due body survived the sweep — expiry is not running")
	}
	if !liveSurvives {
		t.Fatalf(`the sweep deleted a body that had NOT expired (ctid %s in both partitions).

This is the ctid-collision bug: a message still inside its three-hour retention
window was destroyed because an unrelated expired row in another partition
happened to share its physical tuple id.`, ctidLive)
	}
}
