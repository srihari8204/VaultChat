// poll_votes_scope_test.go — GET /chats/{id}/messages/{msgId}/votes must be
// scoped to the chat in the path.
//
// messages.id is ONE global BIGSERIAL. chatsRequireMem proves the caller is a
// member of the chat in the path and nothing more, so a votes query keyed only
// on message_id lets any member of any chat read the tally of any poll on the
// server by walking msgId. The bulk sibling (GET /chats/{id}/poll-votes) always
// joined messages and filtered on chat_id; this pins the singular one to the
// same rule.
//
// Same harness as bookmarks_rls_test.go — see call_sessions_test.go for why
// fixtures need an admin connection.
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
	pvVictim   = "aaaaaaaa-0000-4000-8000-00000000cc01" // member of the poll's chat
	pvOutsider = "bbbbbbbb-0000-4000-8000-00000000cc02" // member of some OTHER chat
	pvChat     = "cccccccc-0000-4000-8000-00000000cc03" // holds the poll
	pvOther    = "dddddddd-0000-4000-8000-00000000cc04" // the outsider's own chat
)

func pvCleanup(ctx context.Context) {
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM poll_votes pv USING messages m
		              WHERE m.id = pv.message_id AND m.chat_id IN ('%s','%s')`, pvChat, pvOther),
		fmt.Sprintf(`DELETE FROM messages WHERE chat_id IN ('%s','%s')`, pvChat, pvOther),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id IN ('%s','%s')`, pvChat, pvOther),
		fmt.Sprintf(`DELETE FROM chats WHERE id IN ('%s','%s')`, pvChat, pvOther),
		fmt.Sprintf(`DELETE FROM users WHERE id IN ('%s','%s')`, pvVictim, pvOutsider),
	} {
		_ = adminExec(ctx, q)
	}
}

func pvSeed(t *testing.T, ctx context.Context) int64 {
	t.Helper()
	pvCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		 ('%s','victim@pv.test','Victim'), ('%s','outsider@pv.test','Outsider')`, pvVictim, pvOutsider),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','group'), ('%s','group')`, pvChat, pvOther),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		 ('%s','%s','owner'), ('%s','%s','owner')`, pvChat, pvVictim, pvOther, pvOutsider),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	var msgID int64
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`INSERT INTO messages (chat_id, sender_id, type, content, meta)
		 VALUES ('%s','%s','poll','Lunch?','{"optionCount":2}'::jsonb) RETURNING id`,
		pvChat, pvVictim), &msgID); err != nil {
		t.Fatalf("seed poll: %v", err)
	}
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO poll_votes (message_id, user_id, option_index) VALUES (%d,'%s',1)`,
		msgID, pvVictim)); err != nil {
		t.Fatalf("seed vote: %v", err)
	}
	return msgID
}

func TestPollVotesAreScopedToTheChatInThePath(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	msgID := pvSeed(t, ctx)
	t.Cleanup(func() { pvCleanup(ctx) })

	mux := http.NewServeMux()
	RegisterChats(mux)

	// Control: a member of the poll's own chat still sees the tally. Without
	// this the test would pass just as well on a handler that returns nothing.
	code, res := call(t, mux, pvVictim, "GET",
		fmt.Sprintf("/chats/%s/messages/%d/votes", pvChat, msgID), "")
	if code != 200 {
		t.Fatalf("a member of the poll's chat must see the tally: %d %v", code, res)
	}
	if total, _ := res["total"].(float64); total != 1 {
		t.Fatalf("member should see the one vote, got total=%v (%v)", res["total"], res)
	}

	// The defect: an outsider is a member of pvOther, NOT of pvChat, and asks
	// for the poll's id under the chat they DO belong to. Membership is proven,
	// the message is someone else's. No tally may come back.
	code, res = call(t, mux, pvOutsider, "GET",
		fmt.Sprintf("/chats/%s/messages/%d/votes", pvOther, msgID), "")
	if code == 200 {
		if total, _ := res["total"].(float64); total != 0 {
			t.Fatalf("cross-chat poll tally leaked: total=%v (%v)", res["total"], res)
		}
		if counts, _ := res["counts"].(map[string]any); len(counts) != 0 {
			t.Fatalf("cross-chat poll counts leaked: %v", counts)
		}
		return
	}
	if code != 403 && code != 404 {
		t.Fatalf("unexpected answer for a cross-chat poll read: %d %v", code, res)
	}
}
