// auth_phone.go — mobile-number-first signup: the v2 phone OTP endpoints.
//
// # WHY A SECOND PHONE OTP STACK
//
// There was already a phone OTP pair (/auth/send-otp-phone, /auth/verify-otp-phone)
// and it cannot be the one this builds on. It writes `phone_hash` plus the
// PLAINTEXT `phone` column and invents a placeholder email so the UNIQUE email
// column is satisfied — none of which is where identity lives since migration
// 042. An account created that way has no `phone_lookup`, so /auth/lookup
// cannot see it: the user signs up successfully and is then told, forever, that
// no account exists. Extending it would have spread that.
//
// So these live on the onboarding (v2) stack instead: the `{error:{code,message}}`
// envelope, the encrypted-PII columns, and the same stateless HMAC tickets the
// email path already mints. The only new idea here is WHERE THE CODE COMES
// FROM — MSG91 generates, delivers and checks it, so no code is ever stored.
//
// # THE TICKET IS THE WHOLE POINT
//
// verify mints a `phoneTicket` bound to `vault.PhoneLookup(phone)`. That is the
// SAME value /auth/profile/init derives from the phone in its own body, so the
// two cannot be made to disagree: a ticket for one number cannot create an
// account for another. It replaces `emailTicket` as the primary proof of
// identity now that email is recovery-only.
package routes

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"

	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/msg91"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/vault"
)

const (
	// Matches the widget's own code lifetime. The reqID is useless once MSG91
	// has expired the attempt behind it, so holding it longer only produces
	// "that code is not right" for a code that was never wrong.
	authPhoneOtpTTLSec = 900
	// One resend per 30s, WhatsApp's shape. Long enough that a slow SMS route
	// gets a chance to arrive before the user burns their next attempt.
	authPhoneResendSec = 30
	// Sentinel request id for the dev path: there is no MSG91 attempt behind it,
	// so verify must compare against DEV_OTP rather than calling the provider.
	authPhoneDevReqID = "dev"
)

// E.164, as the client actually sends it (app/onboard.tsx composes dial code +
// national number). Validating the shape server-side is not cosmetic: the
// lookup hash is computed over this exact string, so "9876543210" and
// "+919876543210" are two different accounts, and accepting both would hand
// each user a second identity depending on which screen they came from.
var authE164Re = regexp.MustCompile(`^\+[1-9]\d{7,14}$`)

// authPhoneE164 normalises with vault.NormalizePhone — the SAME normaliser
// phone_lookup is derived from — and returns "" for anything that is not a
// plausible international number. Never use authNormalizePhone here: it strips
// the '+' and guesses a country code, which produces a lookup hash the rest of
// the v2 stack will never compute.
func authPhoneE164(v any) string {
	p := vault.NormalizePhone(authStr(v))
	if !authE164Re.MatchString(p) {
		return ""
	}
	return p
}

// authPhoneReqKey holds MSG91's request id. Keyed on the LOOKUP HASH, not the
// number: Redis is not where a phone number should be readable, and the hash is
// the only handle the rest of the flow has anyway.
func authPhoneReqKey(lookup string) string { return "otp:msg91:" + lookup }

// authEnvErrRetry is authEnvErr with the wait attached.
//
// The client (lib/onboarding.ts onboardingError) reads
// `body.retryAfter ?? body.error.retryAfter`, and the v2 envelope carried
// NEITHER — so every rate-limit refusal on this stack reached the user as a
// bare "try again later" with no countdown, and the obvious reaction to that is
// to keep tapping, which extends the window that caused it.
func authEnvErrRetry(w http.ResponseWriter, status int, code, message string, retryAfter int64) {
	if retryAfter <= 0 {
		retryAfter = 1
	}
	httpx.JSON(w, status, map[string]any{"error": map[string]any{
		"code": code, "message": message, "retryAfter": retryAfter,
	}})
}

// ── the dev escape hatch, behind one switch ────────────────────────────
//
// AUDIT: authSendOTPSMS used to return nil — SUCCESS — and log the code in
// cleartext whenever Twilio was unconfigured, which is exactly the state prod
// is in. Phone signup therefore looked like it worked, no SMS was ever sent,
// and the only place the code existed was the server log. A stub that reports
// success is worse than no provider at all, because nothing surfaces.
//
// Everything that used to key off "is a provider missing?" now keys off an
// EXPLICIT opt-in instead. Absent the opt-in, a missing provider is an error.

var authDevOtpWarnOnce sync.Once

func authDevOtpAllowed() bool {
	if strings.TrimSpace(os.Getenv("ALLOW_DEV_OTP")) != "1" {
		return false
	}
	// Loud, once. The failure mode this guards against is a deployment that
	// inherits the variable and never notices it is accepting a fixed code.
	authDevOtpWarnOnce.Do(func() {
		log.Printf("[auth] ALLOW_DEV_OTP=1 — OTP delivery may be skipped and DEV_OTP accepted. NEVER set this in production.")
	})
	return true
}

