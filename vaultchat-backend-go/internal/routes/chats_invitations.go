// chats_invitations.go — per-invitee group invitations (Groups & Circles, G1).
//
// The invitation is the PERSON; the invite_links row it mints is the DOOR.
// Redemption always goes through vc_redeem_invite(), the existing row-locked
// path, so this file never reimplements joining — it only addresses people,
// tracks status, and hands out signed tokens.
//
// See migration 067 for the schema and internal/invites for the token format
// and the legal status transitions.

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
// A phone number is reduced to its lookup hash and NEVER stored in the clear,
// matching how contact discovery already treats phone numbers. If the handle
// maps to an existing account we bind the invitation to that user id, which is
// what makes "already a member" and "already invited" checkable.
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
		// Not a user yet: still a valid invitation, it just cannot be delivered
		// in-app. The link/QR is the delivery mechanism.
		return &inviteTarget{kind: invites.KindEmail, ref: &email}, ""
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
			return &inviteTarget{userID: &found, kind: invites.KindUser, ref: &lookup}, ""
		}
		if !db.NoRows(e) {
			return nil, "Could not look up that number"
		}
		// Store the HASH, never the number.
		return &inviteTarget{kind: invites.KindPhone, ref: &lookup}, ""
	}

	// No handle at all: an identity-less invitation, i.e. a shareable link.
	return &inviteTarget{kind: invites.KindLink}, ""
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
	if target.userID != nil {
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
	}

	ttl := invites.DefaultTTL
	if h, ok := chatsParseInt(b["expiresInHours"]); ok && h > 0 {
		ttl = time.Duration(h) * time.Hour
	}
	ttl = invites.ClampTTL(ttl)
	expiresAt := time.Now().Add(ttl)
	channel := invites.NormalizeChannel(chatsStrOr(b["channel"], "link"))

	// The door: single-use and expiring with the invitation, so a leaked link
	// cannot outlive the invitation it belongs to.
	code := chatsGenInviteCode()
	var linkID int64
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO invite_links (code, chat_id, created_by, expires_at, max_uses)
		 VALUES ($1, $2, $3, $4, 1) RETURNING id`,
		[]any{code, chatID, user.ID, expiresAt}, &linkID); err != nil {
		log.Printf("[invitations POST] link: %v", err)
		httpx.Err(w, 500, "Failed to create invitation")
		return
	}

	// The invitation row is inserted with a placeholder token hash: the token
	// signs the invitation's own id, which only exists after the insert. It is
	// updated in place immediately below.
	var invID int64
	err := chatsQRow(ctx, user.ID,
		`INSERT INTO chat_invitations
		   (chat_id, inviter_id, invitee_user_id, invitee_kind, invitee_ref, channel, link_id, token_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
		[]any{chatID, user.ID, target.userID, string(target.kind), target.ref,
			string(channel), linkID, "pending:" + code, expiresAt}, &invID)
	if err != nil {
		// The partial unique indexes from migration 067 are the real duplicate
		// guard — two admins inviting the same person at once both pass an
		// application check, but only one can win the index.
		if strings.Contains(err.Error(), "uq_chat_invitations_pending") {
			httpx.Err(w, 409, "They already have a pending invitation")
			return
		}
		log.Printf("[invitations POST] %v", err)
		httpx.Err(w, 500, "Failed to create invitation")
		return
	}

	token := invites.Mint(inviteSecret(), invID, chatID, expiresAt)
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations SET token_hash = $1 WHERE id = $2`,
		invites.Hash(token), invID); err != nil {
		log.Printf("[invitations POST] token: %v", err)
		httpx.Err(w, 500, "Failed to create invitation")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "invitation_created", target.userID,
		map[string]any{"kind": string(target.kind), "channel": string(channel)})
	if target.userID != nil {
		emitx.ChatEvent(chatID, "invitation_created", map[string]any{"userId": *target.userID, "by": user.ID})
	}

	httpx.JSON(w, 200, map[string]any{
		"id":        invID,
		"token":     token, // returned ONCE; only its hash is stored
		"code":      code,
		"status":    string(invites.StatusPending),
		"expiresAt": httpx.JSTime(expiresAt),
		"channel":   string(channel),
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
		`SELECT ci.id, ci.invitee_user_id, ci.invitee_kind, ci.invitee_ref, ci.channel,
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
				kind, channel, status       string
				expiresAt, createdAt        time.Time
				respondedAt                 *time.Time
			)
			if e := rows.Scan(&id, &inviteeID, &kind, &ref, &channel, &status,
				&expiresAt, &respondedAt, &createdAt, &name, &email); e != nil {
				return e
			}
			row := map[string]any{
				"id": id, "inviteeUserId": inviteeID, "kind": kind, "channel": channel,
				"status": status, "expiresAt": httpx.JSTime(expiresAt),
				"respondedAt": httpx.JST(respondedAt), "createdAt": httpx.JSTime(createdAt),
				"name": name,
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

	status, linkID, _, err := loadInvitation(ctx, user.ID, chatID, invID)
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
	token := invites.Mint(inviteSecret(), invID, chatID, expiresAt)

	// A fresh token must invalidate the previous one, so the old door is
	// re-armed rather than a second door being opened alongside it.
	code := chatsGenInviteCode()
	if linkID != nil {
		if err := chatsExecU(ctx, user.ID,
			`UPDATE invite_links SET code = $1, expires_at = $2, uses = 0, revoked = FALSE WHERE id = $3`,
			code, expiresAt, *linkID); err != nil {
			log.Printf("[invitations resend] link: %v", err)
			httpx.Err(w, 500, "Failed to resend invitation")
			return
		}
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_invitations
		    SET token_hash = $1, expires_at = $2, status = 'pending', responded_at = NULL
		  WHERE id = $3`,
		invites.Hash(token), expiresAt, invID); err != nil {
		log.Printf("[invitations resend] %v", err)
		httpx.Err(w, 500, "Failed to resend invitation")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "invitation_resent", nil, map[string]any{"id": invID})
	httpx.JSON(w, 200, map[string]any{
		"id": invID, "token": token, "code": code,
		"status": string(invites.StatusPending), "expiresAt": httpx.JSTime(expiresAt),
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

	status, linkID, _, err := loadInvitation(ctx, user.ID, chatID, invID)
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

	chatsAudit(ctx, user.ID, chatID, "invitation_revoked", nil, map[string]any{"id": invID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": invID, "status": "revoked"})
}

// ── invitee side ──

func invitationsMine(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)

	out := []map[string]any{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT ci.id, ci.chat_id, c.name, c.group_type, c.icon, c.color,
		        vc_invitation_status(ci.status, ci.expires_at) AS status,
		        ci.expires_at, ci.created_at, u.name AS inviter_name
		   FROM chat_invitations ci
		   JOIN chats c ON c.id = ci.chat_id
		   LEFT JOIN users u ON u.id = ci.inviter_id
		  WHERE ci.invitee_user_id = $1
		    AND vc_invitation_status(ci.status, ci.expires_at) = 'pending'
		  ORDER BY ci.created_at DESC
		  LIMIT 100`,
		[]any{user.ID}, func(rows pgx.Rows) error {
			var (
				id                                int64
				chatID                            string
				name, gtype, icon, color, inviter *string
				status                            string
				expiresAt, createdAt              time.Time
			)
			if e := rows.Scan(&id, &chatID, &name, &gtype, &icon, &color,
				&status, &expiresAt, &createdAt, &inviter); e != nil {
				return e
			}
			out = append(out, map[string]any{
				"id": id, "chatId": chatID, "name": name, "groupType": gtype,
				"icon": icon, "color": color, "status": status,
				"inviterName": inviter,
				"expiresAt":   httpx.JSTime(expiresAt), "createdAt": httpx.JSTime(createdAt),
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
	if !invites.CanTransition(invites.Status(status), invites.StatusRejected) {
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
