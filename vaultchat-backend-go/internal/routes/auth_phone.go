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

// authPhoneHourKey is the 3-per-hour-per-number bucket. Named because the
// refund path has to charge and un-charge the SAME key, and two string
// literals that must stay in step are one edit away from not being.
func authPhoneHourKey(lookup string) string { return "otp:phone:" + lookup }

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
//
// ALL THREE ARE ConsumeSecure, none is Consume. The per-number and per-IP
// limits used to fail OPEN, which is the trade redisx.Consume documents for
// "you are posting comments too fast" — a cache outage must not lock a real
// user out of a harmless action. This is not that: the thing on the other side
// of these two buckets is an SMS bill and a stranger's handset, so with Redis
// down the only surviving limit was the per-process cooldown and one host could
// walk a list of numbers at 2/minute each, indefinitely and in parallel. The
// in-process fallback is the right answer to an outage here; "no limit" is not.
//
// ponytail: that fallback is per-process, so N replicas means N × limit during
// a Redis outage (redisx's own note). Bounded and small beats unbounded; make
// the fallback shared if this ever runs more than one replica in anger.
func authPhoneSendGate(w http.ResponseWriter, r *http.Request, lookup string) bool {
	ctx := r.Context()
	if cd := redisx.ConsumeSecure(ctx, "otp:phone-resend:"+lookup, 1, authPhoneResendSec); !cd.Allowed {
		authEnvErrRetry(w, 429, "rate_limited", "Wait a moment before asking for another code.", cd.ResetInSec)
		return false
	}
	if perPhone := redisx.ConsumeSecure(ctx, authPhoneHourKey(lookup), 3, 3600); !perPhone.Allowed {
		authEnvErrRetry(w, 429, "rate_limited", "Too many codes requested for this number. Try again later.", perPhone.ResetInSec)
		return false
	}
	if perIP := redisx.ConsumeSecure(ctx, "otp:phone-ip:"+authClientIP(r), 10, 3600); !perIP.Allowed {
		authEnvErrRetry(w, 429, "rate_limited", "Too many requests. Try again later.", perIP.ResetInSec)
		return false
	}
	return true
}

// authPhoneRefundSend hands back the hourly allowance for a send that never
// reached anybody — MSG91 unconfigured (503) or MSG91 having a bad day (502).
// Charging for those is how three provider blips lock a real person out for an
// hour having received nothing, which was observed in production: a 503 from
// send-otp-phone still made the next resend answer 429.
//
// ONLY the per-number hourly bucket is refunded:
//   - the 30s COOLDOWN stays charged. It exists to absorb a double-tapped
//     button, and a cooldown that a failed send refunds is not a cooldown — the
//     failing case is exactly when the user taps fastest.
//   - the per-IP hourly bucket stays charged. It meters a HOST, not a person,
//     and refunding it would give anyone who can make the provider call fail
//     an unmetered channel.
func authPhoneRefundSend(ctx context.Context, lookup string) {
	if err := redisx.RefundSecure(ctx, authPhoneHourKey(lookup)); err != nil {
		// Never fatal to the request: the user is already getting an error, and
		// the only cost is one allowance staying spent. Logged so a systematic
		// refund failure is visible rather than showing up as mystery 429s.
		log.Printf("[auth/onboard] hourly send allowance not refunded: %v", err)
	}
}

