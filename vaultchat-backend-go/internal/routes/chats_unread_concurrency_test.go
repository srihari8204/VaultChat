// chats_unread_concurrency_test.go — the unread counter under REAL Postgres.
//
// chats_unread_selfheal_test.go asserts the SHAPE of the SQL. This file runs it.
// A source-text assertion cannot tell you what two interleaved transactions do,
// and the reported defect is precisely an interleaving.
//
// Run it against the disposable cluster, never 15432 (that port is historically
// an SSH tunnel to production and this suite writes):
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=15499 DB_NAME=vaultchat \
//	DB_USER=vaultchat DB_PASS=testpw JWT_SECRET=test-secret-at-least-32-chars-long \
//	VAULTCHAT_MASTER_KEY=$(printf '0%.0s' $(seq 64)) VAULTCHAT_LOOKUP_PEPPER=test-pepper \
//	go test ./internal/routes/ -run TestUnread -v
//
// ISOLATION: every fixture id carries the 0c07 marker and ucCleanup removes
// exactly those rows.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sync"

	"vaultchat/backend-go/internal/db"
	"testing"
)

const (
	ucChatBusy  = "0c070000-0000-4000-8000-000000000001"
	ucChatQuiet = "0c070000-0000-4000-8000-000000000002"
	ucReader    = "0c070000-0000-4000-8000-0000000000a1"
	ucSender    = "0c070000-0000-4000-8000-0000000000a2"
)

func ucSkip(t *testing.T) context.Context {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* (port 15499, NOT 15432) to run the unread concurrency tests")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	return ctx
}

func ucCleanup(ctx context.Context) {
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM messages WHERE chat_id IN ('%s','%s')`, ucChatBusy, ucChatQuiet),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id IN ('%s','%s')`, ucChatBusy, ucChatQuiet),
		fmt.Sprintf(`DELETE FROM chats WHERE id IN ('%s','%s')`, ucChatBusy, ucChatQuiet),
		fmt.Sprintf(`DELETE FROM users WHERE id IN ('%s','%s')`, ucReader, ucSender),
	} {
		_ = adminExec(ctx, q)
	}
}

// ucSeed builds two chats so the cross-chat case has a real higher-id chat to
// borrow a cursor from. Returns the newest message id in each.
func ucSeed(t *testing.T, ctx context.Context) (busyNewest, quietNewest int64) {
	t.Helper()
	ucCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		   ('%s','uc-reader@test.local','UC Reader'),
		   ('%s','uc-sender@test.local','UC Sender')`, ucReader, ucSender),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','group'), ('%s','group')`, ucChatQuiet, ucChatBusy),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		   ('%s','%s','member'), ('%s','%s','owner'),
		   ('%s','%s','member'), ('%s','%s','owner')`,
			ucChatQuiet, ucReader, ucChatQuiet, ucSender,
			ucChatBusy, ucReader, ucChatBusy, ucSender),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v (%s)", err, q)
		}
	}
	// QUIET first, so its ids are LOWER than the busy chat's - that ordering is
	// the whole point of the cross-chat case.
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`INSERT INTO messages (chat_id, sender_id, type, content) VALUES
		   ('%s','%s','text','q1'), ('%s','%s','text','q2')
		 RETURNING id`, ucChatQuiet, ucSender, ucChatQuiet, ucSender), &quietNewest); err != nil {
		t.Fatalf("seed quiet: %v", err)
	}
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`INSERT INTO messages (chat_id, sender_id, type, content) VALUES
		   ('%s','%s','text','b1'), ('%s','%s','text','b2'), ('%s','%s','text','b3')
		 RETURNING id`, ucChatBusy, ucSender, ucChatBusy, ucSender, ucChatBusy, ucSender), &busyNewest); err != nil {
		t.Fatalf("seed busy: %v", err)
	}
	// RETURNING on a multi-row INSERT yields the FIRST row through QueryRow, so
	// read the real maxima back rather than trusting that.
	_ = adminQueryRow(ctx, fmt.Sprintf(`SELECT MAX(id) FROM messages WHERE chat_id='%s'`, ucChatQuiet), &quietNewest)
	_ = adminQueryRow(ctx, fmt.Sprintf(`SELECT MAX(id) FROM messages WHERE chat_id='%s'`, ucChatBusy), &busyNewest)
	return busyNewest, quietNewest
}

func ucUnread(t *testing.T, ctx context.Context, chat string) int64 {
	t.Helper()
	var n int64
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT unread_count FROM chat_members WHERE chat_id='%s' AND user_id='%s'`, chat, ucReader), &n); err != nil {
		t.Fatalf("read unread_count: %v", err)
	}
	return n
}

