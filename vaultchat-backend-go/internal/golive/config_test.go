// config_test.go — the isolation guarantees, asserted.
//
// These are not style tests. Each one covers a way the Go Live tier could
// silently re-couple itself to the calling cluster, which is the failure this
// whole package exists to prevent and the failure that would be invisible in
// production: everything would keep working.
package golive

import (
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"vaultchat/backend-go/internal/livekit"
)

// The load-bearing test. If GOLIVE_LIVEKIT_* is absent, Go Live must be
// unconfigured — NOT quietly running on the calling project's credentials.
func TestNoFallbackToCallingLiveKit(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "calls-key")
	t.Setenv("LIVEKIT_API_SECRET", "calls-secret")
	t.Setenv("LIVEKIT_URL", "ws://calls:7880")
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "")
	t.Setenv("GOLIVE_LIVEKIT_URL", "")

	c := ConfigFromEnv()
	if c.Configured() {
		t.Fatal("Go Live reported itself configured with no GOLIVE_LIVEKIT_* set")
	}
	if c.Usable() {
		t.Fatal("Go Live reported itself usable with no GOLIVE_LIVEKIT_* set")
	}
	if c.APIKey == "calls-key" || c.APISecret == "calls-secret" || c.URL == "ws://calls:7880" {
		t.Fatalf("Go Live fell back to the CALLING project: %+v", c.Config)
	}
}

// Copy-pasting the calling credentials into the GOLIVE_* variables is the
// realistic way this isolation gets undone. It must fail, not work.
func TestOverlapWithCallingProjectIsRefused(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "shared-key")
	t.Setenv("LIVEKIT_API_SECRET", "calls-secret")
	t.Setenv("LIVEKIT_URL", "ws://calls:7880")

	// Same key, different secret — still the same project as far as LiveKit is
	// concerned once the key selects it.
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "shared-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret")
	t.Setenv("GOLIVE_LIVEKIT_URL", "ws://golive:7890")
	if c := ConfigFromEnv(); !c.SameProjectAsCalls() || c.Usable() {
		t.Fatal("a shared API KEY was not detected as an overlap")
	}

	// Same secret, different key — a token minted for one verifies at the other.
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "golive-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "calls-secret")
	if c := ConfigFromEnv(); !c.SameProjectAsCalls() || c.Usable() {
		t.Fatal("a shared API SECRET was not detected as an overlap")
	}

	// Genuinely separate — must be usable, or the check is useless.
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "golive-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret")
	if c := ConfigFromEnv(); c.SameProjectAsCalls() || !c.Usable() {
		t.Fatal("a properly separated project was rejected")
	}
}

// A shared HOSTNAME is legitimate (a proxy can front both); a shared CREDENTIAL
// never is. The overlap check must not confuse the two.
func TestSharedHostnameIsNotAnOverlap(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "calls-key")
	t.Setenv("LIVEKIT_API_SECRET", "calls-secret")
	t.Setenv("LIVEKIT_URL", "wss://media.example.com")
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "golive-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret")
	t.Setenv("GOLIVE_LIVEKIT_URL", "wss://media.example.com")

	if c := ConfigFromEnv(); !c.Usable() {
		t.Fatal("two distinct projects behind one hostname were refused")
	}
}

func TestRoomNamespaceIsSeparateFromCalls(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "k")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "s")
	t.Setenv("GOLIVE_LIVEKIT_URL", "ws://golive:7890")
	t.Setenv("GOLIVE_ROOM_PREFIX", "")

	c := ConfigFromEnv()
	const id = "6f1c8b2e-0000-4000-8000-000000000001"
	room := c.RoomName(id)

	if !strings.HasPrefix(room, "golive_") {
		t.Fatalf("room %q is not in the golive_ namespace", room)
	}
	if room == livekit.RoomName(id) {
		t.Fatal("a Go Live room collided with a call room name")
	}
	if strings.HasPrefix(room, "call-") {
		t.Fatalf("room %q landed in the CALL namespace", room)
	}
	// Derived from the broadcast, not the host — the old "bc_<host-id>" scheme
	// reused one room for every stream a host ever ran.
	if room != "golive_"+id {
		t.Fatalf("room %q is not derived from the broadcast id", room)
	}
}

