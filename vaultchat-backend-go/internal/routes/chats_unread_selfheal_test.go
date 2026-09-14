package routes

import (
	"os"
	"strings"
	"testing"
)

// The unread badge could say "1 unread" on a chat with nothing unread in it,
// and no amount of opening and reading would clear it.
//
// Two halves have to disagree for that to happen, and they did:
//
//   - vc_bump_unread (034_unread_count.sql) is a blind `unread_count + 1`. It
//     runs in a workx-queued goroutine submitted AFTER the message has already
//     gone out on the socket.
//   - POST /chats/{id}/read recomputes unread_count from the messages table,
//     but the UPDATE carried `AND (last_read_message_id IS NULL OR
//     last_read_message_id < $1)`, so the recompute only ever ran on a read
//     that ALSO advanced the cursor.
//
// A recipient with the chat open acks read about 800ms after delivery. If the
// queued bump landed after that recompute, the row ended up with the cursor
// already at the newest id and unread_count = 1. From there the guard could
// never be satisfied again — the client will not re-POST an id it has already
// sent, and the server would have refused it anyway — so the counter was
// permanently wrong until some newer message happened to arrive.
//
// The fix keeps the cursor monotonic with GREATEST (a late or out-of-order
// receipt still cannot rewind it) and drops the guard, so every read recomputes
// and a drifted counter self-heals.
//
// Asserted against source: the real path needs Postgres and a live socket.
// Comments are stripped first — this file describes the bug in prose and a raw
// search would match the description instead of the code.

func chatsHelpersSrc(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("chats_helpers.go")
	if err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	for _, line := range strings.Split(string(b), "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		sb.WriteString(line)
		sb.WriteByte('\n')
	}
	return sb.String()
}

// readUpdateStmt returns just the UPDATE chat_members ... RETURNING statement
// that POST /read runs, so the assertions below cannot accidentally match some
// other statement in this 2800-line file.
func readUpdateStmt(t *testing.T, src string) string {
	t.Helper()
	// Scope to chatsRead FIRST: chats_helpers.go holds a dozen UPDATE
	// chat_members statements and the first one in the file is not this one.
	f := strings.Index(src, "func chatsRead(")
	if f < 0 {
		t.Fatal("chatsRead is gone; update this test deliberately")
	}
	body := src[f:]
	// Stop at the next declaration so a later handler cannot satisfy these
	// assertions on chatsRead’s behalf.
	if j := strings.Index(body[1:], "func chats"); j > 0 {
		body = body[:j+1]
	}
	// Anchor on the START of the SQL literal, whatever keyword opens it: the
	// statement begins with a CTE now, and anchoring on "UPDATE chat_members"
	// would silently slice from the middle and drop the WITH clause.
	i := strings.Index(body, "`WITH prev AS (")
	if i < 0 {
		i = strings.Index(body, "`UPDATE chat_members")
	}
	if i < 0 {
		t.Fatal("the read UPDATE is gone from chatsRead; update this test deliberately")
	}
	rest := body[i:]
	k := strings.Index(rest[1:], "`")
	if k < 0 {
		t.Fatal("unterminated SQL literal")
	}
	return rest[:k+2]
}

func TestReadRecomputeIsNotGatedOnTheCursorAdvancing(t *testing.T) {
	stmt := readUpdateStmt(t, chatsHelpersSrc(t))

	if strings.Contains(stmt, "last_read_message_id < $1") {
		t.Fatal("the cursor guard is back in the read UPDATE's WHERE — unread_count " +
			"is again only recomputed when the cursor advances, so a count that " +
			"drifted high (vc_bump_unread landing after the read) can never come " +
			"back down and the badge stays lit forever")
	}
	if !strings.Contains(stmt, "unread_count = (") {
		t.Fatal("the read no longer recomputes unread_count at all")
	}
}

// Dropping the guard is only safe because GREATEST keeps the cursor monotonic.
// Without it a late receipt carrying an older id would move last_read_message_id
// BACKWARD and re-unread messages the user has already read.
func TestReadCursorCannotBeRewound(t *testing.T) {
	stmt := readUpdateStmt(t, chatsHelpersSrc(t))

	if !strings.Contains(stmt, "last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $1)") {
		t.Fatal("last_read_message_id is no longer assigned through GREATEST — with " +
			"the WHERE guard gone, a POST /read carrying an older id would rewind " +
			"the cursor and mark already-read messages unread again")
	}
	// The count must be taken against the SAME value the cursor is being set to,
	// not against $1 — otherwise a late receipt recomputes the count from an old
	// id and reports messages as unread that the cursor says are read.
	if !strings.Contains(stmt, "m.id > GREATEST(COALESCE(last_read_message_id, 0), $1)") {
		t.Fatal("unread_count is counted from $1 rather than from the value the " +
			"cursor is actually set to; a late receipt would report a count that " +
			"disagrees with last_read_message_id in the same row")
	}
}

