// shopbook_verify_test.go — verification transitions and paging (P1-D / P2).
package routes

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func contains(s, sub string) bool { return strings.Contains(s, sub) }

// A verified shop is a claim the platform has made to customers. It cannot be
// quietly walked back to "unverified" or "pending" — the only way out is
// suspension, which is visible and requires a note.
func TestVerifiedShopCanOnlyBeSuspended(t *testing.T) {
	for _, to := range []string{"unverified", "pending_review", "rejected"} {
		if sbVerifyAllowed("verified", to) {
			t.Errorf("verified→%s allowed; the only way out of verified is suspension", to)
		}
	}
	if !sbVerifyAllowed("verified", "suspended") {
		t.Error("verified→suspended must be possible; it is the emergency brake")
	}
}

func TestSuspensionIsReachableFromEverywhere(t *testing.T) {
	for _, from := range []string{"unverified", "pending_review", "verified", "rejected"} {
		if !sbVerifyAllowed(from, "suspended") {
			t.Errorf("%s→suspended refused; suspension must always be available", from)
		}
	}
}

func TestRejectedShopCanTryAgain(t *testing.T) {
	// A rejection that cannot be appealed is an account deletion wearing a
	// different word.
	if !sbVerifyAllowed("rejected", "pending_review") {
		t.Error("a rejected shop must be able to resubmit")
	}
	if !sbVerifyAllowed("suspended", "verified") {
		t.Error("a suspension must be liftable")
	}
}

func TestUnknownVerifyStatesGoNowhere(t *testing.T) {
	if sbVerifyAllowed("banana", "verified") {
		t.Error("an unknown state must not be a route into verified")
	}
	if sbVerifyAllowed("verified", "banana") {
		t.Error("an unknown target must not be reachable")
	}
}

// ── paging (P2) ───────────────────────────────────────────────────

func TestPageLimitIsBounded(t *testing.T) {
	cases := []struct {
		query string
		want  int
	}{
		{"", 50},               // default
		{"?limit=10", 10},      // honoured
		{"?limit=100000", 100}, // capped, not obeyed
		{"?limit=0", 50},       // nonsense falls back
		{"?limit=-5", 50},
		{"?limit=abc", 50},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/x"+c.query, nil)
		if got := sbPageLimit(r, 50, 100); got != c.want {
			t.Errorf("sbPageLimit(%q) = %d, want %d", c.query, got, c.want)
		}
	}
}

func TestCursorRoundTrips(t *testing.T) {
	at := time.Date(2026, 8, 12, 3, 4, 5, 123456789, time.UTC)
	next := sbNextCursor(50, 50, at)
	if next == "" {
		t.Fatal("a full page must offer a next cursor")
	}
	r := httptest.NewRequest("GET", "/x?cursor="+next, nil)
	got, ok := sbCursor(r)
	if !ok || !got.Equal(at) {
		t.Errorf("cursor round-trip lost precision: %v -> %q -> %v", at, next, got)
	}
}

// A short page means the end of the list. Offering a cursor there would cost
// every client one guaranteed-empty request to discover it had finished.
func TestShortPageEndsPagination(t *testing.T) {
	if got := sbNextCursor(12, 50, time.Now()); got != "" {
		t.Errorf("short page offered a cursor (%q), want none", got)
	}
	if got := sbNextCursor(0, 50, time.Time{}); got != "" {
		t.Errorf("empty page offered a cursor (%q), want none", got)
	}
}

func TestBadCursorIsIgnoredNotFatal(t *testing.T) {
	// A malformed cursor must start from the top rather than 400 — clients
	// persist these, and a stale one should not wedge the list.
	for _, v := range []string{"", "garbage", "12345"} {
		r := httptest.NewRequest("GET", "/x?cursor="+v, nil)
		if _, ok := sbCursor(r); ok {
			t.Errorf("cursor %q was accepted", v)
		}
	}
}

func TestDocumentKindsAreSanitizedForKeys(t *testing.T) {
	// Object keys are built from a user-supplied label; path traversal and
	// separators must not survive into the key.
	cases := map[string]string{
		"GST Certificate": "gst-certificate",
		// Dots are dropped entirely and slashes flatten to hyphens, so no
		// traversal survives into the object key.
		"../../etc/passwd": "--etc-passwd",
		"":                 "doc",
		"!!!":              "doc",
	}
	for in, want := range cases {
		got := sanitizeDocKind(in)
		if got != want {
			t.Errorf("sanitizeDocKind(%q) = %q, want %q", in, got, want)
		}
		for _, bad := range []string{"..", "/", "\\"} {
			if contains(got, bad) {
				t.Errorf("sanitizeDocKind(%q) = %q, which still contains %q", in, got, bad)
			}
		}
	}
	long := sanitizeDocKind("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if len(long) > 40 {
		t.Errorf("sanitizeDocKind did not bound length: %d", len(long))
	}
}

func TestOnlyReviewableDocumentTypes(t *testing.T) {
	for _, m := range []string{"image/jpeg", "image/png", "image/webp", "application/pdf"} {
		if !sbDocMimes[m] {
			t.Errorf("%q should be an accepted document type", m)
		}
	}
	// An open upload endpoint attached to a shop account is a file host.
	for _, m := range []string{"application/zip", "text/html", "application/octet-stream", ""} {
		if sbDocMimes[m] {
			t.Errorf("%q must not be accepted", m)
		}
	}
}