func TestRoomPrefixIsOverridable(t *testing.T) {
	t.Setenv("GOLIVE_ROOM_PREFIX", "live-")
	if got := ConfigFromEnv().RoomName("x"); got != "live-x" {
		t.Fatalf("GOLIVE_ROOM_PREFIX ignored: got %q", got)
	}
}

// The credential boundary, end to end: a token minted for Go Live must be
// unverifiable with the calling secret. This is what "separate credentials"
// buys, and it is worth asserting rather than assuming.
func TestGoLiveTokenIsRejectedByCallingSecret(t *testing.T) {
	t.Setenv("LIVEKIT_API_KEY", "calls-key")
	t.Setenv("LIVEKIT_API_SECRET", "calls-secret")
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "golive-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret")
	t.Setenv("GOLIVE_LIVEKIT_URL", "ws://golive:7890")

	cfg := ConfigFromEnv()
	tok, err := livekit.Mint(cfg.Config, livekit.MintArgs{
		Identity: "user-1",
		Room:     cfg.RoomName("bc-1"),
		Role:     livekit.RoleHost,
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	calls := livekit.ConfigFromEnv()
	if _, err := jwt.Parse(tok, func(*jwt.Token) (any, error) {
		return []byte(calls.APISecret), nil
	}, jwt.WithValidMethods([]string{"HS256"})); err == nil {
		t.Fatal("a Go Live token verified against the CALLING secret")
	}

	// ...and does verify against its own, or the tier is simply broken.
	if _, err := jwt.Parse(tok, func(*jwt.Token) (any, error) {
		return []byte(cfg.APISecret), nil
	}, jwt.WithValidMethods([]string{"HS256"})); err != nil {
		t.Fatalf("a Go Live token failed against its OWN secret: %v", err)
	}
}

// Host publishes, audience does not — enforced by the grant, not the UI. Uses
// the Go Live config so the assertion covers the path Go Live actually takes.
func TestAudienceTokenCannotPublish(t *testing.T) {
	t.Setenv("GOLIVE_LIVEKIT_API_KEY", "golive-key")
	t.Setenv("GOLIVE_LIVEKIT_API_SECRET", "golive-secret")
	t.Setenv("GOLIVE_LIVEKIT_URL", "ws://golive:7890")
	cfg := ConfigFromEnv()

	grant := func(role livekit.Role) livekit.VideoGrant {
		tok, err := livekit.Mint(cfg.Config, livekit.MintArgs{
			Identity: "u", Room: cfg.RoomName("b"), Role: role,
		})
		if err != nil {
			t.Fatalf("mint %s: %v", role, err)
		}
		var c livekit.Claims
		if _, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) {
			return []byte(cfg.APISecret), nil
		}); err != nil {
			t.Fatalf("parse %s: %v", role, err)
		}
		return c.Video
	}

	aud := grant(livekit.RoleAudience)
	if aud.CanPublish {
		t.Fatal("audience token may publish")
	}
	if len(aud.CanPublishSources) != 0 {
		t.Fatalf("audience token carries publish sources: %v", aud.CanPublishSources)
	}
	if aud.RoomAdmin {
		t.Fatal("audience token carries roomAdmin")
	}
	if !aud.CanSubscribe {
		t.Fatal("audience token cannot subscribe — it could not watch")
	}

	host := grant(livekit.RoleHost)
	if !host.CanPublish {
		t.Fatal("host token may not publish")
	}
	// Screen share is a Go Live requirement, and it is a SOURCE on the grant:
	// without it in the list the media server refuses the track no matter what
	// the app does.
	var hasScreen bool
	for _, s := range host.CanPublishSources {
		if s == livekit.SourceScreenShare {
			hasScreen = true
		}
	}
	if !hasScreen {
		t.Fatalf("host token cannot publish screen_share: %v", host.CanPublishSources)
	}
}

func TestHTTPBaseTranslatesWebsocketScheme(t *testing.T) {
	for in, want := range map[string]string{
		"ws://golive:7890":         "http://golive:7890",
		"wss://golive.example.com": "https://golive.example.com",
		"http://golive:7890/":      "http://golive:7890",
	} {
		t.Setenv("GOLIVE_LIVEKIT_URL", in)
		if got := ConfigFromEnv().HTTPBase(); got != want {
			t.Fatalf("HTTPBase(%q) = %q, want %q", in, got, want)
		}
	}
}
