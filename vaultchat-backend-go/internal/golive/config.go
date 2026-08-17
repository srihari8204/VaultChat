// Package golive holds the Go Live broadcasting tier's OWN LiveKit project.
//
// WHY THIS PACKAGE EXISTS AT ALL
// ------------------------------
// Broadcasting used to mint its tokens from livekit.ConfigFromEnv() — the same
// key, the same secret and the same server as 1:1 and group calling. That is one
// blast radius for two products with completely different risk profiles: a
// broadcast is unbounded, unencrypted and CPU-bound (egress runs headless Chrome
// on the same box), while a call is small, frame-encrypted and must never go
// down. A viral stream that exhausts the SFU would have taken calling with it,
// and a leaked broadcast secret would have been a calling secret too.
//
// So Go Live gets its own LiveKit deployment, and this package is the ONLY place
// its credentials are read.
//
// THE RULE THAT MAKES THE ISOLATION REAL
// --------------------------------------
// There is NO FALLBACK to LIVEKIT_*. If GOLIVE_LIVEKIT_* is absent, Go Live is
// not configured and says so — it does not quietly connect to the calling
// cluster. A silent fallback is worse than an outage, because it would restore
// exactly the coupling this package was created to remove and nothing would ever
// report it.
//
// Overlap is checked too (SameProjectAsCalls): pointing both at one project by
// copy-paste is the realistic way this isolation gets undone, and it must fail
// loudly rather than work.
//
// WHAT IS DELIBERATELY SHARED
// ---------------------------
// internal/livekit — token minting, grants and the two egress RPCs. That code is
// pure signing and HTTP against WHATEVER Config it is handed, so reusing it is
// reuse, not coupling: this package supplies a different Config and not one line
// of the calling implementation changes. Object storage (S3_*) is shared for the
// same reason it is shared with uploads — a bucket is not a media server, and
// the brief puts recorded media on the CDN/object-storage tier for both.
package golive

import (
	"os"
	"strings"

	"vaultchat/backend-go/internal/livekit"
)

// DefaultRoomPrefix namespaces every Go Live room away from calling's
// "call-<id>" rooms. Rooms are created on the Go Live server anyway, so this is
// belt AND braces: even if the two servers were ever merged by an operator, a
// broadcast room could not collide with a call room.
const DefaultRoomPrefix = "golive_"

// Config is the Go Live LiveKit project.
//
// livekit.Config is EMBEDDED rather than duplicated so it can be handed straight
// to livekit.Mint / StartHLS / StopHLS. That is the adapter: same signing code,
// different project.
type Config struct {
	livekit.Config
	RoomPrefix string
}

// ConfigFromEnv reads GOLIVE_LIVEKIT_* ONLY.
//
// GOLIVE_LIVEKIT_URL is what the client dials (ws:// or wss://) and is also what
// the egress RPCs are addressed to after scheme translation — see
// livekit.twirp. GOLIVE_LIVEKIT_WS_URL / _HTTP_URL are accepted as explicit
// aliases for deployments that publish the two on different names; the plain URL
// wins when set, because one variable is one thing to get wrong.
func ConfigFromEnv() Config {
	url := env("GOLIVE_LIVEKIT_URL")
	if url == "" {
		url = env("GOLIVE_LIVEKIT_WS_URL")
	}
	if url == "" {
		url = env("GOLIVE_LIVEKIT_HTTP_URL")
	}
	prefix := env("GOLIVE_ROOM_PREFIX")
	if prefix == "" {
		prefix = DefaultRoomPrefix
	}
	return Config{
		Config: livekit.Config{
			APIKey:    env("GOLIVE_LIVEKIT_API_KEY"),
			APISecret: env("GOLIVE_LIVEKIT_API_SECRET"),
			URL:       url,
		},
		RoomPrefix: prefix,
	}
}

func env(k string) string { return strings.TrimSpace(os.Getenv(k)) }

// SameProjectAsCalls reports the one misconfiguration that silently undoes every
// other guarantee here: Go Live pointed at the calling cluster's project.
//
// Checked on the key OR the secret, not both, because either alone is enough for
// a token minted here to be accepted there. The URL is not part of the test —
// two projects may legitimately share a hostname behind a proxy, while a shared
// credential is never legitimate.
func (c Config) SameProjectAsCalls() bool {
	calls := livekit.ConfigFromEnv()
	if !calls.Configured() || !c.Configured() {
		return false
	}
	return c.APIKey == calls.APIKey || c.APISecret == calls.APISecret
}

// Usable is Configured() AND not accidentally sharing the calling project.
// Every handler gates on this rather than Configured(), so an overlap fails
// closed instead of working exactly like the coupling we removed.
func (c Config) Usable() bool { return c.Configured() && !c.SameProjectAsCalls() }

// RoomName is the Go Live room for a broadcast.
//
// Derived from the BROADCAST id, not the host id. The previous scheme was
// "bc_<user-id>", which meant every broadcast a host ever ran reused one room
// name: a viewer holding a stale token could rejoin the host's NEXT stream, and
// two sessions in quick succession could have egress attach to the wrong one.
func (c Config) RoomName(broadcastID string) string { return c.RoomPrefix + broadcastID }
