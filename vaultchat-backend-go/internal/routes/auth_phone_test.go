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
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/msg91"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/vault"
)

// postFrom is post() with a caller address.
//
// NEEDED SINCE THE SEND LIMITERS STOPPED FAILING OPEN. httptest.NewRequest
// hands every request the same RemoteAddr, so with no Redis the per-IP bucket
// is one in-process counter SHARED BY THE WHOLE PACKAGE — ten sends anywhere in
// this file would start 429-ing an unrelated test that happened to run later.
// One IP per test keeps each test's bucket its own.
func postFrom(h http.HandlerFunc, ip string, body map[string]any) (int, map[string]any) {
	b, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "/", bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = ip + ":40000"
	w := httptest.NewRecorder()
	h(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// phoneHourlyRemaining charges the per-number hourly bucket once and reports
// what is left. There is no read-only peek in redisx, and one charge is enough
// to tell a refunded bucket (2 left) from a spent one (1 left).
func phoneHourlyRemaining(t *testing.T, phone string) int64 {
	t.Helper()
	lookup, err := vault.PhoneLookup(phone)
	if err != nil {
		t.Fatalf("PhoneLookup: %v", err)
	}
	return redisx.ConsumeSecure(context.Background(), authPhoneHourKey(lookup), 3, 3600).Remaining
}

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

// An emailTicket proves an EMAIL. It said nothing about the phone in the body,
// so while profile/init accepted it as a stand-in, anyone who could OTP their
// own address could create an account on ANY number — which then answers
// `exists:true` to /auth/lookup forever and locks its real owner out of signup.
//
// No database needed: the ticket check runs before the first query, so a refusal
// never reaches db.Pool. That is also the failure this pins — if the ticket
// check is ever moved below the duplicate-check, this test panics on a nil pool
// instead of quietly passing.
func TestProfileInitRefusesEmailTicketForSomeoneElsesNumber(t *testing.T) {
	phoneTestEnv(t)

	email := "attacker@example.com"
	el, err := vault.EmailLookup(vault.NormalizeEmail(email))
	if err != nil {
		t.Fatalf("EmailLookup: %v", err)
	}
	emailTicket, err := vault.SignTicket(el, 900)
	if err != nil {
		t.Fatalf("SignTicket: %v", err)
	}
	status, body := post(authProfileInit, map[string]any{
		"email": email, "phone": "+919000000099", "emailTicket": emailTicket,
		"firstName": "Squatter", "dob": "1990-01-01",
	})
	if status != 401 {
		t.Fatalf("profile/init created an account on an unproven number with an emailTicket alone: got %d (%v), want 401", status, body)
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
		// The standalone OTP API takes the code as a QUERY PARAMETER, not a JSON
		// body — that is the difference from the widget endpoints this used to
		// speak to. Reading the body here would see "" and make the test pass
		// for the wrong reason.
		otp := r.URL.Query().Get("otp")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK) // 200 for BOTH outcomes — MSG91's actual behaviour
		if otp == "123456" {
			_, _ = w.Write([]byte(`{"type":"success","message":"OTP verified success"}`))
			return
		}
		_, _ = w.Write([]byte(`{"type":"error","message":"OTP not match"}`))
	}))
	defer srv.Close()

	old := msg91.Base
	msg91.Base = srv.URL
	defer func() { msg91.Base = old }()

	if err := msg91.Verify(context.Background(), "919876543210", "123456"); err != nil {
		t.Errorf("correct code rejected: %v", err)
	}
	err := msg91.Verify(context.Background(), "919876543210", "000000")
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
	// than pretending — which is the point of task 5 and is asserted below.
	t.Setenv("MSG91_AUTH_KEY", "")
	t.Setenv("MSG91_WIDGET_ID", "")
	t.Setenv("ALLOW_DEV_OTP", "")

	var status int
	var body map[string]any
	for i := 0; i < 5; i++ {
		status, body = postFrom(authOnboardSendOtpPhone, "198.51.100.11", map[string]any{"phone": phone})
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
	// THE 429 MUST BE THE COOLDOWN, NOT THE HOURLY CAP. This test used to be
	// indifferent about which limit fired, because the old code charged all
	// three before calling the provider and three 503s really did burn the
	// hour's allowance. Now a failed send refunds the hourly bucket, so the only
	// limit that can still be refusing at this point is the 30s one — a
	// retryAfter above that width would mean the refund silently stopped
	// working and the user is locked out for an hour over our outage.
	if ra > authPhoneResendSec+1 {
		t.Errorf("429 retryAfter = %v — that is the HOURLY cap, not the %ds cooldown: a failed send is still spending the hour's allowance", ra, authPhoneResendSec)
	}
}