// authDevOtpMatches is the only place DEV_OTP is honoured. Both variables must
// be set: ALLOW_DEV_OTP is the intent, DEV_OTP is the value, and requiring the
// pair means an inherited DEV_OTP alone cannot open the bypass.
func authDevOtpMatches(code string) bool {
	dev := strings.TrimSpace(os.Getenv("DEV_OTP"))
	return dev != "" && code == dev && authDevOtpAllowed()
}

// ── shared send limits ─────────────────────────────────────────────────

// authPhoneSendGate runs the three limits a send and a resend share, in the
// order that matters: the cooldown FIRST, so a double-tapped button costs the
// user a countdown rather than one of their three attempts per hour.
//
// The cooldown is a 1-per-30s fixed window under ConsumeSecure, which also
// means the FIRST send starts it — a resend one second later is refused with
// the remaining wait, which is what the button's timer displays.
func authPhoneSendGate(w http.ResponseWriter, r *http.Request, lookup string) bool {
	ctx := r.Context()
	if cd := redisx.ConsumeSecure(ctx, "otp:phone-resend:"+lookup, 1, authPhoneResendSec); !cd.Allowed {
		authEnvErrRetry(w, 429, "rate_limited", "Wait a moment before asking for another code.", cd.ResetInSec)
		return false
	}
	if perPhone := redisx.Consume(ctx, "otp:phone:"+lookup, 3, 3600); !perPhone.Allowed {
		authEnvErrRetry(w, 429, "rate_limited", "Too many codes requested for this number. Try again later.", perPhone.ResetInSec)
		return false
	}
	if perIP := redisx.Consume(ctx, "otp:phone-ip:"+authClientIP(r), 10, 3600); !perIP.Allowed {
		authEnvErrRetry(w, 429, "rate_limited", "Too many requests. Try again later.", perIP.ResetInSec)
		return false
	}
	return true
}

// authPhoneStart sends a fresh code and records the attempt. Returns the
// request id so the caller can decide what to do with a failure.
func authPhoneStart(ctx context.Context, e164, lookup string) (string, error) {
	// MSG91 wants bare international digits; the '+' is ours, not theirs.
	reqID, err := msg91.Send(ctx, strings.TrimPrefix(e164, "+"))
	if errors.Is(err, msg91.ErrNotConfigured) {
		if !authDevOtpAllowed() {
			return "", err // surfaced as 503 — see the callers
		}
		reqID, err = authPhoneDevReqID, nil
	}
	if err != nil {
		return "", err
	}
	if err := redisx.SetEx(ctx, authPhoneReqKey(lookup), reqID, authPhoneOtpTTLSec); err != nil {
		// A code is already in flight and we cannot verify it. Say so now
		// rather than letting the user type a code that can only fail.
		return "", err
	}
	return reqID, nil
}

// ── POST /auth/onboard/send-otp-phone ──────────────────────────────────

func authOnboardSendOtpPhone(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Phone any `json:"phone"`
	}
	_ = httpx.Body(r, &b)
	e164 := authPhoneE164(b.Phone)
	if e164 == "" {
		authEnvErr(w, 400, "bad_request", "Enter a valid mobile number")
		return
	}
	lookup, err := vault.PhoneLookup(e164)
	if err != nil {
		log.Printf("[auth/onboard/send-otp-phone] %v", err) // e.g. VAULTCHAT_LOOKUP_PEPPER unset
		authEnvErr(w, 500, "server_error", "Could not send code")
		return
	}
	if !authPhoneSendGate(w, r, lookup) {
		return
	}
	if _, err := authPhoneStart(ctx, e164, lookup); err != nil {
		authPhoneSendErr(w, "send-otp-phone", err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "resendInSec": authPhoneResendSec})
}

// ── POST /auth/onboard/resend-otp-phone ────────────────────────────────

// authPhoneChannel maps the app's words to MSG91's magic numbers. An unknown
// value falls back to SMS rather than erroring: "didn't get it?" is the worst
// moment to hand someone a validation failure.
func authPhoneChannel(v any) int {
	switch strings.ToLower(strings.TrimSpace(authStr(v))) {
	case "voice", "call":
		return msg91.ChannelVoice
	case "whatsapp", "wa":
		return msg91.ChannelWhatsApp
	default:
		return msg91.ChannelSMS
	}
}

