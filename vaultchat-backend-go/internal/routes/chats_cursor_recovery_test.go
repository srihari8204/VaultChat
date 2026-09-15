package routes

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/url"
	"os"
	"testing"
	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

func TestRecoveryContinuationAuthentication(t *testing.T) {
	t.Setenv("JWT_SECRET", "recovery-fixture")
	token := chatsRecoveryContinuation("a", 500, 1200, 5000)
	cursor, head, warm, ok := chatsParseRecoveryContinuation("a", token)
	if !ok || cursor != 500 || head != 1200 || warm != 5000 {
		t.Fatal("valid continuation rejected")
	}
	for _, bad := range []string{token + "x", "r1.999." + chatsSyncContinuation("a", 500), "r1.1201." + token[len("r1.1200."):]} {
		if _, _, _, ok := chatsParseRecoveryContinuation("a", bad); ok {
			t.Fatal("forged continuation accepted")
		}
	}
	if _, _, _, ok := chatsParseRecoveryContinuation("b", token); ok {
		t.Fatal("cross-account token accepted")
	}
	original := map[string]uint64{"stale": 1027, "warm": 20}
	adjusted := chatsRecoveryScopes(original, 59)
	if adjusted["stale"] != 0 || adjusted["warm"] != 20 || original["stale"] != 1027 {
		t.Fatal("scope normalization")
	}
}

