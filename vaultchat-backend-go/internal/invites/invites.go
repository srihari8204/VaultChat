// Package invites holds the per-invitee invitation token and status machine.
//
// PURE by construction: no database, no HTTP. The token format and the legal
// status transitions are security-relevant, so they live somewhere they can be
// tested exhaustively rather than being spread across route handlers.
//
// Token design
//
//	token   = base64url(invitationID "." chatID "." expiryUnix "." sig)
//	sig     = HMAC-SHA256(secret, invitationID "." chatID "." expiryUnix)
//
// Properties this buys, each of which a plain random code lacks:
//   - The group is BOUND INTO the signature, so a token leaked from one group
//     cannot be replayed against another.
//   - The expiry is signed, so it cannot be extended by editing the token.
//   - Verification needs no database round trip to reject a forgery.
//   - The token carries no personal data: two opaque ids and a timestamp.
//
// The database stores only Hash(token), so a dump of chat_invitations does not
// yield working invitations.
package invites

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Status is an invitation's lifecycle state.
type Status string

const (
	StatusPending  Status = "pending"
	StatusAccepted Status = "accepted"
	StatusRejected Status = "rejected"
	StatusExpired  Status = "expired"
	StatusRevoked  Status = "revoked"
)

// InviteeKind is how the invitee was addressed.
type InviteeKind string

const (
	KindUser  InviteeKind = "user"  // resolved to a VaultChat account
	KindPhone InviteeKind = "phone" // addressed by phone, stored as a lookup hash
	KindEmail InviteeKind = "email"
	KindLink  InviteeKind = "link" // identity-less: a bare shareable link
)

// Channel records how an invitation was delivered. Display only.
type Channel string

const (
	ChannelApp      Channel = "app"
	ChannelSMS      Channel = "sms"
	ChannelWhatsApp Channel = "whatsapp"
	ChannelEmail    Channel = "email"
	ChannelQR       Channel = "qr"
	ChannelLink     Channel = "link"
)

// DefaultTTL is how long a new invitation stays redeemable.
const DefaultTTL = 7 * 24 * time.Hour

// MaxTTL bounds a caller-supplied expiry. An invitation that never expires is
// a permanent credential, which is precisely what the per-invitee model exists
// to avoid.
const MaxTTL = 30 * 24 * time.Hour

var (
	ErrMalformed = errors.New("malformed invitation token")
	ErrSignature = errors.New("invitation token signature mismatch")
	ErrExpired   = errors.New("invitation token expired")
	ErrWrongChat = errors.New("invitation token is for a different group")
)

// Token is a decoded, signature-verified invitation token.
type Token struct {
	InvitationID int64
	ChatID       string
	ExpiresAt    time.Time
}

func sign(secret []byte, payload string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(payload))
	return hex.EncodeToString(m.Sum(nil))
}

func payloadOf(invitationID int64, chatID string, expiresAt time.Time) string {
	return strconv.FormatInt(invitationID, 10) + "." + chatID + "." +
		strconv.FormatInt(expiresAt.Unix(), 10)
}

// Mint produces a token for an invitation. The caller stores Hash(token).
func Mint(secret []byte, invitationID int64, chatID string, expiresAt time.Time) string {
	p := payloadOf(invitationID, chatID, expiresAt)
	raw := p + "." + sign(secret, p)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// Verify decodes and authenticates a token. It checks the signature before the
// expiry so a forged token is never reported as merely "expired" — that
// distinction would tell an attacker their forgery was structurally accepted.
func Verify(secret []byte, token string) (*Token, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(token))
	if err != nil {
		return nil, ErrMalformed
	}
	parts := strings.Split(string(raw), ".")
	if len(parts) != 4 {
		return nil, ErrMalformed
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return nil, ErrMalformed
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return nil, ErrMalformed
	}
	want := sign(secret, payloadOf(id, parts[1], time.Unix(exp, 0)))
	// Constant-time: a byte-wise comparison here leaks the signature via timing.
	if !hmac.Equal([]byte(want), []byte(parts[3])) {
		return nil, ErrSignature
	}
	t := &Token{InvitationID: id, ChatID: parts[1], ExpiresAt: time.Unix(exp, 0)}
	if time.Now().After(t.ExpiresAt) {
		return t, ErrExpired
	}
	return t, nil
}

// VerifyFor authenticates a token AND pins it to the group it was minted for.
func VerifyFor(secret []byte, token, chatID string) (*Token, error) {
	t, err := Verify(secret, token)
	if err != nil {
		return t, err
	}
	if t.ChatID != chatID {
		return t, ErrWrongChat
	}
	return t, nil
}

// Hash is what the database stores. Never store the token itself.
func Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ClampTTL bounds a requested lifetime into [1 hour, MaxTTL], defaulting when
// the caller supplies nothing sensible.
func ClampTTL(d time.Duration) time.Duration {
	if d <= 0 {
		return DefaultTTL
	}
	if d < time.Hour {
		return time.Hour
	}
	if d > MaxTTL {
		return MaxTTL
	}
	return d
}

// Effective reports the status a caller should SEE, collapsing a pending row
// that has quietly passed its expiry. The stored value is only rewritten when
// something actually happens to the invitation.
func Effective(stored Status, expiresAt time.Time, now time.Time) Status {
	if stored == StatusPending && now.After(expiresAt) {
		return StatusExpired
	}
	return stored
}

// IsTerminal reports whether a status can never change again.
func IsTerminal(s Status) bool {
	switch s {
	case StatusAccepted, StatusRejected, StatusRevoked:
		return true
	}
	return false
}

// CanTransition reports whether from → to is legal.
//
// Expiry is deliberately NOT terminal: an expired invitation may be revoked
// (tidying a stale list) and may be resent, which returns it to pending with a
// fresh token. Everything else terminal stays terminal — accepting an invite
// that was already rejected would silently re-add a removed member.
func CanTransition(from, to Status) bool {
	if from == to {
		return false
	}
	if IsTerminal(from) {
		return false
	}
	switch from {
	case StatusPending:
		return to == StatusAccepted || to == StatusRejected ||
			to == StatusRevoked || to == StatusExpired
	case StatusExpired:
		return to == StatusRevoked || to == StatusPending
	}
	return false
}

// CanResend reports whether an invitation may be reissued with a fresh token.
// Resending an accepted invitation is meaningless; resending a revoked one
// would quietly undo a deliberate revocation.
func CanResend(s Status) bool {
	return s == StatusPending || s == StatusExpired
}

// CanRevoke reports whether an invitation may still be withdrawn.
func CanRevoke(s Status) bool {
	return s == StatusPending || s == StatusExpired
}

// ValidStatus reports whether a stored string is a status this build knows.
func ValidStatus(s string) bool {
	switch Status(s) {
	case StatusPending, StatusAccepted, StatusRejected, StatusExpired, StatusRevoked:
		return true
	}
	return false
}

// ValidChannel reports whether a delivery channel is known. Unknown channels
// fall back to link rather than being rejected — the channel is a display
// label, and refusing an invitation over a cosmetic field would be absurd.
func ValidChannel(c string) bool {
	switch Channel(c) {
	case ChannelApp, ChannelSMS, ChannelWhatsApp, ChannelEmail, ChannelQR, ChannelLink:
		return true
	}
	return false
}

// NormalizeChannel maps any input onto a known channel.
func NormalizeChannel(c string) Channel {
	if ValidChannel(c) {
		return Channel(c)
	}
	return ChannelLink
}
