// token_test.go — the grant is a security boundary, so it is tested like one.
//
// No database and no cluster: minting is offline signing. These run in plain
// `go test ./...` on any machine, which is the point — the thing that decides
// whether an audience member can broadcast should not be the one part of the
// system nobody can check until infrastructure exists.
package livekit

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var testCfg = Config{APIKey: "APIabc", APISecret: "s3cret-at-least-32-bytes-long-ok!!"}

// parse verifies a token AT a given instant. The clock is pinned rather than
// read: a test that mints at a fixed timestamp and verifies at the wall clock
// passes today and fails tomorrow, which is how a deterministic test quietly
// becomes a scheduled failure. Zero `at` means now.
func parse(t *testing.T, token string, at time.Time) Claims {
	t.Helper()
	if at.IsZero() {
		at = time.Now()
	}
	var c Claims
	_, err := jwt.ParseWithClaims(token, &c, func(*jwt.Token) (any, error) {
		return []byte(testCfg.APISecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithTimeFunc(func() time.Time { return at }))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return c
}

func TestAudienceCannotPublish(t *testing.T) {
	// The single most important assertion in this package. An audience member
	// must be unable to send media even if every UI check were bypassed.
	g := GrantFor(RoleAudience, "call-1")
	if g.CanPublish {
		t.Error("audience must not be able to publish")
	}
	if g.CanPublishData {
		t.Error("audience must not be able to publish data")
	}
	if len(g.CanPublishSources) != 0 {
		t.Errorf("audience must have no permitted publish sources, got %v", g.CanPublishSources)
	}
	if g.RoomAdmin {
		t.Error("audience must not be a room admin")
	}
	if !g.CanSubscribe {
		t.Error("audience must still be able to hear the call")
	}
	if !g.RoomJoin {
		t.Error("audience must be able to join")
	}
}

func TestUnknownRoleFailsClosed(t *testing.T) {
	// A role this build does not recognise — a newer server, a typo, a column
	// default that drifted — must land on the LEAST privilege, not the most.
	for _, r := range []Role{"", "superuser", "moderator", "HOST"} {
		g := GrantFor(r, "call-1")
		if g.CanPublish || g.RoomAdmin || len(g.CanPublishSources) != 0 {
			t.Errorf("unknown role %q must fail closed, got %+v", r, g)
		}
	}
}

func TestPublisherRoles(t *testing.T) {
	for _, tc := range []struct {
		role  Role
		admin bool
	}{
		{RoleHost, true},
		{RoleCohost, true},
		{RoleSpeaker, false},
	} {
		g := GrantFor(tc.role, "call-1")
		if !g.CanPublish || !g.CanSubscribe || !g.CanPublishData {
			t.Errorf("%s must publish and subscribe, got %+v", tc.role, g)
		}
		if len(g.CanPublishSources) != 4 {
			t.Errorf("%s should have all four sources, got %v", tc.role, g.CanPublishSources)
		}
		// Moderation at the media layer tracks who may change roles over REST:
		// host and cohost, not speaker.
		if g.RoomAdmin != tc.admin {
			t.Errorf("%s roomAdmin = %v, want %v", tc.role, g.RoomAdmin, tc.admin)
		}
	}
}

func TestRoomIsPerCallNotPerChat(t *testing.T) {
	// Two calls in the same chat must be different rooms, or a late rejoin
	// lands in a call that already ended.
	if RoomName("aaa") == RoomName("bbb") {
		t.Error("distinct calls must produce distinct rooms")
	}
	if RoomName("aaa") != "call-aaa" {
		t.Errorf("unexpected room name %q", RoomName("aaa"))
	}
}

func TestMintSignsAValidToken(t *testing.T) {
	now := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	tok, err := Mint(testCfg, MintArgs{
		Identity: "user-1", Name: "Ann", Room: "call-1", Role: RoleSpeaker, Now: now,
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	c := parse(t, tok, now)

	if c.Issuer != testCfg.APIKey {
		t.Errorf("iss = %q, want the API key", c.Issuer)
	}
	if c.Subject != "user-1" {
		t.Errorf("sub = %q — LiveKit reads this as the participant identity", c.Subject)
	}
	if c.Name != "Ann" {
		t.Errorf("name = %q", c.Name)
	}
	if c.Video.Room != "call-1" || !c.Video.RoomJoin {
		t.Errorf("grant room/join wrong: %+v", c.Video)
	}
	if got := c.ExpiresAt.Time.Sub(now); got != DefaultTTL {
		t.Errorf("ttl = %v, want %v", got, DefaultTTL)
	}
	// Signed a little in the past so a modestly skewed client clock does not
	// reject its own freshly-minted token.
	if !c.NotBefore.Time.Before(now) {
		t.Error("nbf should allow for clock skew")
	}
}

func TestMintRefusesWithoutKeys(t *testing.T) {
	// A token signed with an empty secret would be accepted by nothing, and the
	// caller would report "join failed" instead of "the server is not set up".
	for _, cfg := range []Config{
		{},
		{APIKey: "APIabc"},
		{APISecret: "secret"},
	} {
		if _, err := Mint(cfg, MintArgs{Identity: "u", Room: "r", Role: RoleSpeaker}); err != ErrNotConfigured {
			t.Errorf("cfg %+v should refuse to mint, got err=%v", cfg, err)
		}
	}
}

func TestMintRequiresIdentityAndRoom(t *testing.T) {
	if _, err := Mint(testCfg, MintArgs{Room: "r", Role: RoleSpeaker}); err == nil {
		t.Error("an identity is required — it IS the participant")
	}
	if _, err := Mint(testCfg, MintArgs{Identity: "u", Role: RoleSpeaker}); err == nil {
		t.Error("a room is required")
	}
}

func TestTokenIsNotForgeableWithTheWrongSecret(t *testing.T) {
	tok, err := Mint(testCfg, MintArgs{Identity: "u", Room: "call-1", Role: RoleAudience})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	var c Claims
	_, err = jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) {
		return []byte("wrong-secret"), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err == nil {
		t.Error("a token must not verify under a different secret")
	}
}

func TestAudienceTokenOmitsPublishClaimsEntirely(t *testing.T) {
	// omitempty means a denied permission is ABSENT from the JSON rather than
	// present-and-false. LiveKit treats absent as false, so this is equivalent —
	// the test exists so a future change to the struct tags cannot quietly
	// start emitting a permission that was meant to be withheld.
	tok, err := Mint(testCfg, MintArgs{Identity: "u", Room: "call-1", Role: RoleAudience})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	c := parse(t, tok, time.Time{})
	if c.Video.CanPublish || c.Video.CanPublishData || c.Video.RoomAdmin || len(c.Video.CanPublishSources) > 0 {
		t.Errorf("audience token carries a publish permission: %+v", c.Video)
	}
	if !c.Video.CanSubscribe {
		t.Error("audience must still subscribe after a round trip through JSON")
	}
}
