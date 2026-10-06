package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"vaultchat/backend-go/internal/games/domain"
)

// Service is Games' application layer.
type Service struct {
	Players  Players
	Signer   LaunchSigner
	Verifier NotifyVerifier
	Voice    VoiceTokens
	Tables   Tables
	Dedupe   Dedupe
	Devices  Devices
	Pusher   Pusher
	Matches  Matches
	Now      func() time.Time
}

// Each error is one answer of the HTTP contract; the inbound adapter maps them.
var (
	ErrLaunchNotConfigured = errors.New("launch signing key not configured")
	ErrNoVaultID           = errors.New("user has no vault id")
	ErrSign                = errors.New("could not sign")
	ErrGameAndRoom         = errors.New("game and room required")
	ErrUnknownGame         = errors.New("unknown game")
	ErrVoiceNotConfigured  = errors.New("voice not configured")
	ErrNotifyNotConfigured = errors.New("notify key not configured")
	ErrNoEvent             = errors.New("event required")
	ErrBadSignature        = errors.New("bad event signature")
	ErrSubAndJTI           = errors.New("sub and jti required")
	ErrDedupe              = errors.New("dedupe failed")
	ErrPushFailed          = errors.New("push delivery failed")
	ErrStore               = errors.New("store failed")
	ErrTokenRequired       = errors.New("fcm token required")
	ErrPracticeOnly        = errors.New("practice tables only")
	ErrTableAndVariant     = errors.New("table and known variant required")
	ErrTableIDRequired     = errors.New("table id required")
	ErrMatchAndResults     = errors.New("match and results required")
)

// notifyTTL: a turn notification is useful for as long as the turn is — which
// in asynchronous play is hours, not the 30 seconds a call ring gets. FCM holds
// an undeliverable data message this long, so a phone that was off overnight
// still gets the nudge when it comes back.
const notifyTTL = 4 * time.Hour

// player resolves the caller to a games identity, or ErrUserNotFound /
// ErrNoVaultID.
func (s *Service) player(ctx context.Context, userID string) (string, string, error) {
	p, err := s.Players.Player(ctx, userID)
	if err != nil {
		return "", "", ErrUserNotFound
	}
	if p.VaultID == "" {
		return "", "", ErrNoVaultID
	}
	return p.VaultID, domain.DisplayName(p.VaultID, p.Name), nil
}

type LaunchToken struct {
	Token, Nonce string
	Exp          int64
}

// LaunchToken mints the signed token the games WebView exchanges for its own
// session. sub is the vaultId — the internal user id never crosses over.
func (s *Service) LaunchToken(ctx context.Context, userID string) (LaunchToken, error) {
	if s.Signer.Ready() != nil {
		return LaunchToken{}, ErrLaunchNotConfigured
	}
	vaultID, name, err := s.player(ctx, userID)
	if err != nil {
		return LaunchToken{}, err
	}
	now := s.Now()
	exp := now.Add(domain.LaunchTTL)
	tok, nonce, err := s.Signer.Sign(vaultID, name, now, exp)
	if err != nil {
		return LaunchToken{}, ErrSign
	}
	// Single use of the nonce is enforced by the games server; no store here.
	return LaunchToken{Token: tok, Nonce: nonce, Exp: exp.Unix()}, nil
}

type VoiceToken struct {
	VoiceGrant
	Room, Identity string
}

// VoiceToken mints a join token for a game table's voice room.
//
// The honest authz: a signed-in user who knows a table's room id may join its
// audio. Room ids travel in invite links; we cannot ask the games server who is
// seated. What keeps it tight: the room name is composed here from slugs, the
// role is never an admin one, and a spectator cannot publish AT THE MEDIA
// SERVER. Identity is the vaultId, because the board lights seats by vaultId.
func (s *Service) VoiceToken(ctx context.Context, userID, game, room string, spectator bool) (VoiceToken, error) {
	game, room = domain.Slug(game), domain.Slug(room)
	if game == "" || room == "" {
		return VoiceToken{}, ErrGameAndRoom
	}
	if !domain.HasVoice(game) {
		return VoiceToken{}, ErrUnknownGame
	}
	if !s.Voice.Configured() {
		return VoiceToken{}, ErrVoiceNotConfigured
	}
	vaultID, name, err := s.player(ctx, userID)
	if err != nil {
		return VoiceToken{}, err
	}
	lkRoom := domain.VoiceRoom(game, room)
	g, err := s.Voice.Mint(vaultID, name, lkRoom, spectator)
	if err != nil {
		return VoiceToken{}, ErrSign
	}
	return VoiceToken{VoiceGrant: g, Room: lkRoom, Identity: vaultID}, nil
}

