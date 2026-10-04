// chats_ops_test.go — the notes/tasks op index (chats_ops.go, migration 145).
//
// TestChatOpKindFromBody needs no database. TestChatOpsIndex WRITES: point
// DB_* at a scratch database with migrations 001-145 applied.
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=... DB_NAME=vaultchat \
//	DB_USER=vaultchat_app DB_PASS=... JWT_SECRET=test \
//	CALL_TEST_ADMIN_DSN='postgres://postgres@127.0.0.1:.../vaultchat' \
//	go test ./internal/routes/ -run 'TestChatOp' -v
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/redisx"
)

func TestChatOpKindFromBody(t *testing.T) {
	group := &chatsMem{ChatType: "group"}
	direct := &chatsMem{ChatType: "direct"}
	cases := []struct {
		name     string
		body     map[string]any
		mem      *chatsMem
		typ      string
		kind     string
		wantCode string
	}{
		{"absent", map[string]any{"content": "x"}, group, "text", "", ""},
		{"null", map[string]any{"opKind": nil}, group, "text", "", ""},
		{"notes", map[string]any{"opKind": "notes"}, group, "text", "notes", ""},
		{"tasks", map[string]any{"opKind": "tasks"}, group, "text", "tasks", ""},
		{"unknown kind", map[string]any{"opKind": "calendar"}, group, "text", "", "invalid_op_kind"},
		{"empty", map[string]any{"opKind": ""}, group, "text", "", "invalid_op_kind"},
		{"not a string", map[string]any{"opKind": true}, group, "text", "", "invalid_op_kind"},
		{"direct chat", map[string]any{"opKind": "notes"}, direct, "text", "", "op_kind_not_allowed"},
		{"not text", map[string]any{"opKind": "tasks"}, group, "image", "", "op_kind_not_allowed"},
	}
	for _, c := range cases {
		kind, msg, code := chatsOpKindFromBody(c.body, c.mem, c.typ)
		if kind != c.kind || code != c.wantCode || (code == "") != (msg == "") {
			t.Errorf("%s: got (%q, %q, %q), want kind %q code %q", c.name, kind, msg, code, c.kind, c.wantCode)
		}
	}
}

const (
	opChat   = "5e700000-0000-4000-8000-00000000c001"
	opDirect = "5e700000-0000-4000-8000-00000000c002"
	opOwner  = "5e700000-0000-4000-8000-00000000a001"
	opMember = "5e700000-0000-4000-8000-00000000a002"
	opGone   = "5e700000-0000-4000-8000-00000000a003"
	opStrng  = "5e700000-0000-4000-8000-00000000a004" // never a member
	opMarker = "5e700000-0000-4000-8000-%"
)

func opCleanup() {
	ctx := context.Background()
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM messages WHERE chat_id::text LIKE '%s'`, opMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM chats WHERE id::text LIKE '%s'`, opMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, opMarker))
}

// opCall drives the real mux and returns the raw body (the ops read is an array).
func opCall(t *testing.T, mux *http.ServeMux, uid, method, path, body string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, uid))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

func opList(t *testing.T, mux *http.ServeMux, uid, path string) []map[string]any {
	t.Helper()
	code, raw := opCall(t, mux, uid, "GET", path, "")
	if code != 200 {
		t.Fatalf("list: %d %s", code, raw)
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("list body: %v %s", err, raw)
	}
	return out
}

func opIDs(rows []map[string]any) []string {
	ids := []string{}
	for _, r := range rows {
		ids = append(ids, fmt.Sprint(r["id"]))
	}
	return ids
}