func ucCursor(t *testing.T, ctx context.Context, chat string) int64 {
	t.Helper()
	var n *int64
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT last_read_message_id FROM chat_members WHERE chat_id='%s' AND user_id='%s'`, chat, ucReader), &n); err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if n == nil {
		return 0
	}
	return *n
}

func ucMux() *http.ServeMux {
	mux := http.NewServeMux()
	RegisterChats(mux)
	return mux
}

// CASE 1 — the reported defect, executed.
//
// vc_bump_unread is a blind +1 submitted to a workx goroutine AFTER the message
// is already on the socket. The recipient acks read ~800ms later. If the bump
// lands after that read's recompute, the row holds unread_count = 1 with the
// cursor already at the newest id.
//
// The requirement is that this is correct WITHOUT reopening the chat to heal
// it. That is what this asserts, and it is the case the self-heal change does
// NOT by itself satisfy - self-healing needs a subsequent read.
func TestUnreadSurvivesABumpThatLandsAfterTheRead(t *testing.T) {
	ctx := ucSkip(t)
	_, quietNewest := ucSeed(t, ctx)
	t.Cleanup(func() { ucCleanup(ctx) })

	// The reader reads everything.
	code, res := call(t, ucMux(), ucReader, "POST",
		"/chats/"+ucChatQuiet+"/read", fmt.Sprintf(`{"lastReadMessageId":%d}`, quietNewest))
	if code != 200 {
		t.Fatalf("mark read: %d %v", code, res)
	}
	if got := ucUnread(t, ctx, ucChatQuiet); got != 0 {
		t.Fatalf("after reading everything unread_count should be 0, got %d", got)
	}

	// The delayed bump for a message the reader has ALREADY read now lands.
	//
	// Three-argument form, because that is what chats_helpers.go calls
	// (135_unread_bump_authoritative.sql). The two-argument function from 034 is
	// still installed and still unconditional - deliberately, so a server binary
	// that predates the migration keeps working - and is covered separately by
	// TestLegacyTwoArgBumpIsStillTheUnguardedOne below.
	if err := adminExec(ctx, fmt.Sprintf(
		`SELECT vc_bump_unread('%s','%s',%d)`, ucChatQuiet, ucSender, quietNewest)); err != nil {
		t.Fatalf("bump: %v", err)
	}

	got := ucUnread(t, ctx, ucChatQuiet)
	if got != 0 {
		t.Fatalf("DEFECT REPRODUCED: unread_count = %d for a chat whose cursor (%d) is "+
			"already at its newest message. vc_bump_unread incremented unconditionally "+
			"for a message the reader had already read, and nothing heals it until some "+
			"LATER read advances the cursor - which cannot happen without a new message. "+
			"The badge stays lit on a chat with nothing unread in it.",
			got, ucCursor(t, ctx, ucChatQuiet))
	}
}

// CASE 4 — a busy chat's higher global id must not satisfy a quieter chat.
//
// messages.id is one BIGSERIAL across every chat, so the busy chat's newest id
// is a well-formed integer for the quiet chat too. It must be refused, because
// the vanish sweep deletes at or below the cursor.
func TestUnreadRejectsACursorFromAnotherChat(t *testing.T) {
	ctx := ucSkip(t)
	busyNewest, quietNewest := ucSeed(t, ctx)
	t.Cleanup(func() { ucCleanup(ctx) })

	if busyNewest <= quietNewest {
		t.Fatalf("fixture is wrong: the busy chat (%d) must have a higher newest id "+
			"than the quiet one (%d) for this case to mean anything", busyNewest, quietNewest)
	}

	code, res := call(t, ucMux(), ucReader, "POST",
		"/chats/"+ucChatQuiet+"/read", fmt.Sprintf(`{"lastReadMessageId":%d}`, busyNewest))
	if code == 200 {
		t.Fatalf("a cursor from chat %s (id %d) was ACCEPTED for chat %s, whose newest "+
			"is %d. The vanish sweep runs at or below the cursor, so this deletes "+
			"vanish_after_read history that was never read. res=%v",
			ucChatBusy, busyNewest, ucChatQuiet, quietNewest, res)
	}
	if code != 400 {
		t.Fatalf("expected 400 for an out-of-scope cursor, got %d %v", code, res)
	}
	if got := ucCursor(t, ctx, ucChatQuiet); got >= busyNewest {
		t.Fatalf("the rejected cursor was written anyway: %d", got)
	}
}

// CASE 3 — duplicate / multi-device reposts of the SAME id.
//
// Two devices on one account keep independent receipt state and both post the
// same id. The repost must not move anything, and (asserted in the source test)
// must not re-emit a read receipt.
func TestUnreadDuplicateRepostsAreInert(t *testing.T) {
	ctx := ucSkip(t)
	_, quietNewest := ucSeed(t, ctx)
	t.Cleanup(func() { ucCleanup(ctx) })

	mux := ucMux()
	body := fmt.Sprintf(`{"lastReadMessageId":%d}`, quietNewest)
	for i := 0; i < 3; i++ {
		if code, res := call(t, mux, ucReader, "POST", "/chats/"+ucChatQuiet+"/read", body); code != 200 {
			t.Fatalf("repost %d: %d %v", i, code, res)
		}
	}
	if got := ucUnread(t, ctx, ucChatQuiet); got != 0 {
		t.Fatalf("unread_count drifted to %d across duplicate reposts", got)
	}
	if got := ucCursor(t, ctx, ucChatQuiet); got != quietNewest {
		t.Fatalf("cursor moved across duplicate reposts: %d != %d", got, quietNewest)
	}
}

// A late receipt carrying an OLDER id must not rewind the cursor - that is what
// GREATEST is for, and rewinding it would re-unread already-read messages and
// re-arm the vanish sweep over them.
func TestUnreadCursorIsNotRewoundByALateReceipt(t *testing.T) {
	ctx := ucSkip(t)
	_, quietNewest := ucSeed(t, ctx)
	t.Cleanup(func() { ucCleanup(ctx) })

	mux := ucMux()
	if code, _ := call(t, mux, ucReader, "POST", "/chats/"+ucChatQuiet+"/read",
		fmt.Sprintf(`{"lastReadMessageId":%d}`, quietNewest)); code != 200 {
		t.Fatal("initial read failed")
	}
	// A receipt from before, arriving now.
	if code, res := call(t, mux, ucReader, "POST", "/chats/"+ucChatQuiet+"/read",
		fmt.Sprintf(`{"lastReadMessageId":%d}`, quietNewest-1)); code != 200 {
		t.Fatalf("late receipt should still be accepted (it recomputes): %d %v", code, res)
	}
	if got := ucCursor(t, ctx, ucChatQuiet); got != quietNewest {
		t.Fatalf("a late receipt REWOUND the cursor from %d to %d", quietNewest, got)
	}
}

// CASE 2 — a genuinely new message and a read, run concurrently, in whatever
// order the scheduler picks. The invariant is not "which wins" but that the row
// never ends up negative, and never claims unread messages that sit at or below
// the cursor.
func TestUnreadStaysConsistentUnderConcurrentSendAndRead(t *testing.T) {
	ctx := ucSkip(t)
	_, quietNewest := ucSeed(t, ctx)
	t.Cleanup(func() { ucCleanup(ctx) })

	mux := ucMux()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = adminExec(ctx, fmt.Sprintf(
			`INSERT INTO messages (chat_id, sender_id, type, content) VALUES ('%s','%s','text','race')`,
			ucChatQuiet, ucSender))
		_ = adminExec(ctx, fmt.Sprintf(`SELECT vc_bump_unread('%s','%s')`, ucChatQuiet, ucSender))
	}()
	go func() {
		defer wg.Done()
		_, _ = call(t, mux, ucReader, "POST", "/chats/"+ucChatQuiet+"/read",
			fmt.Sprintf(`{"lastReadMessageId":%d}`, quietNewest))
	}()
	wg.Wait()

	unread := ucUnread(t, ctx, ucChatQuiet)
	cursor := ucCursor(t, ctx, ucChatQuiet)
	if unread < 0 {
		t.Fatalf("unread_count went negative: %d", unread)
	}
	var truth int64
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT COUNT(*) FROM messages WHERE chat_id='%s' AND id > %d
		   AND sender_id <> '%s' AND deleted_at IS NULL AND type <> 'reaction'`,
		ucChatQuiet, cursor, ucReader), &truth); err != nil {
		t.Fatalf("truth query: %v", err)
	}
	if unread != truth {
		t.Fatalf("unread_count = %d but %d messages actually sit above the cursor (%d). "+
			"The counter and the cursor in the same row disagree.", unread, truth, cursor)
	}
}