// ── 4b. a send that never left must not cost the user an attempt ───────

// Observed in production: send-otp-phone returned 503 (MSG91 unconfigured) and
// the next resend answered 429 retryAfter:29 — the user was charged for an SMS
// that was never sent. Three provider blips in an hour locked a real person out
// for an hour having received nothing.
func TestFailedSendRefundsHourlyAllowanceButNotCooldown(t *testing.T) {
	phoneTestEnv(t)
	const phone = "+919876500003"
	t.Setenv("MSG91_AUTH_KEY", "")
	t.Setenv("MSG91_WIDGET_ID", "")
	t.Setenv("ALLOW_DEV_OTP", "")

	if status, body := postFrom(authOnboardSendOtpPhone, "198.51.100.12", map[string]any{"phone": phone}); status != http.StatusServiceUnavailable {
		t.Fatalf("send with no provider: want 503, got %d (%v)", status, body)
	}

	// Refunded, so the probe below is the FIRST charge in the window: 3 - 1 = 2.
	// Unrefunded it would be the second and leave 1.
	if rem := phoneHourlyRemaining(t, phone); rem != 2 {
		t.Errorf("hourly allowance after a failed send leaves %d of 3 — the undelivered code was charged to the user", rem)
	}

	// THE COOLDOWN MUST STILL BE SPENT. It is the only thing standing between a
	// double-tapped button and free sends, and a cooldown that any failure
	// refunds is not a cooldown at all — the failing case is exactly when a user
	// taps fastest.
	status, body := postFrom(authOnboardResendOtpPhone, "198.51.100.12", map[string]any{"phone": phone})
	if status != 429 {
		t.Fatalf("resend immediately after a failed send: want 429 (cooldown still charged), got %d (%v) — the refund gave back the cooldown too", status, body)
	}
}

// ── 4c. the send limits may not evaporate when Redis does ──────────────

// These tests run with redisx.Client == nil, i.e. exactly the Redis-is-down
// case. Under the old redisx.Consume the per-number and per-IP hourly limits
// returned Allowed unconditionally there, so the only surviving limit was the
// 30s cooldown: one host could walk a list of numbers at 2/minute each, in
// parallel, forever — someone else's handset and our SMS bill on the far side.
//
// Distinct numbers on purpose: that clears the per-number cooldown and hourly
// buckets, leaving the per-IP cap as the only thing that can refuse. Note the
// per-IP bucket is deliberately NOT refunded on a failed send — otherwise a
// caller who can make the provider fail gets an unmetered channel.
func TestPhoneSendPerIPLimitHoldsWithoutRedis(t *testing.T) {
	phoneTestEnv(t)
	t.Setenv("MSG91_AUTH_KEY", "")
	t.Setenv("MSG91_WIDGET_ID", "")
	t.Setenv("ALLOW_DEV_OTP", "")
	if redisx.Client != nil {
		t.Skip("this test is about the no-Redis fallback")
	}

	const ip = "198.51.100.13"
	for i := 0; i < 10; i++ {
		phone := fmt.Sprintf("+9198765610%02d", i)
		if status, body := postFrom(authOnboardSendOtpPhone, ip, map[string]any{"phone": phone}); status != http.StatusServiceUnavailable {
			t.Fatalf("send %d to a fresh number: want 503, got %d (%v)", i+1, status, body)
		}
	}
	status, body := postFrom(authOnboardSendOtpPhone, ip, map[string]any{"phone": "+919876561099"})
	if status != 429 {
		t.Fatalf("11th send from one host: want 429, got %d (%v) — the per-IP cap is failing OPEN with Redis down, which is unmetered SMS from a single address", status, body)
	}
	env, _ := body["error"].(map[string]any)
	if ra, _ := env["retryAfter"].(float64); ra <= 0 {
		t.Errorf("per-IP 429 has no retryAfter: %v", env)
	}
}

// ── 4d. "call me with the code" must not silently send a text ──────────

