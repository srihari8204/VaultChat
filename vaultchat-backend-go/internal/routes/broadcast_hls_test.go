// broadcast_hls_test.go — the playback ticket is the only thing standing
// between a private bucket and a public archive, so it gets pinned.
package routes

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestHLSTicketRoundTrip(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	const id = "11111111-2222-3333-4444-555555555555"
	if !hlsTicketOK(id, hlsTicket(id)) {
		t.Fatal("a freshly minted ticket does not verify")
	}
}

func TestHLSTicketIsScopedToOneBroadcast(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	a := "aaaaaaaa-0000-0000-0000-000000000001"
	b := "bbbbbbbb-0000-0000-0000-000000000002"
	// The whole point: a ticket handed to a viewer of A must not open B. Without
	// the id inside the MAC, one leaked URL would unlock every broadcast.
	if hlsTicketOK(b, hlsTicket(a)) {
		t.Fatal("a ticket for one broadcast opened another")
	}
}

func TestHLSTicketRejectsTamperingAndExpiry(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	const id = "cccccccc-0000-0000-0000-000000000003"
	tk := hlsTicket(id)

	// One flipped byte in the signature.
	bad := []byte(tk)
	bad[len(bad)-1] ^= 0x01
	if hlsTicketOK(id, string(bad)) {
		t.Error("a mutated signature verified")
	}

	// The expiry is INSIDE the MAC, so pushing the deadline out invalidates it.
	// If it were not signed, any viewer could grant themselves forever.
	dot := strings.IndexByte(tk, '.')
	far := strconv.FormatInt(time.Now().Add(87600*time.Hour).Unix(), 10) + tk[dot:]
	if hlsTicketOK(id, far) {
		t.Error("rewriting the expiry produced a valid ticket")
	}

	// Already expired.
	exp := time.Now().Add(-time.Minute).Unix()
	if hlsTicketOK(id, strconv.FormatInt(exp, 10)+"."+hlsSign(id, exp)) {
		t.Error("an expired ticket verified")
	}

	for _, junk := range []string{"", ".", "abc", "999", "999.", ".sig"} {
		if hlsTicketOK(id, junk) {
			t.Errorf("malformed ticket %q verified", junk)
		}
	}
}

func TestHLSTicketRefusesEmptySecret(t *testing.T) {
	// With no JWT_SECRET every HMAC keys off "" and every ticket would verify
	// against every broadcast. Fail closed rather than silently open the bucket.
	t.Setenv("JWT_SECRET", "")
	const id = "dddddddd-0000-0000-0000-000000000004"
	if hlsTicketOK(id, "9999999999.anything") {
		t.Fatal("tickets verify with an empty secret — playback is unauthenticated")
	}
}

func TestPlaybackURLGoesThroughTheRelay(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("BROADCAST_CDN_BASE", "https://api.example.test")
	const id = "eeeeeeee-0000-0000-0000-000000000005"
	u := broadcastHLSURL(id)

	// Must address the API relay, not the bucket, and must carry a ticket —
	// those two together are what let the bucket stay private.
	if !strings.HasPrefix(u, "https://api.example.test/broadcasts/"+id+"/hls/index.m3u8?t=") {
		t.Fatalf("playback URL does not route through the relay: %s", u)
	}
	tk := u[strings.Index(u, "?t=")+3:]
	if !hlsTicketOK(id, tk) {
		t.Fatal("the URL carries a ticket that does not verify")
	}
}

// ── worldwide streaming: the ticket must be CDN-cacheable ─────────────
//
// The bucketing is invisible in normal use and trivially undone by "fixing"
// hlsTicket back to `now + TTL`. These pin it, because the failure mode is not a
// broken stream — it is a stream that works perfectly for ten viewers and melts
// the origin at ten thousand.

