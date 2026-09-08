package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"vaultchat/backend-go/internal/redisx"
)

// AUDIT F10. The deployed path is nginx → Caddy → go-api, so RemoteAddr is
// always a proxy and every per-IP limit was pooled across all users: OTP at
// 10/hour and account lookup at 20/minute, shared by the internet. The header
// cannot be trusted blindly either — that just moves the problem to "anyone can
// mint a fresh identity per request", which is worse.

func req(remote string, headers map[string]string) *http.Request {
	r := httptest.NewRequest("POST", "/auth/otp", nil)
	r.RemoteAddr = remote
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestClientIPBehindTrustedProxy(t *testing.T) {
	for _, tc := range []struct {
		name    string
		remote  string
		headers map[string]string
		want    string
	}{
		{
			"real client through both hops",
			"172.28.0.9:41234",
			map[string]string{"X-Forwarded-For": "203.0.113.7, 172.28.0.5"},
			"203.0.113.7",
		},
		{
			"two different clients are two different identities",
			"172.28.0.9:41235",
			map[string]string{"X-Forwarded-For": "198.51.100.22, 172.28.0.5"},
			"198.51.100.22",
		},
		{
			"X-Real-IP is used when there is no forwarding chain",
			"127.0.0.1:5000",
			map[string]string{"X-Real-IP": "203.0.113.9"},
			"203.0.113.9",
		},
		{
			// The attack the right-most rule exists for: the client prepends a
			// forged entry, our proxies append the truth after it.
			"a forged left-hand entry is ignored",
			"172.28.0.9:41236",
			map[string]string{"X-Forwarded-For": "1.2.3.4, 203.0.113.7, 172.28.0.5"},
			"203.0.113.7",
		},
		{
			// Nothing but our own hops: there is no client address to find.
			"an all-proxy chain falls back to the peer",
			"172.28.0.9:41237",
			map[string]string{"X-Forwarded-For": "172.28.0.5, 127.0.0.1"},
			"172.28.0.9",
		},
	} {
		if got := authClientIP(req(tc.remote, tc.headers)); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

// A request that did NOT come from a recognised proxy must not be able to
// choose its own rate-limit identity.
func TestClientIPIgnoresHeadersFromUntrustedPeer(t *testing.T) {
	r := req("198.51.100.50:33333", map[string]string{
		"X-Forwarded-For": "10.9.9.9",
		"X-Real-IP":       "10.9.9.9",
	})
	if got := authClientIP(r); got != "198.51.100.50" {
		t.Fatalf("spoofable: got %q, want the socket peer 198.51.100.50", got)
	}
}

// AUDIT F11. Consume fails open by design; ConsumeSecure must not, because a
// Redis outage was silently removing the five-attempt limit on a 6-digit PIN.
func TestConsumeSecureStillLimitsWithoutRedis(t *testing.T) {
	if redisx.Client != nil {
		t.Skip("a real Redis client is configured; this covers the outage path")
	}
	ctx := t.Context()
	const limit, window = 5, 900
	key := "test:mpin:" + t.Name()

	allowed := 0
	for i := 0; i < 10; i++ {
		if redisx.ConsumeSecure(ctx, key, limit, window).Allowed {
			allowed++
		}
	}
	if allowed != limit {
		t.Fatalf("allowed %d of 10 attempts with Redis down; the limit is %d", allowed, limit)
	}

	// And the old limiter still fails open — deliberately, for the low-risk
	// endpoints that use it. If this ever flips, that was not the intent.
	openAllowed := 0
	for i := 0; i < 10; i++ {
		if redisx.Consume(ctx, "test:open:"+t.Name(), limit, window).Allowed {
			openAllowed++
		}
	}
	if openAllowed != 10 {
		t.Fatalf("Consume allowed %d of 10; it is meant to fail open", openAllowed)
	}
}

// Separate keys must not share a bucket — an attacker on one account must not
// be able to lock out another, and must not inherit its budget.
func TestConsumeSecureKeysAreIndependent(t *testing.T) {
	if redisx.Client != nil {
		t.Skip("a real Redis client is configured; this covers the outage path")
	}
	ctx := t.Context()
	for i := 0; i < 5; i++ {
		redisx.ConsumeSecure(ctx, "test:userA", 5, 900)
	}
	if !redisx.ConsumeSecure(ctx, "test:userB", 5, 900).Allowed {
		t.Fatal("user B was limited by user A's attempts")
	}
	if redisx.ConsumeSecure(ctx, "test:userA", 5, 900).Allowed {
		t.Fatal("user A got a 6th attempt against a limit of 5")
	}
}
