// auth_onboarding_flow_test.go — the whole signup chain against a real schema.
//
// # WHY THIS EXISTS
//
// Closing the /auth/mpin/set takeover changed the SIGNUP CONTRACT: profile/init
// now returns a setup ticket and the two calls after it require one. That fix
// is worthless if it also breaks account creation, and a broken signup is the
// worst possible launch outcome — existing users keep working, so it would ship
// looking healthy and only new users would hit it.
//
// The binding unit tests in auth_setup_ticket_test.go cannot catch that: they
// test the ticket primitive, not the handlers, the JSON field names, or the
// order the client calls them in. This drives the real handlers against a real
// Postgres, in the exact sequence app/onboard-mpin.tsx uses.
//
// It asserts BOTH directions in one pass:
//
//   - the legitimate chain still completes and yields a working login
//
//   - every call in it refuses a missing or wrong-user ticket
//
//     docker run -d --name vc-onboard-test -e POSTGRES_USER=vaultchat \
//     -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=vaultchat -p 15499:5432 postgres:16-alpine
//     docker cp vaultchat-backend/migrations vc-onboard-test:/migrations
//     docker exec vc-onboard-test sh -c 'for f in $(ls /migrations/*.sql|sort); do psql -v ON_ERROR_STOP=1 -U vaultchat -d vaultchat -q -f $f; done'
//     CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=15499 DB_NAME=vaultchat \
//     DB_USER=vaultchat DB_PASS=testpw JWT_SECRET=test-secret-at-least-32-chars-long \
//     VAULTCHAT_MASTER_KEY=$(printf '0%.0s' $(seq 64)) VAULTCHAT_LOOKUP_PEPPER=test-pepper \
//     go test ./internal/routes/ -run TestOnboarding -v
//
// PORT 15499 IS DELIBERATE. 15432 is historically an SSH tunnel to production
// Postgres; this suite writes, so it must never be pointed at that port.
//
// ISOLATION: every fixture carries the 0b00 marker and onboardCleanup removes
// exactly those rows.
package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/vault"
)

const onboardMarker = "onboardflow"

func onboardSkip(t *testing.T) context.Context {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* (port 15499, NOT 15432) to run the onboarding flow test")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	return ctx
}

func onboardCleanup(ctx context.Context, t *testing.T, email string) {
	t.Helper()
	el, err := vault.EmailLookup(email)
	if err != nil {
		return
	}
	var id string
	if err := db.Pool.QueryRow(ctx, `SELECT id FROM users WHERE email_lookup = $1`, el).Scan(&id); err != nil {
		return
	}
	// user_security_questions cascades from users; delete the row itself.
	_, _ = db.Pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
}

// post drives a handler exactly as the HTTP layer would, so the JSON field
// names on the wire are part of what is under test — a renamed key is the
// likeliest way this contract silently breaks.
func post(h http.HandlerFunc, body map[string]any) (int, map[string]any) {
	b, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/", bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestOnboardingFlowEndToEnd(t *testing.T) {
	ctx := onboardSkip(t)

	email := onboardMarker + "-a@example.com"
	phone := "+919000000001"
	t.Cleanup(func() { onboardCleanup(ctx, t, email) })
	onboardCleanup(ctx, t, email) // a previous failed run must not fail this one

	// The client reaches profile/init holding an emailTicket from
	// /auth/onboard/verify-otp. Mint it the same way that handler does rather
	// than seeding an OTP row — the OTP path is not what this test is about.
	el, err := vault.EmailLookup(vault.NormalizeEmail(email))
	if err != nil {
		t.Fatalf("EmailLookup: %v", err)
	}
	emailTicket, err := vault.SignTicket(el, 900)
	if err != nil {
		t.Fatalf("SignTicket: %v", err)
	}

	// ── STEP 1: profile/init ──────────────────────────────────────────
	code, res := post(authProfileInit, map[string]any{
		"email": email, "phone": phone, "emailTicket": emailTicket,
		"firstName": "Flow", "lastName": "Test", "dob": "1990-01-01", "status": "hi",
	})
	if code != 200 {
		t.Fatalf("profile/init: want 200, got %d (%v)", code, res)
	}
	userID, _ := res["userId"].(string)
	setupTicket, _ := res["setupTicket"].(string)
	if userID == "" {
		t.Fatal("profile/init returned no userId")
	}
	// THE CONTRACT. lib/onboarding.ts reads exactly this key and passes it to
	// the next two calls; without it every signup dies at the security-question
	// step, and only for NEW users, which is why it would ship unnoticed.
	if setupTicket == "" {
		t.Fatal("profile/init returned no setupTicket — the client cannot complete signup without it")
	}

	// ── STEP 2: security questions ────────────────────────────────────
	answers := []map[string]any{}
	for _, qc := range onboardFirstFiveQuestionCodes(t) {
		answers = append(answers, map[string]any{"questionCode": qc, "answer": "answer-" + qc})
	}

	// The hole, before the ticket: a body userId was the only thing needed to
	// overwrite someone's recovery answers, and /mpin/recover trades those for
	// a session.
	if code, _ := post(authSecurityQuestionsSave, map[string]any{
		"userId": userID, "answers": answers,
	}); code != 401 {
		t.Errorf("security-questions/save with NO ticket: want 401, got %d — takeover path is open", code)
	}
	if code, out := post(authSecurityQuestionsSave, map[string]any{
		"userId": userID, "setupTicket": setupTicket, "answers": answers,
	}); code != 200 {
		t.Fatalf("security-questions/save with ticket: want 200, got %d (%v) — signup is broken", code, out)
	}

	// ── STEP 3: mpin/set ──────────────────────────────────────────────
	const pin = "246813" // passes authIsWeakMpin: not sequential, not repeated

	// THE ORIGINAL TAKEOVER, exactly as it was exploitable: name a userId, set
	// its PIN, then trade the PIN for that account's tokens.
	if code, _ := post(authMpinSet, map[string]any{
		"userId": userID, "mpin": pin,
	}); code != 401 {
		t.Errorf("mpin/set with NO ticket: want 401, got %d — ACCOUNT TAKEOVER IS OPEN", code)
	}
	if code, out := post(authMpinSet, map[string]any{
		"userId": userID, "setupTicket": setupTicket, "mpin": pin,
	}); code != 200 {
		t.Fatalf("mpin/set with ticket: want 200, got %d (%v) — signup is broken", code, out)
	}

	// ── STEP 4: the account actually works ────────────────────────────
	// Proof the chain produced a usable login, not just three 200s.
	code, out := post(authMpinVerify, map[string]any{"userId": userID, "mpin": pin})
	if code != 200 {
		t.Fatalf("mpin/verify after onboarding: want 200, got %d (%v)", code, out)
	}
	if s, _ := out["accessToken"].(string); s == "" {
		t.Error("mpin/verify issued no accessToken — the account is not usable")
	}

	// ── STEP 5: first-set-only ────────────────────────────────────────
	// A replayed ticket inside its 15-minute life must not be able to change an
	// established PIN. 200 with already:true, so a client retrying a lost reply
	// is not stranded on the last step of signup.
	code, out = post(authMpinSet, map[string]any{
		"userId": userID, "setupTicket": setupTicket, "mpin": "371592",
	})
	if code != 200 || out["already"] != true {
		t.Errorf("replayed mpin/set: want 200 already:true, got %d (%v)", code, out)
	}
	if code, _ := post(authMpinVerify, map[string]any{"userId": userID, "mpin": "371592"}); code == 200 {
		t.Error("the replayed PIN works — an established MPIN was overwritten")
	}
	if code, _ := post(authMpinVerify, map[string]any{"userId": userID, "mpin": pin}); code != 200 {
		t.Error("the original PIN stopped working after a refused overwrite")
	}
}

