// Package msg91 is a SERVER-SIDE client for MSG91's standalone OTP API.
//
// WHY THE STANDALONE OTP API AND NOT THE WIDGET
// ---------------------------------------------
// This was written against MSG91's *widget* endpoints first (/widget/sendOtp,
// /verifyOtp, /retryOtp) and every call came back AuthenticationFailure, with
// both the account authkey and the widget's own tokenAuth, on both hosts, with
// the credential in a header and in the body. The reason is in MSG91's own
// panel, on the widget's "Server Side Integration" page, which documents
// exactly ONE server-side call:
//
//	POST /api/v5/widget/verifyAccessToken   { authkey, access-token }
//
// and introduces it with "use the access token received from the CLIENT SIDE
// integration". That is the whole design: the widget runs on the device, does
// the sending and the verifying itself, and hands back a JWT that the server
// exchanges for the verified identifier. The send/verify endpoints are the
// widget's own private calls — they authenticate through a handshake the widget
// performs (getWidgetProcess), not through an authkey — so there is no way to
// drive them from a server, and no amount of credential-shuffling was going to
// make there be one.
//
// Using the widget as intended would mean shipping @msg91comm/sendotp-react-
// native: a tokenAuth inside the APK, MSG91's panel owning the resend policy
// instead of the limits this backend already enforces, and a native module that
// opens raw sockets to bypass Android cleartext rules and iOS ATS. That was
// declined deliberately, and it is still declined.
//
// So this speaks to the STANDALONE OTP API instead — /api/v5/otp{,/verify,
// /retry} — which is a genuine server-to-server product, authenticates with the
// authkey, and needs nothing on the device. Verified against the live account:
// POST /api/v5/otp returns {"request_id":"…","type":"success"} and a real
// handset receives a code.
//
// THE AUTHKEY IS THE SECRET. It comes from MSG91_AUTH_KEY and never leaves this
// process. Nothing MSG91-related ships in the app bundle.
//
// TWO GOTCHAS THAT COST HOURS, BOTH RECORDED SO NOBODY PAYS AGAIN:
//
//  1. MSG91 RETURNS HTTP 200 FOR LOGICAL FAILURES. "OTP expired" and "OTP not
//     match" both arrive as 200 with {"type":"error"}. Every decision here is
//     made on the `type` field and never on the status code. Gating on res.ok
//     would accept every wrong code, which is the whole ballgame.
//
//  2. `418` means "IP is not whitelisted", NOT a bad key. The message says so
//     once you reach an endpoint that bothers to explain itself; the widget
//     endpoints just say AuthenticationFailure. If sends work and verifies do
//     not, look at the IP allowlist on the authkey in MSG91's panel before
//     suspecting anything here.
package msg91

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Base is the standalone OTP API root. Overridable because MSG91's docs
// disagree with themselves about api. vs control., so a deployment can correct
// it without a code change if they move again.
var Base = envOr("MSG91_BASE_URL", "https://control.msg91.com/api/v5")

// Length of the code we ask MSG91 to generate.
//
// MUST STAY 6. The API's own default is 4, and the whole client is built for
// six: the server rejects anything that is not six digits, and the OTP screen
// renders six cells and auto-submits when they fill. A 4-digit code would never
// fill them — the user would sit on a screen that silently never submits.
const otpLength = 6

// How long a code stays valid, in minutes. Matches what the screen implies.
const otpExpiryMin = 10

