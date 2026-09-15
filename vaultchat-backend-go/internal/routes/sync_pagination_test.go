package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

func TestMutationCursorPrecision(t *testing.T) {
	at, _ := time.Parse(time.RFC3339Nano, "2026-01-01T00:00:01.123456Z")
	token := chatsMutationCursorOf(chatsPublicMsg{ID: "501", EditedAt: httpx.JST(&at)})
	got, id, ok := chatsMutationCursor(token)
	if !ok || !got.Equal(at) || id != 501 {
		t.Fatalf("lost keyset precision: %q", token)
	}
	for _, bad := range []string{"", "2026-01-01|no", "bad|1", "2026-01-01|-1"} {
		if _, _, ok := chatsMutationCursor(bad); ok {
			t.Fatalf("accepted invalid cursor %q", bad)
		}
	}
}

func TestSyncContinuationAuthentication(t *testing.T) {
	t.Setenv("JWT_SECRET", "sync-fixture-only")
	token := chatsSyncContinuation("user-a", 42)
	if floor, ok := chatsParseSyncContinuation("user-a", token); !ok || floor != 42 {
		t.Fatalf("valid continuation rejected: floor=%d ok=%v", floor, ok)
	}
	if _, ok := chatsParseSyncContinuation("user-b", token); ok {
		t.Fatal("continuation crossed authenticated users")
	}
	forged := token[:len(token)-1] + "A"
	if _, ok := chatsParseSyncContinuation("user-a", forged); ok {
		t.Fatal("forged continuation accepted")
	}
}

