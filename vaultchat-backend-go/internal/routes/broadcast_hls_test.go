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