// Retry channels for the resend path. The standalone API takes words, not the
// numeric ids the widget SDK used.
const (
	ChannelSMS   = "text"
	ChannelVoice = "voice"
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

func authKey() string { return strings.TrimSpace(os.Getenv("MSG91_AUTH_KEY")) }

// templateID is optional: an account with a default DLT template does not need
// one, and this one does not. Kept because Indian traffic on a second sender
// will, and finding that out at launch is worse than an unused env var.
func templateID() string { return strings.TrimSpace(os.Getenv("MSG91_TEMPLATE_ID")) }

// Configured reports whether OTPs can actually be sent. The widget id is no
// longer part of this — the standalone API does not use one.
func Configured() bool { return authKey() != "" }

// Short timeout on purpose: a user is staring at a spinner, and MSG91 being
// slow should surface as a retryable failure rather than a hung request.
var client = &http.Client{Timeout: 12 * time.Second}

// resp covers every shape these endpoints answer with. `request_id` is only on
// a send; `message` carries the prose on both success and failure.
type resp struct {
	Type      string `json:"type"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

// call performs one request and decides success on `type`, never on status.
func call(ctx context.Context, method, path string, q url.Values) (resp, error) {
	if !Configured() {
		return resp{}, ErrNotConfigured
	}
	u := Base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return resp{}, err
	}
	// Header, not a query parameter. The legacy docs put it in the URL, and a
	// URL carrying a live credential ends up in access logs and proxy traces.
	req.Header.Set("authkey", authKey())
	req.Header.Set("Content-Type", "application/json")

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
		// Unparseable body — the one branch where the status code IS the only
		// signal left, precisely because `type` could not be read.
		return resp{}, fmt.Errorf("msg91 %s: bad response (%d)", path, res.StatusCode)
	}
	// THE ONLY SUCCESS TEST. Not res.StatusCode — see the package note.
	if !strings.EqualFold(out.Type, "success") {
		return out, fmt.Errorf("msg91 %s: %s", path, out.Message)
	}
	return out, nil
}

/*
Send issues a code to `identifier` — a phone number in international form
WITHOUT a leading + (e.g. 919876543210), which is the shape MSG91 wants.

Returns MSG91's request id. The standalone API keys everything on the NUMBER
rather than that id, so nothing downstream strictly needs it — but it is what
their support will ask for, so it is threaded through and stored.
*/
func Send(ctx context.Context, identifier string) (reqID string, err error) {
	q := url.Values{}
	q.Set("mobile", identifier)
	q.Set("otp_length", strconv.Itoa(otpLength))
	q.Set("otp_expiry", strconv.Itoa(otpExpiryMin))
	if t := templateID(); t != "" {
		q.Set("template_id", t)
	}
	out, err := call(ctx, http.MethodPost, "/otp", q)
	if err != nil {
		return "", err
	}
	return out.RequestID, nil
}

/*
Retry re-sends the current code, optionally by voice — the "didn't get it?"
escape hatch, and the one case where a different channel genuinely helps.

MSG91 enforces its own retry ceiling ("OTP retry count maxed out") on top of
whatever the caller enforces. Both matter: theirs protects their platform, ours
protects the bill and the person being messaged.
*/
func Retry(ctx context.Context, identifier, channel string) error {
	if channel != ChannelVoice {
		channel = ChannelSMS
	}
	q := url.Values{}
	q.Set("mobile", identifier)
	q.Set("retrytype", channel)
	_, err := call(ctx, http.MethodGet, "/otp/retry", q)
	return err
}

/*
Verify checks a code against the number it was sent to.

Returns ErrBadCode for a wrong or expired code so the caller can tell a user
error apart from an outage — they need very different handling, and conflating
them is how a wrong code ends up looking like a server fault, or worse, how an
outage ends up looking like a wrong code and burns the user's attempts.
*/
func Verify(ctx context.Context, identifier, code string) error {
	q := url.Values{}
	q.Set("mobile", identifier)
	q.Set("otp", code)
	out, err := call(ctx, http.MethodGet, "/otp/verify", q)
	if err == nil {
		return nil
	}
	// MSG91 phrases these in prose and publishes no codes for them, so matching
	// the message is the only option available. Anything unrecognised stays a
	// generic error, which fails CLOSED — the user is told to try again rather
	// than being let in.
	m := strings.ToLower(out.Message)
	if strings.Contains(m, "not match") || strings.Contains(m, "expired") ||
		strings.Contains(m, "invalid otp") || strings.Contains(m, "incorrect") {
		return ErrBadCode
	}
	return err
}
