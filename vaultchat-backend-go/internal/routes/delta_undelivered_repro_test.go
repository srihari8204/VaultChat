// delta_undelivered_repro_test.go — PHASE 1A reproduction, not a prescription.
//
// THE OBSERVED PRODUCTION STATE, reproduced synthetically rather than probed
// live. For one member of one chat:
//
//	last_delivered_message_id = 6
//	last_read_message_id      = 6
//	MAX(messages.id) in chat  = 8
//	messages 7 and 8: retained, not deleted, no expiry, ciphertext intact
//
// The device never acknowledged 7 or 8, they are still eligible, and repeated
// cold starts on the current build did not recover them. The question this file
// answers is narrow and deliberately so: GIVEN that state, does the canonical
// delta handler RETURN those messages? That separates "the server declines to
// send them" from "the client fails to ask, store or display them", and nothing
// else in the trace can be reasoned about until it is settled.
//
// It asserts nothing about WHY the client is at 6. It does not write to
// production. Fixtures carry the 0d17 marker and are removed on cleanup.
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=15499 DB_NAME=vaultchat \
//	DB_USER=vaultchat DB_PASS=testpw CALL_TEST_ADMIN_DSN=... \
//	JWT_SECRET=... VAULTCHAT_MASTER_KEY=... VAULTCHAT_LOOKUP_PEPPER=... \
//	go test ./internal/routes/ -run TestDeltaUndelivered -v
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
	dvChat   = "0d170000-0000-4000-8000-000000000001"
	dvReader = "0d170000-0000-4000-8000-0000000000a1" // the device that is stuck at 6
	dvPeer   = "0d170000-0000-4000-8000-0000000000a2"
)

func dvCleanup(ctx context.Context) {
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM messages WHERE chat_id = '%s'`, dvChat),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id = '%s'`, dvChat),
		fmt.Sprintf(`DELETE FROM chats WHERE id = '%s'`, dvChat),
		fmt.Sprintf(`DELETE FROM users WHERE id IN ('%s','%s')`, dvReader, dvPeer),
	} {
		_ = adminExec(ctx, q)
	}
}

// dvSeed builds the production shape: 8 messages, the reader's delivered AND
// read pointers both parked at the 6th, the last two from the peer.
func dvSeed(t *testing.T, ctx context.Context) (sixth, seventh, eighth int64) {
	t.Helper()
	dvCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		   ('%s','dv-reader@test.local','DV Reader'), ('%s','dv-peer@test.local','DV Peer')`, dvReader, dvPeer),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','direct')`, dvChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		   ('%s','%s','member'), ('%s','%s','member')`, dvChat, dvReader, dvChat, dvPeer),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	// Six the reader has, then two it has not. All from the peer, so they count
	// as unread for the reader exactly as the production rows do.
	for i := 1; i <= 8; i++ {
		if err := adminExec(ctx, fmt.Sprintf(
			`INSERT INTO messages (chat_id, sender_id, type, content) VALUES ('%s','%s','text','ct-%d')`,
			dvChat, dvPeer, i)); err != nil {
			t.Fatalf("seed message %d: %v", i, err)
		}
	}
	var ids []int64
	if err := adminQueryRow(ctx, fmt.Sprintf(
		`SELECT min(id) FROM messages WHERE chat_id='%s'`, dvChat), &sixth); err != nil {
		t.Fatalf("read ids: %v", err)
	}
	_ = ids
	seventh, eighth = sixth+6, sixth+7
	sixth = sixth + 5 // the 6th inserted row
	if err := adminExec(ctx, fmt.Sprintf(
		`UPDATE chat_members SET last_delivered_message_id = %d, last_read_message_id = %d,
		   unread_count = (SELECT count(*) FROM messages m WHERE m.chat_id='%s' AND m.id > %d
		                     AND m.sender_id <> '%s' AND m.deleted_at IS NULL AND m.type <> 'reaction')
		  WHERE chat_id='%s' AND user_id='%s'`,
		sixth, sixth, dvChat, sixth, dvReader, dvChat, dvReader)); err != nil {
		t.Fatalf("park the cursors: %v", err)
	}
	return sixth, seventh, eighth
}

func dvIDs(t *testing.T, res map[string]any) []int64 {
	t.Helper()
	var out []int64
	msgs, _ := res["messages"].([]any)
	for _, m := range msgs {
		mm, _ := m.(map[string]any)
		if mm == nil {
			continue
		}
		switch v := mm["id"].(type) {
		case float64:
			out = append(out, int64(v))
		case string:
			var n int64
			fmt.Sscanf(v, "%d", &n)
			out = append(out, n)
		}
	}
	return out
}

func dvHas(ids []int64, want int64) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// THE REPRODUCTION. An established device asks for everything it does not have.
func TestDeltaUndeliveredReachesAnEstablishedDevice(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* (port 15499, NOT 15432) to run the delta reproduction")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	sixth, seventh, eighth := dvSeed(t, ctx)
	t.Cleanup(func() { dvCleanup(ctx) })

	mux := http.NewServeMux()
	RegisterChats(mux)

	// (a) The catch-up the client actually performs: syncEngine rewinds by
	// LOOKBACK, and with a small account that lands on since=0.
	code, res := call(t, mux, dvReader, "GET", "/chats/delta?since=0&limit=200", "")
	if code != 200 {
		t.Fatalf("delta since=0: %d %v", code, res)
	}
	ids := dvIDs(t, res)
	if !dvHas(ids, seventh) || !dvHas(ids, eighth) {
		t.Fatalf("SERVER-SIDE CAUSE CONFIRMED: a cold catch-up (since=0) did NOT return "+
			"the undelivered messages %d and %d. Returned ids: %v. The device is at "+
			"delivered=%d, both rows are retained and eligible, so the client cannot "+
			"recover them however often it reconnects.", seventh, eighth, ids, sixth)
	}
	t.Logf("since=0 returned %v — the undelivered rows ARE offered to a cold catch-up", ids)

	// (b) The incremental catch-up: an established cursor just below the gap.
	code, res = call(t, mux, dvReader, "GET",
		fmt.Sprintf("/chats/delta?since=%d&limit=200", sixth), "")
	if code != 200 {
		t.Fatalf("delta since=%d: %d %v", sixth, code, res)
	}
	ids = dvIDs(t, res)
	if !dvHas(ids, seventh) || !dvHas(ids, eighth) {
		t.Fatalf("SERVER-SIDE CAUSE CONFIRMED: an incremental catch-up from the device's "+
			"own cursor (since=%d) did NOT return %d and %d. Returned: %v.",
			sixth, seventh, eighth, ids)
	}
	t.Logf("since=%d returned %v — the incremental path offers them too", sixth, ids)
}