// authPhoneStart sends a fresh code and records the attempt. Returns the
// request id so the caller can decide what to do with a failure.
func authPhoneStart(ctx context.Context, e164, lookup string) (string, error) {
	// MSG91 wants bare international digits; the '+' is ours, not theirs.
	reqID, err := msg91.Send(ctx, strings.TrimPrefix(e164, "+"))
	if errors.Is(err, msg91.ErrNotConfigured) && authDevOtpAllowed() {
		reqID, err = authPhoneDevReqID, nil
	}
	if err != nil {
		// Nothing was delivered — not an unconfigured deployment (503), not a
		// provider that refused (502). Give the hourly allowance back; this is
		// THE place that can tell those apart from the store failure below.
		authPhoneRefundSend(ctx, lookup)
		return "", err // 503 or 502 — see authPhoneSendErr
	}
	if err := redisx.SetEx(ctx, authPhoneReqKey(lookup), reqID, authPhoneOtpTTLSec); err != nil {
		// A code is already in flight and we cannot verify it. Say so now
		// rather than letting the user type a code that can only fail.
		//
		// NO REFUND here, deliberately: MSG91 accepted the send, so a message is
		// on its way to that handset. It cost real money and it rang a real
		// phone, so it counts against the hourly allowance even though we lost
		// the handle needed to check the code.
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
	// The first send has no channel to choose from: /sendOtp uses the widget's
	// configured one. Stated anyway so both endpoints answer the same shape.
	authPhoneSent(w, "sms", "")
}

// ── POST /auth/onboard/resend-otp-phone ────────────────────────────────

// authPhoneChannel maps the app's words to the channels MSG91's standalone OTP
// API actually has. An unknown value falls back to SMS rather than erroring:
// "didn't get it?" is the worst possible moment to hand someone a validation
// failure.
//
// WHATSAPP IS GONE, AND THE SECOND RETURN VALUE IS WHY IT MATTERS. The widget
// API had a WhatsApp retry channel; the standalone API has `text` and `voice`
// and nothing else. The client still offers WhatsApp — deliberately, because
// removing a working-looking option is worse than telling the truth about it —
// so a WhatsApp request resolves to SMS and the canonical name comes back as
// "sms". authPhoneSent then reports requestedChannel/channelFallback, and the
// user is told the code went by text instead of silently wondering why no
// WhatsApp message arrived.
func authPhoneChannel(v any) (string, string) {
	switch strings.ToLower(strings.TrimSpace(authStr(v))) {
	case "voice", "call":
		return msg91.ChannelVoice, "voice"
	default:
		return msg91.ChannelSMS, "sms"
	}
}

// authPhoneSent is the success body for both send and resend.
//
// `channel` is what actually went out, which is not always what was asked for:
// MSG91's widget API puts channel selection on /retryOtp ONLY — /sendOtp takes
// widgetId and identifier and nothing else (confirmed against MSG91's own SDKs;
// their `retryChannel` codes live on retry). So a fresh attempt always leaves
// over whatever the widget is configured for, i.e. SMS.
//
// When the two differ, `channelFallback` says so and `requestedChannel` says
// what the user actually pressed. Silently texting someone who pressed "Call me
// with the code" is the worst version of this: they chose voice BECAUSE the SMS
// is not arriving, and a silent SMS looks to them like the button does nothing.
func authPhoneSent(w http.ResponseWriter, sent, requested string) {
	body := map[string]any{"ok": true, "resendInSec": authPhoneResendSec, "channel": sent}
	if requested != "" && requested != sent {
		body["requestedChannel"] = requested
		body["channelFallback"] = true
	}
	httpx.JSON(w, 200, body)
}

func authOnboardResendOtpPhone(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Phone   any `json:"phone"`
		Channel any `json:"channel"`
	}
	_ = httpx.Body(r, &b)
	e164 := authPhoneE164(b.Phone)
	want, wantName := authPhoneChannel(b.Channel)
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
		// A fresh attempt cannot honour `channel` — /sendOtp has no such
		// parameter, only /retryOtp does, and there is no live reqId left to
		// retry. The code goes out by SMS; authPhoneSent tells the client that
		// happened instead of pretending the request was honoured.
		authPhoneSent(w, "sms", wantName)
		return
	}
	if err := msg91.Retry(ctx, strings.TrimPrefix(e164, "+"), want); err != nil {
		// Same reasoning as authPhoneStart: the provider refused, nothing was
		// delivered, so the hourly allowance charged by the gate is given back.
		authPhoneRefundSend(ctx, lookup)
		authPhoneSendErr(w, "resend-otp-phone", err)
		return
	}
	authPhoneSent(w, wantName, wantName)
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
		// THE NUMBER, NOT THE REQUEST ID. The standalone OTP API keys a
		// verification on the mobile it was sent to; the widget API keyed it on a
		// reqId, and this call site kept passing reqID after the switch. Both are
		// strings, so the compiler said nothing and MSG91 answered "Mobile no.
		// empty or not numeric" — which surfaced to the user as a 502 outage on
		// every single correct code. The reqID is still what proves an attempt is
		// in flight (checked above); it is just not what identifies it.
	} else if err := msg91.Verify(ctx, strings.TrimPrefix(e164, "+"), code); err != nil {
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
