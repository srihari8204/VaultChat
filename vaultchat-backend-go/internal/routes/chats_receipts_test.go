// chats_receipts_test.go — Message Info times (migration 142) and the caller's
// notifSound on GET /chats/{id}.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run 'TestChatReceipts|TestChatGetNotifSound' -v
//
// Fixture ids carry the 4e01 marker.
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
	rcA      = "4e010000-0000-4000-8000-0000000000a1" // sender
	rcB      = "4e010000-0000-4000-8000-0000000000a2"
	rcC      = "4e010000-0000-4000-8000-0000000000a3"
	rcD      = "4e010000-0000-4000-8000-0000000000a4" // direct peer, read receipts off
	rcOut    = "4e010000-0000-4000-8000-0000000000a5"
	rcGroup  = "4e010000-0000-4000-8000-00000000c001"
	rcDirect = "4e010000-0000-4000-8000-00000000c002"
	rcMarker = "4e010000-0000-4000-8000-%"
)

func rcCleanup() {
	ctx := context.Background()
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM chats WHERE id::text LIKE '%s'`, rcMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, rcMarker))
}

func rcSeed(t *testing.T) *http.ServeMux {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	rcCleanup()
	t.Cleanup(rcCleanup)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','rca@t.test','A'), ('%s','rcb@t.test','B'),
		  ('%s','rcc@t.test','C'), ('%s','rcd@t.test','D'), ('%s','rco@t.test','Out')`, rcA, rcB, rcC, rcD, rcOut),
		fmt.Sprintf(`UPDATE users SET read_receipts = FALSE WHERE id = '%s'`, rcD),
		fmt.Sprintf(`INSERT INTO chats (id, type, name) VALUES ('%s','group','RC'), ('%s','direct',NULL)`, rcGroup, rcDirect),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		  ('%[1]s','%[3]s','admin'), ('%[1]s','%[4]s','member'), ('%[1]s','%[5]s','member'),
		  ('%[2]s','%[3]s','member'), ('%[2]s','%[6]s','member')`, rcGroup, rcDirect, rcA, rcB, rcC, rcD),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	mux := http.NewServeMux()
	RegisterChats(mux)
	return mux
}

func rcMsg(t *testing.T, chat, sender string) int64 {
	t.Helper()
	var id int64
	if err := adminQueryRow(context.Background(), fmt.Sprintf(
		`INSERT INTO messages (chat_id, sender_id, type, content) VALUES ('%s','%s','text','x') RETURNING id`,
		chat, sender), &id); err != nil {
		t.Fatalf("msg: %v", err)
	}
	return id
}

func rcMember(out map[string]any, uid string) map[string]any {
	for _, m := range out["members"].([]any) {
		if mm := m.(map[string]any); mm["userId"] == uid {
			return mm
		}
	}
	return nil
}

func TestChatReceipts(t *testing.T) {
	mux := rcSeed(t)
	m1 := rcMsg(t, rcGroup, rcA)
	m2 := rcMsg(t, rcGroup, rcA)
	base := fmt.Sprintf("/chats/%s/messages/%d/receipts", rcGroup, m1)

	// Before anything: state false, times null, sender excluded.
	code, out := call(t, mux, rcA, "GET", base, "")
	if code != 200 || len(out["members"].([]any)) != 2 || rcMember(out, rcA) != nil {
		t.Fatalf("initial: %d %v", code, out)
	}
	if b := rcMember(out, rcB); b["delivered"] != false || b["deliveredAt"] != nil || b["readAt"] != nil {
		t.Fatalf("B initial = %v", b)
	}

	// B acks delivery of m1, then reads up to m2 (covers m1). C acks only m1.
	for _, s := range []struct{ uid, path, body string }{
		{rcB, "delivered", fmt.Sprintf(`{"lastDeliveredMessageId":"%d"}`, m1)},
		{rcB, "read", fmt.Sprintf(`{"lastReadMessageId":"%d"}`, m2)},
		{rcC, "delivered", fmt.Sprintf(`{"lastDeliveredMessageId":"%d"}`, m1)},
	} {
		if c, o := call(t, mux, s.uid, "POST", "/chats/"+rcGroup+"/"+s.path, s.body); c != 200 {
			t.Fatalf("%s %s: %d %v", s.uid, s.path, c, o)
		}
	}
	code, out = call(t, mux, rcA, "GET", base, "")
	if code != 200 || out["readReceiptsHidden"] != false {
		t.Fatalf("after: %d %v", code, out)
	}
	b, c := rcMember(out, rcB), rcMember(out, rcC)
	if b["delivered"] != true || b["read"] != true || b["deliveredAt"] == nil || b["readAt"] == nil {
		t.Fatalf("B after = %v", b)
	}
	if c["delivered"] != true || c["read"] != false || c["deliveredAt"] == nil || c["readAt"] != nil {
		t.Fatalf("C after = %v", c)
	}
	// m2 for C: never delivered (C's pointer is at m1).
	_, out2 := call(t, mux, rcA, "GET", fmt.Sprintf("/chats/%s/messages/%d/receipts", rcGroup, m2), "")
	if c2 := rcMember(out2, rcC); c2["delivered"] != false || c2["deliveredAt"] != nil {
		t.Fatalf("C m2 = %v", c2)
	}

	// Only the sender: another member, an outsider and a bad id all get 404/400.
	if code, _ := call(t, mux, rcB, "GET", base, ""); code != 404 {
		t.Fatalf("non-sender member: %d, want 404", code)
	}
	if code, _ := call(t, mux, rcOut, "GET", base, ""); code != 404 {
		t.Fatalf("outsider: %d, want 404", code)
	}
	if code, _ := call(t, mux, rcA, "GET", fmt.Sprintf("/chats/%s/messages/%d/receipts", rcDirect, m1), ""); code != 404 {
		t.Fatalf("other chat's message id: %d, want 404", code)
	}
	if code, _ := call(t, mux, rcA, "GET", "/chats/"+rcGroup+"/messages/abc/receipts", ""); code != 400 {
		t.Fatalf("bad id: %d, want 400", code)
	}

	// Direct chat where the peer has read receipts off: read withheld, and the
	// delivered time is not the read time in disguise.
	dm := rcMsg(t, rcDirect, rcA)
	if c, o := call(t, mux, rcD, "POST", "/chats/"+rcDirect+"/read", fmt.Sprintf(`{"lastReadMessageId":"%d"}`, dm)); c != 200 {
		t.Fatalf("D read: %d %v", c, o)
	}
	_, out = call(t, mux, rcA, "GET", fmt.Sprintf("/chats/%s/messages/%d/receipts", rcDirect, dm), "")
	d := rcMember(out, rcD)
	if out["readReceiptsHidden"] != true || d["read"] != false || d["readAt"] != nil || d["deliveredAt"] != nil {
		t.Fatalf("direct hidden = %v", out)
	}
}

func TestChatGetNotifSound(t *testing.T) {
	mux := rcSeed(t)
	if _, out := call(t, mux, rcA, "GET", "/chats/"+rcGroup, ""); out["notifSound"] != "default" {
		t.Fatalf("default: %v", out["notifSound"])
	}
	if c, o := call(t, mux, rcA, "PATCH", "/chats/"+rcGroup+"/notif-sound", `{"sound":"bell"}`); c != 200 {
		t.Fatalf("patch: %d %v", c, o)
	}
	if _, out := call(t, mux, rcA, "GET", "/chats/"+rcGroup, ""); out["notifSound"] != "bell" {
		t.Fatalf("after patch: %v", out["notifSound"])
	}
	// Per caller: B's view is unaffected.
	if _, out := call(t, mux, rcB, "GET", "/chats/"+rcGroup, ""); out["notifSound"] != "default" {
		t.Fatalf("B: %v", out["notifSound"])
	}
}
