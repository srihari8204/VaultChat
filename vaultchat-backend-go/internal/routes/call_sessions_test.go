// call_sessions_test.go — the call-session API against a REAL Postgres.
//
// Skipped unless CALL_TEST_DB=1, so `go test ./...` stays green on a machine
// with no database. Two connections are needed, for the same reason
// scripts/test-call-rls.sh needs two roles:
//
//	DB_*                 the APP role — what the handlers run as, and the only
//	                     role that proves anything about the policies.
//	CALL_TEST_ADMIN_DSN  an admin/owner role, for fixtures ONLY. `chats` has RLS
//	                     enabled and no INSERT policy, so the app role cannot
//	                     create one at all (docs/RLS_ENFORCEMENT.md) — the very
//	                     first run of this test failed on exactly that.
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=5432 \
//	DB_NAME=vaultchat_test DB_USER=vaultchat_app DB_PASS=... JWT_SECRET=test \
//	CALL_TEST_ADMIN_DSN='postgres://postgres@127.0.0.1:5432/vaultchat_test' \
//	go test ./internal/routes/ -run TestCallSession -v
//
// It WRITES. Never point it at production.
//
// WHY AGAINST A REAL DATABASE
// ---------------------------
// Everything interesting here IS the database: a partial unique index deciding
// who starts versus who joins, an ON CONFLICT that must not reset a promoted
// role, an RLS policy, and a trigger. A mock would assert that the code calls
// the queries I wrote, which is the one thing I already know. Building the 066
// schema turned up two bugs that only a live server would produce — a recursive
// policy and a self-promotion hole — which is the argument for this file.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
)

const (
	tAnn  = "aaaaaaaa-0000-4000-8000-00000000fa01"
	tBob  = "bbbbbbbb-0000-4000-8000-00000000fb01"
	tCarl = "cccccccc-0000-4000-8000-00000000fc01"
	tEve  = "eeeeeeee-0000-4000-8000-00000000fe01"
	tChat = "dddddddd-0000-4000-8000-00000000fd01"
)

func tokenFor(t *testing.T, uid string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": uid, "email": uid + "@test", "exp": time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(os.Getenv("JWT_SECRET")))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// call drives the real mux, so the routing patterns and RequireAuth are under
// test too — not just the handler bodies.
func call(t *testing.T, mux *http.ServeMux, uid, method, path, body string) (int, map[string]any) {
	t.Helper()
	var rdr *strings.Reader
	if body == "" {
		rdr = strings.NewReader("")
	} else {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, uid))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// adminExec runs a fixture statement on the admin connection. Fixtures cannot
// go through db.Pool: that is the app role, and it cannot insert a chat under
// enforced RLS.
func adminExec(ctx context.Context, q string) error {
	dsn := os.Getenv("CALL_TEST_ADMIN_DSN")
	if dsn == "" {
		return fmt.Errorf("CALL_TEST_ADMIN_DSN is required to seed fixtures")
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, q)
	return err
}

func seed(t *testing.T, ctx context.Context) {
	t.Helper()
	cleanupFixtures(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		 ('%s','ann@t.test','Ann'), ('%s','bob@t.test','Bob'),
		 ('%s','carl@t.test','Carl'), ('%s','eve@t.test','Eve')`, tAnn, tBob, tCarl, tEve),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','group')`, tChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		 ('%s','%s','owner'), ('%s','%s','member'), ('%s','%s','member')`,
			tChat, tAnn, tChat, tBob, tChat, tCarl),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
}

func cleanupFixtures(ctx context.Context) {
	for _, q := range []string{
		fmt.Sprintf(`DELETE FROM calls WHERE chat_id = '%s'`, tChat),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id = '%s'`, tChat),
		fmt.Sprintf(`DELETE FROM chats WHERE id = '%s'`, tChat),
		fmt.Sprintf(`DELETE FROM users WHERE id IN ('%s','%s','%s','%s')`, tAnn, tBob, tCarl, tEve),
	} {
		_ = adminExec(ctx, q)
	}
}