func TestHLSTicketIsStableWithinItsWindow(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	const id = "ffffffff-0000-0000-0000-000000000006"

	// Two viewers, two playlist refreshes, moments apart. If these differ, the
	// same segment has two URLs and a CDN caches it twice — which is the whole
	// reason every byte used to transit go-api.
	a, b := hlsTicket(id), hlsTicket(id)
	if a != b {
		t.Fatalf("two tickets minted in the same window differ:\n  %s\n  %s", a, b)
	}
	if !hlsTicketOK(id, a) {
		t.Fatal("a bucketed ticket does not verify")
	}
}

func TestHLSBucketRoundsUpAndNeverBackwards(t *testing.T) {
	base := time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC)
	w := int64(hlsBucketWindow / time.Second)

	for _, off := range []time.Duration{0, time.Second, 31 * time.Minute, hlsBucketWindow - time.Second} {
		at := base.Add(off)
		exp := hlsBucketExp(at)

		if exp%w != 0 {
			t.Fatalf("exp %d is not on a %ds boundary", exp, w)
		}
		// Rounding UP, never down: a truncated deadline would land in the past
		// for anyone minting near a boundary and every such ticket would fail
		// verification the instant it was issued.
		if exp < at.Add(hlsTicketTTL).Unix() {
			t.Fatalf("bucket rounded DOWN: exp %d < deadline %d", exp, at.Add(hlsTicketTTL).Unix())
		}
		// ...and never further out than one extra window, or the ticket
		// outlives its stated TTL by more than the bucketing costs.
		if exp > at.Add(hlsTicketTTL).Unix()+w {
			t.Fatalf("bucket overshot by more than one window: %d", exp)
		}
	}

	// A ticket from one window must not be identical to the next window's —
	// otherwise it never rolls and the TTL means nothing.
	if hlsBucketExp(base) == hlsBucketExp(base.Add(hlsBucketWindow)) {
		t.Fatal("the ticket never rolls between windows")
	}
}

// #EXT-X-START is what stops the player choosing its own start point three
// target durations back — 6s of self-inflicted latency at 2s segments. It is
// injected into a live playlist, so the shape of that edit is worth pinning.
func TestInjectStartOffset(t *testing.T) {
	in := "#EXTM3U\n#EXT-X-VERSION:4\n#EXTINF:2.0,\nsegment_00000.ts?t=abc\n"
	out := injectStartOffset(in)

	if !strings.Contains(out, "#EXT-X-START:TIME-OFFSET=-4,PRECISE=YES") {
		t.Fatalf("start tag missing:\n%s", out)
	}
	// It MUST precede the first segment, or players ignore it.
	if strings.Index(out, "#EXT-X-START") > strings.Index(out, "#EXTINF") {
		t.Error("#EXT-X-START must come before the first media segment")
	}
	// The header stays first: a playlist not beginning #EXTM3U is invalid.
	if !strings.HasPrefix(out, "#EXTM3U\n") {
		t.Errorf("playlist must still start with #EXTM3U, got %q", out[:16])
	}
	// Nothing else may be disturbed — the tickets above are what keep segments
	// authorized, and losing one 401s the stream mid-play.
	if !strings.Contains(out, "segment_00000.ts?t=abc") {
		t.Error("segment line was altered")
	}
}

// A second #EXT-X-START is invalid and players disagree on which wins, so an
// existing one is left alone rather than doubled.
func TestInjectStartOffsetIdempotent(t *testing.T) {
	in := "#EXTM3U\n#EXT-X-START:TIME-OFFSET=-8\n#EXTINF:2.0,\nseg.ts\n"
	if out := injectStartOffset(in); out != in {
		t.Errorf("existing #EXT-X-START must be preserved, got:\n%s", out)
	}
	if n := strings.Count(injectStartOffset(in), "#EXT-X-START"); n != 1 {
		t.Errorf("want exactly 1 #EXT-X-START, got %d", n)
	}
}

// Anything that is not a playlist must come back byte-identical: corrupting a
// response that was working is worse than missing the optimisation.
func TestInjectStartOffsetLeavesNonPlaylistAlone(t *testing.T) {
	in := "not a playlist"
	if out := injectStartOffset(in); out != in {
		t.Errorf("non-playlist altered: %q", out)
	}
}
