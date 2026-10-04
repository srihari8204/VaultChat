// user_pin_verify_limit_test.go — POST /user/pin/verify has a per-user,
// fail-closed attempt budget (the hidden-chats gate).
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestUserPinVerify -v
package routes

import (
	"context"
	"fmt"
	"os"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/redisx"
)

const pvUser = "4e000000-0000-4000-8000-0000000000a1"

func TestUserPinVerifyLimit(t *testing.T) {
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run against a scratch database")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("2468"), 4)
	cleanup := func() {
		_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM users WHERE id = '%s'`, pvUser))
		redisx.Reset(ctx, "pinverify:"+pvUser)
	}
	cleanup()
	t.Cleanup(cleanup)
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO users (id, email, name, pin_hash) VALUES ('%s','pv@t.test','Pin','%s')`, pvUser, hash)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	mux := adMux()
	verify := func(pin string) (int, map[string]any) {
		return call(t, mux, pvUser, "POST", "/user/pin/verify", fmt.Sprintf(`{"pin":%q}`, pin))
	}

	// A correct PIN clears earlier strikes.
	for i := 0; i < 4; i++ {
		if code, out := verify("1111"); code != 200 || out["ok"] != false {
			t.Fatalf("wrong #%d: %d %v", i+1, code, out)
		}
	}
	if code, out := verify("2468"); code != 200 || out["ok"] != true {
		t.Fatalf("right: %d %v", code, out)
	}
	// Five wrong tries are answered; the sixth is locked, even with the right PIN.
	for i := 0; i < 5; i++ {
		if code, out := verify("1111"); code != 200 || out["ok"] != false {
			t.Fatalf("wrong #%d after reset: %d %v", i+1, code, out)
		}
	}
	code, out := verify("2468")
	e, _ := out["error"].(map[string]any)
	if code != 423 || e == nil || e["code"] != "locked" || e["retryAfter"] == nil {
		t.Fatalf("6th try: %d %v, want 423 locked with retryAfter", code, out)
	}
	// A malformed PIN is refused without spending the budget (and stays ok:false).
	redisx.Reset(ctx, "pinverify:"+pvUser)
	for i := 0; i < 8; i++ {
		if code, out := verify("ab"); code != 200 || out["ok"] != false {
			t.Fatalf("malformed: %d %v", code, out)
		}
	}
	if code, out := verify("2468"); code != 200 || out["ok"] != true {
		t.Fatalf("right after malformed: %d %v", code, out)
	}
}