func TestCallSessionAPI(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	seed(t, ctx)
	t.Cleanup(func() { cleanupFixtures(ctx) })

	mux := http.NewServeMux()
	RegisterCallSessions(mux)

	body := fmt.Sprintf(`{"chatId":%q,"kind":"video"}`, tChat)

	// ── start / join ──
	code, res := call(t, mux, tAnn, "POST", "/calls", body)
	if code != 200 || res["created"] != true {
		t.Fatalf("Ann should CREATE the call: %d %v", code, res)
	}
	callID, _ := res["call"].(map[string]any)["id"].(string)
	if callID == "" {
		t.Fatal("no call id returned")
	}

	// The same endpoint, and it must JOIN rather than open a rival call —
	// this is the partial unique index doing its job.
	code, res = call(t, mux, tBob, "POST", "/calls", body)
	if code != 200 || res["created"] != false {
		t.Fatalf("Bob should JOIN the live call, not create one: %d %v", code, res)
	}

	// A non-member of the chat has no business on the call.
	if code, _ = call(t, mux, tEve, "POST", "/calls", body); code != 403 {
		t.Fatalf("a non-member must not join: got %d", code)
	}

	// Re-starting is idempotent for someone already on the call.
	if code, res = call(t, mux, tAnn, "POST", "/calls", body); code != 200 || res["created"] != false {
		t.Fatalf("re-join should be a no-op join: %d %v", code, res)
	}

	// ── roles ──
	roleOf := func(uid string) string {
		_, r := call(t, mux, tAnn, "GET", "/calls/"+callID, "")
		for _, p := range r["participants"].([]any) {
			m := p.(map[string]any)
			if m["userId"] == uid {
				return m["role"].(string)
			}
		}
		return ""
	}
	if got := roleOf(tAnn); got != "host" {
		t.Fatalf("the starter hosts: got %q", got)
	}
	if got := roleOf(tBob); got != "speaker" {
		t.Fatalf("a joiner speaks in a meeting: got %q", got)
	}

	// A speaker is not a moderator.
	if code, _ = call(t, mux, tBob, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"audience"}`, tAnn)); code != 403 {
		t.Fatalf("a speaker must not change roles: got %d", code)
	}
	// The host is.
	if code, _ = call(t, mux, tAnn, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"cohost"}`, tBob)); code != 200 {
		t.Fatalf("the host may promote: got %d", code)
	}
	if got := roleOf(tBob); got != "cohost" {
		t.Fatalf("promotion did not stick: got %q", got)
	}
	// One host, so a second may not be minted by promotion.
	if code, _ = call(t, mux, tAnn, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"host"}`, tBob)); code != 400 {
		t.Fatalf("promoting to host must be refused: got %d", code)
	}
	// A cohost moderates the room but not its moderators.
	call(t, mux, tCarl, "POST", "/calls", body)
	if code, _ = call(t, mux, tBob, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"audience"}`, tCarl)); code != 200 {
		t.Fatalf("a cohost may demote a speaker: got %d", code)
	}
	if code, _ = call(t, mux, tBob, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"audience"}`, tAnn)); code != 403 {
		t.Fatalf("a cohost must not demote the host: got %d", code)
	}
	if code, _ = call(t, mux, tAnn, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"speaker"}`, tAnn)); code != 400 {
		t.Fatalf("changing your own role must be refused: got %d", code)
	}
	if code, _ = call(t, mux, tAnn, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"superuser"}`, tBob)); code != 400 {
		t.Fatalf("an unknown role must be refused: got %d", code)
	}

	// A promoted role must SURVIVE a reconnect — the ON CONFLICT on rejoin
	// updates left_at and joined_at and deliberately leaves role alone.
	call(t, mux, tBob, "POST", "/calls/"+callID+"/leave", "")
	call(t, mux, tBob, "POST", "/calls", body)
	if got := roleOf(tBob); got != "cohost" {
		t.Fatalf("rejoining must not reset a promoted role: got %q", got)
	}

	// ── raise hand ──
	handOf := func(uid string) any {
		_, r := call(t, mux, tAnn, "GET", "/calls/"+callID, "")
		for _, p := range r["participants"].([]any) {
			if m := p.(map[string]any); m["userId"] == uid {
				return m["handRaisedAt"]
			}
		}
		return nil
	}
	if code, _ = call(t, mux, tCarl, "POST", "/calls/"+callID+"/hand", `{"raised":true}`); code != 200 {
		t.Fatalf("a participant may raise their own hand: got %d", code)
	}
	if handOf(tCarl) == nil {
		t.Fatal("the raised hand was not recorded")
	}
	// Raising someone else's hand would let anyone put words in their mouth.
	if code, _ = call(t, mux, tBob, "POST", "/calls/"+callID+"/hand",
		fmt.Sprintf(`{"raised":true,"userId":%q}`, tAnn)); code != 403 {
		t.Fatalf("raising another's hand must be refused: got %d", code)
	}
	// Promoting answers the request, so the hand comes down with it — otherwise
	// the host grants the floor and the queue still shows it pending.
	if code, _ = call(t, mux, tAnn, "POST", "/calls/"+callID+"/role",
		fmt.Sprintf(`{"userId":%q,"role":"speaker"}`, tCarl)); code != 200 {
		t.Fatalf("promote: got %d", code)
	}
	if handOf(tCarl) != nil {
		t.Fatal("promoting to speaker must lower the hand")
	}
	// A host may clear a hand without promoting.
	call(t, mux, tCarl, "POST", "/calls/"+callID+"/hand", `{"raised":true}`)
	if code, _ = call(t, mux, tAnn, "POST", "/calls/"+callID+"/hand",
		fmt.Sprintf(`{"raised":false,"userId":%q}`, tCarl)); code != 200 {
		t.Fatalf("a host may lower another hand: got %d", code)
	}
	if handOf(tCarl) != nil {
		t.Fatal("the host's lower did not take effect")
	}

	// ── ending ──
	if code, _ = call(t, mux, tBob, "POST", "/calls/"+callID+"/end", ""); code != 403 {
		t.Fatalf("a cohost must not end the call: got %d", code)
	}
	if code, _ = call(t, mux, tAnn, "POST", "/calls/"+callID+"/end", ""); code != 200 {
		t.Fatalf("the host may end the call: got %d", code)
	}
	// Everyone still marked present is stamped out, so a crashed client cannot
	// leave a participant who never left.
	var live int
	if err := db.Pool.QueryRow(ctx,
		`SELECT count(*) FROM call_participants WHERE call_id = $1 AND left_at IS NULL`,
		callID).Scan(&live); err != nil || live != 0 {
		t.Fatalf("ending should stamp everyone out: live=%d err=%v", live, err)
	}
	// Ending twice is a no-op, not an error — teardown paths retry.
	if code, res = call(t, mux, tAnn, "POST", "/calls/"+callID+"/end", ""); code != 200 || res["alreadyEnded"] != true {
		t.Fatalf("a second end should be a no-op: %d %v", code, res)
	}

	// The chat is free to hold a new call once the previous one closed.
	if code, res = call(t, mux, tAnn, "POST", "/calls", body); code != 200 || res["created"] != true {
		t.Fatalf("a new call should start after the last ended: %d %v", code, res)
	}
	second, _ := res["call"].(map[string]any)["id"].(string)

	// ── history ──
	code, res = call(t, mux, tAnn, "GET", "/calls/history", "")
	if code != 200 {
		t.Fatalf("history: %d", code)
	}
	hist := res["calls"].([]any)
	if len(hist) < 2 {
		t.Fatalf("Ann was on two calls, history has %d", len(hist))
	}
	if hist[0].(map[string]any)["callId"] != second {
		t.Fatalf("history must be newest first, got %v", hist[0])
	}
	// Eve was never on a call, and must not see anyone else's.
	if _, res = call(t, mux, tEve, "GET", "/calls/history", ""); len(res["calls"].([]any)) != 0 {
		t.Fatalf("a non-participant's history must be empty: %v", res["calls"])
	}
	// Nor may she read a call she wasn't part of.
	if code, _ = call(t, mux, tEve, "GET", "/calls/"+callID, ""); code != 404 {
		t.Fatalf("a non-member must not read a call: got %d", code)
	}

	// ── the database's own guard, independent of the API ──
	// Even if a future handler forgot the host check, the 066 trigger refuses a
	// participant setting their own role. This is the second of the two gates.
	call(t, mux, tCarl, "POST", "/calls", body)
	err := db.WithUser(ctx, tCarl, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE call_participants SET role = 'host' WHERE call_id = $1 AND user_id = $2`,
			second, tCarl)
		return e
	})
	if err == nil {
		t.Fatal("the database must refuse a self-promotion even without the API check")
	}
}
