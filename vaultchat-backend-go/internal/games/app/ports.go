// Package app holds Games' use cases and the ports they drive (openspec:
// hexagonal-architecture). It depends on the domain only; adapters implement
// the ports and are wired together in package games.
package app

import (
	"context"
	"errors"
	"time"

	"vaultchat/backend-go/internal/games/domain"
)

// Players reads VaultChat users as the games server knows them.
type Players interface {
	// Player is a live (not deleted) user with their decoded display name;
	// ErrUserNotFound when there is none. VaultID is "" when unassigned.
	Player(ctx context.Context, userID string) (domain.Player, error)
	// VaultID is the user's vault id, "" when unassigned (matches path).
	VaultID(ctx context.Context, userID string) (string, error)
	// UserIDForVault resolves a live user by vault id.
	UserIDForVault(ctx context.Context, vaultID string) (string, error)
}

// LaunchSigner signs the token the games WebView exchanges for a session.
type LaunchSigner interface {
	Ready() error
	Sign(vaultID, name string, iat, exp time.Time) (token, nonce string, err error)
}

// NotifyVerifier checks a games-server event's signature and expiry.
type NotifyVerifier interface {
	Ready() error
	Verify(event string) (domain.Event, error)
}

// VoiceTokens mints media-server tokens for a table's voice room.
type VoiceTokens interface {
	Configured() bool
	// Mint grants listen-only when spectator, speak otherwise; never admin.
	Mint(identity, name, room string, spectator bool) (VoiceGrant, error)
}

type VoiceGrant struct{ Token, URL, Role string }

// Tables is the per-player live-tables list (migration 125). Every operation is
// scoped to userID by the adapter itself: RLS is inert in production.
type Tables interface {
	List(ctx context.Context, userID string) ([]domain.LiveTable, error)
	Remember(ctx context.Context, userID string, t domain.LiveTable) error
	Forget(ctx context.Context, userID, game, room string) error
}

// Dedupe records notify event ids so a retried delivery is not pushed twice.
type Dedupe interface {
	// Claim reports whether jti was new. Concurrent claims of one jti: exactly
	// one wins.
	Claim(ctx context.Context, jti string, expires time.Time) (bool, error)
	Release(ctx context.Context, jti string)
}

// Devices are the users' push registrations, shared with calls and chat.
type Devices interface {
	Tokens(ctx context.Context, userID string) []string
	Register(ctx context.Context, userID, token, platform string) error
	Unregister(ctx context.Context, userID, token string) error
	ClearDead(ctx context.Context, tokens []string)
}

// Pusher sends a data push to device tokens.
type Pusher interface {
	Send(tokens []string, data map[string]string, ttl time.Duration) PushResult
}

type PushResult struct {
	OK   bool
	Sent int
	Dead []string
}

// Matches stores Pool/Deals matches (migration 126).
type Matches interface {
	// Open returns the running match at the table, creating it if there is none.
	Open(ctx context.Context, tableID string, v domain.Variant, hostVaultID string) (domain.Match, error)
	// Running is the running match at the table, nil when there is none.
	Running(ctx context.Context, tableID string) (*domain.Match, error)
	// Get is ErrMatchNotFound when there is no such match.
	Get(ctx context.Context, id string) (domain.Match, error)
	// Advance writes next only if the stored match is still running at
	// fromDeals; won=false means another seat's report got there first.
	Advance(ctx context.Context, next domain.Match, fromDeals int) (won bool, err error)
}

var (
	ErrUserNotFound  = errors.New("user not found")
	ErrMatchNotFound = errors.New("no such match")
)
