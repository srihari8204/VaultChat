// chats_invitations.go — creating and withdrawing group invitations
// (Groups & Circles; rewritten for membership v2).
//
// An invitation is a PERSON, and since membership v2 it is ONLY a person. It no
// longer mints an invite_links row, no longer returns a token, and cannot be
// addressed to anyone who is not already on VaultChat. Answering one lives in
// chats_membership.go, because accepting and approving are separate acts with
// separate audiences.
//
// invitationsRedeem is the one thing here that still speaks the old language:
// it exists so a link already sitting in somebody's messages keeps working, and
// nothing produces a new one.
//
// See migrations 067 and 069/070 for the schema, and internal/invites for the
// legal status transitions.

package routes

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/invites"
	"vaultchat/backend-go/internal/vault"
)

// inviteSecret keys the invitation-token HMAC.
//
// Falls back to JWT_SECRET so a deployment that has not set the dedicated
// variable still signs with a real secret rather than an empty key — an empty
// HMAC key would make every token forgeable. Prefer setting INVITE_SECRET so
// rotating invitation tokens does not invalidate every session.
func inviteSecret() []byte {
	if s := os.Getenv("INVITE_SECRET"); s != "" {
		return []byte(s)
	}
	return []byte(os.Getenv("JWT_SECRET"))
}

func RegisterChatInvitations(mux *http.ServeMux) {
	// Invitee-side: what am I holding, and declining one.
	mux.HandleFunc("GET /invitations", httpx.RequireAuth(invitationsMine))
	mux.HandleFunc("POST /invitations/redeem", httpx.RequireAuth(invitationsRedeem))
	mux.HandleFunc("POST /invitations/{invId}/reject", httpx.RequireAuth(invitationsReject))
}

// RegisterChatInvitationsOnID adds the /chats/{id}/… half. Called from
// RegisterChats with its private id-mux, because Go's ServeMux cannot order
// these against the literal-second-segment routes (see RegisterChats).
func RegisterChatInvitationsOnID(id *http.ServeMux) {
	id.HandleFunc("POST /chats/{id}/invitations", httpx.RequireAuth(invitationsCreate))
	id.HandleFunc("GET /chats/{id}/invitations", httpx.RequireAuth(invitationsList))
	id.HandleFunc("POST /chats/{id}/invitations/{invId}/resend", httpx.RequireAuth(invitationsResend))
	id.HandleFunc("DELETE /chats/{id}/invitations/{invId}", httpx.RequireAuth(invitationsRevoke))
}

// ── invitee resolution ──

type inviteTarget struct {
	userID *string
	kind   invites.InviteeKind
	ref    *string // lookup hash for phone, lowercased address for email
}

// resolveInvitee turns whatever the caller addressed into a target.
//
// MEMBERSHIP V2: every invitation must land on a VaultChat account. A handle
// that does not resolve is refused rather than being stored as a "pending
// off-platform invite", because there is no longer any off-platform delivery to
// pend for — no link, no QR, no SMS. Failing here is honest; storing a row
// nobody can ever act on is not.
//
// A phone number is reduced to its lookup hash and NEVER stored in the clear,
// matching how contact discovery already treats phone numbers.
func resolveInvitee(ctx context.Context, uid string, b map[string]any) (*inviteTarget, string) {
	if s := strings.TrimSpace(chatsStrOr(b["userId"], "")); s != "" {
		return &inviteTarget{userID: &s, kind: invites.KindUser}, ""
	}

	if raw := strings.TrimSpace(chatsStrOr(b["email"], "")); raw != "" {
		email := vault.NormalizeEmail(raw)
		lookup, err := vault.EmailLookup(email)
		if err != nil {
			return nil, "Could not process that email"
		}
		var found string
		e := chatsQRow(ctx, uid,
			`SELECT id FROM users WHERE email_lookup = $1 AND is_deleted = FALSE LIMIT 1`,
			[]any{lookup}, &found)
		if e == nil {
			return &inviteTarget{userID: &found, kind: invites.KindUser, ref: &email}, ""
		}
		if !db.NoRows(e) {
			return nil, "Could not look up that email"
		}
		return nil, "That email is not on VaultChat"
	}

	if raw := strings.TrimSpace(chatsStrOr(b["phone"], "")); raw != "" {
		lookup, err := vault.PhoneLookup(raw)
		if err != nil {
			return nil, "Could not process that phone number"
		}
		var found string
		e := chatsQRow(ctx, uid,
			`SELECT id FROM users WHERE phone_lookup = $1 AND is_deleted = FALSE LIMIT 1`,
			[]any{lookup}, &found)
		if e == nil {
			// Store the HASH, never the number.
			return &inviteTarget{userID: &found, kind: invites.KindUser, ref: &lookup}, ""
		}
		if !db.NoRows(e) {
			return nil, "Could not look up that number"
		}
		return nil, "That number is not on VaultChat"
	}

	return nil, "Choose someone to invite"
}

