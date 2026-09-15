// auth_phone_test.go — the parts of number-first signup that fail silently.
//
// # WHY THESE FIVE
//
// Every check here covers a failure that produces a WORKING-LOOKING system:
//
//   - a normaliser disagreement mints a ticket for a lookup hash that
//     /auth/profile/init will never compute, so verify returns 200 and account
//     creation then says "verify your mobile number first" forever;
//   - a ticket that is not bound to the number would let one verified phone
//     create an account for any other;
//   - a wrong code accepted is the whole product, and MSG91 answers HTTP 200
//     for "OTP not match" — gating on the status code would accept it;
//   - a 429 without retryAfter reaches the user as "try again later" with no
//     countdown, and the user's response to that is to keep tapping.
//
// Most of these are pure: no Postgres, no network. Only TestPhoneOnlyLookup
// needs a database, and it uses the same CALL_TEST_DB=1 / port 15499 harness as
// auth_onboarding_flow_test.go — see that file's header for the setup command.
package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/msg91"
	"vaultchat/backend-go/internal/vault"
)

// phoneTestEnv gives vault a master key and pepper so the lookup/ticket
// primitives work without a deployment's secrets.
func phoneTestEnv(t *testing.T) {
	t.Helper()
	t.Setenv("VAULTCHAT_MASTER_KEY", strings.Repeat("0", 64))
	t.Setenv("VAULTCHAT_LOOKUP_PEPPER", "test-pepper")
}

// ── 1. the two normalisers, and which one may touch phone_lookup ───────

func TestPhoneE164AgreesWithLookupNormaliser(t *testing.T) {
	phoneTestEnv(t)

	// Formatting noise must not change the identity: all of these are one
	// account, and a user who types spaces must not get a second one.
	same := []string{"+919876543210", " +91 98765 43210 ", "+91-98765-43210"}
	want, err := vault.PhoneLookup(same[0])
	if err != nil {
		t.Fatalf("PhoneLookup: %v", err)
	}
	for _, in := range same {
		p := authPhoneE164(in)
		if p == "" {
			t.Fatalf("authPhoneE164(%q) rejected a valid number", in)
		}
		got, err := vault.PhoneLookup(p)
		if err != nil {
			t.Fatalf("PhoneLookup: %v", err)
		}
		if got != want {
			t.Errorf("authPhoneE164(%q) hashes to a different account than %q", in, same[0])
		}
	}

	// THE TRAP. authNormalizePhone drops the '+' and invents a country code, so
	// it produces a string vault.PhoneLookup would hash differently. If someone
	// "simplifies" auth_phone.go to use it, the ticket stops matching what
	// /auth/profile/init derives and signup dies at the last step.
	if authNormalizePhone("+919876543210") == vault.NormalizePhone("+919876543210") {
		t.Fatal("the two normalisers now agree — the guard comment in auth_phone.go is stale")
	}

	// Anything that is not a plausible E.164 number is refused rather than
	// silently hashed: "9876543210" and "+919876543210" are two different
	// lookups, and accepting both hands one user two identities.
	for _, bad := range []string{"", "9876543210", "+0123456789", "+1234567", "not a phone", "+91987654321012345"} {
		if got := authPhoneE164(bad); got != "" {
			t.Errorf("authPhoneE164(%q) = %q, want rejection", bad, got)
		}
	}
}

// ── 2. the ticket is bound to the number ───────────────────────────────

func TestPhoneTicketBindsToThatNumber(t *testing.T) {
	phoneTestEnv(t)

	mine, err := vault.PhoneLookup("+919876543210")
	if err != nil {
		t.Fatalf("PhoneLookup: %v", err)
	}
	theirs, err := vault.PhoneLookup("+919876500000")
	if err != nil {
		t.Fatalf("PhoneLookup: %v", err)
	}
	ticket, err := vault.SignTicket(mine, 900)
	if err != nil {
		t.Fatalf("SignTicket: %v", err)
	}
	if !vault.VerifyTicket(ticket, mine) {
		t.Fatal("a freshly minted phoneTicket does not verify for its own number")
	}
	// The attack profile/init has to refuse: verify YOUR number, then ask for an
	// account on somebody else's.
	if vault.VerifyTicket(ticket, theirs) {
		t.Error("a phoneTicket verified for a DIFFERENT number — profile/init would create the wrong account")
	}
	// An expired ticket is not a valid one; 15 minutes is the window, and a
	// negative TTL is the cheapest way to prove the check exists at all.
	stale, err := vault.SignTicket(mine, -1)
	if err != nil {
		t.Fatalf("SignTicket: %v", err)
	}
	if vault.VerifyTicket(stale, mine) {
		t.Error("an expired phoneTicket still verifies")
	}
}

