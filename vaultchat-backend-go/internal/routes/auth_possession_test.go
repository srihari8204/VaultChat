// auth_possession_test.go — with AUTH_REQUIRE_PHONE_TICKET=1, MPIN sign-in and
// MPIN recovery need proof of the number (the SMS OTP's phoneTicket) or a live
// session for that same account, and /auth/lookup stops handing out the
// account id to callers without that proof. With the flag off, nothing changes.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... VAULTCHAT_LOOKUP_PEPPER=... VAULTCHAT_MASTER_KEY=... \
//	go test ./internal/routes/ -run TestAuthPossession -v
package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/vault"
)

func apReq(t *testing.T, mux *http.ServeMux, method, path string, body map[string]any, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, path, rd)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func apCode(out map[string]any) string {
	if e, ok := out["error"].(map[string]any); ok {
		s, _ := e["code"].(string)
		return s
	}
	return ""
}

func TestAuthPossession(t *testing.T) {
	ctx := onboardSkip(t)
	const phone, other, mpin = "+919000004401", "+919000004402", "482913"
	cleanup := func() {
		for _, p := range []string{phone, other} {
			if pl, err := vault.PhoneLookup(p); err == nil {
				_, _ = db.Pool.Exec(ctx, `DELETE FROM users WHERE phone_lookup = $1`, pl)
			}
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	ticketFor := func(p string) string {
		pl, err := vault.PhoneLookup(p)
		if err != nil {
			t.Fatal(err)
		}
		tk, err := vault.SignTicket(pl, 900)
		if err != nil {
			t.Fatal(err)
		}
		return tk
	}
	ticket, otherTicket := ticketFor(phone), ticketFor(other)

	// A real, finished account (profile/init + mpin/set, as the app does).
	status, body := post(authProfileInit, map[string]any{"phone": phone, "phoneTicket": ticket, "firstName": "Pos", "dob": "1990-01-01"})
	if status != 200 {
		t.Fatalf("profile/init: %d %v", status, body)
	}
	userID, setup := body["userId"].(string), body["setupTicket"].(string)
	if status, out := post(authMpinSet, map[string]any{"userId": userID, "setupTicket": setup, "mpin": mpin}); status != 200 {
		t.Fatalf("mpin/set: %d %v", status, out)
	}
	resetBudgets := func() {
		redisx.Reset(ctx, "mpin:"+userID)
		redisx.Reset(ctx, "recover:"+userID)
		redisx.Reset(ctx, "sq:get-user:"+userID)
	}
	resetBudgets()
	t.Cleanup(resetBudgets)
	mux := http.NewServeMux()
	RegisterAuth(mux)

	// ── flag OFF: today's behaviour, unchanged ──
	t.Setenv("AUTH_REQUIRE_PHONE_TICKET", "")
	if code, out := apReq(t, mux, "POST", "/auth/lookup", map[string]any{"phone": phone}, nil); code != 200 || out["userId"] != userID {
		t.Fatalf("off: lookup: %d %v", code, out)
	}
	if code, out := apReq(t, mux, "POST", "/auth/mpin/verify", map[string]any{"userId": userID, "mpin": mpin}, nil); code != 200 || out["accessToken"] == nil {
		t.Fatalf("off: mpin verify: %d %v", code, out)
	}

	// ── flag ON ──
	t.Setenv("AUTH_REQUIRE_PHONE_TICKET", "1")
	code, out := apReq(t, mux, "POST", "/auth/lookup", map[string]any{"phone": phone}, nil)
	if code != 200 || out["exists"] != true || out["otpRequired"] != true || out["userId"] != nil {
		t.Fatalf("on: lookup without ticket leaked or failed: %d %v", code, out)
	}
	if code, out := apReq(t, mux, "POST", "/auth/lookup", map[string]any{"phone": phone, "phoneTicket": ticket}, nil); code != 200 || out["userId"] != userID {
		t.Fatalf("on: lookup with ticket: %d %v", code, out)
	}
	if code, out := apReq(t, mux, "POST", "/auth/lookup", map[string]any{"phone": phone, "phoneTicket": otherTicket}, nil); out["userId"] != nil {
		t.Fatalf("on: lookup with another number's ticket: %d %v", code, out)
	}

	// No ticket → 403 otp_required, and the MPIN budget is NOT spent: seven
	// refusals, then the right MPIN with the ticket still signs in.
	for i := 0; i < 7; i++ {
		if code, out := apReq(t, mux, "POST", "/auth/mpin/verify", map[string]any{"userId": userID, "mpin": "000000"}, nil); code != 403 || apCode(out) != "otp_required" {
			t.Fatalf("on: no ticket #%d: %d %v", i+1, code, out)
		}
	}
	if code, out := apReq(t, mux, "POST", "/auth/mpin/verify", map[string]any{"userId": userID, "mpin": mpin, "phoneTicket": otherTicket}, nil); code != 403 {
		t.Fatalf("on: another number's ticket: %d %v", code, out)
	}
	code, out = apReq(t, mux, "POST", "/auth/mpin/verify", map[string]any{"userId": userID, "mpin": mpin, "phoneTicket": ticket}, nil)
	if code != 200 || out["accessToken"] == nil {
		t.Fatalf("on: with ticket: %d %v", code, out)
	}
	// A device already signed in as this account re-checks with its token.
	bearer := map[string]string{"Authorization": "Bearer " + out["accessToken"].(string)}
	if code, out := apReq(t, mux, "POST", "/auth/mpin/verify", map[string]any{"userId": userID, "mpin": mpin}, bearer); code != 200 {
		t.Fatalf("on: re-check with own session: %d %v", code, out)
	}
	// ...but a session for a DIFFERENT account is not proof for this one.
	if code, _ := apReq(t, mux, "POST", "/auth/mpin/verify", map[string]any{"userId": "4e060000-0000-4000-8000-0000000000a1", "mpin": mpin}, bearer); code != 403 {
		t.Fatalf("on: someone else's session: %d", code)
	}

	// Recovery: the questions and the answer check need the ticket too.
	if code, out := apReq(t, mux, "GET", "/auth/security-questions/"+userID, nil, nil); code != 403 || apCode(out) != "otp_required" {
		t.Fatalf("on: questions without ticket: %d %v", code, out)
	}
	if code, _ := apReq(t, mux, "GET", "/auth/security-questions/"+userID, nil, map[string]string{"X-Phone-Ticket": ticket}); code != 200 {
		t.Fatalf("on: questions with ticket: %d", code)
	}
	answers := []map[string]any{{"questionCode": "pet", "answer": "x"}}
	if code, out := apReq(t, mux, "POST", "/auth/security-questions/verify", map[string]any{"userId": userID, "answers": answers}, nil); code != 403 || apCode(out) != "otp_required" {
		t.Fatalf("on: answers without ticket: %d %v", code, out)
	}
	if code, out := apReq(t, mux, "POST", "/auth/security-questions/verify", map[string]any{"userId": userID, "answers": answers, "phoneTicket": ticket}, nil); code == 403 || code == 200 {
		t.Fatalf("on: wrong answers with ticket should fail on the answers, not the ticket: %d %v", code, out)
	}
}

// verify-otp-phone tells a caller who just proved the number whether it has
// an account, and which — so the client never needs the unauthenticated
// lookup. Needs Redis (the OTP request id lives there) and the dev OTP switch.
func TestAuthPossessionVerifyOtpReportsAccount(t *testing.T) {
	ctx := onboardSkip(t)
	if os.Getenv("REDIS_URL") == "" {
		t.Skip("set REDIS_URL: the OTP request id is stored in Redis")
	}
	redisx.Connect()
	t.Setenv("ALLOW_DEV_OTP", "1")
	t.Setenv("DEV_OTP", "135790")
	const phone, fresh = "+919000004403", "+919000004404"
	cleanup := func() {
		for _, p := range []string{phone, fresh} {
			if pl, err := vault.PhoneLookup(p); err == nil {
				_, _ = db.Pool.Exec(ctx, `DELETE FROM users WHERE phone_lookup = $1`, pl)
				for _, k := range []string{"otp:phone-resend:" + pl, authPhoneHourKey(pl), "verify-otp-phone-v2:" + pl} {
					redisx.Reset(ctx, k)
				}
				redisx.Reset(ctx, "otp:phone-ip:"+"192.0.2.1")
			}
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	pl, _ := vault.PhoneLookup(phone)
	tk, _ := vault.SignTicket(pl, 900)
	_, body := post(authProfileInit, map[string]any{"phone": phone, "phoneTicket": tk, "firstName": "Otp", "dob": "1990-01-01"})
	userID, _ := body["userId"].(string)
	if status, out := post(authMpinSet, map[string]any{"userId": userID, "setupTicket": body["setupTicket"], "mpin": "482913"}); status != 200 {
		t.Fatalf("mpin/set: %d %v", status, out)
	}
	for _, c := range []struct {
		phone  string
		exists bool
		uid    any
	}{{phone, true, userID}, {fresh, false, nil}} {
		if status, out := post(authOnboardSendOtpPhone, map[string]any{"phone": c.phone}); status != 200 {
			t.Fatalf("send %s: %d %v", c.phone, status, out)
		}
		status, out := post(authOnboardVerifyOtpPhone, map[string]any{"phone": c.phone, "code": "135790"})
		if status != 200 || out["phoneTicket"] == nil || out["exists"] != c.exists || out["userId"] != c.uid {
			t.Fatalf("verify %s: %d %v", c.phone, status, out)
		}
	}
}
