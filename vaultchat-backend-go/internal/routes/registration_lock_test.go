package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// F7 — REGISTRATION LOCK.
//
// An SMS code proves control of a NUMBER, not that you are the person whose
// account that number belongs to. The gap between those two is a SIM swap, and
// /auth/verify-otp-phone used to issue full session tokens across it: whoever
// received the code got the account, its chats and its history.
//
// The lock closes that for accounts that have an MPIN, by sending the caller to
// /auth/mpin/verify — which already exists and is already rate-limited.

func regLockSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRegistrationLockStopsTokensForAProtectedAccount(t *testing.T) {
	src := regLockSource(t)

	guard := regexp.MustCompile(`if !isNewUser && user\.MpinHash != nil && \*user\.MpinHash != ""`)
	if !guard.MatchString(src) {
		t.Fatal("the registration lock is gone from the phone-signup path")
	}

	// The guard must RETURN before tokens are minted. A lock that runs after
	// authIssueTokens protects nothing — the session already exists.
	loc := guard.FindStringIndex(src)
	after := src[loc[1]:]
	ret := strings.Index(after, "return")
	issue := strings.Index(after, "authIssueTokens")
	if ret < 0 || (issue >= 0 && issue < ret) {
		t.Error("the lock does not return before session tokens are issued")
	}
	if !strings.Contains(after[:ret+10], `"registrationLock": true`) {
		t.Error("the response no longer tells the client a lock is in force")
	}
}

// The lock must NOT apply to an account with no MPIN. Such an account has no
// second factor to offer, so demanding one would lock its owner out for good
// rather than protect anyone.
func TestRegistrationLockDoesNotStrandAccountsWithoutAnMpin(t *testing.T) {
	src := regLockSource(t)
	if !strings.Contains(src, `user.MpinHash != nil && *user.MpinHash != ""`) {
		t.Error("the lock no longer checks that an MPIN actually exists first")
	}
	// isNewUser must be part of the condition: a brand-new account created by
	// this very request cannot have an MPIN, and locking it would make
	// signup-by-phone impossible.
	if !strings.Contains(src, "if !isNewUser && user.MpinHash") {
		t.Error("the lock no longer exempts a newly created account")
	}
}

// The second factor has to be a RATE-LIMITED one, or the lock just moves the
// attack from an SMS to a six-digit brute force.
func TestRegistrationLockSecondFactorIsRateLimited(t *testing.T) {
	src := regLockSource(t)
	if !strings.Contains(src, `redisx.ConsumeSecure(ctx, "mpin:"+userID, 5, 900)`) {
		t.Error("the MPIN endpoint the lock delegates to is no longer rate-limited by ConsumeSecure")
	}
}

// A lock event is worth recording: repeated hits on one account are the signal
// that somebody is working through a stolen number.
func TestRegistrationLockIsAudited(t *testing.T) {
	src := regLockSource(t)
	if !strings.Contains(src, `"registration_lock"`) {
		t.Error("registration-lock hits are no longer audited")
	}
}
