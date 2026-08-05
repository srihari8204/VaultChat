package invites

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

var secret = []byte("test-secret-not-a-real-one")

func future() time.Time { return time.Now().Add(time.Hour) }
func past() time.Time   { return time.Now().Add(-time.Hour) }

func TestMintVerifyRoundTrip(t *testing.T) {
	exp := future()
	tok := Mint(secret, 42, "chat-abc", exp)
	got, err := Verify(secret, tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.InvitationID != 42 || got.ChatID != "chat-abc" {
		t.Fatalf("round trip lost data: %+v", got)
	}
	if got.ExpiresAt.Unix() != exp.Unix() {
		t.Fatalf("expiry drifted: %v vs %v", got.ExpiresAt, exp)
	}
}

func TestTokenCannotBeReplayedAgainstAnotherGroup(t *testing.T) {
	// The property that makes this better than a random code.
	tok := Mint(secret, 1, "group-A", future())
	if _, err := VerifyFor(secret, tok, "group-A"); err != nil {
		t.Fatalf("own group should verify: %v", err)
	}
	if _, err := VerifyFor(secret, tok, "group-B"); err != ErrWrongChat {
		t.Fatalf("cross-group replay must fail, got %v", err)
	}
}

func TestForgedSignatureRejected(t *testing.T) {
	tok := Mint(secret, 1, "chat", future())
	if _, err := Verify([]byte("different-secret"), tok); err != ErrSignature {
		t.Fatalf("wrong secret must fail signature, got %v", err)
	}
}

func TestExpiryCannotBeExtendedByEditingTheToken(t *testing.T) {
	// Re-sign attempt without the secret: change the expiry, keep the old sig.
	tok := Mint(secret, 7, "chat", past())
	dec := decode(t, tok)
	parts := strings.Split(dec, ".")
	parts[2] = "99999999999" // far future
	tampered := encode(strings.Join(parts, "."))
	if _, err := Verify(secret, tampered); err != ErrSignature {
		t.Fatalf("extending expiry must break the signature, got %v", err)
	}
}

func TestSignatureCheckedBeforeExpiry(t *testing.T) {
	// A forged token must never be reported as merely "expired" — that would
	// confirm to an attacker that their forgery was structurally accepted.
	tok := Mint(secret, 1, "chat", past())
	if _, err := Verify([]byte("wrong"), tok); err != ErrSignature {
		t.Fatalf("expected signature error first, got %v", err)
	}
	if _, err := Verify(secret, tok); err != ErrExpired {
		t.Fatalf("valid-but-old token should be expired, got %v", err)
	}
}

func TestMalformedTokens(t *testing.T) {
	for _, bad := range []string{"", "!!!not base64!!!", encode("only.three.parts"), encode("nope.chat.123.sig")} {
		if _, err := Verify(secret, bad); err == nil {
			t.Errorf("malformed token %q should fail", bad)
		}
	}
}

func TestTokenCarriesNoPersonalData(t *testing.T) {
	tok := Mint(secret, 99, "chat-xyz", future())
	dec := decode(t, tok)
	for _, leak := range []string{"@", "priya", "+91", "Family"} {
		if strings.Contains(strings.ToLower(dec), strings.ToLower(leak)) {
			t.Fatalf("token payload leaked %q: %s", leak, dec)
		}
	}
}

func TestHashIsStableAndNotTheToken(t *testing.T) {
	tok := Mint(secret, 1, "chat", future())
	h := Hash(tok)
	if h == tok {
		t.Fatal("hash must not equal the token")
	}
	if h != Hash(tok) {
		t.Fatal("hash must be stable")
	}
	if Hash("a") == Hash("b") {
		t.Fatal("different tokens must hash differently")
	}
}

func TestClampTTL(t *testing.T) {
	cases := []struct {
		in   time.Duration
		want time.Duration
	}{
		{0, DefaultTTL},
		{-time.Hour, DefaultTTL},
		{time.Minute, time.Hour},         // floor
		{48 * time.Hour, 48 * time.Hour}, // passthrough
		{365 * 24 * time.Hour, MaxTTL},   // ceiling: no permanent credentials
	}
	for _, c := range cases {
		if got := ClampTTL(c.in); got != c.want {
			t.Errorf("ClampTTL(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestEffectiveCollapsesSilentlyExpiredRows(t *testing.T) {
	now := time.Now()
	if got := Effective(StatusPending, now.Add(-time.Minute), now); got != StatusExpired {
		t.Fatalf("stale pending should read expired, got %s", got)
	}
	if got := Effective(StatusPending, now.Add(time.Minute), now); got != StatusPending {
		t.Fatalf("live pending should stay pending, got %s", got)
	}
	// A terminal status is never rewritten by the clock.
	if got := Effective(StatusAccepted, now.Add(-time.Hour), now); got != StatusAccepted {
		t.Fatalf("accepted must survive expiry, got %s", got)
	}
	if got := Effective(StatusRevoked, now.Add(-time.Hour), now); got != StatusRevoked {
		t.Fatalf("revoked must survive expiry, got %s", got)
	}
}

func TestTransitions(t *testing.T) {
	cases := []struct {
		from, to Status
		want     bool
		why      string
	}{
		{StatusPending, StatusAccepted, true, "normal acceptance"},
		{StatusPending, StatusRejected, true, "invitee declines"},
		{StatusPending, StatusRevoked, true, "admin withdraws"},
		{StatusPending, StatusExpired, true, "time passes"},
		{StatusExpired, StatusPending, true, "resend revives"},
		{StatusExpired, StatusRevoked, true, "tidy a stale list"},
		{StatusAccepted, StatusPending, false, "cannot un-accept"},
		{StatusRejected, StatusAccepted, false, "a rejection must not be overturned"},
		{StatusRevoked, StatusAccepted, false, "revoking must not be undoable by redeeming"},
		{StatusRevoked, StatusPending, false, "revoked stays revoked"},
		{StatusPending, StatusPending, false, "no self-transition"},
	}
	for _, c := range cases {
		if got := CanTransition(c.from, c.to); got != c.want {
			t.Errorf("%s: %s→%s = %v, want %v", c.why, c.from, c.to, got, c.want)
		}
	}
}

func TestResendAndRevokeWindows(t *testing.T) {
	for _, s := range []Status{StatusPending, StatusExpired} {
		if !CanResend(s) {
			t.Errorf("%s should be resendable", s)
		}
		if !CanRevoke(s) {
			t.Errorf("%s should be revocable", s)
		}
	}
	for _, s := range []Status{StatusAccepted, StatusRejected, StatusRevoked} {
		if CanResend(s) {
			t.Errorf("%s must not be resendable", s)
		}
		if CanRevoke(s) {
			t.Errorf("%s must not be revocable", s)
		}
	}
}

func TestValidators(t *testing.T) {
	if !ValidStatus("pending") || ValidStatus("banished") {
		t.Fatal("ValidStatus wrong")
	}
	if !ValidChannel("whatsapp") || ValidChannel("carrier-pigeon") {
		t.Fatal("ValidChannel wrong")
	}
	// An unknown channel is cosmetic — fall back rather than reject.
	if NormalizeChannel("carrier-pigeon") != ChannelLink {
		t.Fatal("unknown channel should normalize to link")
	}
	if NormalizeChannel("sms") != ChannelSMS {
		t.Fatal("known channel should pass through")
	}
}

func TestIsTerminal(t *testing.T) {
	// CHANGED in membership v2: 'accepted' used to be terminal, because
	// accepting WAS joining. It is now the waiting room before an owner
	// approves, so it must stay changeable. See TestAcceptedIsNotTerminalButJoinedIs.
	for _, s := range []Status{StatusJoined, StatusRejected, StatusRevoked, StatusCancelled} {
		if !IsTerminal(s) {
			t.Errorf("%s should be terminal", s)
		}
	}
	// Expired is deliberately NOT terminal — a resend revives it. Nor is
	// accepted, which is still awaiting a decision.
	for _, s := range []Status{StatusPending, StatusExpired, StatusAccepted} {
		if IsTerminal(s) {
			t.Errorf("%s should not be terminal", s)
		}
	}
}

// ── helpers ──

func decode(t *testing.T, tok string) string {
	t.Helper()
	b, err := b64decode(tok)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return string(b)
}

func b64decode(tok string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(tok)
}

func encode(raw string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// ── membership v2: the three-step flow ──

func TestApprovalModes(t *testing.T) {
	if !ValidMode("strict") || !ValidMode("user_approval") || !ValidMode("admin_approval") {
		t.Fatal("the three real modes must validate")
	}
	if ValidMode("open") {
		t.Fatal("an unknown mode must not validate")
	}
	// The load-bearing default: anything unrecognised falls back to the
	// STRICTEST mode. A corrupt value must never downgrade a group to
	// auto-joining, which is the one outcome nobody could undo.
	if NormalizeMode("") != ModeStrict {
		t.Fatal("empty must normalise to strict")
	}
	if NormalizeMode("open") != ModeStrict {
		t.Fatal("unknown must normalise to strict, not to the permissive mode")
	}
	if NormalizeMode("user_approval") != ModeUserApproval {
		t.Fatal("a known mode should pass through")
	}
}

func TestAcceptLandsInTheRightPlacePerMode(t *testing.T) {
	if NextAfterAccept(ModeStrict) != StatusAccepted {
		t.Fatal("strict must wait for an owner after acceptance")
	}
	if NextAfterAccept(ModeUserApproval) != StatusJoined {
		t.Fatal("user_approval must join immediately on acceptance")
	}
	// admin_approval invitations never travel this path, but must not join.
	if NextAfterAccept(ModeAdminApproval) == StatusJoined {
		t.Fatal("admin_approval must not auto-join")
	}
}

func TestAcceptedIsNotTerminalButJoinedIs(t *testing.T) {
	// The whole three-step flow rests on this: 'accepted' is a waiting room.
	if IsTerminal(StatusAccepted) {
		t.Fatal("accepted must remain changeable — an owner still has to approve")
	}
	for _, s := range []Status{StatusJoined, StatusRejected, StatusRevoked, StatusCancelled} {
		if !IsTerminal(s) {
			t.Errorf("%s should be terminal", s)
		}
	}
}

func TestApprovalCannotSkipConsent(t *testing.T) {
	// Approving a PENDING invitation would grant membership to someone who has
	// not agreed to join. That is precisely what the consent step prevents.
	if CanApprove(StatusPending) {
		t.Fatal("an owner must not be able to approve before the invitee accepts")
	}
	if !CanApprove(StatusAccepted) {
		t.Fatal("an owner should approve an accepted invitation")
	}
	for _, s := range []Status{StatusJoined, StatusRejected, StatusCancelled, StatusRevoked, StatusExpired} {
		if CanApprove(s) {
			t.Errorf("must not approve from %s", s)
		}
	}
}

func TestTransitionsV2(t *testing.T) {
	cases := []struct {
		from, to Status
		want     bool
		why      string
	}{
		{StatusPending, StatusAccepted, true, "strict: invitee consents"},
		{StatusPending, StatusJoined, true, "user_approval: consent joins directly"},
		{StatusPending, StatusCancelled, true, "inviter withdraws before a reply"},
		{StatusAccepted, StatusJoined, true, "owner approves"},
		{StatusAccepted, StatusRejected, true, "invitee changes their mind while waiting"},
		{StatusAccepted, StatusCancelled, true, "owner withdraws while waiting"},
		{StatusAccepted, StatusExpired, true, "nobody approved in time"},
		{StatusJoined, StatusAccepted, false, "membership cannot be un-granted here"},
		{StatusJoined, StatusRejected, false, "leaving is a member action, not an invitation one"},
		{StatusCancelled, StatusJoined, false, "a withdrawn invitation must not complete"},
		{StatusRejected, StatusJoined, false, "a declined invitation must not complete"},
		{StatusExpired, StatusPending, true, "a resend revives it"},
	}
	for _, c := range cases {
		if got := CanTransition(c.from, c.to); got != c.want {
			t.Errorf("%s: %s→%s = %v, want %v", c.why, c.from, c.to, got, c.want)
		}
	}
}

func TestDeclineAndCancelWindows(t *testing.T) {
	// An invitee may decline even after accepting, while an owner sits on it.
	if !CanDecline(StatusPending) || !CanDecline(StatusAccepted) {
		t.Fatal("declining should be possible before AND after acceptance")
	}
	if CanDecline(StatusJoined) {
		t.Fatal("once a member, declining is leaving — a different operation")
	}
	if !CanCancel(StatusPending) || !CanCancel(StatusAccepted) {
		t.Fatal("an inviter should be able to withdraw at either stage")
	}
	if CanCancel(StatusJoined) {
		t.Fatal("cancelling a completed invitation is meaningless")
	}
}

func TestIsLiveMatchesTheDuplicateGuard(t *testing.T) {
	// Must agree with uq_chat_invitations_live_user in migration 069, or the
	// route and the database will disagree about who can be re-invited.
	if !IsLive(StatusPending) || !IsLive(StatusAccepted) {
		t.Fatal("pending and accepted both occupy the invitee's slot")
	}
	for _, s := range []Status{StatusJoined, StatusRejected, StatusCancelled, StatusRevoked, StatusExpired} {
		if IsLive(s) {
			t.Errorf("%s should free the slot for a fresh invitation", s)
		}
	}
}

func TestNewStatusesValidate(t *testing.T) {
	for _, s := range []string{"joined", "cancelled"} {
		if !ValidStatus(s) {
			t.Errorf("%s should be a known status", s)
		}
	}
}
