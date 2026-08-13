// chats_membership.go — in-app group membership (Groups & Circles, membership v2).
//
// EVERYTHING HERE HAPPENS INSIDE VAULTCHAT. There is no link to paste, no QR to
// scan, no SMS and no WhatsApp hand-off. An invitation names a VaultChat account
// and travels as an in-app notification; the only way to act on one is to be
// signed in as the person it names. That is the whole point: an invitation that
// can be forwarded is a credential, and a credential is exactly what a family
// or friends group must not be protected by.
//
// The flow migration 073 introduced has THREE steps, not two:
//
//	strict (default)  owner invites -> invitee ACCEPTS -> owner APPROVES -> joined
//	user_approval     owner invites -> invitee accepts  -> joined
//	admin_approval    user REQUESTS -> owner approves   -> joined
//
// So "accepted" and "joined" are different things, and this file is careful
// never to conflate them. Accepting is consent; approving is admission.
//
// Status transitions are decided by internal/invites, which is pure and tested
// on its own. Nothing here re-derives them inline.

package routes

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/invites"
	"vaultchat/backend-go/internal/realtime"
	"vaultchat/backend-go/internal/vault"
)

// RegisterChatMembership adds the invitee-side routes, which are not scoped to
// a group the caller is in — the whole point is that they are not a member yet.
func RegisterChatMembership(mux *http.ServeMux) {
	mux.HandleFunc("POST /invitations/{invId}/accept", httpx.RequireAuth(membershipAccept))
}

// RegisterChatMembershipOnID adds the /chats/{id}/… half, on the private id-mux
// for the same routing reason described in RegisterChats.
func RegisterChatMembershipOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/membership/candidates", httpx.RequireAuth(membershipCandidates))
	id.HandleFunc("GET /chats/{id}/membership/pending", httpx.RequireAuth(membershipPending))
	id.HandleFunc("POST /chats/{id}/membership/request", httpx.RequireAuth(membershipRequest))
	id.HandleFunc("POST /chats/{id}/membership/transfer", httpx.RequireAuth(membershipTransfer))
	id.HandleFunc("PATCH /chats/{id}/membership/approval-mode", httpx.RequireAuth(membershipApprovalMode))
	id.HandleFunc("POST /chats/{id}/invitations/{invId}/approve", httpx.RequireAuth(membershipApprove))
	id.HandleFunc("POST /chats/{id}/invitations/{invId}/reject", httpx.RequireAuth(membershipRejectByAdmin))
	id.HandleFunc("POST /chats/{id}/invitations/{invId}/cancel", httpx.RequireAuth(membershipCancel))
}

// ── shared helpers ──────────────────────────────────────────────────

// membershipInv is one invitation, loaded with its effective status.
type membershipInv struct {
	ID        int64
	ChatID    string
	InviterID *string
	InviteeID *string
	Status    invites.Status
	Requested bool
}

const membershipInvCols = `id, chat_id, inviter_id, invitee_user_id,
	vc_invitation_status(status, expires_at), requested`

func (m *membershipInv) scan(row pgx.Row) error {
	var st string
	if err := row.Scan(&m.ID, &m.ChatID, &m.InviterID, &m.InviteeID, &st, &m.Requested); err != nil {
		return err
	}
	m.Status = invites.Status(st)
	return nil
}

// membershipLoadInv fetches one invitation scoped to its group.
func membershipLoadInv(ctx context.Context, uid, chatID string, invID int64) (*membershipInv, error) {
	inv := &membershipInv{}
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return inv.scan(tx.QueryRow(ctx,
			`SELECT `+membershipInvCols+` FROM chat_invitations WHERE id = $1 AND chat_id = $2`,
			invID, chatID))
	})
	if err != nil {
		return nil, err
	}
	return inv, nil
}

