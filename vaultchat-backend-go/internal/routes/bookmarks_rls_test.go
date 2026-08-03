// bookmarks_rls_test.go — the two-gate membership check, exercised.
//
// Bookmarking someone else's message is the clean example of a handler that
// reads a row and then checks membership itself. The read is now bound to the
// caller, so RLS backs that check up instead of it standing alone — and this
// test pins both halves of the resulting behaviour:
//
//	RLS enforced      → the read returns nothing → 404, membership check unused
//	RLS not enforced  → the read succeeds → the manual check answers 403
//
// Both are correct. The point is that the handler no longer depends on which.
//
// Same harness and same two roles as call_sessions_test.go; see that file's
// header for why fixtures need an admin connection.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"

	"vaultchat/backend-go/internal/db"
)

const (
	bkOwner   = "aaaaaaaa-0000-4000-8000-00000000bb01" // in the chat
	bkOutside = "bbbbbbbb-0000-4000-8000-00000000bb02" // not in the chat
	bkChat    = "cccccccc-0000-4000-8000-00000000bb03"
)

func bkSeed(t *testing.T, ctx context.Context) int64 {
	t.Helper()
	bkCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		 ('%s','owner@bk.test','Owner'), ('%s','outside@bk.test','Outside')`, bkOwner, bkOutside),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','group')`, bkChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES ('%s','%s','owner')`, bkChat, bkOwner),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	// The message must exist for the "not found vs not a member" distinction to
	// mean anything — a 404 for a message that genuinely doesn't exist would
	// prove nothing about RLS.
	var id int64
	if err := adminQueryRow(ctx,
		fmt.Sprintf(`INSERT INTO messages (chat_id, sender_id, type, content)
		             VALUES ('%s','%s','text','hello') RETURNING id`, bkChat, bkOwner), &id); err != nil {
		t.Fatalf("seed message: %v", err)
	}
	return id
}

func bkCleanup(ctx context.Context) {
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM bookmarks WHERE user_id IN ('%s','%s')`, bkOwner, bkOutside),
		fmt.Sprintf(`DELETE FROM messages WHERE chat_id = '%s'`, bkChat),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id = '%s'`, bkChat),
		fmt.Sprintf(`DELETE FROM chats WHERE id = '%s'`, bkChat),
		fmt.Sprintf(`DELETE FROM users WHERE id IN ('%s','%s')`, bkOwner, bkOutside),
	} {
		_ = adminExec(ctx, q)
	}
}

func TestBookmarkMembershipIsDoubleGated(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	messageID := bkSeed(t, ctx)
	t.Cleanup(func() { bkCleanup(ctx) })

	mux := http.NewServeMux()
	RegisterUser(mux)

	body := fmt.Sprintf(`{"messageId":%d}`, messageID)

	// A member may bookmark a message from their own chat.
	if code, res := call(t, mux, bkOwner, "POST", "/user/bookmarks", body); code != 200 {
		t.Fatalf("a chat member should be able to bookmark: %d %v", code, res)
	}

	// A non-member must be refused. WHICH refusal depends on whether RLS is
	// enforced on this database, and both are acceptable — that is the whole
	// point of the two gates. What must never happen is 200.
	code, res := call(t, mux, bkOutside, "POST", "/user/bookmarks", body)
	switch code {
	case 404:
		t.Logf("RLS enforced: the message is invisible to a non-member (404) — the "+
			"membership check never ran. res=%v", res)
	case 403:
		t.Logf("RLS not enforced here: the read succeeded and the manual membership "+
			"check refused it (403). res=%v", res)
	default:
		t.Fatalf("a non-member must not be able to bookmark someone else's message: got %d %v", code, res)
	}

	// And nothing was written either way.
	// bookmarks has no RLS policy of its own, but read it through the admin
	// connection anyway so this assertion cannot be confused by one later.
	var n int
	if err := adminQueryRow(ctx,
		fmt.Sprintf(`SELECT count(*) FROM bookmarks WHERE user_id = '%s'`, bkOutside), &n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("a refused bookmark must not persist, found %d", n)
	}
}
