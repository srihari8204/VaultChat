// message_bodies_test.go — the read seam that lets ciphertext live in an
// ephemeral table without any client noticing.
//
// The pure half (SQL shape) always runs. The DB half is gated on CALL_TEST_DB=1
// like the other route tests, so `go test ./...` stays green on a machine with
// no scratch database.
package routes

import (
	"context"
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
)

// ── pure: the generated SQL ───────────────────────────────────────────

func TestMsgSelBodyCoalescesContent(t *testing.T) {
	got := chatsMsgSelBody("m")

	// The body must WIN over the legacy column: once a body exists, m.content
	// is NULL for that row, and reversing the arguments would return NULL for
	// every message written after the cutover. COALESCE(b, m) is the whole
	// migration in one expression, so it is worth pinning by string.
	if !strings.Contains(got, "COALESCE(b.content, m.content) AS content") {
		t.Fatalf("content is not body-aware:\n%s", got)
	}

	// The alias must survive. chatsMsgRow.dest() scans positionally, so a
	// column that silently loses its qualification would still compile, still
	// run, and quietly return the wrong table's value once message_bodies
	// gained a same-named column.
	for _, col := range []string{"m.id", "m.chat_id", "m.sender_id", "m.created_at", "m.expires_at"} {
		if !strings.Contains(got, col) {
			t.Fatalf("missing %s in select list:\n%s", col, got)
		}
	}

	// expires_at (disappearing messages) must come from the SPINE and must not
	// be confused with body_expires_at (infrastructure retention). If these two
	// ever merge, every message vanishes from the user's chat at the retention
	// boundary — the exact outcome the separate column exists to prevent.
	if strings.Contains(got, "body_expires_at") {
		t.Fatalf("body_expires_at leaked into the client-facing select list:\n%s", got)
	}
}

// topLevelCols counts select-list entries, ignoring commas nested inside a
// function call. Splitting on ", " naively counts COALESCE(b.content,
// m.content) as two columns — which is exactly the trap a reader of this test
// would fall into next time, so the depth walk is the point rather than an
// implementation detail.
func topLevelCols(sel string) int {
	n, depth := 1, 0
	for _, c := range sel {
		switch c {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				n++
			}
		}
	}
	return n
}

func TestMsgSelBodyColumnCountMatchesRowScanner(t *testing.T) {
	// dest() scans a fixed number of columns in a fixed order. A column added to
	// chatsMsgCols without a matching field is a runtime scan error on the
	// chat-open path, which is the kind of break that only shows up in
	// production. Counting here makes it a test failure instead.
	want := len(strings.Split(chatsMsgCols, ", "))
	if got := topLevelCols(chatsMsgSelBody("m")); got != want {
		t.Fatalf("chatsMsgSelBody produced %d columns, chatsMsgCols has %d", got, want)
	}
	var row chatsMsgRow
	if n := len(row.dest()); n != want {
		t.Fatalf("chatsMsgRow.dest() scans %d columns, chatsMsgCols has %d", n, want)
	}
}

func TestBodyJoinUsesPartitionKey(t *testing.T) {
	// Joining on message_id alone is CORRECT but pathological: without
	// created_at the planner cannot prune, so every lookup probes every hourly
	// partition. At a few days of partitions that is already hundreds of index
	// probes per message.
	if !strings.Contains(chatsBodyJoin, "b.created_at = m.created_at") {
		t.Fatalf("join does not carry the partition key, pruning will not happen:\n%s", chatsBodyJoin)
	}
	if !strings.Contains(chatsBodyJoin, "LEFT JOIN") {
		t.Fatalf("join must be a LEFT JOIN — an inner join would HIDE every message whose body has been reclaimed:\n%s", chatsBodyJoin)
	}
}

// ── DB-backed: the schema guarantees ──────────────────────────────────

func mbSkip(t *testing.T) {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
}

// The 3-hour ceiling must be enforced by the DATABASE, not by the caller.
//
// bodyTTL() in internal/jobs already refuses to return more than three hours,
// but that is one code path. This asserts the constraint that holds for every
// writer — including a future one, a migration, a manual psql session, or a bug.
func TestBodyExpiresAtCeilingIsEnforcedBySchema(t *testing.T) {
	mbSkip(t)
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("db: %v", err)
	}
	if _, err := db.SysPool.Exec(ctx,
		`INSERT INTO message_bodies (message_id, chat_id, created_at, content, body_expires_at)
		 VALUES (-1, gen_random_uuid(), NOW(), 'x', NOW() + INTERVAL '4 hours')`); err == nil {
		_, _ = db.SysPool.Exec(ctx, `DELETE FROM message_bodies WHERE message_id = -1`)
		t.Fatal("a 4-hour body was accepted — message_bodies_ttl_cap is missing or not enforced")
	}
}

// Partition creation must be safe to call repeatedly and concurrently: it runs
// on a 15-minute ticker on every replica, and again on demand from the writer.
func TestEnsurePartitionIsIdempotent(t *testing.T) {
	mbSkip(t)
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("db: %v", err)
	}
	var first, second string
	if err := db.SysPool.QueryRow(ctx, `SELECT vc_message_bodies_ensure_partition(NOW())`).Scan(&first); err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	if err := db.SysPool.QueryRow(ctx, `SELECT vc_message_bodies_ensure_partition(NOW())`).Scan(&second); err != nil {
		t.Fatalf("second ensure (idempotency): %v", err)
	}
	if first != second {
		t.Fatalf("same instant produced two partition names: %q then %q", first, second)
	}
}

// A body must never outlive its partition's window, and the partition name must
// be derivable from created_at alone — otherwise the retention job cannot know
// which partitions are safe to reclaim without reading their rows.
func TestPartitionNameIsDerivedFromUTCHour(t *testing.T) {
	mbSkip(t)
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("db: %v", err)
	}
	var name string
	if err := db.SysPool.QueryRow(ctx,
		`SELECT vc_message_bodies_ensure_partition(TIMESTAMPTZ '2026-08-12 20:37:00+00')`).Scan(&name); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if name != "message_bodies_2026081220" {
		t.Fatalf("partition name = %q, want message_bodies_2026081220 (UTC hour, not session tz)", name)
	}
}