// membershipGrant admits a user to a group and settles their invitation in ONE
// transaction. Doing these separately would let a crash between them leave an
// invitation marked joined with nobody in the group, or a silent member with no
// audit trail — both states a human then has to untangle by hand.
//
// It runs on the plain pool rather than under RLS on purpose: the invitee-side
// paths admit someone who is BY DEFINITION not yet a member, so the
// chat_members insert policy could never pass. The authority is the invitation
// row this function re-checks inside the transaction, not the caller's session.
// The member-cap trigger from migration 070 still fires, which is what turns an
// over-subscribed group into a clean 409 instead of a silent overflow.
func membershipGrant(ctx context.Context, invID int64, chatID, userID string, approvedBy *string) (err error) {
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after Commit

	// Re-read the status INSIDE the transaction and lock the row. Two admins
	// hitting approve at the same moment both saw 'accepted' a moment ago; only
	// one may act on it.
	var st string
	if err := tx.QueryRow(ctx,
		`SELECT vc_invitation_status(status, expires_at) FROM chat_invitations
		  WHERE id = $1 FOR UPDATE`, invID).Scan(&st); err != nil {
		return err
	}
	if !invites.CanTransition(invites.Status(st), invites.StatusJoined) {
		return errMembershipRaced
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')
		 ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
		chatID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE chat_invitations
		    SET status = 'joined', joined_at = NOW(), responded_at = NOW(), approved_by = $2
		  WHERE id = $1`, invID, approvedBy); err != nil {
		return err
	}
	// Admission clears any cooldown from a previous removal — the group has
	// just decided, deliberately, to let them back in.
	if _, err := tx.Exec(ctx,
		`DELETE FROM group_removals WHERE chat_id = $1 AND user_id = $2`, chatID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// errMembershipRaced marks the lost side of a concurrent approve/accept. It is
// a 409, never a 500: nothing is broken, someone else simply got there first.
var errMembershipRaced = &membershipRaceErr{}

type membershipRaceErr struct{}

func (*membershipRaceErr) Error() string { return "invitation already settled" }

// membershipCooldown reports when a removed user may be invited again, or nil.
func membershipCooldown(ctx context.Context, uid, chatID, userID string) (*time.Time, error) {
	var until *time.Time
	err := chatsQRow(ctx, uid,
		`SELECT cooldown_until FROM group_removals
		  WHERE chat_id = $1 AND user_id = $2 AND cooldown_until > NOW()`,
		[]any{chatID, userID}, &until)
	if db.NoRows(err) {
		return nil, nil
	}
	return until, err
}

// ── notifications ───────────────────────────────────────────────────
//
// Membership events have TWO possible audiences and getting them wrong is not
// cosmetic. Chat fan-out reaches the group's socket room, which by definition
// excludes the invitee — being outside it is what being invited means. So an
// invitation announced only to the group is announced to everyone except the
// one person who has to answer it.
//
// The table below is the whole routing decision in one place, so "who hears
// about this?" is answerable by reading rather than by tracing call sites.

// membershipAudience says who an event is for.
type membershipAudience int

const (
	audGroup membershipAudience = iota // existing members: the owner's queue
	audUser                            // the invitee/requester, wherever they are
)

// membershipEvent describes one membership notification.
type membershipEvent struct {
	audience membershipAudience
	// title/body are used only for audUser, and only when the recipient has no
	// live socket. An empty title means socket-only: worth interrupting for is a
	// higher bar than worth telling.
	title string
	body  string
}

// Every membership event, with who hears it and whether it is worth a push.
//
// Push is reserved for the three that are ABOUT the recipient and that they
// cannot discover any other way: being invited, being let in, being turned
// down. Withdrawals and revocations reach them silently — a notification whose
// entire content is that something is no longer on offer is not worth an
// interruption. Acceptances and join requests go to admins over the socket
// only: an owner who is asleep does not need waking because somebody wants to
// join a cycling group.
var membershipEvents = map[string]membershipEvent{
	"invitation_created":    {audience: audUser, title: "Group invitation", body: "You have been invited to a group on VaultChat"},
	"invitation_cancelled":  {audience: audUser},
	"invitation_revoked":    {audience: audUser},
	"member_approved":       {audience: audUser, title: "You are in", body: "You have been added to a group on VaultChat"},
	"member_rejected":       {audience: audUser, title: "Group request declined", body: "Your request to join a group was not approved"},
	"ownership_transferred": {audience: audGroup},
	"invitation_accepted":   {audience: audGroup},
	"invitation_declined":   {audience: audGroup},
	"join_requested":        {audience: audGroup},
	"members_added":         {audience: audGroup},
}

// membershipNotify routes one membership event to the right people.
//
// userID is who the event is ABOUT. For an audUser event that is also the
// recipient; for an audGroup event it is only part of the payload. An unknown
// event falls back to the group, which is the safe direction: telling members
// something is a smaller mistake than telling a non-member.
func membershipNotify(chatID, event string, userID *string, payload map[string]any) {
	spec, known := membershipEvents[event]
	if !known {
		log.Printf("[membership notify] unknown event %q, defaulting to the group", event)
		emitx.ChatEvent(chatID, event, payload)
		return
	}
	if spec.audience == audGroup {
		emitx.ChatEvent(chatID, event, payload)
		return
	}
	if userID == nil {
		// An audUser event with nobody to send it to is a bug at the call site,
		// not something to paper over by broadcasting it to the group instead.
		log.Printf("[membership notify] %s has no recipient, dropped", event)
		return
	}
	var push *emitx.Push
	if spec.title != "" {
		// The group's NAME is deliberately absent from the push body. A lock
		// screen is readable by whoever is holding the phone, and "You have been
		// invited to Anand Family" tells them something the invitee has not yet
		// agreed to share. The app fills in the detail once it is unlocked.
		push = &emitx.Push{
			Title: spec.title,
			Body:  spec.body,
			Data:  map[string]any{"chatId": chatID, "event": event},
		}
	}
	emitx.NotifyUsers([]string{*userID}, event, payload, push)
}

// ── invitee side: accept ────────────────────────────────────────────

// membershipAccept records the invitee's consent.
//
// Under user_approval that consent IS the join. Under strict it is not: the
// invitation moves to 'accepted' and waits for an owner. Deciding which by
// reading the group's mode — rather than by trusting a flag from the client —
// is what stops a caller from choosing the weaker path for themselves.
func membershipAccept(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	invID, ok := httpx.ParseIntPrefix(r.PathValue("invId"))
	if !ok {
		httpx.Err(w, 400, "invalid invitation id")
		return
	}

	// Scoped to the caller as the INVITEE. An invitation addressed to someone
	// else is not merely forbidden, it is invisible: 404, not 403, so this
	// endpoint cannot be used to probe who has been invited where.
	var st, chatID, modeRaw string
	var inviter *string
	err := chatsQRow(ctx, user.ID,
		`SELECT vc_invitation_status(ci.status, ci.expires_at), ci.chat_id, c.approval_mode, ci.inviter_id
		   FROM chat_invitations ci JOIN chats c ON c.id = ci.chat_id
		  WHERE ci.id = $1 AND ci.invitee_user_id = $2`,
		[]any{invID, user.ID}, &st, &chatID, &modeRaw, &inviter)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Invitation not found")
		return
	}
	if err != nil {
		log.Printf("[membership accept] %v", err)
		httpx.Err(w, 500, "Failed to accept invitation")
		return
	}
	mode := invites.NormalizeMode(modeRaw)
	next := invites.NextAfterAccept(mode)

	// Recovery for invitations stranded by the old 'strict' default (migration
	// 077): the invitee already consented, so the row sits in 'accepted' waiting
	// for an owner approval that no screen ever surfaced. Now that accepting IS
	// the join, tapping Accept again completes it instead of 409-ing forever.
	// Only ever from Accepted, and only when the group's mode says one yes is
	// enough — this cannot admit anyone who has not said yes themselves.
	stranded := invites.Status(st) == invites.StatusAccepted && next == invites.StatusJoined
	if !invites.CanAccept(invites.Status(st)) && !stranded {
		httpx.Err(w, 409, membershipWhyNot(invites.Status(st), "accepted"))
		return
	}

	if next == invites.StatusJoined {
		if err := membershipGrant(ctx, invID, chatID, user.ID, inviter); err != nil {
			membershipGrantFailed(w, "accept", err)
			return
		}
		realtime.InvalidateChatMembers(ctx, chatID)
		membershipNotify(chatID, "members_added", nil,
			map[string]any{"added": []string{user.ID}, "by": user.ID})
		httpx.JSON(w, 200, map[string]any{
			"id": invID, "chatId": chatID, "status": string(invites.StatusJoined), "joined": true,
		})
		return
	}

	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
		invID); err != nil {
		log.Printf("[membership accept] %v", err)
		httpx.Err(w, 500, "Failed to accept invitation")
		return
	}
	// The group is told someone is waiting, so an owner sees the pending list
	// light up without polling.
	membershipNotify(chatID, "invitation_accepted", nil,
		map[string]any{"userId": user.ID, "invitationId": invID})
	httpx.JSON(w, 200, map[string]any{
		"id": invID, "chatId": chatID, "status": string(invites.StatusAccepted), "joined": false,
	})
}

// membershipWhyNot turns a refused transition into something a person can act
// on. "This invitation can no longer be accepted" leaves the user guessing;
// telling them it was withdrawn, or that they already joined, does not.
func membershipWhyNot(s invites.Status, verb string) string {
	switch s {
	case invites.StatusJoined:
		return "You are already in this group"
	case invites.StatusRejected:
		return "This invitation was declined"
	case invites.StatusCancelled:
		return "The invitation was withdrawn"
	case invites.StatusRevoked:
		return "This invitation was revoked"
	case invites.StatusExpired:
		return "This invitation has expired"
	case invites.StatusAccepted:
		return "This invitation is waiting for an admin to approve it"
	}
	return "This invitation can no longer be " + verb
}

// membershipGrantFailed maps a failed admission onto the right status code.
// A full group and a lost race are both 409 — temporary and not the caller's
// mistake — while anything else is a genuine 500.
func membershipGrantFailed(w http.ResponseWriter, where string, err error) {
	switch {
	case err == errMembershipRaced:
		httpx.Err(w, 409, "This invitation was already settled")
	case chatsCapExceeded(err):
		httpx.Err(w, 409, "This group is full")
	default:
		log.Printf("[membership %s] grant: %v", where, err)
		httpx.Err(w, 500, "Failed to update membership")
	}
}

// ── admin side: approve / reject / cancel ───────────────────────────

func membershipApprove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to approve members", "Failed to approve member")
	if mem == nil {
		return
	}
	invID, ok := httpx.ParseIntPrefix(r.PathValue("invId"))
	if !ok {
		httpx.Err(w, 400, "invalid invitation id")
		return
	}

	inv, err := membershipLoadInv(ctx, user.ID, chatID, invID)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Invitation not found")
		return
	}
	if err != nil {
		log.Printf("[membership approve] %v", err)
		httpx.Err(w, 500, "Failed to approve member")
		return
	}
	// Only from 'accepted'. Approving a still-pending invitation would put
	// someone in a group they have not agreed to join — the exact thing the
	// consent step exists to prevent.
	if !invites.CanApprove(inv.Status) {
		if inv.Status == invites.StatusPending {
			httpx.Err(w, 409, "They have not accepted the invitation yet")
			return
		}
		httpx.Err(w, 409, membershipWhyNot(inv.Status, "approved"))
		return
	}
	if inv.InviteeID == nil {
		httpx.Err(w, 409, "This invitation is not addressed to a VaultChat account")
		return
	}

	if err := membershipGrant(ctx, invID, chatID, *inv.InviteeID, &user.ID); err != nil {
		membershipGrantFailed(w, "approve", err)
		return
	}
	realtime.InvalidateChatMembers(ctx, chatID)
	chatsAudit(ctx, user.ID, chatID, "member_approved", inv.InviteeID, map[string]any{"invitationId": invID})
	membershipNotify(chatID, "members_added", nil,
		map[string]any{"added": []string{*inv.InviteeID}, "by": user.ID})
	// Separately to the person it happened to: they are not in the group's
	// socket room until their client reconnects, so the fan-out above does not
	// reach the one reader who most needs it.
	membershipNotify(chatID, "member_approved", inv.InviteeID,
		map[string]any{"chatId": chatID, "invitationId": invID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": invID, "status": string(invites.StatusJoined)})
}

// membershipRejectByAdmin turns down someone who accepted (or requested).
// Distinct from the invitee's own decline, which lives in chats_invitations.go
// — same terminal status, different actor, and the audit log records which.
func membershipRejectByAdmin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to manage members", "Failed to reject request")
	if mem == nil {
		return
	}
	invID, ok := httpx.ParseIntPrefix(r.PathValue("invId"))
	if !ok {
		httpx.Err(w, 400, "invalid invitation id")
		return
	}

	inv, err := membershipLoadInv(ctx, user.ID, chatID, invID)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Invitation not found")
		return
	}
	if err != nil {
		log.Printf("[membership reject] %v", err)
		httpx.Err(w, 500, "Failed to reject request")
		return
	}
	if !invites.CanTransition(inv.Status, invites.StatusRejected) {
		httpx.Err(w, 409, membershipWhyNot(inv.Status, "rejected"))
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations SET status = 'rejected', responded_at = NOW() WHERE id = $1`,
		invID); err != nil {
		log.Printf("[membership reject] %v", err)
		httpx.Err(w, 500, "Failed to reject request")
		return
	}
	chatsAudit(ctx, user.ID, chatID, "member_rejected", inv.InviteeID, map[string]any{"invitationId": invID})
	if inv.InviteeID != nil {
		membershipNotify(chatID, "member_rejected", inv.InviteeID,
			map[string]any{"chatId": chatID, "by": user.ID, "invitationId": invID})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": invID, "status": string(invites.StatusRejected)})
}

// membershipCancel is the INVITER withdrawing their own invitation.
//
// Deliberately not the same as revoking. Revoke is an administrative act on
// someone else's invitation; cancel is "I changed my mind". They land in
// different statuses so the audit trail can still answer who ended it, which is
// the only question an audit trail of an aborted invitation is ever asked.
func membershipCancel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to cancel invitation"); mem == nil {
		return
	}
	invID, ok := httpx.ParseIntPrefix(r.PathValue("invId"))
	if !ok {
		httpx.Err(w, 400, "invalid invitation id")
		return
	}

	inv, err := membershipLoadInv(ctx, user.ID, chatID, invID)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Invitation not found")
		return
	}
	if err != nil {
		log.Printf("[membership cancel] %v", err)
		httpx.Err(w, 500, "Failed to cancel invitation")
		return
	}
	// Only the person who sent it. Anyone else with the permission uses revoke,
	// and the distinction survives into the log.
	if inv.InviterID == nil || *inv.InviterID != user.ID {
		httpx.Err(w, 403, "Only the person who sent this invitation can cancel it")
		return
	}
	if !invites.CanCancel(inv.Status) {
		httpx.Err(w, 409, membershipWhyNot(inv.Status, "cancelled"))
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations SET status = 'cancelled', responded_at = NOW() WHERE id = $1`,
		invID); err != nil {
		log.Printf("[membership cancel] %v", err)
		httpx.Err(w, 500, "Failed to cancel invitation")
		return
	}
	chatsAudit(ctx, user.ID, chatID, "invitation_cancelled", inv.InviteeID, map[string]any{"invitationId": invID})
	if inv.InviteeID != nil {
		membershipNotify(chatID, "invitation_cancelled", inv.InviteeID,
			map[string]any{"chatId": chatID, "invitationId": invID})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": invID, "status": string(invites.StatusCancelled)})
}

// ── pending list ────────────────────────────────────────────────────

// membershipPending is the owner's queue: everyone who is part-way in.
//
// Both directions in one list — people who accepted an invitation and people
// who asked to join — because to an owner they are the same decision, and
// splitting them across two screens is how a request sits unanswered for a
// week.
func membershipPending(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to view pending members", "Failed to load pending members")
	if mem == nil {
		return
	}

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT ci.id, ci.invitee_user_id, ci.requested, ci.created_at, ci.accepted_at,
		        vc_invitation_status(ci.status, ci.expires_at) AS status,
		        u.name, u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.photo_url,
		        iu.first_name_cipher, iu.last_name_cipher, iu.email_cipher, iu.name, iu.email
		   FROM chat_invitations ci
		   LEFT JOIN users u  ON u.id  = ci.invitee_user_id
		   LEFT JOIN users iu ON iu.id = ci.inviter_id
		  WHERE ci.chat_id = $1
		    AND vc_invitation_status(ci.status, ci.expires_at) IN ('pending', 'accepted')
		  ORDER BY ci.requested DESC, ci.accepted_at NULLS LAST, ci.created_at
		  LIMIT 200`,
		[]any{chatID}, func(rows pgx.Rows) error {
			var (
				id                            int64
				inviteeID                     *string
				requested                     bool
				createdAt                     time.Time
				acceptedAt                    *time.Time
				status                        string
				name, fnc, lnc, ec, photo     *string
				ifnc, ilnc, iec, ilegN, ilegE *string
			)
			if e := rows.Scan(&id, &inviteeID, &requested, &createdAt, &acceptedAt, &status,
				&name, &fnc, &lnc, &ec, &photo,
				&ifnc, &ilnc, &iec, &ilegN, &ilegE); e != nil {
				return e
			}
			ident := vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, name, nil, nil, nil, nil)
			// The invitee's name was already decrypted here; the INVITER's was
			// not, so the approval queue said "accepted an invitation from —".
			inviterName := spaceName(ifnc, ilnc, iec, ilegN, ilegE)
			out = append(out, map[string]any{
				"id": id, "userId": inviteeID, "name": ident.Name, "photoURL": photo,
				"status": status, "requested": requested,
				"inviterName": inviterName,
				"createdAt":   httpx.JSTime(createdAt), "acceptedAt": httpx.JST(acceptedAt),
				// What the owner may DO with this row, so the client does not
				// have to reimplement the status machine to draw two buttons.
				"canApprove": invites.CanApprove(invites.Status(status)),
				"canReject":  invites.CanTransition(invites.Status(status), invites.StatusRejected),
			})
			return nil
		})
	if err != nil {
		log.Printf("[membership pending] %v", err)
		httpx.Err(w, 500, "Failed to load pending members")
		return
	}
	httpx.JSON(w, 200, out)
}