// ── create ──

func invitationsCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to invite members", "Failed to create invitation")
	if mem == nil {
		return
	}
	if mem.ChatType != "group" {
		httpx.Err(w, 400, "Only group chats support invitations")
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)

	target, errMsg := resolveInvitee(ctx, user.ID, b)
	if errMsg != "" {
		httpx.Err(w, 400, errMsg)
		return
	}

	// Already in the group? Inviting them again is a no-op that would only
	// confuse the sent-invitations list.
	var one int
	e := chatsQRow(ctx, user.ID,
		`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		[]any{chatID, *target.userID}, &one)
	if e == nil {
		httpx.Err(w, 409, "They are already in this group")
		return
	}
	if !db.NoRows(e) {
		log.Printf("[invitations POST] member check: %v", e)
		httpx.Err(w, 500, "Failed to create invitation")
		return
	}

	// A member who was removed cannot be re-invited until their cooldown ends.
	// Without this a removal is a formality: anyone with invite rights could
	// undo an owner's decision in one tap, seconds later.
	until, err := membershipCooldown(ctx, user.ID, chatID, *target.userID)
	if err != nil {
		log.Printf("[invitations POST] cooldown: %v", err)
		httpx.Err(w, 500, "Failed to create invitation")
		return
	}
	if until != nil {
		httpx.Err(w, 409, "They were recently removed and cannot be re-invited yet",
			map[string]any{"cooldownUntil": httpx.JSTime(*until)})
		return
	}

	ttl := invites.DefaultTTL
	if h, ok := chatsParseInt(b["expiresInHours"]); ok && h > 0 {
		ttl = time.Duration(h) * time.Hour
	}
	ttl = invites.ClampTTL(ttl)
	expiresAt := time.Now().Add(ttl)

	// NO LINK IS MINTED and no token is returned. In membership v2 the
	// invitation is the whole mechanism: it is acted on by being signed in as
	// the account it names. There is nothing here to forward, and the channel
	// is always the app because there is no other channel left.
	var invID int64
	err = chatsQRow(ctx, user.ID,
		`INSERT INTO chat_invitations
		   (chat_id, inviter_id, invitee_user_id, invitee_kind, invitee_ref, channel, expires_at)
		 VALUES ($1, $2, $3, $4, $5, 'app', $6) RETURNING id`,
		[]any{chatID, user.ID, target.userID, string(target.kind), target.ref, expiresAt}, &invID)
	if err != nil {
		// The partial unique index from migration 069 is the real duplicate
		// guard — two admins inviting the same person at once both pass an
		// application check, but only one can win the index. It covers
		// 'accepted' as well as 'pending', so somebody awaiting approval cannot
		// be invited a second time either.
		if strings.Contains(err.Error(), "uq_chat_invitations_live") ||
			strings.Contains(err.Error(), "uq_chat_invitations_pending") {
			httpx.Err(w, 409, "They already have an invitation for this group")
			return
		}
		log.Printf("[invitations POST] %v", err)
		httpx.Err(w, 500, "Failed to create invitation")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "invitation_created", target.userID,
		map[string]any{"kind": string(target.kind)})
	// To the INVITEE, not the group. They are not in the group's socket room —
	// that is what being invited means — so a chat fan-out would announce the
	// invitation to everyone except the one person who has to answer it.
	membershipNotify(chatID, "invitation_created", target.userID,
		map[string]any{"chatId": chatID, "by": user.ID, "invitationId": invID})

	httpx.JSON(w, 200, map[string]any{
		"id":            invID,
		"inviteeUserId": *target.userID,
		"status":        string(invites.StatusPending),
		"expiresAt":     httpx.JSTime(expiresAt),
		"channel":       string(invites.ChannelApp),
	})
}

// ── list (group side) ──

func invitationsList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to view invitations", "Failed to list invitations")
	if mem == nil {
		return
	}

	out := []map[string]any{}
	// vc_invitation_status collapses a pending row that has silently passed its
	// expiry, so the list can never show a dead invitation as live.
	err := chatsQueryU(ctx, user.ID,
		`SELECT ci.id, ci.invitee_user_id, ci.inviter_id, ci.invitee_kind, ci.invitee_ref, ci.channel,
		        vc_invitation_status(ci.status, ci.expires_at) AS status,
		        ci.expires_at, ci.responded_at, ci.created_at,
		        u.name, u.email
		   FROM chat_invitations ci
		   LEFT JOIN users u ON u.id = ci.invitee_user_id
		  WHERE ci.chat_id = $1
		  ORDER BY ci.created_at DESC
		  LIMIT 200`,
		[]any{chatID}, func(rows pgx.Rows) error {
			var (
				id                          int64
				inviteeID, ref, name, email *string
				inviterID                   string
				kind, channel, status       string
				expiresAt, createdAt        time.Time
				respondedAt                 *time.Time
			)
			if e := rows.Scan(&id, &inviteeID, &inviterID, &kind, &ref, &channel, &status,
				&expiresAt, &respondedAt, &createdAt, &name, &email); e != nil {
				return e
			}
			row := map[string]any{
				"id": id, "inviteeUserId": inviteeID, "kind": kind, "channel": channel,
				"status": status, "expiresAt": httpx.JSTime(expiresAt),
				"respondedAt": httpx.JST(respondedAt), "createdAt": httpx.JSTime(createdAt),
				"name": name,
				// Whether the CALLER sent this one. Withdrawing your own
				// invitation and revoking someone else's are different acts that
				// land in different statuses, so the client has to be able to
				// tell them apart to offer the right one.
				"mine": inviterID == user.ID,
			}
			// A phone invitee's ref is a lookup hash — never expose it. An email
			// invitee's ref is the address they were invited at, which the
			// inviter typed and may legitimately see.
			if kind == string(invites.KindEmail) {
				row["ref"] = ref
			}
			out = append(out, row)
			return nil
		})
	if err != nil {
		log.Printf("[invitations GET] %v", err)
		httpx.Err(w, 500, "Failed to list invitations")
		return
	}
	httpx.JSON(w, 200, out)
}

// ── resend / revoke ──

// loadInvitation fetches one invitation scoped to its chat, with its effective
// status already collapsed.
func loadInvitation(ctx context.Context, uid, chatID string, invID int64) (status string, linkID *int64, inviteeID *string, err error) {
	err = chatsQRow(ctx, uid,
		`SELECT vc_invitation_status(status, expires_at), link_id, invitee_user_id
		   FROM chat_invitations WHERE id = $1 AND chat_id = $2`,
		[]any{invID, chatID}, &status, &linkID, &inviteeID)
	return
}

func invitationsResend(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to manage invitations", "Failed to resend invitation")
	if mem == nil {
		return
	}
	invID, ok := httpx.ParseIntPrefix(r.PathValue("invId"))
	if !ok {
		httpx.Err(w, 400, "invalid invitation id")
		return
	}

	status, linkID, inviteeID, err := loadInvitation(ctx, user.ID, chatID, invID)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Invitation not found")
		return
	}
	if err != nil {
		log.Printf("[invitations resend] %v", err)
		httpx.Err(w, 500, "Failed to resend invitation")
		return
	}
	// Resending an accepted invitation is meaningless; resending a revoked one
	// would quietly undo a deliberate revocation.
	if !invites.CanResend(invites.Status(status)) {
		httpx.Err(w, 409, "This invitation can no longer be resent")
		return
	}

	expiresAt := time.Now().Add(invites.DefaultTTL)

	// A legacy invitation still has a door behind it. Re-arm it rather than
	// opening a second one alongside, so the previously issued link stops
	// working — otherwise "resend" would multiply live credentials. New
	// invitations have no link_id and skip this entirely.
	if linkID != nil {
		if err := chatsExecU(ctx, user.ID,
			`UPDATE invite_links SET code = $1, expires_at = $2, uses = 0, revoked = FALSE WHERE id = $3`,
			chatsGenInviteCode(), expiresAt, *linkID); err != nil {
			log.Printf("[invitations resend] link: %v", err)
			httpx.Err(w, 500, "Failed to resend invitation")
			return
		}
	}
	// Nothing is re-delivered by this endpoint any more; the invitation was
	// always visible in the invitee's inbox. Resending gives it a fresh expiry
	// and pulls it back out of 'expired', which is the only part that was ever
	// doing work.
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations
		    SET expires_at = $1, status = 'pending', responded_at = NULL
		  WHERE id = $2`,
		expiresAt, invID); err != nil {
		log.Printf("[invitations resend] %v", err)
		httpx.Err(w, 500, "Failed to resend invitation")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "invitation_resent", nil, map[string]any{"id": invID})
	membershipNotify(chatID, "invitation_created", inviteeID,
		map[string]any{"chatId": chatID, "by": user.ID, "invitationId": invID})
	httpx.JSON(w, 200, map[string]any{
		"id": invID, "status": string(invites.StatusPending), "expiresAt": httpx.JSTime(expiresAt),
	})
}

func invitationsRevoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermInviteMembers,
		"You do not have permission to manage invitations", "Failed to revoke invitation")
	if mem == nil {
		return
	}
	invID, ok := httpx.ParseIntPrefix(r.PathValue("invId"))
	if !ok {
		httpx.Err(w, 400, "invalid invitation id")
		return
	}

	status, linkID, inviteeID, err := loadInvitation(ctx, user.ID, chatID, invID)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Invitation not found")
		return
	}
	if err != nil {
		log.Printf("[invitations revoke] %v", err)
		httpx.Err(w, 500, "Failed to revoke invitation")
		return
	}
	if !invites.CanRevoke(invites.Status(status)) {
		httpx.Err(w, 409, "This invitation can no longer be revoked")
		return
	}

	// Revoke the door as well as the invitation — leaving the link live would
	// make "revoked" a lie.
	if linkID != nil {
		if err := chatsExecU(ctx, user.ID,
			`UPDATE invite_links SET revoked = TRUE WHERE id = $1`, *linkID); err != nil {
			log.Printf("[invitations revoke] link: %v", err)
			httpx.Err(w, 500, "Failed to revoke invitation")
			return
		}
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations SET status = 'revoked', responded_at = NOW() WHERE id = $1`,
		invID); err != nil {
		log.Printf("[invitations revoke] %v", err)
		httpx.Err(w, 500, "Failed to revoke invitation")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "invitation_revoked", inviteeID, map[string]any{"id": invID})
	membershipNotify(chatID, "invitation_revoked", inviteeID,
		map[string]any{"chatId": chatID, "invitationId": invID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": invID, "status": "revoked"})
}

// ── invitee side ──

func invitationsMine(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	out := []map[string]any{}
	// Both live states, not just pending. After accepting under strict mode the
	// invitee is waiting on an owner — dropping the row from their inbox at that
	// point is how someone concludes their acceptance did not register, and
	// accepts nothing else ever again.
	err := chatsQueryU(ctx, user.ID,
		`SELECT ci.id, ci.chat_id, c.name, c.group_type, c.icon, c.color,
		        vc_invitation_status(ci.status, ci.expires_at) AS status,
		        c.approval_mode, ci.expires_at, ci.created_at, ci.requested,
		        u.name AS inviter_name,
		        (SELECT COUNT(*) FROM chat_members cm
		          WHERE cm.chat_id = ci.chat_id AND cm.left_at IS NULL) AS member_count
		   FROM chat_invitations ci
		   JOIN chats c ON c.id = ci.chat_id
		   LEFT JOIN users u ON u.id = ci.inviter_id
		  WHERE ci.invitee_user_id = $1
		    AND vc_invitation_status(ci.status, ci.expires_at) IN ('pending', 'accepted')
		  ORDER BY ci.created_at DESC
		  LIMIT 100`,
		[]any{user.ID}, func(rows pgx.Rows) error {
			var (
				id                                int64
				chatID                            string
				name, gtype, icon, color, inviter *string
				status, mode                      string
				requested                         bool
				memberCount                       int64
				expiresAt, createdAt              time.Time
			)
			if e := rows.Scan(&id, &chatID, &name, &gtype, &icon, &color,
				&status, &mode, &expiresAt, &createdAt, &requested, &inviter, &memberCount); e != nil {
				return e
			}
			st := invites.Status(status)
			out = append(out, map[string]any{
				"id": id, "chatId": chatID, "name": name, "groupType": gtype,
				"icon": icon, "color": color, "status": status,
				"inviterName": inviter,
				// The preview an invitee is entitled to before deciding: how big
				// the group is and what happens when they say yes. Never the
				// member list — that is for members.
				"memberCount":  memberCount,
				"approvalMode": string(invites.NormalizeMode(mode)),
				"requested":    requested,
				// Whether accepting admits them outright or only starts the wait.
				"joinsOnAccept": invites.NextAfterAccept(invites.NormalizeMode(mode)) == invites.StatusJoined,
				"canAccept":     invites.CanAccept(st),
				"canDecline":    invites.CanDecline(st),
				"expiresAt":     httpx.JSTime(expiresAt), "createdAt": httpx.JSTime(createdAt),
			})
			return nil
		})
	if err != nil {
		log.Printf("[invitations mine] %v", err)
		httpx.Err(w, 500, "Failed to load invitations")
		return
	}
	httpx.JSON(w, 200, out)
}

func invitationsReject(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	invID, ok := httpx.ParseIntPrefix(r.PathValue("invId"))
	if !ok {
		httpx.Err(w, 400, "invalid invitation id")
		return
	}

	// Scoped to the caller: only the invitee may decline their own invitation.
	var status, chatID string
	err := chatsQRow(ctx, user.ID,
		`SELECT vc_invitation_status(status, expires_at), chat_id
		   FROM chat_invitations WHERE id = $1 AND invitee_user_id = $2`,
		[]any{invID, user.ID}, &status, &chatID)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Invitation not found")
		return
	}
	if err != nil {
		log.Printf("[invitations reject] %v", err)
		httpx.Err(w, 500, "Failed to decline invitation")
		return
	}
	// CanDecline, not CanTransition: an invitee may also change their mind after
	// accepting, while an owner has yet to approve. Someone who said yes on
	// Monday and thought better of it on Tuesday should not have to join first
	// and then leave.
	if !invites.CanDecline(invites.Status(status)) {
		httpx.Err(w, 409, "This invitation can no longer be declined")
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations SET status = 'rejected', responded_at = NOW() WHERE id = $1`,
		invID); err != nil {
		log.Printf("[invitations reject] %v", err)
		httpx.Err(w, 500, "Failed to decline invitation")
		return
	}
	// The group is told, so an owner watching the pending list sees it clear
	// rather than approving someone who has already backed out.
	membershipNotify(chatID, "invitation_declined", nil,
		map[string]any{"userId": user.ID, "invitationId": invID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": invID, "status": "rejected"})
}

// invitationsRedeem accepts a signed invitation token (from a QR scan or a deep
// link) and joins the group through the existing redeem path.
func invitationsRedeem(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	var b map[string]any
	_ = httpx.Body(r, &b)
	token := strings.TrimSpace(chatsStrOr(b["token"], ""))
	if token == "" {
		httpx.Err(w, 400, "token required")
		return
	}

	// Signature first: a forged token must never be reported as merely expired.
	tok, err := invites.Verify(inviteSecret(), token)
	switch err {
	case nil:
	case invites.ErrExpired:
		httpx.Err(w, http.StatusGone, "This invitation has expired")
		return
	default:
		httpx.Err(w, http.StatusGone, "This invitation is not valid")
		return
	}

	// The stored hash is the second gate: a token whose signature checks out but
	// whose hash is not on the row has been superseded by a resend.
	var status, chatID, code string
	e := chatsQRow(ctx, user.ID,
		`SELECT vc_invitation_status(ci.status, ci.expires_at), ci.chat_id, il.code
		   FROM chat_invitations ci
		   JOIN invite_links il ON il.id = ci.link_id
		  WHERE ci.id = $1 AND ci.token_hash = $2`,
		[]any{tok.InvitationID, invites.Hash(token)}, &status, &chatID, &code)
	if db.NoRows(e) {
		httpx.Err(w, http.StatusGone, "This invitation is no longer valid")
		return
	}
	if e != nil {
		log.Printf("[invitations redeem] %v", e)
		httpx.Err(w, 500, "Failed to accept invitation")
		return
	}
	if chatID != tok.ChatID {
		// Belt and braces: the token binds the group, so this cannot normally
		// happen. If it ever does, something is very wrong — refuse.
		httpx.Err(w, http.StatusGone, "This invitation is not valid")
		return
	}
	if invites.Status(status) != invites.StatusPending {
		httpx.Err(w, http.StatusGone, "This invitation is no longer pending")
		return
	}

	var rChatID, rStatus *string
	if err := db.Pool.QueryRow(ctx,
		`SELECT chat_id, status FROM vc_redeem_invite($1, $2)`, code, user.ID).
		Scan(&rChatID, &rStatus); err != nil && !db.NoRows(err) {
		log.Printf("[invitations redeem] %v", err)
		httpx.Err(w, 500, "Failed to accept invitation")
		return
	}
	if rStatus == nil || *rStatus != "ok" {
		msg, sc := "This invitation is no longer valid", http.StatusGone
		if rStatus != nil && *rStatus == "full" {
			// The group filled up while the invitation sat unread. Not the
			// invitee's fault and not permanent — 409, not 410.
			msg, sc = "This group is full", http.StatusConflict
		}
		httpx.Err(w, sc, msg)
		return
	}

	// vc_redeem_invite settles the bound invitation to 'accepted' itself.
	emitx.ChatEvent(*rChatID, "members_added",
		map[string]any{"added": []string{user.ID}, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"chatId": *rChatID, "ok": true})
}
