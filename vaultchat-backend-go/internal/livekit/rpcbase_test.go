package livekit

import (
	"os"
	"testing"
)

// The whole point of RPCURL: the address a PHONE dials and the address THIS
// SERVER posts twirp to are allowed to differ. Before the split they were one
// value, so an internal RPC went out through the public edge and came back —
// and died on a 15s timeout when that edge was slow.
func TestRPCBaseSplitsClientURLFromServerRPC(t *testing.T) {
	cfg := Config{
		URL:    "wss://api.corefinite.com/golive-livekit",
		RPCURL: "http://172.20.0.1:7890",
	}

	if got := cfg.RPCBase(); got != "http://172.20.0.1:7890" {
		t.Fatalf("server RPC should use RPCURL verbatim, got %q", got)
	}
	// The client-facing value must be untouched — a phone still has to reach it.
	if cfg.URL != "wss://api.corefinite.com/golive-livekit" {
		t.Fatalf("client URL was mutated: %q", cfg.URL)
	}
}

// Back-compat: every deployment that never sets RPCURL must behave exactly as
// before, including the ws→http scheme translation and trailing-slash trim.
func TestRPCBaseFallsBackToTranslatedURL(t *testing.T) {
	for _, c := range []struct{ url, want string }{
		{"wss://api.corefinite.com/livekit", "https://api.corefinite.com/livekit"},
		{"ws://golive:7890", "http://golive:7890"},
		{"wss://host/livekit/", "https://host/livekit"},
		{"http://172.20.0.1:7890", "http://172.20.0.1:7890"},
		{"", ""},
	} {
		if got := (Config{URL: c.url}).RPCBase(); got != c.want {
			t.Errorf("RPCBase(URL=%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

// Only the FIRST scheme occurrence is rewritten, so a host that merely contains
// "ws://" later in a path cannot be corrupted.
func TestRPCBaseRewritesSchemeOnlyOnce(t *testing.T) {
	got := (Config{URL: "ws://proxy/ws://inner"}).RPCBase()
	if got != "http://proxy/ws://inner" {
		t.Fatalf("scheme rewrite escaped the prefix: %q", got)
	}
}

func TestConfigFromEnvReadsHTTPURL(t *testing.T) {
	for k, v := range map[string]string{
		"LIVEKIT_API_KEY":    "k",
		"LIVEKIT_API_SECRET": "s",
		"LIVEKIT_URL":        "wss://public/livekit",
		"LIVEKIT_HTTP_URL":   "  http://172.20.0.1:7880  ", // trimmed, like its siblings
	} {
		t.Setenv(k, v)
	}
	cfg := ConfigFromEnv()
	if cfg.RPCURL != "http://172.20.0.1:7880" {
		t.Fatalf("LIVEKIT_HTTP_URL not read/trimmed: %q", cfg.RPCURL)
	}
	if cfg.RPCBase() != "http://172.20.0.1:7880" {
		t.Fatalf("RPCBase ignored RPCURL: %q", cfg.RPCBase())
	}
	if cfg.URL != "wss://public/livekit" {
		t.Fatalf("client URL disturbed: %q", cfg.URL)
	}
}

// Unset LIVEKIT_HTTP_URL must leave RPCURL empty rather than inheriting a stray
// value, so the fallback path above is the one that runs.
func TestConfigFromEnvWithoutHTTPURL(t *testing.T) {
	os.Unsetenv("LIVEKIT_HTTP_URL")
	t.Setenv("LIVEKIT_URL", "wss://public/livekit")
	if cfg := ConfigFromEnv(); cfg.RPCURL != "" {
		t.Fatalf("RPCURL should be empty when unset, got %q", cfg.RPCURL)
	}
}