// ── candidate search ────────────────────────────────────────────────

const membershipCandidateLimit = 20

// membershipNameScanMax bounds the name search. Names are encrypted, so matching
// costs a decrypt per candidate and cannot be done by the database; this caps how
// many of the caller's chat-mates are opened for one query. Well above any real
// contact list, and far below anything that could be used to grind the CPU.
const membershipNameScanMax = 2000

// membershipCandidates finds people to invite, WITHOUT being a user directory.
//
// Two sources, both of which the caller already had:
//
//  1. An exact email address or phone number they typed. Matched through the
//     same lookup hashes contact discovery uses, and only for accounts that
//     are discoverable. A number that is not on VaultChat returns nothing —
//     there is no off-platform invite to fall back to.
//  2. A name, matched only against people the caller ALREADY shares a chat
//     with. Their address book inside the app, in other words.
//
// What it deliberately does not do is search every account by name. That would
// turn "add a member" into a way to enumerate the user base, and the feature
// does not need it: you cannot invite a stranger to your family group.
//
// Each result is annotated with why it can or cannot be invited, so the client
// shows "already a member" in place of a button rather than letting the user
// discover it by being refused.
func membershipCandidates(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to add members", "Failed to search")
	if mem == nil {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		httpx.JSON(w, 200, []any{})
		return
	}

	ids, err := membershipFindUsers(ctx, user.ID, q)
	if err != nil {
		log.Printf("[membership candidates] %v", err)
		httpx.Err(w, 500, "Failed to search")
		return
	}
	if len(ids) == 0 {
		httpx.JSON(w, 200, []any{})
		return
	}

	out := []map[string]any{}
	err = chatsQueryU(ctx, user.ID,
		`SELECT u.id, u.name, u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.photo_url,
		        (cm.user_id IS NOT NULL AND cm.left_at IS NULL) AS is_member,
		        ci.status IS NOT NULL AS invited,
		        gr.cooldown_until
		   FROM users u
		   LEFT JOIN chat_members cm ON cm.chat_id = $2 AND cm.user_id = u.id
		   LEFT JOIN LATERAL (
		        SELECT 1 AS status FROM chat_invitations x
		         WHERE x.chat_id = $2 AND x.invitee_user_id = u.id
		           AND vc_invitation_status(x.status, x.expires_at) IN ('pending','accepted')
		         LIMIT 1) ci ON TRUE
		   LEFT JOIN group_removals gr ON gr.chat_id = $2 AND gr.user_id = u.id
		                              AND gr.cooldown_until > NOW()
		  WHERE u.id = ANY($1::uuid[])`,
		[]any{ids, chatID}, func(rows pgx.Rows) error {
			var (
				id                        string
				name, fnc, lnc, ec, photo *string
				isMember, invited         bool
				cooldown                  *time.Time
			)
			if e := rows.Scan(&id, &name, &fnc, &lnc, &ec, &photo, &isMember, &invited, &cooldown); e != nil {
				return e
			}
			ident := vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, name, nil, nil, nil, nil)
			state := "invitable"
			switch {
			case isMember:
				state = "member"
			case invited:
				state = "invited"
			case cooldown != nil:
				state = "cooldown"
			}
			row := map[string]any{
				"id": id, "name": ident.Name, "photoURL": photo, "state": state,
			}
			if cooldown != nil {
				row["cooldownUntil"] = httpx.JSTime(*cooldown)
			}
			out = append(out, row)
			return nil
		})
	if err != nil {
		log.Printf("[membership candidates] annotate: %v", err)
		httpx.Err(w, 500, "Failed to search")
		return
	}
	httpx.JSON(w, 200, out)
}

