package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"vaultchat/backend-go/internal/db"
)

const (
	icUserA = "aaaaaaaa-0000-4000-8000-00000000000a"
	icUserB = "bbbbbbbb-0000-4000-8000-00000000000b"
	icGone  = "cccccccc-0000-4000-8000-00000000000c"
	icNone  = "dddddddd-0000-4000-8000-00000000000d"
)

func icPost(t *testing.T, mux *http.ServeMux, path, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if key != "" {
		r.Header.Set("X-Internal-Key", key)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestInternalCoreGuardAndInput(t *testing.T) {
	t.Setenv("INTERNAL_EMIT_KEY", "")
	t.Setenv("INTERNAL_SERVICE_KEYS", "golive=live-key")
	var emitted []string
	mux := http.NewServeMux()
	RegisterCoreInternal(mux, func(uids []string, event string, _ any) {
		emitted = append(emitted, event+":"+strings.Join(uids, ","))
	})

	ok := `{"userIds":["` + icUserA + `"],"event":"e"}`
	for _, path := range []string{"/internal/notify", "/internal/users/cards"} {
		for _, key := range []string{"", "wrong"} {
			if w := icPost(t, mux, path, key, ok); w.Code != http.StatusForbidden {
				t.Errorf("%s with key %q = %d, want 403", path, key, w.Code)
			}
		}
	}

	many := make([]string, internalNotifyMaxUsers+1)
	for i := range many {
		many[i] = icUserA
	}
	manyJSON, _ := json.Marshal(map[string]any{"userIds": many, "event": "e"})
	for name, body := range map[string]string{
		"no ids":     `{"userIds":[],"event":"e"}`,
		"not a uuid": `{"userIds":["1 OR 1=1"],"event":"e"}`,
		"too many":   string(manyJSON),
		"no event":   `{"userIds":["` + icUserA + `"]}`,
		"not json":   `{`,
	} {
		if w := icPost(t, mux, "/internal/notify", "live-key", body); w.Code != http.StatusBadRequest {
			t.Errorf("notify %s = %d, want 400", name, w.Code)
		}
	}
	if w := icPost(t, mux, "/internal/users/cards", "live-key", string(manyJSON)); w.Code != http.StatusBadRequest {
		t.Errorf("cards over the cap = %d, want 400", w.Code)
	}
	if len(emitted) != 0 {
		t.Fatalf("refused requests must not emit, got %v", emitted)
	}

	// socket=true: the caller had no hub, so core emits. No push, so no DB.
	body := `{"userIds":["` + icUserA + `","` + icUserB + `"],"event":"golive:start","socket":true}`
	if w := icPost(t, mux, "/internal/notify", "live-key", body); w.Code != http.StatusOK {
		t.Fatalf("notify = %d: %s", w.Code, w.Body)
	}
	if want := "golive:start:" + icUserA + "," + icUserB; len(emitted) != 1 || emitted[0] != want {
		t.Fatalf("emitted %v, want [%s]", emitted, want)
	}
	// socket=false: the caller already emitted; core must not do it twice.
	body = `{"userIds":["` + icUserA + `"],"event":"x","socket":false}`
	if w := icPost(t, mux, "/internal/notify", "live-key", body); w.Code != http.StatusOK || len(emitted) != 1 {
		t.Fatalf("socket=false must not emit (code %d, emitted %v)", w.Code, emitted)
	}
}

// Needs a disposable localhost Postgres, like the other scratch route tests.
func TestInternalUserCards(t *testing.T) {
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
	cfg.MaxConns = 1 // one connection, so the TEMP table is visible to the handler
	ctx := context.Background()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	oldPool, oldSys := db.Pool, db.SysPool
	db.Pool, db.SysPool = pool, pool
	t.Cleanup(func() { db.Pool, db.SysPool = oldPool, oldSys; pool.Close() })
	t.Setenv("INTERNAL_EMIT_KEY", "k")

	// Legacy plaintext names only: the cipher columns are NULL, so no master
	// key is needed and IdentityFromRow falls back to users.name.
	if _, err := pool.Exec(ctx, `
 CREATE TEMP TABLE users(id uuid PRIMARY KEY, vault_id text, first_name_cipher text,
   last_name_cipher text, name text, is_deleted boolean NOT NULL DEFAULT false);
 INSERT INTO users(id, vault_id, name, is_deleted) VALUES
   ('`+icUserA+`', 'vA', 'Asha', false),
   ('`+icUserB+`', 'vB', NULL, false),
   ('`+icGone+`',  'vC', 'Gone', true);`); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	RegisterCoreInternal(mux, nil)
	w := icPost(t, mux, "/internal/users/cards", "k",
		`{"userIds":["`+icUserA+`","`+icUserB+`","`+icGone+`","`+icNone+`"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("cards = %d: %s", w.Code, w.Body)
	}
	var got struct {
		Cards []struct {
			ID      string  `json:"id"`
			VaultID *string `json:"vaultId"`
			Name    string  `json:"name"`
		} `json:"cards"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	names := map[string]string{}
	for _, c := range got.Cards {
		names[c.ID] = c.Name
	}
	if len(got.Cards) != 2 || names[icUserA] != "Asha" || names[icUserB] != "" {
		t.Fatalf("cards = %+v, want Asha and a nameless B, without the deleted and unknown users", got.Cards)
	}
}