// The two-argument function is retained ON PURPOSE so this migration can be
// applied before the binary that calls the three-argument form. Pin that: if
// someone "tidies up" by making 034's signature guarded, a mid-deploy old binary
// silently changes behaviour; if someone drops it, that binary starts erroring
// on every send. Either is a deployment-ordering hazard worth a failing test.
func TestLegacyTwoArgBumpIsStillTheUnguardedOne(t *testing.T) {
	ctx := ucSkip(t)
	_, quietNewest := ucSeed(t, ctx)
	t.Cleanup(func() { ucCleanup(ctx) })

	if code, _ := call(t, ucMux(), ucReader, "POST", "/chats/"+ucChatQuiet+"/read",
		fmt.Sprintf(`{"lastReadMessageId":%d}`, quietNewest)); code != 200 {
		t.Fatal("initial read failed")
	}
	if err := adminExec(ctx, fmt.Sprintf(
		`SELECT vc_bump_unread('%s','%s')`, ucChatQuiet, ucSender)); err != nil {
		t.Fatalf("the 2-arg overload must still exist for rollback safety: %v", err)
	}
	if got := ucUnread(t, ctx, ucChatQuiet); got != 1 {
		t.Fatalf("expected the legacy 2-arg form to still increment unconditionally "+
			"(that is why the 3-arg overload was added rather than the signature "+
			"changed), got unread_count = %d", got)
	}
}