// The realistic attack now that a ticket is required: an attacker onboards
// normally, holds a VALID ticket for their own account, and swaps the body
// userId to the victim's.
func TestOnboardingTicketIsNotTransferable(t *testing.T) {
	ctx := onboardSkip(t)

	victimEmail := onboardMarker + "-victim@example.com"
	attackerEmail := onboardMarker + "-attacker@example.com"
	t.Cleanup(func() {
		onboardCleanup(ctx, t, victimEmail)
		onboardCleanup(ctx, t, attackerEmail)
	})
	onboardCleanup(ctx, t, victimEmail)
	onboardCleanup(ctx, t, attackerEmail)

	mk := func(email, phone string) (string, string) {
		el, err := vault.EmailLookup(vault.NormalizeEmail(email))
		if err != nil {
			t.Fatalf("EmailLookup: %v", err)
		}
		tk, err := vault.SignTicket(el, 900)
		if err != nil {
			t.Fatalf("SignTicket: %v", err)
		}
		code, res := post(authProfileInit, map[string]any{
			"email": email, "phone": phone, "emailTicket": tk,
			"firstName": "X", "dob": "1990-01-01",
		})
		if code != 200 {
			t.Fatalf("profile/init(%s): want 200, got %d (%v)", email, code, res)
		}
		id, _ := res["userId"].(string)
		st, _ := res["setupTicket"].(string)
		return id, st
	}

	victimID, _ := mk(victimEmail, "+919000000002")
	_, attackerTicket := mk(attackerEmail, "+919000000003")

	if code, _ := post(authMpinSet, map[string]any{
		"userId": victimID, "setupTicket": attackerTicket, "mpin": "246813",
	}); code != 401 {
		t.Errorf("mpin/set with ANOTHER user's ticket: want 401, got %d — the ticket is not bound to its account", code)
	}
	if code, _ := post(authSecurityQuestionsSave, map[string]any{
		"userId": victimID, "setupTicket": attackerTicket,
		"answers": func() []map[string]any {
			out := []map[string]any{}
			for _, qc := range onboardFirstFiveQuestionCodes(t) {
				out = append(out, map[string]any{"questionCode": qc, "answer": "x-" + qc})
			}
			return out
		}(),
	}); code != 401 {
		t.Errorf("security-questions/save with ANOTHER user's ticket: want 401, got %d", code)
	}

	// And the victim, having never set a PIN, still cannot be logged into.
	if code, _ := post(authMpinVerify, map[string]any{"userId": victimID, "mpin": "246813"}); code == 200 {
		t.Error("the victim account was logged into with an attacker-chosen PIN")
	}
}

// Five valid codes from the server's own pool, so the test cannot drift from it.
func onboardFirstFiveQuestionCodes(t *testing.T) []string {
	t.Helper()
	out := []string{}
	for code := range authSecurityQuestionCodes {
		out = append(out, code)
		if len(out) == 5 {
			break
		}
	}
	if len(out) != 5 {
		t.Fatalf("need 5 question codes, pool has %d", len(out))
	}
	return out
}

var _ = fmt.Sprintf
