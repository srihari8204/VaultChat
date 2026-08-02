// Package livekit mints LiveKit access tokens from a VaultChat call role.
//
// A LiveKit token is an HS256 JWT signed with the project's API secret. It is a
// JOIN credential: LiveKit reads the grant once, at connect, and enforces it for
// the lifetime of that session. So the grant is the only place a role becomes
// real at the media layer — and it is exactly why call_participants.role lives
// in a database the client cannot write to (migration 066).
//
// THE POINT OF THIS PACKAGE
// -------------------------
// An audience token has canPublish=false and an EMPTY publish-source list, so an
// audience member cannot send camera, microphone or screen — not because the app
// hides the buttons, but because the media server refuses the track. That is the
// difference between a UI convention and a guarantee, and it is the whole reason
// roles were built before the SFU rather than with it.
//
// Nothing here talks to a LiveKit server. Minting is offline signing, which is
// why it can be written and fully tested with no cluster provisioned.
package livekit

import (
	"errors"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Role mirrors call_participants.role. Kept as its own type rather than reusing
// a string so an unmapped role cannot silently fall through to a permissive
// grant — see GrantFor's default.
type Role string

const (
	RoleHost     Role = "host"
	RoleCohost   Role = "cohost"
	RoleSpeaker  Role = "speaker"
	RoleAudience Role = "audience"
)

// Config is the LiveKit project. Absent, minting fails loudly rather than
// producing a token no server will accept.
type Config struct {
	APIKey    string
	APISecret string
	// URL is handed to the client so it does not hardcode a host. Not signed.
	URL string
}

// ConfigFromEnv reads LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL.
func ConfigFromEnv() Config {
	return Config{
		APIKey:    strings.TrimSpace(os.Getenv("LIVEKIT_API_KEY")),
		APISecret: strings.TrimSpace(os.Getenv("LIVEKIT_API_SECRET")),
		URL:       strings.TrimSpace(os.Getenv("LIVEKIT_URL")),
	}
}

// Configured reports whether tokens can be minted at all.
func (c Config) Configured() bool { return c.APIKey != "" && c.APISecret != "" }

var ErrNotConfigured = errors.New("livekit is not configured")

// VideoGrant is LiveKit's permission object, as it appears under the "video"
// claim. Field names are LiveKit's wire contract — do not rename them.
//
// omitempty on the booleans is deliberate and matters: LiveKit treats an absent
// boolean as false, so omitting is the same as denying. Emitting `false`
// explicitly would be equally correct but noisier; what must NEVER happen is a
// permission appearing because a struct was zero-valued into `true`.
type VideoGrant struct {
	Room     string `json:"room,omitempty"`
	RoomJoin bool   `json:"roomJoin,omitempty"`

	CanPublish     bool `json:"canPublish,omitempty"`
	CanSubscribe   bool `json:"canSubscribe,omitempty"`
	CanPublishData bool `json:"canPublishData,omitempty"`

	// Which track sources publishing is allowed FROM. Empty means none, which
	// is what makes an audience grant airtight: even if canPublish were somehow
	// true, there is no permitted source.
	CanPublishSources []string `json:"canPublishSources,omitempty"`

	// Moderation at the media layer: mute another participant, remove them.
	// Held by host and cohost, matching who may change roles over REST.
	RoomAdmin bool `json:"roomAdmin,omitempty"`

	// Hidden participants are not visible to others. Never set by this app;
	// present so the shape is complete and a future webinar "ghost host" does
	// not need the struct changed.
	Hidden bool `json:"hidden,omitempty"`
}

// Track sources LiveKit recognises.
const (
	SourceCamera           = "camera"
	SourceMicrophone       = "microphone"
	SourceScreenShare      = "screen_share"
	SourceScreenShareAudio = "screen_share_audio"
)

var publisherSources = []string{SourceCamera, SourceMicrophone, SourceScreenShare, SourceScreenShareAudio}

// GrantFor maps a VaultChat call role onto a LiveKit grant.
//
// The mapping is intentionally narrow. Everyone may subscribe — being on a call
// means hearing it. Publishing is the privilege, and it tracks the same
// host/cohost/speaker split the REST API already enforces.
//
// canPublishData follows canPublish rather than being granted freely: VaultChat
// does not use LiveKit's data channels at all (in-call chat and reactions ride
// the app's own socket relay, sealed per peer — see lib/call/signal.ts), so
// there is nothing an audience member needs it for, and an unused capability
// handed out by default is just an unmonitored one.
//
// An UNKNOWN role gets the audience grant. Failing closed is the only safe
// default when the thing being defaulted is permission to broadcast.
func GrantFor(role Role, room string) VideoGrant {
	g := VideoGrant{Room: room, RoomJoin: true, CanSubscribe: true}
	switch role {
	case RoleHost, RoleCohost:
		g.CanPublish = true
		g.CanPublishData = true
		g.CanPublishSources = publisherSources
		g.RoomAdmin = true
	case RoleSpeaker:
		g.CanPublish = true
		g.CanPublishData = true
		g.CanPublishSources = publisherSources
	default: // RoleAudience and anything unrecognised
	}
	return g
}

// RoomName is the LiveKit room for a call. Derived from the call id rather than
// the chat id, because a chat has many calls over time and reusing one room name
// would let a late rejoin land in a call that already ended.
func RoomName(callID string) string { return "call-" + callID }

// Claims is the signed body. `video` is LiveKit's; the rest are standard JWT.
type Claims struct {
	Video    VideoGrant `json:"video"`
	Name     string     `json:"name,omitempty"`
	Metadata string     `json:"metadata,omitempty"`
	jwt.RegisteredClaims
}

// DefaultTTL is how long a minted token may be USED TO JOIN. It does not cap
// the call: LiveKit reads the grant at connect and the session outlives the
// token. Short because a join credential that leaks should stop working quickly,
// and long enough to survive a slow ring plus a retry.
const DefaultTTL = 15 * time.Minute

type MintArgs struct {
	Identity string // the participant — this app uses the user id
	Name     string // display name
	Room     string
	Role     Role
	TTL      time.Duration
	// Now is injectable so tests are deterministic. Zero means time.Now().
	Now time.Time
}

// Mint signs a join token. Returns ErrNotConfigured rather than a useless token
// when the project keys are absent — a caller that cannot tell the difference
// would surface "join failed" instead of "the server is not set up".
func Mint(cfg Config, a MintArgs) (string, error) {
	if !cfg.Configured() {
		return "", ErrNotConfigured
	}
	if a.Identity == "" || a.Room == "" {
		return "", errors.New("identity and room are required")
	}
	now := a.Now
	if now.IsZero() {
		now = time.Now()
	}
	ttl := a.TTL
	if ttl <= 0 {
		ttl = DefaultTTL
	}

	claims := Claims{
		Video: GrantFor(a.Role, a.Room),
		Name:  a.Name,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:  cfg.APIKey,
			Subject: a.Identity,
			// LiveKit reads `sub` as the participant identity; `jti` keeps two
			// tokens minted in the same second distinguishable in server logs.
			ID:        a.Identity + "-" + now.UTC().Format("20060102150405.000"),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-30 * time.Second)), // clock skew
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(cfg.APISecret))
}
