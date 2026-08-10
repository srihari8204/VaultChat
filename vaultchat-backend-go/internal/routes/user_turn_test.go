package routes

import (
	"strings"
	"testing"
)

// The ICE server list is the only thing standing between a client and a relay.
// A malformed URL does not error anywhere — the client just silently gathers no
// relay candidate and the call fails to connect on any network that needs one,
// which is indistinguishable from "calls sometimes don't work".

func urlsOf(servers []map[string]any) []string {
	var out []string
	for _, s := range servers {
		switch u := s["urls"].(type) {
		case string:
			out = append(out, u)
		case []string:
			out = append(out, u...)
		}
	}
	return out
}

func TestTurnIceServersIPv4Only(t *testing.T) {
	got := urlsOf(turnIceServers("turn.example.com", "", "user", "cred"))

	// Three transports, in the order ICE should prefer them: plain UDP for the
	// common case, UDP 443 for networks that allow only 80/443, and TURNS last
	// because TLS-over-TCP is the slowest but the hardest to block.
	want := []string{
		"stun:stun.l.google.com:19302",
		"turn:turn.example.com:3478?transport=udp",
		"turn:turn.example.com:3478?transport=tcp",
		"turn:turn.example.com:443?transport=udp",
		"turns:turn.example.com:5349?transport=tcp",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d urls, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("url %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestTurnIceServersAddsIPv6Literal(t *testing.T) {
	const v6 = "2a01:4f9:6a:1c5c::2"
	got := urlsOf(turnIceServers("turn.example.com", v6, "user", "cred"))

	// A bare v6 literal would parse as host:port and silently address the wrong
	// thing; RFC 3986 requires brackets.
	wantUDP := "turn:[" + v6 + "]:3478?transport=udp"
	wantTCP := "turn:[" + v6 + "]:3478?transport=tcp"

	var sawUDP, sawTCP bool
	for _, u := range got {
		if u == wantUDP {
			sawUDP = true
		}
		if u == wantTCP {
			sawTCP = true
		}
		if strings.Contains(u, v6) && !strings.Contains(u, "["+v6+"]") {
			t.Errorf("v6 literal not bracketed: %q", u)
		}
	}
	if !sawUDP {
		t.Errorf("missing %q in %v", wantUDP, got)
	}
	if !sawTCP {
		t.Errorf("missing %q in %v", wantTCP, got)
	}

	// The IPv4 hostname entries must survive: dropping them would break every
	// client on an IPv4-only network.
	if !sawURL(got, "turn:turn.example.com:3478?transport=udp") {
		t.Error("IPv4 relay was lost when IPv6 was added")
	}
}

// turns: over a literal cannot validate — the cert is issued for the hostname.
func TestTurnIceServersNoTLSOnLiteral(t *testing.T) {
	got := urlsOf(turnIceServers("turn.example.com", "2a01:4f9:6a:1c5c::2", "u", "c"))
	for _, u := range got {
		if strings.HasPrefix(u, "turns:") && strings.Contains(u, "[") {
			t.Errorf("turns: offered on an IP literal, cert would fail: %q", u)
		}
	}
}

// TURNS is the transport most likely to cross a restrictive network, so its
// absence is a real regression rather than a missing nicety.
func TestTurnIceServersOffersTLS(t *testing.T) {
	if !sawURL(urlsOf(turnIceServers("turn.example.com", "", "u", "c")),
		"turns:turn.example.com:5349?transport=tcp") {
		t.Error("turns:5349 missing — the TLS relay is how calls survive locked-down networks")
	}
}

// The whole point of the 443 entry: it must be UDP, because TCP 443 is nginx.
func TestTurnIceServersHas443UDP(t *testing.T) {
	got := urlsOf(turnIceServers("turn.example.com", "", "u", "c"))
	if !sawURL(got, "turn:turn.example.com:443?transport=udp") {
		t.Errorf("missing the UDP 443 fallback in %v", got)
	}
	for _, u := range got {
		if strings.Contains(u, ":443?transport=tcp") {
			t.Errorf("TCP 443 offered, but that port belongs to nginx: %q", u)
		}
	}
}

// Credentials must ride on every relay entry; a relay the client cannot
// authenticate to is the same as no relay.
func TestTurnIceServersCredentialsOnEveryRelay(t *testing.T) {
	servers := turnIceServers("turn.example.com", "2a01:4f9:6a:1c5c::2", "user-1", "cred-1")
	for _, s := range servers {
		urls := urlsOf([]map[string]any{s})
		if len(urls) == 0 || strings.HasPrefix(urls[0], "stun:") {
			continue // STUN needs no credentials
		}
		if s["username"] != "user-1" || s["credential"] != "cred-1" {
			t.Errorf("relay entry %v is missing credentials", urls)
		}
	}
}

func sawURL(urls []string, want string) bool {
	for _, u := range urls {
		if u == want {
			return true
		}
	}
	return false
}