// membershipFindUsers resolves a query to at most membershipCandidateLimit user
// ids. Runs on the plain pool because it reads the users table, which RLS does
// not scope by chat membership; the SCOPING is in the WHERE clause instead, and
// is the security-relevant part of this function.
func membershipFindUsers(ctx context.Context, uid, q string) ([]string, error) {
	// Exact handle first: if someone typed an address or a number they are
	// naming one specific person, and a name search would only add noise.
	if strings.ContainsAny(q, "@") {
		lookup, err := vault.EmailLookup(vault.NormalizeEmail(q))
		if err != nil {
			return nil, nil // unprocessable handle is "no match", not an error
		}
		return membershipByLookup(ctx, uid, `email_lookup`, lookup)
	}
	if digits := chatsNormalizePhone(q); len(digits) >= 7 {
		lookup, err := vault.PhoneLookup(q)
		if err != nil {
			return nil, nil
		}
		return membershipByLookup(ctx, uid, `phone_lookup`, lookup)
	}

	// Name search, confined to people the caller already shares a chat with.
	//
	// The match happens in Go, not in SQL, and it has to: a display name lives in
	// first_name_cipher/last_name_cipher, and users.name is a legacy plaintext
	// column that is NULL for every account. The old `u.name ILIKE $2` therefore
	// matched NOBODY — searching a name in the invite picker returned an empty
	// list every single time, which is why a member could not be invited by name
	// at all. Encrypted columns cannot be ILIKE'd; they have to be opened first.
	//
	// This stays bounded the same way the SQL did: only people the caller already
	// shares a chat with are ever considered, and the scan is capped, so it is a
	// small set decrypted per keystroke rather than a table scan.
	needle := strings.ToLower(strings.TrimSpace(q))
	if needle == "" {
		return nil, nil
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT DISTINCT u.id, u.first_name_cipher, u.last_name_cipher,
		        u.email_cipher, u.name, u.email
		   FROM chat_members mine
		   JOIN chat_members theirs ON theirs.chat_id = mine.chat_id AND theirs.left_at IS NULL
		   JOIN users u ON u.id = theirs.user_id
		  WHERE mine.user_id = $1 AND mine.left_at IS NULL
		    AND u.id <> $1 AND u.is_deleted = FALSE
		  LIMIT $2`, uid, membershipNameScanMax)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var (
			id                       string
			fnc, lnc, ec, legN, legE *string
		)
		if err := rows.Scan(&id, &fnc, &lnc, &ec, &legN, &legE); err != nil {
			return nil, err
		}
		name := spaceName(fnc, lnc, ec, legN, legE)
		if name == nil {
			continue
		}
		if !strings.Contains(strings.ToLower(*name), needle) {
			continue
		}
		ids = append(ids, id)
		if len(ids) >= membershipCandidateLimit {
			break
		}
	}
	return ids, rows.Err()
}

// membershipByLookup resolves one exact handle hash to a user id.
//
// `discoverable` is honoured: a user who has opted out of being found by their
// number stays un-findable here too. Making the invite flow an exception would
// quietly undo that setting.
func membershipByLookup(ctx context.Context, uid, column, lookup string) ([]string, error) {
	var id string
	// column is a package-level literal, never caller input.
	err := db.Pool.QueryRow(ctx,
		`SELECT id FROM users
		  WHERE `+column+` = $1 AND is_deleted = FALSE AND discoverable = TRUE AND id <> $2
		  LIMIT 1`, lookup, uid).Scan(&id)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return []string{id}, nil
}

// ── request to join ─────────────────────────────────────────────────

// membershipRequest is the admin_approval entry point: the user asks, an owner
// decides.
//
// It is stored as a chat_invitations row with requested = TRUE and status
// 'accepted', not 'pending'. That is not a shortcut — the person has already
// consented by asking, so the only outstanding gate is the owner's, and the
// row lands in exactly the state the approve path expects. Modelling requests
// as a separate table would mean two queues, two status machines and two ways
// to forget somebody.
func membershipRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	// Not a member yet, so this cannot go through chatsRequireMem. Read the
	// group on the plain pool and reveal nothing beyond whether a request is
	// possible.
	var gtype *string
	var modeRaw, chatType string
	err := db.Pool.QueryRow(ctx,
		`SELECT type, group_type, approval_mode FROM chats WHERE id = $1`, chatID).
		Scan(&chatType, &gtype, &modeRaw)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Group not found")
		return
	}
	if err != nil {
		log.Printf("[membership request] %v", err)
		httpx.Err(w, 500, "Failed to send request")
		return
	}
	if chatType != "group" {
		httpx.Err(w, 400, "Only groups accept join requests")
		return
	}
	if invites.NormalizeMode(modeRaw) != invites.ModeAdminApproval {
		// Any other mode admits people by invitation only. Saying so plainly
		// beats a 403 that reads like a permissions bug.
		httpx.Err(w, 409, "This group is invite-only")
		return
	}

	var one int
	e := db.Pool.QueryRow(ctx,
		`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		chatID, user.ID).Scan(&one)
	if e == nil {
		httpx.Err(w, 409, "You are already in this group")
		return
	}
	if !db.NoRows(e) {
		log.Printf("[membership request] member check: %v", e)
		httpx.Err(w, 500, "Failed to send request")
		return
	}

	// A removal cooldown applies to requests as much as to invitations —
	// otherwise being removed only stops you until you ask again yourself.
	var until *time.Time
	e = db.Pool.QueryRow(ctx,
		`SELECT cooldown_until FROM group_removals
		  WHERE chat_id = $1 AND user_id = $2 AND cooldown_until > NOW()`,
		chatID, user.ID).Scan(&until)
	if e == nil && until != nil {
		httpx.Err(w, 409, "You cannot rejoin this group yet",
			map[string]any{"cooldownUntil": httpx.JSTime(*until)})
		return
	}
	if e != nil && !db.NoRows(e) {
		log.Printf("[membership request] cooldown: %v", e)
		httpx.Err(w, 500, "Failed to send request")
		return
	}

	// inviter_id = invitee_user_id: you invited yourself. No token, because
	// there is nothing to hand anyone (migration 074 made the column nullable
	// rather than have this path fabricate a credential to satisfy NOT NULL).
	expiresAt := time.Now().Add(invites.DefaultTTL)
	var invID int64
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO chat_invitations
		   (chat_id, inviter_id, invitee_user_id, invitee_kind, channel,
		    expires_at, requested, status, accepted_at)
		 VALUES ($1, $2, $2, 'user', 'app', $3, TRUE, 'accepted', NOW())
		 RETURNING id`,
		chatID, user.ID, expiresAt).Scan(&invID)
	if err != nil {
		// The live-invitation index is the real duplicate guard; asking twice
		// in parallel loses on the index rather than on a check-then-insert.
		if strings.Contains(err.Error(), "uq_chat_invitations_live_user") {
			httpx.Err(w, 409, "You already have a request or invitation for this group")
			return
		}
		log.Printf("[membership request] %v", err)
		httpx.Err(w, 500, "Failed to send request")
		return
	}

	membershipNotify(chatID, "join_requested", nil, map[string]any{"userId": user.ID, "invitationId": invID})
	httpx.JSON(w, 200, map[string]any{"id": invID, "chatId": chatID, "status": "accepted", "pending": true})
}

// ── ownership transfer ──────────────────────────────────────────────

// membershipTransfer hands the group to another member.
//
// Its own endpoint and its own permission check, deliberately not part of the
// role-change route. Giving away a group is not an edit to somebody's role: it
// demotes the caller irreversibly, and an admin who may legitimately promote
// and demote must not be able to reassign ownership as a side effect of that
// power. Both rows move in one transaction, because a group with two owners —
// or none — is worse than a failed transfer.
func membershipTransfer(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to transfer ownership")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	target := strings.TrimSpace(chatsStrOr(b["userId"], ""))
	if target == "" {
		httpx.Err(w, 400, "userId required")
		return
	}
	if target == user.ID {
		httpx.Err(w, 400, "You already own this group")
		return
	}

	var targetRole string
	var leftAt *time.Time
	err := chatsQRow(ctx, user.ID,
		`SELECT role, left_at FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
		[]any{chatID, target}, &targetRole, &leftAt)
	if db.NoRows(err) || (err == nil && leftAt != nil) {
		httpx.Err(w, 404, "They are not in this group")
		return
	}
	if err != nil {
		log.Printf("[membership transfer] %v", err)
		httpx.Err(w, 500, "Failed to transfer ownership")
		return
	}
	if !groups.CanTransferOwnership(mem.Role, targetRole) {
		httpx.Err(w, 403, "Only the owner can transfer the group, and only to a full member")
		return
	}

	// Confirmation is required in the body rather than inferred from the tap.
	// This is the one group action with no undo, so it should not be reachable
	// by a client that merely forgot to show a dialog.
	if !chatsTruthy(b["confirm"]) {
		httpx.Err(w, 400, "Confirmation required to transfer ownership")
		return
	}

	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		// Promote first: if the demotion landed first and the promotion failed,
		// the group would be left with no owner at all.
		if _, e := tx.Exec(ctx,
			`UPDATE chat_members SET role = 'owner' WHERE chat_id = $1 AND user_id = $2`,
			chatID, target); e != nil {
			return e
		}
		_, e := tx.Exec(ctx,
			`UPDATE chat_members SET role = 'admin' WHERE chat_id = $1 AND user_id = $2`,
			chatID, user.ID)
		return e
	})
	if err != nil {
		log.Printf("[membership transfer] %v", err)
		httpx.Err(w, 500, "Failed to transfer ownership")
		return
	}

	realtime.InvalidateChatMembers(ctx, chatID)
	chatsAudit(ctx, user.ID, chatID, "ownership_transferred", &target,
		map[string]any{"from": user.ID, "to": target})
	membershipNotify(chatID, "ownership_transferred", nil, map[string]any{"from": user.ID, "to": target})
	httpx.JSON(w, 200, map[string]any{"ok": true, "ownerId": target, "yourRole": "admin"})
}

