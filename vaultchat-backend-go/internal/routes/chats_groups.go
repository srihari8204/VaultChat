// chats_groups.go — Groups & Circles route support (migration 070).
//
// Kept separate from chats.go/chats_helpers.go so the group model is readable
// on its own: metadata validation, the audit trail, and the JSON the client
// needs in order to render a typed group and know what it is allowed to do.
//
// The permission RULES are not here — they live in internal/groups, which the
// client mirrors in lib/groups/permissions.ts. This file only loads, validates
// and records.

package routes

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/invites"
)

// Group metadata limits. Names and descriptions are user text, so they are
// bounded here rather than trusting the client.
const (
	chatsGroupDescMax  = 300
	chatsGroupIconMax  = 40
	chatsGroupColorMax = 9 // "#RRGGBB" plus slack
)

// chatsValidPrivacy mirrors the chats_privacy_check constraint. Validating in
// the route as well gives a 400 with a useful message instead of a 500 from a
// constraint violation.
func chatsValidPrivacy(p string) bool {
	return p == "private" || p == "invite_only"
}

// chatsKnownGroupType reports whether a type exists in group_type_config.
// Types are DATA, not an enum, so this is a lookup rather than a switch —
// adding a type must never require a code change.
func chatsKnownGroupType(ctx context.Context, uid, gtype string) (bool, error) {
	var found string
	err := chatsQRow(ctx, uid,
		`SELECT group_type FROM group_type_config WHERE group_type = $1`,
		[]any{gtype}, &found)
	if err != nil {
		if db.NoRows(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// chatsGroupMeta is the group half of a chat, as returned to the client.
type chatsGroupMeta struct {
	GroupType   *string  `json:"groupType"`
	Icon        *string  `json:"icon"`
	Color       *string  `json:"color"`
	Privacy     string   `json:"privacy"`
	MaxMembers  *int32   `json:"maxMembers"`
	Permissions []string `json:"permissions"` // the CALLER's resolved set
	Role        string   `json:"role"`        // the CALLER's role
	// How many gates stand between an invitation and membership. Normalised, so
	// a corrupt stored value is reported as the STRICTEST mode rather than
	// letting the client draw a looser one than the server will honour.
	ApprovalMode string `json:"approvalMode"`
}

// chatsBuildGroupMeta assembles what the client needs to render a typed group
// and gate its own UI.
//
// `permissions` is the caller's own resolved set, not the group's policy. The
// client uses it to decide what to draw; it is never the authority for whether
// an action is allowed — every mutating endpoint re-resolves server-side.
func chatsBuildGroupMeta(mem *chatsMem, icon, color *string, privacy string) chatsGroupMeta {
	if privacy == "" {
		privacy = "private"
	}
	perms := []string{}
	if mem.isTypedGroup() {
		perms = mem.perms().List()
	} else {
		// Legacy untyped group: report the effective legacy rule so the client
		// draws the same affordances the server will actually honour.
		if mem.isAdmin() {
			perms = make([]string, 0, len(groups.All))
			for _, p := range groups.All {
				perms = append(perms, string(p))
			}
		}
	}
	return chatsGroupMeta{
		GroupType:    mem.GroupType,
		Icon:         icon,
		Color:        color,
		Privacy:      privacy,
		MaxMembers:   mem.MaxMembers,
		Permissions:  perms,
		Role:         mem.Role,
		ApprovalMode: string(invites.NormalizeMode(mem.ApprovalModeRaw)),
	}
}

// chatsAudit records a group membership/settings change.
//
// Best-effort by design: an audit write must never fail the operation the user
// asked for. A lost audit row is bad; a member who cannot be removed because
// logging hiccuped is worse. Failures are logged loudly instead.
func chatsAudit(ctx context.Context, uid, chatID, action string, targetID *string, detail map[string]any) {
	var raw []byte
	if detail != nil {
		b, err := json.Marshal(detail)
		if err != nil {
			log.Printf("[chats audit] marshal %s: %v", action, err)
		} else {
			raw = b
		}
	}
	if err := chatsExecU(ctx, uid,
		`INSERT INTO group_audit_log (chat_id, actor_id, action, target_id, detail)
		 VALUES ($1, $2, $3, $4, $5)`,
		chatID, uid, action, targetID, raw); err != nil {
		log.Printf("[chats audit] %s on %s: %v", action, chatID, err)
	}
}

// chatsCapExceeded reports whether an error is the member-cap trigger firing.
// The trigger raises with SQLSTATE check_violation and a recognisable prefix
// (see migration 070), so the route can turn a database-level race rejection
// into a clean 409 rather than a 500.
func chatsCapExceeded(err error) bool {
	return err != nil && strings.Contains(err.Error(), "group_member_cap_exceeded")
}

// chatsRequirePerm gates a handler on a single permission, writing the 403
// itself. Returns nil when the caller may not proceed.
//
// Every mutating group endpoint goes through here, so the permission model has
// exactly one enforcement point on the server.
func chatsRequirePerm(w http.ResponseWriter, r *http.Request, p groups.Permission, notMember, errMsg string) *chatsMem {
	mem := chatsRequireMem(w, r, 403, notMember, errMsg)
	if mem == nil {
		return nil
	}
	if !mem.can(p) {
		httpx.Err(w, 403, notMember)
		return nil
	}
	return mem
}

// chatsNilIfEmpty maps "" to a NULL column rather than storing an empty string,
// so "unset the icon" and "the icon is the empty string" cannot diverge.
func chatsNilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