// ── 3. a wrong code is a wrong code, on HTTP 200 ───────────────────────

// MSG91 answers 200 with {"type":"error"} for "OTP not match". verify-otp-phone
// relies on msg91.Verify reading `type` and NOT the status code; if that ever
// regresses to a res.ok check, every wrong code is accepted and this test is
// the only thing that notices.
func TestMsg91VerifyRejectsWrongCodeOnHTTP200(t *testing.T) {
	t.Setenv("MSG91_AUTH_KEY", "test-key")
	t.Setenv("MSG91_WIDGET_ID", "test-widget")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Otp string `json:"otp"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK) // 200 for BOTH outcomes — MSG91's actual behaviour
		if body.Otp == "123456" {
			_, _ = w.Write([]byte(`{"type":"success","message":"OTP verified success"}`))
			return
		}
		_, _ = w.Write([]byte(`{"type":"error","message":"OTP not match"}`))
	}))
	defer srv.Close()

	old := msg91.Base
	msg91.Base = srv.URL
	defer func() { msg91.Base = old }()

	if err := msg91.Verify(context.Background(), "req-1", "123456"); err != nil {
		t.Errorf("correct code rejected: %v", err)
	}
	err := msg91.Verify(context.Background(), "req-1", "000000")
	if err == nil {
		t.Fatal("A WRONG CODE WAS ACCEPTED — msg91.Verify is gating on the HTTP status, not `type`")
	}
	// It must be ErrBadCode specifically: the handler shows "that code is not
	// right" for this and "we couldn't check that code" for an outage, and
	// conflating them burns the user's attempts on our fault (or hides ours as
	// theirs).
	if err != msg91.ErrBadCode {
		t.Errorf("wrong code gave %v, want ErrBadCode — the handler will report it as an outage", err)
	}
}

// ── 4. a 429 the client can count down from ────────────────────────────

func TestSendOtpPhoneRateLimitCarriesRetryAfter(t *testing.T) {
	phoneTestEnv(t)
	const phone = "+919876500001"

	// No MSG91 credentials and no dev opt-in: the handler answers 503 rather
	// than pretending — which is the point of task 5 and is asserted below. The
	// limiter runs FIRST either way, so the 4th call is still a 429.
	t.Setenv("MSG91_AUTH_KEY", "")
	t.Setenv("MSG91_WIDGET_ID", "")
	t.Setenv("ALLOW_DEV_OTP", "")

	var status int
	var body map[string]any
	for i := 0; i < 5; i++ {
		status, body = post(authOnboardSendOtpPhone, map[string]any{"phone": phone})
		if status == 429 {
			break
		}
		if status != http.StatusServiceUnavailable {
			t.Fatalf("call %d: want 503 (no provider) or 429, got %d (%v)", i+1, status, body)
		}
	}
	if status != 429 {
		t.Fatalf("no 429 after 5 sends — the cooldown/hourly limits are not being applied")
	}
	env, _ := body["error"].(map[string]any)
	if env == nil {
		t.Fatalf("429 body is not the {error:{code,message}} envelope: %v", body)
	}
	// lib/onboarding.ts onboardingError reads body.retryAfter ?? body.error.retryAfter.
	// Without this the resend button has nothing to count down from.
	ra, ok := env["retryAfter"].(float64)
	if !ok || ra <= 0 {
		t.Errorf("429 envelope has no usable retryAfter (%v) — the app cannot show 'resend in Ns'", env["retryAfter"])
	}
}

// The cooldown is charged before the hourly cap, so a double-tap costs a
// countdown and not one of three codes per hour. Asserted through the handler
// because the ORDER is the behaviour, and it lives only in authPhoneSendGate.
func TestPhoneResendCooldownRefusesImmediateRetry(t *testing.T) {
	phoneTestEnv(t)
	t.Setenv("MSG91_AUTH_KEY", "")
	t.Setenv("MSG91_WIDGET_ID", "")
	t.Setenv("ALLOW_DEV_OTP", "")
	const phone = "+919876500002"

	if status, body := post(authOnboardSendOtpPhone, map[string]any{"phone": phone}); status != http.StatusServiceUnavailable {
		t.Fatalf("first send: want 503 with no provider configured, got %d (%v) — a missing provider must never look like success", status, body)
	}
	status, body := post(authOnboardResendOtpPhone, map[string]any{"phone": phone, "channel": "voice"})
	if status != 429 {
		t.Fatalf("resend one second after send: want 429 (cooldown), got %d (%v)", status, body)
	}
	env, _ := body["error"].(map[string]any)
	// +1 because both limiter paths round the remaining TTL up, so a window that
	// has barely started reports one second more than its width.
	if ra, _ := env["retryAfter"].(float64); ra <= 0 || ra > authPhoneResendSec+1 {
		t.Errorf("cooldown retryAfter = %v, want 1..%d", env["retryAfter"], authPhoneResendSec+1)
	}
}

// ── 5. the dev bypass needs two keys turned at once ────────────────────

func TestDevOtpNeedsExplicitOptIn(t *testing.T) {
	t.Setenv("DEV_OTP", "111111")
	t.Setenv("ALLOW_DEV_OTP", "")
	if authDevOtpMatches("111111") {
		t.Error("DEV_OTP alone opened the bypass — an inherited env var is enough to accept a fixed code")
	}
	t.Setenv("ALLOW_DEV_OTP", "1")
	if !authDevOtpMatches("111111") {
		t.Error("with both variables set the dev code is refused — local signup is unusable")
	}
	if authDevOtpMatches("222222") {
		t.Error("a code that is not DEV_OTP was accepted")
	}
	t.Setenv("DEV_OTP", "")
	if authDevOtpMatches("") {
		t.Error("an empty DEV_OTP matched an empty code — every blank submission would pass")
	}
}

// ── /auth/lookup with a number and nothing else (needs Postgres) ───────

func TestPhoneOnlyLookup(t *testing.T) {
	ctx := onboardSkip(t)

	phone := "+919000000009"
	// onboardCleanup keys on email_lookup, and the account under test has no
	// email at all — which is exactly the point of it.
	cleanup := func() {
		if pl, err := vault.PhoneLookup(phone); err == nil {
			_, _ = db.Pool.Exec(ctx, `DELETE FROM users WHERE phone_lookup = $1`, pl)
		}
	}
	t.Cleanup(cleanup)
	cleanup()

	// The sign-in screen has a number and nothing else. Before this, lookup 400'd
	// on a missing email and the screen could not be served at all.
	if status, body := post(authLookup, map[string]any{"phone": phone}); status != 200 {
		t.Fatalf("lookup with phone only: want 200, got %d (%v)", status, body)
	} else if body["exists"] != false {
		t.Fatalf("unknown number reported as existing: %v", body)
	}

	pl, err := vault.PhoneLookup(phone)
	if err != nil {
		t.Fatalf("PhoneLookup: %v", err)
	}
	phoneTicket, err := vault.SignTicket(pl, 900)
	if err != nil {
		t.Fatalf("SignTicket: %v", err)
	}
	// No email at all: the account this creates is the one number-first signup
	// produces, and it must be visible to lookup afterwards — the exact thing
	// the legacy phone path gets wrong.
	status, body := post(authProfileInit, map[string]any{
		"phone": phone, "phoneTicket": phoneTicket,
		"firstName": "Phone", "dob": "1990-01-01",
	})
	if status != 200 {
		t.Fatalf("profile/init with phoneTicket and no email: want 200, got %d (%v)", status, body)
	}
	userID, _ := body["userId"].(string)
	if userID == "" {
		t.Fatal("profile/init returned no userId")
	}

	status, body = post(authLookup, map[string]any{"phone": phone})
	if status != 200 || body["exists"] != true || body["userId"] != userID {
		t.Fatalf("the account just created is invisible to a phone-only lookup: %d %v", status, body)
	}

	// A phoneTicket for one number must not create an account on another.
	other := "+919000000010"
	if status, _ := post(authProfileInit, map[string]any{
		"phone": other, "phoneTicket": phoneTicket,
		"firstName": "Not", "dob": "1990-01-01",
	}); status != 401 {
		t.Errorf("profile/init accepted a ticket bound to a DIFFERENT number: got %d, want 401", status)
	}
}
