// Package msg91 is a SERVER-SIDE client for MSG91's OTP widget REST API.
//
// WHY THE SERVER CALLS THIS AND NOT THE APP
// -----------------------------------------
// MSG91 ships a React Native widget (@msg91comm/sendotp-react-native) that runs
// the whole OTP flow on the device. It is the obvious integration and it is the
// wrong one here, for four reasons:
//
//   1. It needs a `tokenAuth` credential INSIDE the app bundle. That token is
//      scoped (it is not the account authkey) but anyone who unzips the APK can
//      use it to send OTPs on our account — i.e. burn SMS credits and spam
//      numbers. Calling from the server means no MSG91 credential ships at all.
//   2. It owns the resend policy, configured in MSG91's panel rather than in
//      our code — which would bypass the rate limits this backend already
//      enforces (3/phone/hour on send, 5/15min on verify, plus a per-code
//      attempt cap).
//   3. It carries a native module, `RawFetch`, that opens RAW SOCKETS to follow
//      carrier redirects for silent network auth — deliberately bypassing
//      Android's cleartext-traffic rules and iOS ATS. That is an App Review
//      conversation and a Play Data Safety disclosure for a feature we do not
//      use, plus a ProGuard keep rule whose absence fails SILENTLY in release
//      builds only.
//   4. With the widget, the server learns the verified number by exchanging an
//      access token (`verifyAccessToken`) whose lifetime, single-use semantics
//      and replay behaviour MSG91 does not document anywhere. Calling verifyOtp
//      here instead means the server IS the party that verified the code, so
//      there is nothing to replay and nothing to bind after the fact.
//
// THE AUTHKEY IS THE SECRET. It comes from MSG91_AUTH_KEY and never leaves this
// process. `widgetId` is not secret (it names the widget) but is kept here too,
// so the client sends nothing but a phone number and a six-digit code.
//
// GOTCHA THAT WILL BITE ANYONE EDITING THIS: **MSG91 RETURNS HTTP 200 FOR
// LOGICAL FAILURES.** "OTP expired" and "OTP not match" both arrive as 200 with
// `{"type":"error"}`. Every decision here is made on the `type` field and never
// on the status code. Gating on res.ok would treat a wrong code as a correct
// one, which is the whole ballgame.
package msg91

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Base is MSG91's widget API root.
//
// Their docs are inconsistent about the host (api.msg91.com vs
// control.msg91.com) and about whether the authkey goes in a header or the
// body. We send the header form against api.msg91.com, which is what the
// current docs show, and make it overridable so a deployment can correct it
// without a code change if MSG91 moves again.
var Base = envOr("MSG91_BASE_URL", "https://api.msg91.com/api/v5/widget")

// Retry channels, from the widget SDK's own source.
const (
	ChannelSMS      = 11
	ChannelVoice    = 4
	ChannelEmail    = 3
	ChannelWhatsApp = 12
)

var (
	// ErrNotConfigured means no credentials — the caller should degrade to the
	// existing dev path rather than reporting a failure to the user.
	ErrNotConfigured = errors.New("msg91 is not configured")
	// ErrBadCode is a WRONG or EXPIRED code. It is a normal outcome, not a
	// fault, and must be reported to the user as "that code is not right"
	// rather than "something went wrong".
	ErrBadCode = errors.New("msg91: incorrect or expired code")
)

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func authKey() string  { return strings.TrimSpace(os.Getenv("MSG91_AUTH_KEY")) }
func widgetID() string { return strings.TrimSpace(os.Getenv("MSG91_WIDGET_ID")) }

// Configured reports whether OTPs can actually be sent.
func Configured() bool { return authKey() != "" && widgetID() != "" }

// Short timeout on purpose: a user is staring at a spinner, and MSG91 being
// slow should surface as a retryable failure rather than a hung request.
var client = &http.Client{Timeout: 12 * time.Second}

// resp is the shape every widget endpoint answers with.
type resp struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func post(ctx context.Context, path string, body map[string]any) (resp, error) {
	if !Configured() {
		return resp{}, ErrNotConfigured
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return resp{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Base+path, bytes.NewReader(raw))
	if err != nil {
		return resp{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("authkey", authKey())

	res, err := client.Do(req)
	if err != nil {
		return resp{}, err
	}
	defer res.Body.Close()
	// Capped read: a proxy error page must not become an unbounded allocation.
	payload, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return resp{}, err
	}

	var out resp
	if err := json.Unmarshal(payload, &out); err != nil {
		// Unparseable body. Include the status because at this point it IS the
		// only signal we have — but note this is the one branch where status
		// matters, precisely because `type` was unreadable.
		return resp{}, fmt.Errorf("msg91 %s: bad response (%d)", path, res.StatusCode)
	}
	// THE ONLY SUCCESS TEST. Not res.StatusCode — see the package note.
	if !strings.EqualFold(out.Type, "success") {
		return out, fmt.Errorf("msg91 %s: %s", path, out.Message)
	}
	return out, nil
}

/*
Send starts a verification for `identifier` (a phone number in international
form WITHOUT a leading +, e.g. 919876543210 — the form MSG91 uses).

Returns MSG91's request id, which every later call for this attempt needs. The
caller is responsible for holding it against the phone for the life of the
attempt; it is not a secret, but it IS a capability to resend, so it should not
be handed to the client.
*/
func Send(ctx context.Context, identifier string) (reqID string, err error) {
	out, err := post(ctx, "/sendOtp", map[string]any{
		"widgetId":   widgetID(),
		"identifier": identifier,
	})
	if err != nil {
		return "", err
	}
	if out.Message == "" {
		return "", errors.New("msg91 sendOtp: no request id returned")
	}
	return out.Message, nil
}

/*
Retry re-sends the code for an in-flight attempt, optionally over a different
channel (voice, WhatsApp) — which is the "didn't get it?" escape hatch.

MSG91 enforces its own retry ceiling ("OTP retry count maxed out") on top of
whatever the caller enforces. Both matter: theirs protects their platform, ours
protects our bill and the person being messaged.
*/
func Retry(ctx context.Context, reqID string, channel int) error {
	body := map[string]any{"widgetId": widgetID(), "reqId": reqID}
	if channel > 0 {
		body["retryChannel"] = channel
	}
	_, err := post(ctx, "/retryOtp", body)
	return err
}

/*
Verify checks a code against an in-flight attempt.

Returns ErrBadCode for a wrong or expired code so the caller can tell a user
error apart from an outage — they need very different handling, and conflating
them is how a wrong code ends up looking like a server fault (or worse, how an
outage ends up looking like a wrong code and burns the user's attempts).
*/
func Verify(ctx context.Context, reqID, code string) error {
	out, err := post(ctx, "/verifyOtp", map[string]any{
		"widgetId": widgetID(),
		"reqId":    reqID,
		"otp":      code,
	})
	if err == nil {
		return nil
	}
	// MSG91 phrases these in prose and does not publish codes, so matching the
	// message is the only option available. Anything unrecognised stays a
	// generic error, which fails CLOSED — the user is told to try again rather
	// than being let in.
	m := strings.ToLower(out.Message)
	if strings.Contains(m, "not match") || strings.Contains(m, "expired") ||
		strings.Contains(m, "invalid otp") || strings.Contains(m, "incorrect") {
		return ErrBadCode
	}
	return err
}