func TestChatOpsIndex(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	opCleanup()
	t.Cleanup(opCleanup)
	for _, u := range []string{opOwner, opMember} {
		redisx.Reset(ctx, "msg:send:"+u)
		redisx.Reset(ctx, "msg:send:h:"+u)
		redisx.Reset(ctx, "chat:ops:"+u)
	}
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','op1@t.test','O'),
		  ('%s','op2@t.test','M'), ('%s','op3@t.test','G'), ('%s','op4@t.test','S')`,
			opOwner, opMember, opGone, opStrng),
		fmt.Sprintf(`INSERT INTO chats (id, type, name, created_by) VALUES ('%s','group','Trip','%s')`, opChat, opOwner),
		fmt.Sprintf(`INSERT INTO chats (id, type, created_by) VALUES ('%s','direct','%s')`, opDirect, opOwner),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		  ('%[1]s','%[2]s','admin'), ('%[1]s','%[3]s','member'), ('%[1]s','%[4]s','member'),
		  ('%[5]s','%[2]s','member'), ('%[5]s','%[3]s','member')`,
			opChat, opOwner, opMember, opGone, opDirect),
		fmt.Sprintf(`UPDATE chat_members SET left_at = NOW() WHERE user_id = '%s'`, opGone),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
	mux := http.NewServeMux()
	RegisterChats(mux)

	send := func(uid, chat, body string) (int, map[string]any) {
		code, raw := opCall(t, mux, uid, "POST", "/chats/"+chat+"/messages", body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return code, out
	}
	sent := map[string]string{} // label -> id
	for _, s := range []struct{ label, uid, body string }{
		{"n1", opOwner, `{"content":"GSK1:n1","type":"text","opKind":"notes"}`},
		{"chat", opMember, `{"content":"GSK1:hello","type":"text"}`},
		{"t1", opMember, `{"content":"GSK1:t1","type":"text","opKind":"tasks"}`},
		{"n2", opMember, `{"content":"GSK1:n2","type":"text","opKind":"notes"}`},
		{"n3", opOwner, `{"content":"GSK1:n3","type":"text","opKind":"notes","clientId":"op-dup-1"}`},
	} {
		code, out := send(s.uid, opChat, s.body)
		if code != 200 && code != 201 {
			t.Fatalf("send %s: %d %v", s.label, code, out)
		}
		sent[s.label] = fmt.Sprint(out["id"])
	}
	// A retried tagged send (same clientId) is the same row, not a second op.
	if code, out := send(opOwner, opChat, `{"content":"GSK1:n3","type":"text","opKind":"notes","clientId":"op-dup-1"}`); code >= 300 || fmt.Sprint(out["id"]) != sent["n3"] {
		t.Fatalf("dup send: %d %v, want id %s", code, out, sent["n3"])
	}

	// Refusals: unknown kind, a direct chat, a non-text type. None writes a row.
	var before int
	_ = adminQueryRow(ctx, fmt.Sprintf(`SELECT COUNT(*) FROM messages WHERE chat_id::text LIKE '%s'`, opMarker), &before)
	for _, c := range []struct{ chat, body, code string }{
		{opChat, `{"content":"x","type":"text","opKind":"calendar"}`, "invalid_op_kind"},
		{opChat, `{"content":"x","type":"text","opKind":""}`, "invalid_op_kind"},
		{opDirect, `{"content":"x","type":"text","opKind":"notes"}`, "op_kind_not_allowed"},
		{opChat, `{"content":"x","type":"image","opKind":"notes","meta":{"attachmentId":"x"}}`, "op_kind_not_allowed"},
	} {
		if code, out := send(opOwner, c.chat, c.body); code != 400 || out["code"] != c.code {
			t.Errorf("%s: %d %v, want 400 %s", c.body, code, out, c.code)
		}
	}
	var after int
	_ = adminQueryRow(ctx, fmt.Sprintf(`SELECT COUNT(*) FROM messages WHERE chat_id::text LIKE '%s'`, opMarker), &after)
	if after != before {
		t.Errorf("refused sends wrote %d rows", after-before)
	}
	// What was stored: the tag only on tagged sends, never on the chat line.
	var tags string
	_ = adminQueryRow(ctx, fmt.Sprintf(`SELECT string_agg(COALESCE(op_kind,'-'), ',' ORDER BY id) FROM messages WHERE chat_id = '%s'`, opChat), &tags)
	if tags != "notes,-,tasks,notes,notes" {
		t.Errorf("stored tags = %q", tags)
	}

	// The read: only notes, newest first, for a current member.
	notes := opList(t, mux, opMember, "/chats/"+opChat+"/ops?kind=notes&limit=200")
	if got, want := opIDs(notes), []string{sent["n3"], sent["n2"], sent["n1"]}; !reflect.DeepEqual(got, want) {
		t.Errorf("notes = %v, want %v", got, want)
	}
	tasks := opList(t, mux, opOwner, "/chats/"+opChat+"/ops?kind=tasks")
	if got := opIDs(tasks); !reflect.DeepEqual(got, []string{sent["t1"]}) {
		t.Errorf("tasks = %v", got)
	}

	// Same element shape and values as the message list.
	all := opList(t, mux, opMember, "/chats/"+opChat+"/messages?limit=200")
	var listRow map[string]any
	for _, m := range all {
		if fmt.Sprint(m["id"]) == sent["n2"] {
			listRow = m
		}
	}
	if !reflect.DeepEqual(listRow, notes[1]) {
		t.Errorf("ops row %v differs from the message list's %v", notes[1], listRow)
	}
	keys := []string{}
	for k := range notes[0] {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if fmt.Sprint(keys) != "[chatId content createdAt deletedAt editedAt expiresAt id meta replyToId senderId type vanishAfterRead]" {
		t.Errorf("keys = %v", keys)
	}

	// Paging with before= and limit=.
	page1 := opList(t, mux, opMember, "/chats/"+opChat+"/ops?kind=notes&limit=2")
	if got := opIDs(page1); !reflect.DeepEqual(got, []string{sent["n3"], sent["n2"]}) {
		t.Errorf("page1 = %v", got)
	}
	page2 := opList(t, mux, opMember, "/chats/"+opChat+"/ops?kind=notes&limit=2&before="+sent["n2"])
	if got := opIDs(page2); !reflect.DeepEqual(got, []string{sent["n1"]}) {
		t.Errorf("page2 = %v", got)
	}

	// Expired rows are left out; deleted rows come back with deletedAt.
	_ = adminExec(ctx, fmt.Sprintf(`UPDATE messages SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = %s`, sent["n1"]))
	_ = adminExec(ctx, fmt.Sprintf(`UPDATE messages SET deleted_at = NOW(), content = NULL WHERE id = %s`, sent["n2"]))
	notes = opList(t, mux, opMember, "/chats/"+opChat+"/ops?kind=notes")
	if got := opIDs(notes); !reflect.DeepEqual(got, []string{sent["n3"], sent["n2"]}) || notes[1]["deletedAt"] == nil {
		t.Errorf("after expiry/delete: %v %v", got, notes)
	}

	// Refusals on the read.
	if code, raw := opCall(t, mux, opMember, "GET", "/chats/"+opChat+"/ops?kind=calendar", ""); code != 400 || !strings.Contains(string(raw), "invalid_op_kind") {
		t.Errorf("bad kind: %d %s", code, raw)
	}
	if code, raw := opCall(t, mux, opMember, "GET", "/chats/"+opChat+"/ops", ""); code != 400 {
		t.Errorf("no kind: %d %s", code, raw)
	}
	for _, uid := range []string{opGone, opStrng} {
		if code, raw := opCall(t, mux, uid, "GET", "/chats/"+opChat+"/ops?kind=notes", ""); code != 403 {
			t.Errorf("%s: %d %s, want 403", uid, code, raw)
		}
	}

	// Rate limit: the 121st read in the window is refused with retryAfter.
	orig := chatsOpsConsume
	t.Cleanup(func() { chatsOpsConsume = orig })
	chatsOpsConsume = func(_ context.Context, key string, limit, win int64) redisx.RateResult {
		if key != "chat:ops:"+opMember || limit != chatOpsReadLimit || win != chatOpsReadWindow {
			t.Errorf("limiter called with %q %d %d", key, limit, win)
		}
		return redisx.RateResult{Allowed: false, ResetInSec: 42}
	}
	code, raw := opCall(t, mux, opMember, "GET", "/chats/"+opChat+"/ops?kind=notes", "")
	if code != 429 || !strings.Contains(string(raw), `"retryAfter":42`) {
		t.Errorf("rate limited: %d %s", code, raw)
	}
}
