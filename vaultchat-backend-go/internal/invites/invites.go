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
	StatusPending Status = "pending"
	// The invitee consented. NOT yet a member: in strict mode an owner still
	// has to approve. Keeping this distinct from StatusJoined is what makes the
	// three-step flow expressible at all.
	StatusAccepted Status = "accepted"
	StatusJoined   Status = "joined"
	StatusRejected Status = "rejected"
	// The INVITER withdrew, as opposed to StatusRejected where the INVITEE
	// declined. Merging them would lose who ended it.
	StatusCancelled Status = "cancelled"
	StatusExpired   Status = "expired"
	StatusRevoked   Status = "revoked"
)

// ApprovalMode decides how many gates stand between an invitation and
// membership. Mirrors chats.approval_mode (migration 073).
type ApprovalMode string

const (
	// ModeStrict is the default: both sides must say yes.
	ModeStrict        ApprovalMode = "strict"
	ModeUserApproval  ApprovalMode = "user_approval"
	ModeAdminApproval ApprovalMode = "admin_approval"
)

func ValidMode(m string) bool {
	switch ApprovalMode(m) {
	case ModeStrict, ModeUserApproval, ModeAdminApproval:
		return true
	}
	return false
}

// NormalizeMode falls back to the STRICTEST mode for anything unrecognised.
// A corrupt or future value must not silently downgrade a group to
// auto-joining, which is the one outcome nobody could undo.
func NormalizeMode(m string) ApprovalMode {
	if ValidMode(m) {
		return ApprovalMode(m)
	}
	return ModeStrict
}

// NextAfterAccept is where an invitation lands once the invitee consents.
//
// Under user_approval that is membership immediately; under strict it waits for
// an owner. admin_approval never reaches here by this path — its invitations
// start as a request from the user, not an invite from the owner.
func NextAfterAccept(mode ApprovalMode) Status {
	if mode == ModeUserApproval {
		return StatusJoined
	}
	return StatusAccepted
}

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
//
// StatusAccepted is deliberately NOT terminal any more: it is now the waiting
// room before an owner approves. StatusJoined is, because membership is granted
// and any later change belongs to the member list, not the invitation.
func IsTerminal(s Status) bool {
	switch s {
	case StatusJoined, StatusRejected, StatusRevoked, StatusCancelled:
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
		// user_approval jumps straight to joined; strict stops at accepted.
		return to == StatusAccepted || to == StatusJoined ||
			to == StatusRejected || to == StatusCancelled ||
			to == StatusRevoked || to == StatusExpired
	case StatusAccepted:
		// The owner's decision, or the invitee changing their mind before it.
		return to == StatusJoined || to == StatusRejected ||
			to == StatusCancelled || to == StatusExpired
	case StatusExpired:
		return to == StatusRevoked || to == StatusCancelled || to == StatusPending
	}
	return false
}

// CanAccept reports whether the INVITEE may consent right now.
func CanAccept(s Status) bool { return s == StatusPending }

// CanApprove reports whether an owner/admin may grant membership.
//
// Only from Accepted: approving a Pending invitation would grant membership to
// someone who has not yet agreed to join, which is the one thing the consent
// step exists to prevent.
func CanApprove(s Status) bool { return s == StatusAccepted }

// CanCancel reports whether the INVITER may withdraw.
func CanCancel(s Status) bool { return s == StatusPending || s == StatusAccepted || s == StatusExpired }

// CanDecline reports whether the INVITEE may say no. Allowed after accepting
// too — someone may change their mind while waiting on an owner.
func CanDecline(s Status) bool { return s == StatusPending || s == StatusAccepted }

// CanResend reports whether an invitation may be reissued with a fresh token.
// Resending an accepted invitation is meaningless; resending a revoked one
// would quietly undo a deliberate revocation.
func CanResend(s Status) bool {
	return s == StatusPending || s == StatusExpired
}

// IsLive reports whether an invitation still occupies its invitee's slot, which
// is what the duplicate guard in migration 073 keys on.
func IsLive(s Status) bool { return s == StatusPending || s == StatusAccepted }

// CanRevoke reports whether an invitation may still be withdrawn.
func CanRevoke(s Status) bool {
	return s == StatusPending || s == StatusExpired
}

// ValidStatus reports whether a stored string is a status this build knows.
func ValidStatus(s string) bool {
	switch Status(s) {
	case StatusPending, StatusAccepted, StatusJoined,
		StatusRejected, StatusCancelled, StatusExpired, StatusRevoked:
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
