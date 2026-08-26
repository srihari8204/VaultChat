package golive

import "testing"

// GOLIVE_LIVEKIT_HTTP_URL used to be a FALLBACK for the client URL, which meant
// that once GOLIVE_LIVEKIT_URL was set (as it is on prod) setting the HTTP one
// did nothing at all. Splitting them is the fix; this is the test that catches
// a revert.
func TestHTTPURLOverridesRPCButNotClientURL(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "golive-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret")
	t.Setenv("GOLIVE_LIVEKIT_URL", "wss://api.corefinite.com/golive-livekit")
	t.Setenv("GOLIVE_LIVEKIT_HTTP_URL", "http://172.20.0.1:7890")

	cfg := ConfigFromEnv()

	if cfg.URL != "wss://api.corefinite.com/golive-livekit" {
		t.Fatalf("the phone must still get the public URL, got %q", cfg.URL)
	}
	if got := cfg.RPCBase(); got != "http://172.20.0.1:7890" {
		t.Fatalf("egress RPC should go internally, got %q", got)
	}
}

// Back-compat 1: only GOLIVE_LIVEKIT_HTTP_URL set — it still stands in for the
// client URL, exactly as before, so a one-address deployment is untouched.
func TestHTTPURLStillStandsInForClientURL(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "k")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "s")
	t.Setenv("GOLIVE_LIVEKIT_URL", "")
	t.Setenv("GOLIVE_LIVEKIT_WS_URL", "")
	t.Setenv("GOLIVE_LIVEKIT_HTTP_URL", "http://golive:7890")

	cfg := ConfigFromEnv()
	if cfg.URL != "http://golive:7890" {
		t.Fatalf("URL should fall back to the HTTP one, got %q", cfg.URL)
	}
	if cfg.RPCBase() != "http://golive:7890" {
		t.Fatalf("RPCBase wrong: %q", cfg.RPCBase())
	}
}

// Back-compat 2: only the plain URL set — the RPC still derives from it, so
// nothing changes for a deployment that never heard of the new variable.
func TestPlainURLAloneStillDrivesBoth(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "k")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "s")
	t.Setenv("GOLIVE_LIVEKIT_URL", "wss://public/golive-livekit")
	t.Setenv("GOLIVE_LIVEKIT_HTTP_URL", "")

	cfg := ConfigFromEnv()
	if cfg.RPCURL != "" {
		t.Fatalf("RPCURL should stay empty, got %q", cfg.RPCURL)
	}
	if cfg.RPCBase() != "https://public/golive-livekit" {
		t.Fatalf("RPCBase should translate the ws scheme, got %q", cfg.RPCBase())
	}
}

// The WS alias must not be mistaken for an RPC address.
func TestWSAliasDoesNotSetRPCURL(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "k")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "s")
	t.Setenv("GOLIVE_LIVEKIT_URL", "")
	t.Setenv("GOLIVE_LIVEKIT_WS_URL", "wss://public/golive-livekit")
	t.Setenv("GOLIVE_LIVEKIT_HTTP_URL", "")

	cfg := ConfigFromEnv()
	if cfg.URL != "wss://public/golive-livekit" {
		t.Fatalf("WS alias should fill URL, got %q", cfg.URL)
	}
	if cfg.RPCURL != "" {
		t.Fatalf("WS alias must not set RPCURL, got %q", cfg.RPCURL)
	}
}

// Splitting the addresses must not weaken the isolation guarantee: sharing a
// credential with the calling cluster still fails closed.
func TestSplitURLsDoNotWeakenProjectIsolation(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "shared-key")
	t.Setenv("LIVEKIT_API_SECRET", "calls-secret")
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "shared-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret")
	t.Setenv("GOLIVE_LIVEKIT_URL", "wss://public/golive-livekit")
	t.Setenv("GOLIVE_LIVEKIT_HTTP_URL", "http://172.20.0.1:7890")

	if ConfigFromEnv().Usable() {
		t.Fatal("a shared API key must still make Go Live unusable")
	}
}

// The health probe must follow the SERVER's address, not the client's.
// Otherwise /golive/health reports on a path egress no longer uses.
func TestHealthProbeFollowsRPCURL(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "k")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "s")
	t.Setenv("GOLIVE_LIVEKIT_URL", "wss://api.corefinite.com/golive-livekit")
	t.Setenv("GOLIVE_LIVEKIT_HTTP_URL", "http://172.20.0.1:7890")

	if got := ConfigFromEnv().HTTPBase(); got != "http://172.20.0.1:7890" {
		t.Fatalf("health probe went to the client URL, not the RPC one: %q", got)
	}
}
