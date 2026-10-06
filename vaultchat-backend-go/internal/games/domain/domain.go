// Package domain is the core of Games (openspec: hexagonal-architecture): the
// rules for identifiers that cross into the games WebView, table voice rooms,
// the live-tables list and Pool/Deals rummy scoring. Standard library only.
package domain

import (
	"strings"
	"time"
)

// LaunchTTL is the life of a games launch token. Short on purpose: the token is
// a bearer credential for the WebView, and a short life is the replay defense.
// The app re-mints as needed.
const LaunchTTL = 15 * time.Minute

// MaxText bounds free text the games server supplies. It is a trusted peer, not
// trusted input: these strings reach a notification builder on a phone.
const MaxText = 200

// Slug bounds an identifier that becomes part of a URL the app opens inside the
// games WebView, or of a voice room name; "" means rejected.
//
// INPUT VALIDATION AT A TRUST BOUNDARY — do not drop this because the caller is
// "our own" server. The app composes games.corefinite.com/<game>.html?room=
// <room> from these two fields; a game of "../../x", or a room carrying a quote
// or an ampersand, rewrites that URL into something else. The WebView's origin
// allowlist is the second line of defence and must never be the only one.
func Slug(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 64 {
		return ""
	}
	for _, c := range s {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
			c == '-' || c == '_'
		if !ok {
			return ""
		}
	}
	return s
}

// Text trims and bounds games-server free text.
func Text(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > MaxText {
		s = s[:MaxText]
	}
	return s
}

// DisplayName is the name the games server shows for a player: their decoded
// name when there is one, else the vaultId. The games server rejects an empty
// name outright, so the fallback stays — as the last resort, not the path
// everyone takes.
func DisplayName(vaultID string, name *string) string {
	if name != nil {
		if trimmed := strings.TrimSpace(*name); trimmed != "" {
			return trimmed
		}
	}
	return vaultID
}

// Player is a VaultChat user as the games server knows them. VaultID is the
// ONLY identity that crosses the boundary: the games server keys balances,
// stats, seats and deep links by it.
type Player struct {
	VaultID string
	Name    *string
}