// Temporary tables on a single dedicated connection: no real application data
// or migration ledger is read or modified, even on a shared local Postgres.
func TestSyncPaginationScratchDB(t *testing.T) {
	dsn := os.Getenv("SYNC_TEST_DSN")
	if dsn == "" {
		t.Skip("set SYNC_TEST_DSN to a disposable localhost PostgreSQL")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Host != "127.0.0.1" && cfg.ConnConfig.Host != "localhost" {
		t.Fatal("scratch test requires localhost")
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
	t.Setenv("JWT_SECRET", "sync-fixture-only")
	_, err = pool.Exec(ctx, `
 CREATE TEMP TABLE messages(id bigint, chat_id uuid, sender_id uuid, type text, content text, meta jsonb, reply_to_id bigint, edited_at timestamptz, deleted_at timestamptz, created_at timestamptz DEFAULT NOW(), expires_at timestamptz, vanish_after_read boolean DEFAULT false);
 CREATE TEMP TABLE chat_members(chat_id uuid,user_id uuid,left_at timestamptz,hidden boolean DEFAULT false,last_delivered_message_id bigint);
 CREATE TEMP TABLE message_bodies(message_id bigint,created_at timestamptz,content text,meta_private jsonb);
 `)
	if err != nil {
		t.Fatal(err)
	}
	const a = "aaaaaaaa-0000-4000-8000-000000000001"
	const b = "bbbbbbbb-0000-4000-8000-000000000002"
	const uid = "cccccccc-0000-4000-8000-000000000003"
	_, err = pool.Exec(ctx, `INSERT INTO chat_members(chat_id,user_id) VALUES($1,$3),($2,$3);`, a, b, uid)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO messages(id,chat_id,sender_id,type,content,edited_at)
 SELECT n,$1,$2,'text','ciphertext','2026-01-01T00:00:01.123456Z'::timestamptz FROM generate_series(1,501) n`, a, uid)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /chats/delta", httpx.RequireAuth(chatsDelta))
	code, r := call(t, mux, uid, "GET", "/chats/delta?since=20000&mutatedSince=2026-01-01T00:00:00Z", "")
	if code != 200 || len(r["mutations"].([]any)) != 500 {
		t.Fatalf("first mutation page: %d %v", code, r)
	}
	token := r["nextMutationCursor"].(string)
	code, r = call(t, mux, uid, "GET", "/chats/delta?since=20000&mutationCursor="+url.QueryEscape(token), "")
	if code != 200 || len(r["mutations"].([]any)) != 1 {
		t.Fatalf("timestamp tie lost: %d %v", code, r)
	}
	if r["mutations"].([]any)[0].(map[string]any)["id"] != "501" {
		t.Fatal("wrong tie continuation")
	}
	code, _ = call(t, mux, uid, "GET", "/chats/delta?since=20000&mutationCursor=invalid", "")
	if code != 400 {
		t.Fatalf("invalid cursor status: %d", code)
	}

	// A busy unrelated chat would occupy the whole unscoped page. An empty
	// requested chat and a far-ahead cursor must not pin the minimum position.
	_, err = pool.Exec(ctx, `INSERT INTO messages(id,chat_id,sender_id,type,content) VALUES(600,$1,$2,'text','wanted')`, b, uid)
	if err != nil {
		t.Fatal(err)
	}
	scopes := map[string]uint64{a: 501, b: 1}
	filter, args := chatsDeltaScopes(scopes, []any{uid, int64(1), 200}, 0, false)
	query := `SELECT m.id FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$1 WHERE m.id>$2` + filter + ` ORDER BY m.id LIMIT $3`
	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(ids) != "[600]" {
		t.Fatalf("scoped page stalled: %v", ids)
	}
	delete(scopes, a)
	filter, args = chatsDeltaScopes(scopes, []any{uid, int64(1), 200}, 0, false)
	var id int64
	if err := pool.QueryRow(ctx, `SELECT m.id FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$1 WHERE m.id>$2`+filter+` ORDER BY m.id LIMIT $3`, args...).Scan(&id); err != nil || id != 600 {
		t.Fatalf("unrequested chat starves page: id=%d err=%v", id, err)
	}
	// The zero-position chat is cold; the warm chat must still receive id 2
	// even when another device has acknowledged it and the cold floor is 500.
	if _, err := pool.Exec(ctx, `UPDATE chat_members SET last_delivered_message_id=501 WHERE chat_id=$1`, a); err != nil {
		t.Fatal(err)
	}
	filter, args = chatsDeltaScopes(map[string]uint64{a: 1, b: 0}, []any{uid, int64(0), 200}, 500, true)
	if err := pool.QueryRow(ctx, `SELECT m.id FROM messages m JOIN chat_members cm ON cm.chat_id=m.chat_id AND cm.user_id=$1 WHERE m.id>$2`+filter+` ORDER BY m.id LIMIT $3`, args...).Scan(&id); err != nil || id != 2 {
		t.Fatalf("cold scope skipped warm messages: id=%d err=%v", id, err)
	}

	// A delivered row from another chat sits between two pending rows. The
	// continuation must keep the cold filter on page two and skip that row.
	if _, err := pool.Exec(ctx, `UPDATE messages SET chat_id=$1 WHERE id=500`, b); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE chat_members SET last_delivered_message_id=498 WHERE chat_id=$1`, a); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE chat_members SET last_delivered_message_id=600 WHERE chat_id=$1`, b); err != nil {
		t.Fatal(err)
	}
	code, r = call(t, mux, uid, "GET", "/chats/delta?since=0&limit=1", "")
	if code != 200 || r["messages"].([]any)[0].(map[string]any)["id"] != "499" {
		t.Fatalf("cold first page: %d %v", code, r)
	}
	continuation := r["syncContinuation"].(string)
	code, r = call(t, mux, uid, "GET", "/chats/delta?since=499&limit=1&syncContinuation="+url.QueryEscape(continuation), "")
	if code != 200 || r["messages"].([]any)[0].(map[string]any)["id"] != "501" {
		t.Fatalf("cold continuation leaked delivered row: %d %v", code, r)
	}
	code, _ = call(t, mux, uid, "GET", "/chats/delta?since=499&syncContinuation="+url.QueryEscape(continuation+"x"), "")
	if code != 400 {
		t.Fatalf("forged continuation status: %d", code)
	}
}