// NotifyResult is a 200 answer to the games server: delivered, deduped, or a
// settled reason no retry can change.
type NotifyResult struct {
	Deduped   bool
	Delivered bool
	Reason    string
	Sent      int
}

// Notify turns one signed games-server event into a push.
//
// The signature is the authentication: the caller is a server with no session.
// The jti is claimed BEFORE sending and released if the send fails — recording
// afterwards would double-notify when the write lost a race with a retry, and
// never releasing would swallow the retry of a push that genuinely failed.
func (s *Service) Notify(ctx context.Context, rawEvent string) (NotifyResult, error) {
	if s.Verifier.Ready() != nil {
		// A server that cannot check, not a caller that failed a check.
		return NotifyResult{}, ErrNotifyNotConfigured
	}
	if strings.TrimSpace(rawEvent) == "" {
		return NotifyResult{}, ErrNoEvent
	}
	ev, err := s.Verifier.Verify(rawEvent)
	if err != nil {
		return NotifyResult{}, ErrBadSignature
	}
	vaultID, jti := strings.TrimSpace(ev.Recipient), strings.TrimSpace(ev.ID)
	if vaultID == "" || jti == "" {
		return NotifyResult{}, ErrSubAndJTI
	}
	game, room := domain.Slug(ev.Game), domain.Slug(ev.Room)

	expires := s.Now().Add(15 * time.Minute)
	if ev.ExpiresAt != nil {
		expires = *ev.ExpiresAt
	}
	fresh, err := s.Dedupe.Claim(ctx, jti, expires)
	if err != nil {
		return NotifyResult{}, ErrDedupe
	}
	if !fresh {
		// The games server retried something we already delivered.
		return NotifyResult{Deduped: true}, nil
	}

	userID, err := s.Players.UserIDForVault(ctx, vaultID)
	if err != nil {
		// Settled, not transient. The jti stays claimed so retries stop.
		return NotifyResult{Reason: "unknown_recipient"}, nil
	}

	// Remember the table BEFORE the push and regardless of whether it lands:
	// the list is the half of asynchronous play that works when the push is
	// missed. Fail-soft — a list hiccup must not turn a deliverable turn
	// notification into a 500 the games server retries.
	title, body := domain.Text(ev.Title), domain.Text(ev.Body)
	if game != "" && room != "" && domain.IsTableKind(ev.Kind) {
		_ = s.Tables.Remember(ctx, userID, domain.LiveTable{
			Game: game, Room: room, YourTurn: domain.IsYourTurn(ev.Kind), Title: title, Body: body,
		})
	}

	tokens := s.Devices.Tokens(ctx, userID)
	if len(tokens) == 0 {
		return NotifyResult{Reason: "no_device_token"}, nil
	}
	// game+room make the tap land on the right table. Title and body cross
	// Google's servers in the clear: game state is not end-to-end encrypted
	// anywhere — it lives in plaintext on the games server by design.
	res := s.Pusher.Send(tokens, map[string]string{
		"type":  "games_turn",
		"kind":  domain.Text(ev.Kind),
		"title": title,
		"body":  body,
		"game":  game,
		"room":  room,
		"jti":   jti,
	}, notifyTTL)
	if len(res.Dead) > 0 {
		s.Devices.ClearDead(ctx, res.Dead)
	}
	if !res.OK {
		// Every token was dead, or the transport failed: release the claim so
		// the retry is not deduped into silence.
		s.Dedupe.Release(ctx, jti)
		return NotifyResult{}, ErrPushFailed
	}
	return NotifyResult{Delivered: true, Sent: res.Sent}, nil
}

// LiveTables is the caller's tables, newest first.
func (s *Service) LiveTables(ctx context.Context, userID string) ([]domain.LiveTable, error) {
	t, err := s.Tables.List(ctx, userID)
	if err != nil {
		return nil, ErrStore
	}
	return t, nil
}

