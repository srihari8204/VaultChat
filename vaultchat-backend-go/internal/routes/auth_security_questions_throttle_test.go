// auth_security_questions_throttle_test.go — GET /auth/security-questions/{userId}
// is deliberately unauthenticated, so it must cost something per attempt.
//
// The route hands back an account's exact recovery questions given only its
// userId. It is the front half of
//
//	/auth/security-questions/{userId} -> .../verify -> /auth/mpin/recover
//
// and until this test existed it had no auth, no rate limit and no delay:
// sweepable at line rate.
//
// Auth is NOT the fix and this file asserts that too — recovery is pre-auth by
// definition, and wrapping it in RequireAuth would break the flow it exists to
// serve. Throttling is the fix.
//
// SOURCE-PINNED, not exercised: redisx.Consume returns Allowed when Client is
// nil (redisx.go:185-187), so without a live Redis a behavioural test would
// pass against a handler with the limiter deleted — the worst kind of green.
// registration_lock_test.go:71 pins its limiter the same way for the same
// reason; this follows that rather than adding a Redis dependency to the suite.
package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func authSecurityQuestionsSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatalf("read auth.go: %v", err)
	}
	src := string(b)
	i := strings.Index(src, "func authSecurityQuestionsGet(")
	if i < 0 {
		t.Fatal("authSecurityQuestionsGet is gone — this test is pinning nothing")
	}
	j := strings.Index(src[i:], "\nfunc ")
	if j < 0 {
		return src[i:]
	}
	return src[i : i+j]
}

// Both keys, because they stop different attacks: per-IP catches one attacker
// sweeping many userIds, per-userId catches a distributed sweep grinding one
// account. Losing either silently reopens half the hole.
func TestSecurityQuestionsGetIsRateLimited(t *testing.T) {
	src := authSecurityQuestionsSource(t)

	if !strings.Contains(src, `redisx.Consume(ctx, "sq:get-ip:"+authClientIP(r)`) {
		t.Error("the per-IP limit is gone — one attacker can sweep every userId again")
	}
	if !strings.Contains(src, `redisx.Consume(ctx, "sq:get-user:"+userID`) {
		t.Error("the per-userId limit is gone — a distributed sweep can grind one account again")
	}
	if !strings.Contains(src, "429") {
		t.Error("a refused attempt no longer answers 429")
	}
}

// Order matters more than the limits do. A limiter placed AFTER the query still
// costs the database every attempt, which is most of what an enumeration sweep
// is actually spending. Both Consume calls must precede db.Pool.Query.
func TestSecurityQuestionsGetThrottlesBeforeTouchingTheDatabase(t *testing.T) {
	src := authSecurityQuestionsSource(t)
	query := strings.Index(src, "db.Pool.Query")
	if query < 0 {
		t.Fatal("no db.Pool.Query in the handler — this test is pinning nothing")
	}
	for _, key := range []string{`"sq:get-ip:"`, `"sq:get-user:"`} {
		at := strings.Index(src, key)
		if at < 0 {
			t.Errorf("%s limit missing entirely", key)
			continue
		}
		if at > query {
			t.Errorf("%s limit runs AFTER db.Pool.Query — every refused attempt still costs a query", key)
		}
	}
}

// The route must stay unauthenticated. Someone "hardening" this by wrapping it
// in RequireAuth would break account recovery for exactly the people it exists
// for: those who cannot sign in.
func TestSecurityQuestionsGetStaysUnauthenticated(t *testing.T) {
	b, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatalf("read auth.go: %v", err)
	}
	line := regexp.MustCompile(`mux\.HandleFunc\("GET /auth/security-questions/\{userId\}"[^)]*\)`).
		FindString(string(b))
	if line == "" {
		t.Fatal("the route registration is gone")
	}
	if strings.Contains(line, "RequireAuth") {
		t.Errorf("route is now behind RequireAuth, which breaks recovery for users who cannot sign in: %s", line)
	}
}
