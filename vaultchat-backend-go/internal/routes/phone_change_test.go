package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// F4 — CHANGING YOUR NUMBER HAS TO MOVE THE WHOLE IDENTITY.
//
// A phone number lives in four columns since migration 042, and they do
// different jobs:
//
//	phone_cipher   what the profile DISPLAYS
//	phone_lookup   what resolves an account at login, what invitations match
//	               on, and what membership-by-lookup uses
//	phone_hash     contact discovery
//	phone          the legacy plaintext column
//
// The linking branch of /auth/verify-otp-phone updated only `phone` and
// `phone_hash`. So "change your number" moved discovery and left login,
// invitations, group membership and the user's own displayed number pointing at
// the old one — an account answering to two numbers, inconsistently. A number
// change that half-applies is worse than one that is refused.

func phoneChangeSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestPhoneChangeMovesEveryIdentityColumn(t *testing.T) {
	src := phoneChangeSource(t)

	// The UPDATE that carries the change must name all four columns. Anything
	// missing is a column left pointing at the previous number.
	update := regexp.MustCompile(`UPDATE users\s*\n?\s*SET phone = \$1, phone_hash = \$2, phone_lookup = \$3, phone_cipher = \$4`)
	if !update.MatchString(src) {
		t.Error("the number change no longer writes all four identity columns in one statement")
	}

	// One statement, not several: a multi-step write leaves a window where the
	// columns disagree, and a failure halfway leaves it permanent.
	if strings.Contains(src, "UPDATE users SET phone = $1, phone_hash = $2 WHERE id = $3") {
		t.Error("the old partial update is back — it moves discovery but not login")
	}
}

func TestPhoneChangeRefusesANumberAlreadyInUse(t *testing.T) {
	src := phoneChangeSource(t)

	// Checking phone_hash alone is not enough: a number that is already
	// somebody's LOGIN but predates the discovery hash would pass the check and
	// produce two accounts answering to one number.
	conflict := regexp.MustCompile(`WHERE \(phone_hash = \$1 OR \(\$3 <> '' AND phone_lookup = \$3\)\)`)
	if !conflict.MatchString(src) {
		t.Error("the duplicate check no longer covers phone_lookup as well as phone_hash")
	}
	if !strings.Contains(src, "Phone already linked to another account") {
		t.Error("the conflict no longer returns a distinguishable error")
	}
}

func TestPhoneChangeFailsClosedWithoutCrypto(t *testing.T) {
	src := phoneChangeSource(t)

	// vault.PhoneLookup and vault.Encrypt need the pepper and master key. If
	// either is unavailable the change must be REFUSED, not applied partially —
	// a half-written identity is the exact failure this test exists to prevent.
	guard := regexp.MustCompile(`if lerr != nil \|\| cerr != nil \{[\s\S]{0,240}?httpx\.Err\(w, 500`)
	if !guard.MatchString(src) {
		t.Error("a crypto failure no longer aborts the change before writing")
	}
}
