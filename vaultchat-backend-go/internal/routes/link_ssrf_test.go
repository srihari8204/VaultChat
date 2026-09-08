package routes

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// The defect this locks down (audit F01, 2026-09-08): the handler validated the
// hostname, fetched with http.DefaultClient — which follows redirects on its
// own — and re-checked the final URL afterwards. By then the request to the
// internal host had already been sent and answered. Rejecting the response is
// not a control; making the request is the vulnerability.

// A redirect hop into private space must be REFUSED rather than followed.
//
// CheckRedirect is exercised directly: every httptest server binds 127.0.0.1,
// so a "public" origin cannot be stood up locally — the dialer would (rightly)
// block that first hop and the redirect under test would never be reached.
// Calling the hook is what actually proves the ordering, because Go invokes it
// BEFORE issuing the next request.
func TestCheckRedirectRefusesPrivateHops(t *testing.T) {
	for _, target := range []string{
		"http://127.0.0.1:9200/",
		"http://169.254.169.254/latest/meta-data/",
		"http://10.0.0.5/",
		"http://[::1]/",
		"http://localhost/admin",
		"http://db.internal/",
		"file:///etc/passwd",
		"http://example.com:2375/containers/json",
	} {
		u, err := url.Parse(target)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		req := &http.Request{URL: u, Method: "GET"}
		req = req.WithContext(context.Background())
		if err := linkClient.CheckRedirect(req, nil); err == nil {
			t.Errorf("%s: redirect allowed; want refusal before the request is made", target)
		} else if !strings.Contains(err.Error(), "blocked redirect") {
			t.Errorf("%s: wrong refusal: %v", target, err)
		}
	}
}

// ...and the hop cap is enforced by the same hook, independently of the target.
func TestCheckRedirectCapsChain(t *testing.T) {
	u, _ := url.Parse("https://example.com/")
	req := (&http.Request{URL: u, Method: "GET"}).WithContext(context.Background())
	via := make([]*http.Request, linkMaxRedirects)
	if err := linkClient.CheckRedirect(req, via); err == nil {
		t.Fatalf("chain of %d hops allowed; cap is %d", len(via), linkMaxRedirects)
	} else if !strings.Contains(err.Error(), "too many redirects") {
		t.Fatalf("wrong refusal: %v", err)
	}
}

// The policy itself, applied to a single URL — this is what every hop is run
// through, so its edges matter more than the handler's.
func TestAssertFetchablePolicy(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		raw  string
		want bool // true = fetchable
	}{
		{"https://example.com/", true},
		{"http://example.com:80/", true},
		{"ftp://example.com/", false},
		{"file:///etc/passwd", false},
		{"http://example.com:9200/", false}, // odd port, a classic internal service
		{"http://127.0.0.1/", false},
		{"http://[::1]/", false},
		{"http://169.254.169.254/latest/meta-data/", false}, // cloud metadata
		{"http://10.0.0.5/", false},
		{"http://192.168.1.1/", false},
		{"http://localhost/", false},
		{"http://db.internal/", false},
	} {
		u, err := url.Parse(tc.raw)
		if err != nil {
			t.Fatalf("%s: %v", tc.raw, err)
		}
		got := assertFetchable(ctx, u) == nil
		// Public names need DNS; skip rather than fail an offline test run.
		if tc.want && got != tc.want {
			if _, dnsErr := net.DefaultResolver.LookupIPAddr(ctx, u.Hostname()); dnsErr != nil {
				t.Logf("skipping %s (no DNS in this environment)", tc.raw)
				continue
			}
		}
		if got != tc.want {
			t.Errorf("%s: fetchable=%v, want %v", tc.raw, got, tc.want)
		}
	}
}

// The dialer must reject a private address even when the URL policy passed —
// this is the DNS-rebinding window, where the name checks out and then resolves
// to loopback a moment later at connect time.
func TestLinkClientDialerRejectsPrivateAddress(t *testing.T) {
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("dialer connected to a private address")
	}))
	defer internal.Close()

	req, _ := http.NewRequest("GET", internal.URL, nil)
	resp, err := linkClient.Do(req)
	if err == nil {
		resp.Body.Close()
		t.Fatal("connected to a loopback address; want refusal at dial")
	}
	if !strings.Contains(err.Error(), "blocked address") {
		t.Fatalf("wrong refusal: %v", err)
	}
}