// MSG91's widget API puts channel selection on /retryOtp ONLY; /sendOtp takes
// widgetId + identifier and nothing else. So once the attempt behind the reqId
// has expired there is nothing to retry, and a voice or WhatsApp resend can
// only go out as a fresh SMS.
//
// That is a real limitation and the response has to admit it: the user pressed
// "Call me with the code" precisely BECAUSE the SMS is not arriving, so another
// silent SMS reads as a dead button. Asserted on authPhoneSent directly — it
// owns the contract, and the handler path through it needs a live Redis to
// reach (GetKey has no client here).
func TestResendReportsTheChannelItActuallyUsed(t *testing.T) {
	// Fell back: say so, and say what was asked for.
	w := httptest.NewRecorder()
	authPhoneSent(w, "sms", "voice")
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["channel"] != "sms" {
		t.Errorf("channel = %v, want the channel that carried the code", body["channel"])
	}
	if body["channelFallback"] != true || body["requestedChannel"] != "voice" {
		t.Errorf("a voice request answered by SMS is indistinguishable from a voice call: %v", body)
	}

	// Honoured: no fallback flag, or the client shows an apology for nothing.
	// Fresh map — json.Unmarshal MERGES into a non-nil one, so reusing `body`
	// would carry the fallback flag over from above and pass by accident.
	w = httptest.NewRecorder()
	authPhoneSent(w, "voice", "voice")
	var ok map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &ok)
	if ok["channel"] != "voice" || ok["channelFallback"] != nil {
		t.Errorf("a voice resend that worked is being reported as a fallback: %v", ok)
	}

	// The channel words the app sends must map to the channels the standalone
	// OTP API actually has, and an unknown one falls back to SMS rather than
	// erroring mid-"didn't get it?".
	//
	// WHATSAPP RESOLVES TO SMS, and that is the assertion worth having. The
	// widget API had a WhatsApp retry channel; the standalone API has text and
	// voice only. The client still offers it, so the mapping must degrade to
	// SMS *and report itself as* "sms" — that name is what authPhoneSent turns
	// into channelFallback, which is the difference between telling the user
	// their code went by text and leaving them waiting on WhatsApp forever.
	for in, wantName := range map[string]string{
		"call": "voice", "voice": "voice",
		"WhatsApp": "sms", "wa": "sms",
		"": "sms", "carrier pigeon": "sms",
	} {
		ch, name := authPhoneChannel(in)
		if name != wantName {
			t.Errorf("authPhoneChannel(%q) named %q, want %q", in, name, wantName)
		}
		if name == "sms" && ch != msg91.ChannelSMS || name == "voice" && ch != msg91.ChannelVoice {
			t.Errorf("authPhoneChannel(%q) = %q, which is not the %s channel", in, ch, name)
		}
	}
}

// ── 4e. the E.164 guard belongs on every door, not just the OTP ones ───

// /auth/lookup and /auth/profile/init hashed whatever they were given, so
// "9876543210" was a DIFFERENT identity from "+919876543210". It failed closed
// (the ticket is minted over the E.164 form and would not verify against the
// other hash) so it cost a confusing refusal rather than a wrong account — but
// a number-shaped identity system should refuse the wrong shape at the door.
//
// No database: both handlers validate before their first query, so a nil
// db.Pool is never reached. If that ordering is ever inverted this panics
// rather than quietly passing.
func TestLookupAndProfileInitRequireE164(t *testing.T) {
	phoneTestEnv(t)

	for _, bad := range []string{"9876543210", "+0123456789", "+1234567", "not a phone", ""} {
		if status, body := post(authLookup, map[string]any{"phone": bad}); status != 400 {
			t.Errorf("lookup(%q): got %d (%v), want 400 — a non-E.164 number is a second identity for the same person", bad, status, body)
		}
		if status, body := post(authProfileInit, map[string]any{
			"phone": bad, "firstName": "X", "dob": "1990-01-01",
		}); status != 400 {
			t.Errorf("profile/init(%q): got %d (%v), want 400", bad, status, body)
		}
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

	if status, body := postFrom(authOnboardSendOtpPhone, "198.51.100.14", map[string]any{"phone": phone}); status != http.StatusServiceUnavailable {
		t.Fatalf("first send: want 503 with no provider configured, got %d (%v) — a missing provider must never look like success", status, body)
	}
	status, body := postFrom(authOnboardResendOtpPhone, "198.51.100.14", map[string]any{"phone": phone, "channel": "voice"})
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

	// FINISH THE SIGNUP BEFORE ASKING WHETHER IT EXISTS.
	//
	// This used to assert `exists` straight off profile/init, which passed only
	// because lookup could not tell a real account from an abandoned first
	// step. It can now, and it must: a row with no mpin_hash cannot be signed
	// into, so reporting it sends the client to a PIN screen that 401s forever
	// (see TestOnboardingResumeAfterInterruption). Setting the PIN is what
	// makes this an account, and is what the real client does two screens
	// later — so the test now covers what it always claimed to.
	setupTicket, _ := body["setupTicket"].(string)
	if status, out := post(authMpinSet, map[string]any{
		"userId": userID, "setupTicket": setupTicket, "mpin": "246813",
	}); status != 200 {
		t.Fatalf("mpin/set for the email-less account: want 200, got %d (%v)", status, out)
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
