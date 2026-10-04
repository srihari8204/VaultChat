// account_delete_mpin_test.go — DELETE /user/account demands the MPIN.
//
// The bearer token proves a session, not who holds the unlocked phone. These
// pin that the server (not just the app) checks the MPIN, shares the
// /auth/mpin/verify attempt budget, and answers a wrong MPIN with 403 so the
// client does not treat it as a dead session.
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=15499 DB_NAME=vaultchat DB_USER=... DB_PASS=... \
//	JWT_SECRET=... CALL_TEST_ADMIN_DSN=postgres://... go test ./internal/routes/ -run TestAccountDelete -v
package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/vault"
)

const adUser = "ad000000-0000-4000-8000-0000000000a1"

func adMux() *http.ServeMux {
	mux := http.NewServeMux()
	RegisterUser(mux)
	return mux
}

func adErrCode(out map[string]any) string {
	if e, ok := out["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

// No DB needed: the missing-MPIN refusal happens before any query.
func TestAccountDeleteRequiresMpin(t *testing.T) {
	if os.Getenv("JWT_SECRET") == "" {
		t.Setenv("JWT_SECRET", "account-delete-test-secret")
	}
	for _, body := range []string{``, `{}`, `{"reason":"bye"}`, `{"mpin":""}`} {
		code, out := call(t, adMux(), adUser, "DELETE", "/user/account", body)
		if code != 400 || adErrCode(out) != "mpin_required" {
			t.Errorf("body %q: got %d %v, want 400 mpin_required", body, code, out)
		}
	}
}

func TestAccountDeleteMpinFlow(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background() // not t.Context(): that is cancelled before Cleanup runs
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	hash, err := vault.HashSecret("482916")
	if err != nil {
		t.Fatal(err)
	}
	cleanup := func() { _ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id = '%s'`, adUser)) }
	cleanup()
	t.Cleanup(cleanup)
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO users (id, email, name, mpin_hash) VALUES ('%s','adel@t.test','Del Me','%s')`, adUser, hash)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	redisx.Reset(ctx, "mpin:"+adUser)
	t.Cleanup(func() { redisx.Reset(ctx, "mpin:"+adUser) })
	mux := adMux()
	deleted := func() bool {
		var d bool
		if err := db.Pool.QueryRow(ctx, `SELECT is_deleted FROM users WHERE id = $1`, adUser).Scan(&d); err != nil {
			t.Fatalf("read: %v", err)
		}
		return d
	}

	// A wrong MPIN is 403 (not 401) and erases nothing.
	code, out := call(t, mux, adUser, "DELETE", "/user/account", `{"mpin":"000000","reason":"x"}`)
	if code != 403 || adErrCode(out) != "invalid_mpin" {
		t.Fatalf("wrong mpin: %d %v, want 403 invalid_mpin", code, out)
	}
	if deleted() {
		t.Fatal("account deleted on a wrong MPIN")
	}

	// Same five-attempt budget as /auth/mpin/verify: after five, even the
	// right MPIN is refused with 423 locked.
	for i := 0; i < 4; i++ {
		call(t, mux, adUser, "DELETE", "/user/account", `{"mpin":"000000"}`)
	}
	code, out = call(t, mux, adUser, "DELETE", "/user/account", `{"mpin":"482916"}`)
	if code != http.StatusLocked || adErrCode(out) != "locked" {
		t.Fatalf("sixth attempt: %d %v, want 423 locked", code, out)
	}
	if deleted() {
		t.Fatal("account deleted while locked out")
	}

	// Window over: the right MPIN deletes.
	redisx.Reset(ctx, "mpin:"+adUser)
	code, out = call(t, mux, adUser, "DELETE", "/user/account", `{"mpin":"482916","reason":"leaving"}`)
	if code != 200 || out["ok"] != true {
		t.Fatalf("right mpin: %d %v, want 200 ok", code, out)
	}
	if !deleted() {
		t.Fatal("account not deleted with the right MPIN")
	}
}