func authOnboardResendOtpPhone(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Phone   any `json:"phone"`
		Channel any `json:"channel"`
	}
	_ = httpx.Body(r, &b)
	e164 := authPhoneE164(b.Phone)
	if e164 == "" {
		authEnvErr(w, 400, "bad_request", "Enter a valid mobile number")
		return
	}
	lookup, err := vault.PhoneLookup(e164)
	if err != nil {
		log.Printf("[auth/onboard/resend-otp-phone] %v", err)
		authEnvErr(w, 500, "server_error", "Could not send code")
		return
	}
	if !authPhoneSendGate(w, r, lookup) {
		return
	}

	reqID, err := redisx.GetKey(ctx, authPhoneReqKey(lookup))
	if err != nil {
		log.Printf("[auth/onboard/resend-otp-phone] store read failed: %v", err)
		authEnvErr(w, 500, "server_error", "Could not send code")
		return
	}
	// No attempt in flight — the user sat on the screen past the TTL, or came
	// back to it. Starting a new one is what they asked for either way; retrying
	// a dead reqID would just fail.
	if reqID == "" || reqID == authPhoneDevReqID {
		if _, err := authPhoneStart(ctx, e164, lookup); err != nil {
			authPhoneSendErr(w, "resend-otp-phone", err)
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "resendInSec": authPhoneResendSec})
		return
	}
	if err := msg91.Retry(ctx, reqID, authPhoneChannel(b.Channel)); err != nil {
		authPhoneSendErr(w, "resend-otp-phone", err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "resendInSec": authPhoneResendSec})
}

// authPhoneSendErr keeps the delivery failure shapes identical across the send
// and resend paths, and keeps the number out of the log in both. The 503 is
// deliberately distinct from the 502: one is a deployment that never set
// MSG91_AUTH_KEY, the other is MSG91 having a bad day, and telling them apart
// in the log is the difference between a five-minute fix and an outage hunt.
func authPhoneSendErr(w http.ResponseWriter, where string, err error) {
	if errors.Is(err, msg91.ErrNotConfigured) {
		log.Printf("[auth/onboard/%s] MSG91 is not configured — set MSG91_AUTH_KEY and MSG91_WIDGET_ID", where)
		authEnvErr(w, http.StatusServiceUnavailable, "sms_unavailable", "We can't send codes right now. Try again shortly.")
		return
	}
	log.Printf("[auth/onboard/%s] send failed: %v", where, err)
	authEnvErr(w, 502, "sms_failed", "We couldn't send that code. Try again.")
}

// ── POST /auth/onboard/verify-otp-phone ────────────────────────────────

func authOnboardVerifyOtpPhone(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Phone any `json:"phone"`
		Code  any `json:"code"`
	}
	_ = httpx.Body(r, &b)
	e164 := authPhoneE164(b.Phone)
	code := strings.TrimSpace(authStr(b.Code))
	if e164 == "" {
		authEnvErr(w, 400, "bad_request", "Enter a valid mobile number")
		return
	}
	if !sixDigitsRe.MatchString(code) {
		authEnvErr(w, 400, "bad_request", "Enter the 6-digit code")
		return
	}
	lookup, err := vault.PhoneLookup(e164)
	if err != nil {
		log.Printf("[auth/onboard/verify-otp-phone] %v", err)
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	// Same 5-per-15-minutes-per-identity ceiling as every other verify here.
	// MSG91 has its own attempt cap, but it is theirs, not ours, and it does not
	// bound an attacker who walks a list of numbers from one host.
	if ok, retryAfter := authOtpVerifyAllow(r, "verify-otp-phone-v2", lookup); !ok {
		// NOT "request a new code": this gate is keyed on the number, not on the
		// attempt, so a resend does not clear it — and the app runs `retryAfter`
		// down on the resend button itself (app/email-verify.tsx), so the old copy
		// told the user to press a button it had just greyed out. Waiting is the
		// only thing that works, so waiting is what it says.
		authEnvErrRetry(w, http.StatusLocked, "locked", "Too many wrong codes. Wait before trying again.", retryAfter)
		return
	}

	reqID, err := redisx.GetKey(ctx, authPhoneReqKey(lookup))
	if err != nil {
		log.Printf("[auth/onboard/verify-otp-phone] store read failed: %v", err)
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	if reqID == "" {
		authEnvErr(w, 400, "code_expired", "That code has expired. Request a new one.")
		return
	}

	if reqID == authPhoneDevReqID {
		if !authDevOtpMatches(code) {
			authEnvErr(w, 401, "invalid_code", "That code is not right")
			return
		}
	} else if err := msg91.Verify(ctx, reqID, code); err != nil {
		// ErrBadCode is a user mistake, not an outage, and the two need opposite
		// handling — see msg91.Verify, which is also the reason a non-"success"
		// `type` on an HTTP 200 counts as a failure at all.
		if errors.Is(err, msg91.ErrBadCode) {
			authEnvErr(w, 401, "invalid_code", "That code is not right")
			return
		}
		log.Printf("[auth/onboard/verify-otp-phone] provider error: %v", err)
		authEnvErr(w, 502, "sms_failed", "We couldn't check that code. Try again.")
		return
	}

	// Single use. The ticket below is now the proof of ownership; leaving the
	// reqID alive would let the same code be re-verified for a second ticket.
	redisx.DelKey(ctx, authPhoneReqKey(lookup))

	ticket, err := vault.SignTicket(lookup, 900)
	if err != nil {
		log.Printf("[auth/onboard/verify-otp-phone] %v", err)
		authEnvErr(w, 500, "server_error", "Verification failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "phoneTicket": ticket})
}
