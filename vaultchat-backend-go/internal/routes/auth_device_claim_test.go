package routes

import (
	"net/http/httptest"
	"testing"

	"vaultchat/backend-go/internal/httpx"
)

// The `dev` claim is the thing that makes a device id TRUSTWORTHY.
//
// X-Device-Id is client-asserted on every request, so a guard keyed on the
// header is no guard at all — anyone can send someone else's id.
// docs/LINKED_DEVICES_PLAN.md puts it as "a guard keyed on an unauthenticated
// header is worse than no guard", which is exactly why it declines to read
// user_devices until this claim exists.
//
// The claim closes that: the id is read from the header ONCE, at login, when the
// client is legitimately naming its own install, and is signed into the token
// from then on. Every later request carries a signed claim.
//
// Two properties have to hold together or the change is unsafe:
//
//   1. a valid id round-trips, so per-device handlers can rely on it;
//   2. an ABSENT or malformed id yields "" rather than an error, because "" is
//      migration 140's legacy `device_id = ''` row and every token minted before
//      this claim existed has no `dev`. Rejecting those would log out the field.

func TestDeviceClaimRoundTrips(t *testing.T) {
	t.Setenv("JWT_SECRET", "device-claim-test-secret")

	const dev = "a1b2c3d4e5f60718" // 16 hex, the shortest the validator accepts
	tok, err := authSignAccess("user-1", nil, dev)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sub, _, gotDev, err := httpx.VerifyAccess(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if sub != "user-1" {
		t.Errorf("sub = %q, want user-1", sub)
	}
	if gotDev != dev {
		t.Errorf("dev claim = %q, want %q", gotDev, dev)
	}
}

// A token with NO device id must verify and report "", not fail. This is the
// shape of every token already in the field.
func TestTokenWithoutDeviceClaimStillVerifies(t *testing.T) {
	t.Setenv("JWT_SECRET", "device-claim-test-secret")

	tok, err := authSignAccess("user-2", nil, "")
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sub, _, dev, err := httpx.VerifyAccess(tok)
	if err != nil {
		t.Fatalf("a token minted before the dev claim existed must still verify: %v", err)
	}
	if sub != "user-2" {
		t.Errorf("sub = %q, want user-2", sub)
	}
	if dev != "" {
		t.Errorf("dev = %q, want \"\" so handlers use the legacy device_id row", dev)
	}
}

// What authDeviceID will and will not sign. Anything it refuses must come back
// as "" — a dropped id, not a rejected login.
func TestAuthDeviceIDValidation(t *testing.T) {
	cases := []struct {
		name, header, want string
	}{
		{"valid 64-hex", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
		{"valid 16-hex", "0123456789abcdef", "0123456789abcdef"},
		{"uppercase is normalised", "ABCDEF0123456789", "abcdef0123456789"},
		{"surrounding space trimmed", "  abcdef0123456789  ", "abcdef0123456789"},
		{"absent", "", ""},
		{"too short", "abc123", ""},
		{"too long", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef00", ""},
		{"non-hex", "zzzzzzzzzzzzzzzz", ""},
		// The ones that matter: a signed claim must never carry smuggled content.
		{"sql-ish", "abcdef0123456789' OR '1'='1", ""},
		{"path traversal", "../../etc/passwd", ""},
		{"newline injection", "abcdef0123456789\nX-Admin: 1", ""},
		{"json fragment", `{"dev":"abcdef0123456789"}`, ""},
		{"unicode confusable", "аbcdef0123456789", ""}, // leading Cyrillic 'а'
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/auth/login", nil)
			if c.header != "" {
				r.Header.Set("X-Device-Id", c.header)
			}
			if got := authDeviceID(r); got != c.want {
				t.Errorf("authDeviceID(%q) = %q, want %q", c.header, got, c.want)
			}
		})
	}
}

// A rejected device id must not become a signed claim. Belt and braces over the
// validator: this asserts the OUTPUT of signing, so a future refactor that
// bypasses authDeviceID still fails here.
func TestMalformedDeviceIDNeverReachesTheToken(t *testing.T) {
	t.Setenv("JWT_SECRET", "device-claim-test-secret")

	r := httptest.NewRequest("POST", "/auth/login", nil)
	r.Header.Set("X-Device-Id", "not-a-valid-device-id")
	tok, err := authSignAccess("user-3", nil, authDeviceID(r))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, _, dev, err := httpx.VerifyAccess(tok); err != nil || dev != "" {
		t.Errorf("dev = %q (err %v), want \"\" — a malformed header must not be signed", dev, err)
	}
}

// nil request: authIssueTokens is the only caller and always has one, but a
// helper that panics on nil is a trap for the next caller.
func TestAuthDeviceIDNilRequest(t *testing.T) {
	if got := authDeviceID(nil); got != "" {
		t.Errorf("authDeviceID(nil) = %q, want \"\"", got)
	}
}
