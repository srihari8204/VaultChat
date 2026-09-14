package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"vaultchat/backend-go/internal/vault"
)

// The one thing that silently kills contact discovery is the client and the
// server disagreeing on how a phone number becomes a hash. There is no error
// when they diverge — /contacts/match just returns an empty list forever.
//
// Client half (lib/chatService.ts normalizePhoneForHash + hashPhoneForLookup):
//     digits = raw.replace(/\D/g,''); if (digits.length === 10) digits = '91'+digits
//     h = sha256(digits), lowercase hex
// Server half (auth.go authNormalizePhone/authDiscoveryPhoneHash, and
// contacts.go on the lookup side):
//     H = HMAC-SHA256(PEPPER, h)  -> this is what users.phone_hash stores.
//
// These vectors are the client's output for a known number, computed by the
// TS rules above. If someone changes either side's normalization, this fails.
func TestDiscoveryHashMatchesClient(t *testing.T) {
	// clientHash mirrors lib/chatService.ts exactly.
	clientHash := func(digits string) string {
		sum := sha256.Sum256([]byte(digits))
		return hex.EncodeToString(sum[:])
	}

	cases := []struct{ raw, wantDigits string }{
		{"9876543210", "919876543210"},       // bare 10-digit -> 91 prefix
		{"+91 98765 43210", "919876543210"},  // E.164 with spaces -> same
		{"+91-98765-43210", "919876543210"},  // punctuation stripped
		{"919876543210", "919876543210"},     // already prefixed, untouched
		{"(987) 654-3210", "919876543210"},   // US-style punctuation, still 10 digits
	}

	// Every spelling of the same number must normalize to one digit string,
	// so every spelling must produce one client hash...
	want := clientHash("919876543210")
	for _, c := range cases {
		got := authNormalizePhone(c.raw)
		if got != c.wantDigits {
			t.Errorf("authNormalizePhone(%q) = %q, want %q", c.raw, got, c.wantDigits)
			continue
		}
		if h := clientHash(got); h != want {
			t.Errorf("client hash for %q = %s, want %s", c.raw, h, want)
		}
	}

	// ...and the server's stored value must be the pepper applied to exactly
	// that client hash — not to the digits, and not to anything else. This is
	// the invariant /contacts/match depends on: it peppers what the client
	// sent and compares against the column written at signup.
	t.Setenv("VAULTCHAT_LOOKUP_PEPPER", "test-pepper-for-discovery-hash-agreement")

	stored, err := authDiscoveryPhoneHash("+91 98765 43210")
	if err != nil {
		t.Fatalf("authDiscoveryPhoneHash: %v", err)
	}
	viaMatch, err := vault.DiscoveryHash(want)
	if err != nil {
		t.Fatalf("vault.DiscoveryHash: %v", err)
	}
	if stored != viaMatch {
		t.Fatalf("signup wrote %s but /contacts/match would look up %s —\n"+
			"discovery is broken: every existing user would stop matching", stored, viaMatch)
	}

	// And the login-side hasher must agree with the signup-side one.
	viaAuth, err := authHashPhone("919876543210")
	if err != nil {
		t.Fatalf("authHashPhone: %v", err)
	}
	if viaAuth != stored {
		t.Fatalf("authHashPhone = %s, authDiscoveryPhoneHash = %s — the two write paths diverged",
			viaAuth, stored)
	}
}

// The per-account hash quota is the thing standing between discovery and a
// directory-enumeration oracle, so pin the numbers rather than let someone
// "tidy" them upward. 5 req/min x 5000 hashes is 36M hashes/day if only the
// call limiter applies; the quota must be far below that and at least one
// full address book.
func TestMatchHashQuotaIsSane(t *testing.T) {
	if matchHashesPerDay >= 5*60*24*maxHashesPerRequest {
		t.Fatal("hash quota is above what the call limiter already allows — it does nothing")
	}
	if matchHashesPerDay < maxHashesPerRequest {
		t.Fatal("hash quota is below one full address book — a normal user cannot sync")
	}
	if matchQuotaWindow != 86400 {
		t.Fatalf("quota window = %d, expected a 1-day window", matchQuotaWindow)
	}
}
