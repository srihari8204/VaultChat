package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// OTP VERIFY — BRUTE FORCE.
//
// The attempts column never bounded guessing: it was read in one statement and
// incremented in another, so N concurrent requests all saw attempts = 0, all
// passed the cap and all had their guess evaluated. A 6-digit code is a million
// guesses; with enough parallelism that is minutes, not years.
//
// Two things close it, and both are asserted here because either alone is
// insufficient: a rate limiter in front (the actual bound), and the cap folded
// into the UPDATE so the counter cannot be over-spent by a race.
//
// THE RACE ITSELF IS NOT EXERCISED — it needs a live Postgres and concurrent
// requests. These are SOURCE-LEVEL assertions on the shape of the fix.

func otpVerifySource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatal(err)
	}
	return stripLineComments(string(b))
}

func TestOtpVerifyHandlersAreRateLimited(t *testing.T) {
	src := otpVerifySource(t)

	// The gate must fail CLOSED. Consume fails open by design; a Redis outage
	// must not lift a brute-force limit on a six-digit secret.
	if !strings.Contains(src, "redisx.ConsumeSecure(ctx, scope+\":\"+id, 5, 900)") ||
		!strings.Contains(src, "redisx.ConsumeSecure(ctx, scope+\"-ip:\"+authClientIP(r), 50, 900)") {
		t.Error("authOtpVerifyGate no longer limits per identity AND per IP via ConsumeSecure")
	}

	for _, h := range []struct{ fn, scope string }{
		{"func authVerifyOtp(", `authOtpVerifyGate(w, r, "verify-otp", e)`},
		{"func authVerifyOtpPhone(", `authOtpVerifyGate(w, r, "verify-otp-phone", ph)`},
	} {
		i := strings.Index(src, h.fn)
		if i < 0 {
			t.Fatalf("%s is gone", h.fn)
		}
		body := src[i:]
		gate := strings.Index(body, h.scope)
		// The gate has to run BEFORE the code is compared, or it bounds nothing.
		cmp := strings.Index(body, "authVerifyOTP(code, codeHash)")
		if gate < 0 || cmp < 0 || gate > cmp {
			t.Errorf("%s does not rate-limit before evaluating the guess", h.fn)
		}
	}
}

func TestOtpAttemptCapIsEnforcedInTheUpdate(t *testing.T) {
	src := otpVerifySource(t)

	// The cap belongs in the WHERE clause. A preceding SELECT is a stale read.
	bump := regexp.MustCompile(`UPDATE otp_codes SET attempts = attempts \+ 1\s+WHERE id = \$1 AND attempts < \$2\s+RETURNING attempts`)
	if !bump.MatchString(src) {
		t.Error("the attempt increment no longer carries the cap and RETURNING")
	}
	if regexp.MustCompile(`UPDATE otp_codes SET attempts = attempts \+ 1 WHERE id = \$1\b`).MatchString(src) {
		t.Error("an unconditional attempts increment is back")
	}
	// Zero rows updated means a concurrent guess already spent the cap.
	bumpFn := src[strings.Index(src, "func authOtpBumpAttempts("):]
	if !regexp.MustCompile(`db\.NoRows\(err\)\s*{\s*return true, nil`).MatchString(bumpFn) {
		t.Error("authOtpBumpAttempts no longer treats zero rows as an exhausted cap")
	}
	for _, fn := range []string{"func authVerifyOtp(", "func authVerifyOtpPhone("} {
		body := src[strings.Index(src, fn):]
		if !strings.Contains(body[:strings.Index(body, "authIssueTokens")], "authOtpBumpAttempts(ctx, otpID)") {
			t.Errorf("%s no longer charges a wrong guess through the guarded UPDATE", fn)
		}
	}
}
