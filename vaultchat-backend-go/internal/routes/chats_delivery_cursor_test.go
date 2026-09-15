package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

// Only temporary tables on a dedicated disposable PostgreSQL connection.
func TestDeliveryCursorScratchDB(t *testing.T) {
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
	t.Setenv("JWT_SECRET", "delivery-fixture-only")
	t.Setenv("NODE_INTERNAL_URL", "")
	t.Setenv("INTERNAL_EMIT_KEY", "")
	_, err = pool.Exec(ctx, `
 CREATE TEMP TABLE messages(id bigint PRIMARY KEY, chat_id uuid);
 CREATE TEMP TABLE chat_members(chat_id uuid,user_id uuid,left_at timestamptz,last_delivered_message_id bigint);
 CREATE TEMP TABLE chat_device_delivery(chat_id uuid,user_id uuid,device_id text,last_delivered_message_id bigint,updated_at timestamptz,PRIMARY KEY(chat_id,user_id,device_id));`)
	if err != nil {
		t.Fatal(err)
	}
	const chat = "aaaaaaaa-0000-4000-8000-000000000001"
	const other = "bbbbbbbb-0000-4000-8000-000000000002"
	const user = "cccccccc-0000-4000-8000-000000000003"
	const outsider = "dddddddd-0000-4000-8000-000000000004"
	_, err = pool.Exec(ctx, `INSERT INTO chat_members(chat_id,user_id) VALUES($1,$2)`, chat, user)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO messages VALUES(10,$1),(20,$1),(15,$2),(100,$2)`, chat, other)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /chats/{id}/delivered", httpx.RequireAuth(chatsDelivered))
	post := func(uid string, id int64) int {
		req := httptest.NewRequest("POST", "/chats/"+chat+"/delivered", strings.NewReader(fmt.Sprintf(`{"lastDeliveredMessageId":%d}`, id)))
		req.Header.Set("Authorization", "Bearer "+tokenFor(t, uid))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Device-Id", "scratch-device")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}
	assertPointers := func(want int64, devices int) {
		t.Helper()
		var account, device int64
		var count int
		if err := pool.QueryRow(ctx, `SELECT COALESCE(last_delivered_message_id,0) FROM chat_members WHERE user_id=$1`, user).Scan(&account); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT COUNT(*),COALESCE(MAX(last_delivered_message_id),0) FROM chat_device_delivery`).Scan(&count, &device); err != nil {
			t.Fatal(err)
		}
		if account != want || device != want || count != devices {
			t.Fatalf("account=%d device=%d rows=%d; want cursor=%d rows=%d", account, device, count, want, devices)
		}
	}
	for _, id := range []int64{-1, 0, 15, 100, 9223372036854775807} {
		if code := post(user, id); code != 400 {
			t.Fatalf("invalid cursor %d: HTTP %d", id, code)
		}
		assertPointers(0, 0)
	}
	if code := post(outsider, 10); code != 400 {
		t.Fatalf("outsider: HTTP %d", code)
	}
	assertPointers(0, 0)
	for _, id := range []int64{10, 12, 20, 20, 10} {
		if code := post(user, id); code != 200 {
			t.Fatalf("valid cursor %d: HTTP %d", id, code)
		}
	}
	assertPointers(20, 1)
	if _, err := pool.Exec(ctx, `UPDATE chat_members SET left_at=NOW()`); err != nil {
		t.Fatal(err)
	}
	if code := post(user, 20); code != 400 {
		t.Fatalf("departed member: HTTP %d", code)
	}
	assertPointers(20, 1)
}