// ── approval mode ───────────────────────────────────────────────────

// membershipApprovalMode changes how many gates stand before membership.
//
// Owner-only, not merely edit_settings: loosening this is what decides whether
// someone can be added to a group without an owner ever seeing it, so it is
// held at the same level as giving the group away.
func membershipApprovalMode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update approval mode")
	if mem == nil {
		return
	}
	if mem.Role != groups.RoleOwner {
		httpx.Err(w, 403, "Only the owner can change how members are approved")
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	raw := strings.TrimSpace(chatsStrOr(b["mode"], ""))
	if !invites.ValidMode(raw) {
		httpx.Err(w, 400, "mode must be strict, user_approval or admin_approval")
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chats SET approval_mode = $2 WHERE id = $1`, chatID, raw); err != nil {
		log.Printf("[membership approval-mode] %v", err)
		httpx.Err(w, 500, "Failed to update approval mode")
		return
	}
	chatsAudit(ctx, user.ID, chatID, "approval_mode_changed", nil, map[string]any{"mode": raw})
	httpx.JSON(w, 200, map[string]any{"ok": true, "approvalMode": raw})
}

// ── sharing a group into a chat ─────────────────────────────────────

// chatsValidateGroupRef checks that the caller may post a card pointing at the
// group in meta, returning "" when they may. It also NORMALISES meta so the
// name, icon and colour on the card come from the database rather than from
// whatever the client typed — otherwise the card is a place to write anything
// you like next to a real group id.
//
// Two rules, and they are what keep this from being an invite link again:
//
//  1. The group must be in admin_approval mode. That is a group which has
//     explicitly opted into hearing from people it did not invite. Sharing a
//     strict-mode group would route a request at a group with no queue to put
//     it in.
//  2. The sharer must hold invite_members THERE. It is the same authority that
//     could have invited the person directly, so the card grants nothing they
//     could not already have done — it only makes it possible at a distance.
//
// What the card can never do, however it is forwarded, is admit anybody. It
// carries no token. Admission still runs through membershipRequest and an
// admin's approval.
func chatsValidateGroupRef(ctx context.Context, uid string, meta map[string]any) string {
	if meta == nil {
		return "A group reference needs a group"
	}
	groupID := strings.TrimSpace(chatsStrOr(meta["groupId"], ""))
	if groupID == "" {
		return "A group reference needs a group"
	}

	// Loaded as the CALLER, so a group they are not in is simply not found —
	// this endpoint must not become a way to test whether a group id exists.
	mem, err := chatsLoadMem(ctx, uid, groupID)
	if err != nil {
		log.Printf("[group_ref] load: %v", err)
		return "Could not check that group"
	}
	if mem == nil || mem.LeftAt != nil {
		return "You are not in that group"
	}
	if !mem.can(groups.PermInviteMembers) {
		return "You do not have permission to share that group"
	}
	if invites.NormalizeMode(mem.ApprovalModeRaw) != invites.ModeAdminApproval {
		// Said plainly rather than as a bare 403: the owner can change this, and
		// a message that reads like a permissions bug will not tell them so.
		return "That group does not accept requests to join. An owner can change that in Members."
	}

	var name, gtype, icon, color *string
	if err := chatsQRow(ctx, uid,
		`SELECT name, group_type, icon, color FROM chats WHERE id = $1`,
		[]any{groupID}, &name, &gtype, &icon, &color); err != nil {
		log.Printf("[group_ref] meta: %v", err)
		return "Could not check that group"
	}
	// Overwrite, never merge: a client-supplied name sitting next to a real
	// group id is a way to make a card say whatever the sender wants.
	meta["groupId"] = groupID
	meta["name"] = name
	meta["groupType"] = gtype
	meta["icon"] = icon
	meta["color"] = color
	return ""
}