// With the guard gone the UPDATE now also matches when the stored cursor is
// already ahead of the reported id. That row must not re-broadcast message_read,
// or every member is told their peer just read something they read long ago.
func TestStaleReadDoesNotRebroadcastAReceipt(t *testing.T) {
	src := chatsHelpersSrc(t)
	if !strings.Contains(src, "advanced := prevRead == nil || *prevRead < id") {
		t.Fatal("the pre-UPDATE cursor is no longer compared — without it the emit " +
			"cannot tell a real advance from a duplicate receipt, because lastRead " +
			"== id is true for both")
	}
	if !strings.Contains(src, "if err == nil && lastRead == id && advanced {") {
		t.Fatal("the message_read emit is no longer gated on the cursor having " +
			"actually advanced; a duplicate or late receipt re-broadcasts and " +
			"re-runs the vanish sweep behind it")
	}
}

// `advanced` is only meaningful if prev_read really is the value from BEFORE the
// UPDATE. A plain subquery against chat_members inside RETURNING would see the
// NEW row and make the gate always false, silently killing every read receipt.
func TestThePreviousCursorComesFromACTE(t *testing.T) {
	stmt := readUpdateStmt(t, chatsHelpersSrc(t))
	if !strings.Contains(stmt, "WITH prev AS (") {
		t.Fatal("the CTE capturing the pre-UPDATE cursor is gone")
	}
	if !strings.Contains(stmt, "(SELECT old_read FROM prev) AS prev_read") {
		t.Fatal("prev_read no longer reads from the CTE; if it reads chat_members " +
			"directly it sees the row this statement just wrote and `advanced` is " +
			"never true, so read receipts stop being emitted entirely")
	}
}


// The cursor is a GLOBAL BIGSERIAL, so an id from another conversation parses
// fine here. It must be rejected against this chat's own history before it can
// reach the UPDATE, because the vanish sweep hard-deletes every
// vanish_after_read message at or below the cursor for every member, and
// GREATEST() then makes the bad cursor permanent.
//
// EXECUTION LIMIT, stated rather than papered over: this is a source assertion.
// The real behaviour needs Postgres, and no reachable instance exists in this
// environment (the migration suite reports Docker Desktop unable to start), so
// the rejection has NOT been executed against a database.
func TestReadCursorIsScopedToTheChat(t *testing.T) {
	src := chatsHelpersSrc(t)
	f := strings.Index(src, "func chatsRead(")
	if f < 0 {
		t.Fatal("chatsRead is gone; update this test deliberately")
	}
	body := src[f:]
	if j := strings.Index(body[1:], "func chats"); j > 0 {
		body = body[:j+1]
	}
	sel := strings.Index(body, "SELECT MAX(id) FROM messages WHERE chat_id = $1")
	if sel < 0 {
		t.Fatal("the per-chat cursor bound is gone: a lastReadMessageId belonging to " +
			"a DIFFERENT chat is accepted again, and the vanish sweep will delete " +
			"this chat's vanish_after_read history up to that foreign id")
	}
	if !strings.Contains(body, "id < 0 || chatMaxID == nil || id > *chatMaxID") {
		t.Fatal("the bound check changed shape; it must reject negative (Exit-Kit " +
			"import) ids, a chat with no messages at all, and any id beyond this " +
			"chat's newest")
	}
	// Rejection, not clamping - clamping converts a client bug into a
	// destructive read against whatever value it clamped to.
	if !strings.Contains(body, `httpx.Err(w, 400, "lastReadMessageId is not a message in this chat")`) {
		t.Fatal("the out-of-scope cursor no longer 400s; if it is being clamped " +
			"instead, that is a destructive read, not a validation")
	}
	upd := strings.Index(body, "`WITH prev AS (")
	if upd < 0 || sel > upd {
		t.Fatal("the scope check no longer runs BEFORE the UPDATE - by the time it " +
			"is consulted the cursor has already been written")
	}
}