// Actual handler and SQL, on temporary tables/sequence in disposable localhost PG.
func TestCursorRecoveryScratchDB(t *testing.T) {
	dsn := os.Getenv("SYNC_TEST_DSN")
	if dsn == "" {
		t.Skip("requires disposable localhost PostgreSQL")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "localhost" && cfg.ConnConfig.Host != "127.0.0.1" {
		t.Fatal("localhost only")
	}
	cfg.MaxConns = 1
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	oldPool, oldSys := db.Pool, db.SysPool
	db.Pool, db.SysPool = pool, pool
	t.Cleanup(func() { db.Pool, db.SysPool = oldPool, oldSys; pool.Close() })
	t.Setenv("JWT_SECRET", "recovery-fixture")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`CREATE TEMP TABLE messages(id bigserial PRIMARY KEY,chat_id uuid,sender_id uuid,type text,content text,meta jsonb,reply_to_id bigint,edited_at timestamptz,deleted_at timestamptz,created_at timestamptz DEFAULT NOW(),expires_at timestamptz,vanish_after_read boolean DEFAULT false);
 CREATE TEMP TABLE chat_members(chat_id uuid,user_id uuid,left_at timestamptz,hidden boolean DEFAULT false,last_delivered_message_id bigint);
 CREATE TEMP TABLE message_bodies(message_id bigint,created_at timestamptz,content text,meta_private jsonb);`)
	const chat = "aaaaaaaa-0000-4000-8000-000000000001"
	const other = "bbbbbbbb-0000-4000-8000-000000000002"
	const uid = "cccccccc-0000-4000-8000-000000000003"
	const stranger = "dddddddd-0000-4000-8000-000000000004"
	exec(`INSERT INTO chat_members(chat_id,user_id,last_delivered_message_id) VALUES($1,$2,57)`, chat, uid)
	exec(`INSERT INTO messages(chat_id,sender_id,type,content) SELECT $1,$2,'text','fixture' FROM generate_series(1,59)`, chat, uid)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /chats/delta", httpx.RequireAuth(chatsDelta))
	get := func(user, path string) map[string]any {
		t.Helper()
		code, r := call(t, mux, user, "GET", path, "")
		if code != 200 {
			t.Fatalf("status%d %v", code, r)
		}
		return r
	}
	ids := func(r map[string]any) []string {
		out := []string{}
		for _, m := range r["messages"].([]any) {
			out = append(out, m.(map[string]any)["id"].(string))
		}
		return out
	}
	if r := get(uid, "/chats/delta?since=1027"); fmt.Sprint(ids(r)) != "[58 59]" {
		t.Fatal("pending lost", r)
	}
	exec(`UPDATE chat_members SET last_delivered_message_id=59 WHERE user_id=$1`, uid)
	exec(`INSERT INTO messages(chat_id,sender_id,type,content) VALUES($1,$2,'text','next')`, chat, uid)
	if r := get(uid, "/chats/delta?since=1027"); fmt.Sprint(ids(r)) != "[60]" {
		t.Fatal("next message lost", r)
	}
	if len(ids(get(stranger, "/chats/delta?since=1027"))) != 0 {
		t.Fatal("membership leaked")
	}
	exec(`UPDATE chat_members SET hidden=true WHERE user_id=$1`, uid)
	if len(ids(get(uid, "/chats/delta?since=1027"))) != 0 {
		t.Fatal("hidden leaked")
	}
	exec(`UPDATE chat_members SET hidden=false,last_delivered_message_id=60 WHERE user_id=$1`, uid)
	if fmt.Sprint(ids(get(uid, "/chats/delta?since=57"))) != "[58 59 60]" {
		t.Fatal("warm changed")
	}
	exec(`INSERT INTO messages(chat_id,sender_id,type,content) SELECT $1,$2,'text','fixture' FROM generate_series(61,1201)`, chat, uid)
	seen := map[string]bool{}
	rCross := get(uid, "/chats/delta?since=1027&limit=500")
	if got := ids(rCross); len(got) != 500 || got[0] != "61" {
		t.Fatal("sequence overtook cursor and lost gap", got)
	}
	token := ""
	for page := 0; page < 4; page++ {
		path := "/chats/delta?since=5000&limit=500"
		if token != "" {
			path += "&syncContinuation=" + url.QueryEscape(token)
		}
		r := get(uid, path)
		for _, id := range ids(r) {
			if seen[id] {
				t.Fatal("page repeated", id)
			}
			seen[id] = true
		}
		token = r["syncContinuation"].(string)
		if !r["more"].(bool) {
			if token != "" {
				t.Fatal("terminal token retained")
			}
			break
		}
		if token == "" {
			t.Fatal("missing continuation")
		}
		if page == 0 {
			code, _ := call(t, mux, stranger, "GET", "/chats/delta?since=5000&syncContinuation="+url.QueryEscape(token), "")
			if code != 400 {
				t.Fatal("cross-user token")
			}
		}
	}
	if len(seen) != 1141 || !seen["61"] || !seen["1201"] {
		t.Fatal("pagination lost rows", len(seen))
	}
	exec(`DELETE FROM messages WHERE id>60`)
	// MAX is now60 but sequence1201: cursor1000 is legitimate with no pending gap.
	exec(`UPDATE chat_members SET last_delivered_message_id=60 WHERE user_id=$1`, uid)
	if len(ids(get(uid, "/chats/delta?since=1000"))) != 0 {
		t.Fatal("hard-delete falsely recovered")
	}
	scope := chatsRecoveryScopes(map[string]uint64{chat: 1027, other: 0}, 59)
	exec(`UPDATE chat_members SET last_delivered_message_id=57 WHERE user_id=$1`, uid)
	filter, args := chatsDeltaScopes(scope, []any{uid, int64(0), 500}, 0, true)
	rows, err := pool.Query(ctx, `SELECT m.id FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$1 AND cm.left_at IS NULL AND cm.hidden=false WHERE m.id>$2`+filter+` ORDER BY m.id LIMIT $3`, args...)
	if err != nil {
		t.Fatal(err)
	}
	var scoped []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		scoped = append(scoped, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(scoped) != "[58 59 60]" {
		t.Fatal("scope recovery", scoped)
	}
	token = chatsRecoveryContinuation(uid, 57, 59, 1027)
	exec(`UPDATE chat_members SET last_delivered_message_id=60 WHERE user_id=$1`, uid)
	r := get(uid, "/chats/delta?since=1027&syncContinuation="+url.QueryEscape(token))
	if len(ids(r)) != 0 || r["syncContinuation"] != "" || r["more"] != false {
		t.Fatal("late acknowledgements kept token", r)
	}
	// Recovering an old gap must retain another device's acknowledged warm rows.
	exec(`TRUNCATE messages RESTART IDENTITY; DELETE FROM chat_members`)
	exec(`INSERT INTO chat_members(chat_id,user_id,last_delivered_message_id) VALUES($1,$3,5),($2,$3,120)`, chat, other, uid)
	exec(`INSERT INTO messages(id,chat_id,sender_id,type,content) VALUES(50,$1,$2,'text','gap'),(130,$1,$2,'text','new')`, chat, uid)
	exec(`INSERT INTO messages(id,chat_id,sender_id,type,content) SELECT n,$1,$2,'text','warm' FROM generate_series(110,120) n`, other, uid)
	exec(`SELECT setval(pg_get_serial_sequence('messages','id'),130)`)
	token = ""
	warmRows := map[string]bool{}
	for page := 0; page < 6; page++ {
		path := "/chats/delta?since=100&limit=3"
		if token != "" {
			path = "/chats/delta?since=9999&limit=3&syncContinuation=" + url.QueryEscape(token)
		}
		pageResult := get(uid, path)
		for _, id := range ids(pageResult) {
			if warmRows[id] {
				t.Fatal("warm row repeated", id)
			}
			warmRows[id] = true
		}
		token = pageResult["syncContinuation"].(string)
		if !pageResult["more"].(bool) {
			break
		}
	}
	if len(warmRows) != 13 || !warmRows["50"] || !warmRows["110"] || !warmRows["120"] || !warmRows["130"] {
		t.Fatal("recovery hid valid warm rows", warmRows)
	}

}
