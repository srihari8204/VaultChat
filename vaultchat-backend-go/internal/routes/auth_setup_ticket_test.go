package routes

import (
	"os"
	"strings"
	"testing"

	"vaultchat/backend-go/internal/vault"
)

// The regression this guards: /auth/mpin/set and /auth/security-questions/save
// used to trust a userId read straight out of the request body, so anyone who
// could name a userId could overwrite that account's login PIN and then trade
// it for a session. Both now require a setup ticket bound to the id, minted
// only by /auth/profile/init after the email OTP.
//
// Each case below is one way the old code fell over.
func TestSetupTicketBinding(t *testing.T) {
	t.Setenv("VAULTCHAT_LOOKUP_PEPPER", "test-pepper-value")

	const victim = "11111111-1111-1111-1111-111111111111"
	const attacker = "22222222-2222-2222-2222-222222222222"

	ticket, err := vault.SignTicket(authSetupTicketData(victim), 900)
	if err != nil {
		t.Fatalf("SignTicket: %v", err)
	}

	// The legitimate onboarding client: same id it was minted for.
	if !vault.VerifyTicket(ticket, authSetupTicketData(victim)) {
		t.Error("a freshly minted setup ticket must verify for its own userId — onboarding is broken")
	}

	// THE TAKEOVER. An attacker mid-onboarding holds a valid ticket for their
	// own account and swaps the body userId to the victim's. This is the whole
	// attack, and it must not verify.
	if vault.VerifyTicket(ticket, authSetupTicketData(attacker)) {
		t.Error("setup ticket verified for a DIFFERENT userId — horizontal account takeover is open")
	}

	// No ticket at all: exactly what the vulnerable version accepted.
	if vault.VerifyTicket("", authSetupTicketData(victim)) {
		t.Error("empty setup ticket accepted — the endpoint is effectively ungated")
	}

	// A ticket minted for a different PURPOSE must not be reusable here. The
	// recovery ticket is the dangerous one: /security-questions/verify hands it
	// out to anyone who answers the questions, and if the prefixes collided it
	// would unlock first-set too.
	recovery, err := vault.SignTicket("recover:"+victim, 900)
	if err != nil {
		t.Fatalf("SignTicket(recover): %v", err)
	}
	if vault.VerifyTicket(recovery, authSetupTicketData(victim)) {
		t.Error("a recovery ticket satisfied the setup gate — ticket purposes have collided")
	}

	// Tampering with the id inside the token invalidates the signature.
	if vault.VerifyTicket(ticket+"x", authSetupTicketData(victim)) {
		t.Error("tampered setup ticket accepted")
	}

	// Expiry is enforced, so a leaked ticket dies with its window.
	expired, err := vault.SignTicket(authSetupTicketData(victim), -1)
	if err != nil {
		t.Fatalf("SignTicket(expired): %v", err)
	}
	if vault.VerifyTicket(expired, authSetupTicketData(victim)) {
		t.Error("expired setup ticket accepted")
	}
}

// The Go and Node backends must agree byte-for-byte on the binding string, or a
// client onboarded against one cannot finish against the other.
func TestSetupTicketDataFormat(t *testing.T) {
	if got := authSetupTicketData("abc"); got != "setup:abc" {
		t.Errorf("binding drifted from the Node backend's `setup:${userId}`: got %q", got)
	}
}

// TestCredentialWritersAreGated reads the source, because the bug this replaces
// was not a wrong result from a function — it was a missing CALL. The binding
// tests above would all have passed against the vulnerable code. This is the
// one that would have failed.
//
// Every pre-auth handler that writes a credential must verify SOMETHING before
// it writes. Deleting a gate makes this fail; adding a new ungated
// credential-writer to the list makes it fail too.
func TestCredentialWritersAreGated(t *testing.T) {
	src, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatalf("read auth.go: %v", err)
	}
	for _, fn := range preAuthCredentialWriters {
		gated, found := handlerContains(string(src), fn, "vault.VerifyTicket(")
		if !found {
			t.Errorf("%s not found — renamed? this guard must be updated with it", fn)
			continue
		}
		if !gated {
			t.Errorf("%s writes a credential with NO vault.VerifyTicket call — "+
				"this is the account-takeover shape: userId comes from the request body "+
				"and nothing proves the caller owns it", fn)
		}
	}

	// The OTP endpoint mints the ticket everything else keys off, so unlimited
	// guessing there unravels the whole chain.
	limited, found := handlerContains(string(src), "authOnboardVerifyOtp", "redisx.Consume(")
	if !found {
		t.Fatal("authOnboardVerifyOtp not found")
	}
	if !limited {
		t.Error("authOnboardVerifyOtp has no rate limit — a 6-digit code with unlimited " +
			"attempts is not a check, and it gates email ownership for the whole flow")
	}
}

// Handlers in the pre-auth /auth router that write something a later request
// can trade for a session.
var preAuthCredentialWriters = []string{
	"authMpinSet",               // writes mpin_hash → /mpin/verify issues JWTs
	"authSecurityQuestionsSave", // writes answer_hash → /mpin/recover issues JWTs
	"authProfileInit",           // creates the account
	"authMpinRecover",           // resets mpin_hash
}

// handlerContains reports whether fn's body contains needle. Bodies run to the
// next top-level func, which is unambiguous in gofmt'd source: nested closing
// braces are indented, only a declaration starts at column zero.
func handlerContains(src, fn, needle string) (has, found bool) {
	start := strings.Index(src, "func "+fn+"(")
	if start < 0 {
		return false, false
	}
	end := strings.Index(src[start+1:], "\nfunc ")
	if end < 0 {
		end = len(src) - start - 1
	}
	return strings.Contains(src[start:start+1+end], needle), true
}

// Proves the scan above can actually FAIL. Without this, a detector that
// silently matched everything (or nothing) would report a clean bill of health
// on genuinely vulnerable source, which is the exact failure mode a security
// guard must not have.
func TestHandlerContainsDetectsAnUngatedWriter(t *testing.T) {
	const vulnerable = `package routes

func authMpinSet(w http.ResponseWriter, r *http.Request) {
	userID := authStr(b.UserID)
	if authIsWeakMpin(mpin) {
		return
	}
	db.Pool.Exec(ctx, ` + "`UPDATE users SET mpin_hash = $1 WHERE id = $2`" + `, hash, userID)
}

func authMpinRecover(w http.ResponseWriter, r *http.Request) {
	if !vault.VerifyTicket(authStr(b.RecoveryTicket), "recover:"+userID) {
		return
	}
}
`
	// This is the shipped-and-exploitable version of authMpinSet. The scan must
	// call it out.
	if has, found := handlerContains(vulnerable, "authMpinSet", "vault.VerifyTicket("); !found || has {
		t.Errorf("scan passed an ungated authMpinSet (found=%v, gated=%v) — it cannot detect the bug it exists for", found, has)
	}
	// ...and must not cross the boundary into the NEXT function, which is
	// gated. A body-slicing bug would show up here as a false clean.
	if has, found := handlerContains(vulnerable, "authMpinRecover", "vault.VerifyTicket("); !found || !has {
		t.Errorf("scan missed a gate that is present (found=%v, gated=%v)", found, has)
	}
	// A handler that does not exist must report not-found, never a silent pass.
	if _, found := handlerContains(vulnerable, "authNoSuchHandler", "x"); found {
		t.Error("scan claimed to find a handler that is not there")
	}
}