// ForgetTable drops one of the caller's own rows, when the app opens a table
// and the games server's snapshot says the game is over. The client relays
// what the authoritative snapshot said; it does not decide game truth.
func (s *Service) ForgetTable(ctx context.Context, userID, game, room string) error {
	game, room = domain.Slug(game), domain.Slug(room)
	if game == "" || room == "" {
		return ErrGameAndRoom
	}
	if s.Tables.Forget(ctx, userID, game, room) != nil {
		return ErrStore
	}
	return nil
}

// DeviceToken registers (or unregisters) the caller's device for games push,
// through the same device row calls and chat use.
func (s *Service) DeviceToken(ctx context.Context, userID, token, platform string, unregister bool) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return ErrTokenRequired
	}
	if unregister {
		if s.Devices.Unregister(ctx, userID, token) != nil {
			return ErrStore
		}
		return nil
	}
	platform = strings.ToLower(strings.TrimSpace(platform))
	if platform == "" {
		platform = "android"
	}
	if s.Devices.Register(ctx, userID, token, platform) != nil {
		return ErrStore
	}
	return nil
}

func (s *Service) vaultID(ctx context.Context, userID string) (string, error) {
	vid, err := s.Players.VaultID(ctx, userID)
	if err != nil {
		return "", ErrStore
	}
	if vid == "" {
		return "", ErrNoVaultID
	}
	return vid, nil
}

// OpenMatch opens a match at a table, or returns the one already running there
// (every client at the table may try to open it).
//
// PRACTICE TABLES ONLY: a staked table settles coins on every deal, so a pool
// over it would charge per deal and per match. Only the games server knows a
// table's stake and it exposes no API to ask, so the claim comes from the
// client — a stated limitation; no coin moves through this module.
func (s *Service) OpenMatch(ctx context.Context, userID, tableID, variant string, practice bool) (domain.Match, error) {
	tableID = strings.TrimSpace(tableID)
	v := domain.Variant(strings.TrimSpace(variant))
	if tableID == "" || !v.Valid() {
		return domain.Match{}, ErrTableAndVariant
	}
	if !practice {
		return domain.Match{}, ErrPracticeOnly
	}
	vid, err := s.vaultID(ctx, userID)
	if err != nil {
		return domain.Match{}, err
	}
	m, err := s.Matches.Open(ctx, tableID, v, vid)
	if err != nil {
		return domain.Match{}, ErrStore
	}
	return m, nil
}

// RunningMatch is the running match at a table; nil (not an error) when there
// is none, which is the ordinary case on every board open.
func (s *Service) RunningMatch(ctx context.Context, tableID string) (*domain.Match, error) {
	tableID = strings.TrimSpace(tableID)
	if tableID == "" {
		return nil, ErrTableIDRequired
	}
	m, err := s.Matches.Running(ctx, tableID)
	if err != nil {
		return nil, ErrStore
	}
	return m, nil
}

// AdvanceMatch applies one deal's result EXACTLY ONCE. Every seat posts the
// same deal; the write applies only where the stored deal count still equals
// the reported index, so the first writer wins and the rest read back its
// state. Without this, one deal counts once per seat — in Pool, eliminating
// the whole table at once.
func (s *Service) AdvanceMatch(ctx context.Context, userID, matchID string, dealIndex int, results []domain.DealResult) (domain.Match, error) {
	if strings.TrimSpace(matchID) == "" || len(results) == 0 {
		return domain.Match{}, ErrMatchAndResults
	}
	if _, err := s.vaultID(ctx, userID); err != nil {
		return domain.Match{}, err
	}
	m, err := s.Matches.Get(ctx, matchID)
	if errors.Is(err, ErrMatchNotFound) {
		return domain.Match{}, ErrMatchNotFound
	} else if err != nil {
		return domain.Match{}, ErrStore
	}
	next, ok := m.Advance(dealIndex, results)
	if !ok {
		return m, nil
	}
	won, err := s.Matches.Advance(ctx, next, m.DealsPlayed)
	if err != nil {
		return domain.Match{}, ErrStore
	}
	if !won {
		// Lost the race: return what the winner wrote.
		if latest, err := s.Matches.Get(ctx, matchID); err == nil {
			return latest, nil
		}
		return m, nil
	}
	return next, nil
}
