// spaces_roster.go — the ops roster and the visibility edge (migration 085).
//
// This file carries the most sensitive rule in Spaces & Operations: a parent
// sees their own child and no other child. Read the scoping note before editing.
//
// ── where the rule is actually enforced ──
//
// In BOTH places, and the redundancy is not an accident. Do not delete the
// WHERE clauses below because "RLS already does that".
//
// Migration 085 puts the rule in RLS policies, which is the right place for it.
// But RLS is bypassed for a SUPERUSER connection, and this deployment's API
// connects as `vaultchat`, which is one (verified against production on
// 2026-08-11: a parent saw 2 of 2 roster rows through the app's role, where the
// policy would have returned 1). Until the API runs as a non-superuser role —
// see vaultchat-backend/scripts/enable-rls-force.sql, which exists for exactly
// this and has not been run — the policies are inert and the only thing standing
// between a parent and every child in the school is the SQL in this file.
//
// So every sensitive read below carries the policy's predicate explicitly,
// composed from the SAME SECURITY DEFINER functions the policy uses
// (space_can_view_roster, vc_space_ops_viewer). Two callers of one rule, not two
// rules. When the API moves to a non-superuser role these become genuinely
// redundant — and they should still stay, because defence that only works in one
// deployment posture is not defence.
//
// ── why the roster is not chat_members ──
//
// A six-year-old has no account, and chat membership is mutual disclosure by
// definition — everyone in a chat can see who else is in it, and hiding senders
// would break attribution, mentions and receipts. So the ops roster is its own
// table. Staff and parents appear in both (they chat, and they are tracked);
// children appear only in the roster.

package routes

import (
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
)

const (
	spaceRosterNameMax = 120
	spaceRosterRefMax  = 64
	// The depth the resolver walks. Mirrors the default in space_visible_roster;
	// passed explicitly so the two cannot drift apart silently.
	spaceLinkMaxDepth = 6
)

// Relations mirror the CHECK in migration 085. Validated here as well so a bad
// value is a 400 with a reason rather than a 500 from a constraint.
var spaceRelations = map[string]bool{
	"guardian_of": true,
	"supervises":  true,
	"teaches":     true,
}

func RegisterSpaceRosterOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/roster", httpx.RequireAuth(spaceRosterList))
	id.HandleFunc("POST /chats/{id}/roster", httpx.RequireAuth(spaceRosterCreate))
	id.HandleFunc("PATCH /chats/{id}/roster/{rosterId}", httpx.RequireAuth(spaceRosterPatch))
	id.HandleFunc("GET /chats/{id}/links", httpx.RequireAuth(spaceLinksList))
	id.HandleFunc("POST /chats/{id}/links", httpx.RequireAuth(spaceLinkCreate))
	id.HandleFunc("DELETE /chats/{id}/links", httpx.RequireAuth(spaceLinkDelete))
	id.HandleFunc("PATCH /chats/{id}/members/{userId}/role-key", httpx.RequireAuth(spaceMemberRoleKey))
}

type spaceRosterEntry struct {
	ID          string  `json:"id"`
	UserID      *string `json:"userId"`
	DisplayName string  `json:"displayName"`
	Kind        string  `json:"kind"`
	ExternalRef *string `json:"externalRef"`
	Archived    bool    `json:"archived"`
}

// spaceRosterList returns the roster the CALLER may see.
//
// `truncated` is not decoration. The resolver walks a bounded depth, and a
// supervisor silently missing half their reporting line is worse than one told
// the hierarchy is deeper than the walk. The flag travels to the client so the
// UI can say so.
func spaceRosterList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load roster")
	if mem == nil {
		return
	}

	// The scope predicate mirrors the space_roster_select policy and calls the
	// same functions. Load-bearing while the API connects as a superuser — see
	// the file header before removing it.
	out := []spaceRosterEntry{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT id, user_id, display_name, kind, external_ref, archived_at IS NOT NULL
		   FROM space_roster
		  WHERE chat_id = $1 AND archived_at IS NULL
		    AND (vc_space_ops_viewer($1) OR space_can_view_roster($1, $2, id))
		  ORDER BY display_name`,
		[]any{chatID, user.ID}, func(rows pgx.Rows) error {
			var e spaceRosterEntry
			if err := rows.Scan(&e.ID, &e.UserID, &e.DisplayName, &e.Kind, &e.ExternalRef, &e.Archived); err != nil {
				return err
			}
			out = append(out, e)
			return nil
		})
	if err != nil {
		log.Printf("[space roster GET] %v", err)
		httpx.Err(w, 500, "Failed to load roster")
		return
	}

	truncated := false
	if !mem.can(groups.PermViewSpaceOps) {
		// Only meaningful for a scoped viewer: someone with the space-wide view
		// did not walk the graph at all.
		if err := chatsQRow(ctx, user.ID,
			`SELECT COALESCE(bool_or(truncated), FALSE)
			   FROM space_visible_roster($1, $2, $3)`,
			[]any{chatID, user.ID, spaceLinkMaxDepth}, &truncated); err != nil {
			log.Printf("[space roster GET truncated] %v", err)
			// Not fatal — but report the UNKNOWN as truncated rather than as
			// complete. Claiming a full view we could not verify is the failure
			// this flag exists to prevent.
			truncated = true
		}
	}

	httpx.JSON(w, 200, map[string]any{
		"roster":    out,
		"truncated": truncated,
		"scoped":    !mem.can(groups.PermViewSpaceOps),
	})
}

// spaceRosterFields bounds the writable roster fields.
//
// Takes the ALREADY-DECODED body rather than the request: httpx.Body consumes
// r.Body, so a second call inside one handler reads zero bytes and silently
// yields an empty map. Every field parsed after that would be quietly dropped.
func spaceRosterFields(w http.ResponseWriter, b map[string]any) (name, kind string, extRef *string, ok bool) {
	name = strings.TrimSpace(chatsStrOr(b["displayName"], ""))
	if name == "" || len(name) > spaceRosterNameMax {
		httpx.Err(w, 400, "displayName must be 1–120 characters")
		return "", "", nil, false
	}
	kind = strings.TrimSpace(chatsStrOr(b["kind"], "person"))
	if kind == "" {
		kind = "person"
	}
	if len(kind) > 32 {
		httpx.Err(w, 400, "kind is too long")
		return "", "", nil, false
	}
	if ref := strings.TrimSpace(chatsStrOr(b["externalRef"], "")); ref != "" {
		if len(ref) > spaceRosterRefMax {
			httpx.Err(w, 400, "externalRef is too long")
			return "", "", nil, false
		}
		extRef = &ref
	}
	return name, kind, extRef, true
}

func spaceRosterCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot manage this space's roster", "Failed to add roster entry")
	if mem == nil {
		return
	}
	if !mem.isTypedGroup() {
		httpx.Err(w, 400, "Only a typed space has a roster")
		return
	}

	// ONE read of the body — see spaceRosterFields.
	var b map[string]any
	_ = httpx.Body(r, &b)

	name, kind, extRef, ok := spaceRosterFields(w, b)
	if !ok {
		return
	}

	// A roster entry MAY be linked to an account (staff, parents, employees) or
	// stand alone (a child with no phone). userId is optional for exactly that
	// reason — see migration 085.
	var userID *string
	if u := strings.TrimSpace(chatsStrOr(b["userId"], "")); u != "" {
		// Only an actual member of the space may be attached. Otherwise a roster
		// entry could name an arbitrary user id and later become a link target.
		var exists int
		err := chatsQRow(ctx, user.ID,
			`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
			[]any{chatID, u}, &exists)
		if db.NoRows(err) {
			httpx.Err(w, 400, "That user is not in this space")
			return
		}
		if err != nil {
			log.Printf("[space roster POST member] %v", err)
			httpx.Err(w, 500, "Failed to add roster entry")
			return
		}
		userID = &u
	}

	var id string
	if err := chatsQRow(ctx, user.ID,
		`INSERT INTO space_roster (chat_id, user_id, display_name, kind, external_ref)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		[]any{chatID, userID, name, kind, extRef}, &id); err != nil {
		if strings.Contains(err.Error(), "uq_space_roster") {
			httpx.Err(w, 409, "That person is already on the roster")
			return
		}
		log.Printf("[space roster POST] %v", err)
		httpx.Err(w, 500, "Failed to add roster entry")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "roster_add", userID, map[string]any{"rosterId": id, "kind": kind})
	httpx.JSON(w, 200, map[string]any{"id": id})
}

// spaceRosterPatch renames or archives an entry.
//
// Archive, never delete: a child who leaves must vanish from every live view
// while their historical run records stay attributable. A hard delete would
// cascade the manifest history away with them.
func spaceRosterPatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	rosterID := r.PathValue("rosterId")

	if mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot manage this space's roster", "Failed to update roster entry"); mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)

	var name *string
	if raw, present := b["displayName"]; present {
		n := strings.TrimSpace(chatsStrOr(raw, ""))
		if n == "" || len(n) > spaceRosterNameMax {
			httpx.Err(w, 400, "displayName must be 1–120 characters")
			return
		}
		name = &n
	}
	var archived *bool
	if raw, present := b["archived"]; present {
		v := chatsTruthy(raw)
		archived = &v
	}
	if name == nil && archived == nil {
		httpx.Err(w, 400, "Nothing to update")
		return
	}

	var updated string
	err := chatsQRow(ctx, user.ID,
		`UPDATE space_roster
		    SET display_name = COALESCE($3, display_name),
		        archived_at  = CASE
		                         WHEN $4::bool IS NULL THEN archived_at
		                         WHEN $4::bool THEN COALESCE(archived_at, NOW())
		                         ELSE NULL
		                       END
		  WHERE chat_id = $1 AND id = $2
		  RETURNING id`,
		[]any{chatID, rosterID, name, archived}, &updated)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Roster entry not found")
		return
	}
	if err != nil {
		log.Printf("[space roster PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update roster entry")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "roster_update", nil, map[string]any{"rosterId": rosterID})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

type spaceLink struct {
	SubjectID string `json:"subjectId"`
	ObjectID  string `json:"objectId"`
	Relation  string `json:"relation"`
}

// spaceLinksList returns the links the caller may see. Ops sees the graph; a
// parent sees only the edges they are the SUBJECT of — a child must not be able
// to enumerate who watches them, and an employee must not be able to read the
// org chart above them. Enforced by the policy in 085, not here.
func spaceLinksList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load links"); mem == nil {
		return
	}

	out := []spaceLink{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT subject_id, object_id, relation
		   FROM space_links
		  WHERE chat_id = $1
		    AND (vc_space_ops_viewer($1)
		         OR EXISTS (SELECT 1 FROM space_roster r
		                     WHERE r.id = subject_id AND r.user_id = $2))
		  ORDER BY relation, subject_id`,
		[]any{chatID, user.ID}, func(rows pgx.Rows) error {
			var l spaceLink
			if err := rows.Scan(&l.SubjectID, &l.ObjectID, &l.Relation); err != nil {
				return err
			}
			out = append(out, l)
			return nil
		})
	if err != nil {
		log.Printf("[space links GET] %v", err)
		httpx.Err(w, 500, "Failed to load links")
		return
	}
	httpx.JSON(w, 200, out)
}

func spaceLinkBody(w http.ResponseWriter, r *http.Request) (subject, object, relation string, ok bool) {
	var b map[string]any
	_ = httpx.Body(r, &b)
	subject = strings.TrimSpace(chatsStrOr(b["subjectId"], ""))
	object = strings.TrimSpace(chatsStrOr(b["objectId"], ""))
	relation = strings.TrimSpace(chatsStrOr(b["relation"], ""))
	if subject == "" || object == "" {
		httpx.Err(w, 400, "subjectId and objectId are required")
		return "", "", "", false
	}
	if subject == object {
		httpx.Err(w, 400, "A link cannot point at itself")
		return "", "", "", false
	}
	if !spaceRelations[relation] {
		httpx.Err(w, 400, "relation must be guardian_of, supervises or teaches")
		return "", "", "", false
	}
	return subject, object, relation, true
}

func spaceLinkCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot manage this space's roster", "Failed to create link"); mem == nil {
		return
	}

	subject, object, relation, ok := spaceLinkBody(w, r)
	if !ok {
		return
	}

	// Re-linking the same pair is the same state, and a roster import re-run must
	// not 409 its way through a whole school — so this is idempotent. It is a DO
	// UPDATE rather than DO NOTHING for one reason: DO NOTHING reports zero rows
	// affected, which is also what the WHERE EXISTS guard reports when it rejects
	// the write. Touching the row keeps those two cases distinguishable, so the
	// count below means exactly one thing.
	//
	// Both ids are ROSTER ids, not user ids. Passing a user id used to insert
	// nothing and still answer 200: the link silently never existed, and the
	// parent saw no child with no error to explain it. That is now a 400.
	n, err := chatsExecAffected(ctx, user.ID,
		`INSERT INTO space_links (chat_id, subject_id, object_id, relation, created_by)
		 SELECT $1, $2, $3, $4, $5
		  WHERE EXISTS (SELECT 1 FROM space_roster WHERE id = $2 AND chat_id = $1)
		    AND EXISTS (SELECT 1 FROM space_roster WHERE id = $3 AND chat_id = $1)
		 ON CONFLICT (chat_id, subject_id, object_id, relation)
		 DO UPDATE SET relation = EXCLUDED.relation`,
		chatID, subject, object, relation, user.ID)
	if err != nil {
		log.Printf("[space links POST] %v", err)
		httpx.Err(w, 500, "Failed to create link")
		return
	}
	if n == 0 {
		httpx.Err(w, 400, "Both people must be on this space's roster before they can be linked")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "link_add", nil, map[string]any{
		"subjectId": subject, "objectId": object, "relation": relation,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func spaceLinkDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	if mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot manage this space's roster", "Failed to remove link"); mem == nil {
		return
	}

	subject, object, relation, ok := spaceLinkBody(w, r)
	if !ok {
		return
	}

	if err := chatsExecU(ctx, user.ID,
		`DELETE FROM space_links
		  WHERE chat_id = $1 AND subject_id = $2 AND object_id = $3 AND relation = $4`,
		chatID, subject, object, relation); err != nil {
		log.Printf("[space links DELETE] %v", err)
		httpx.Err(w, 500, "Failed to remove link")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "link_remove", nil, map[string]any{
		"subjectId": subject, "objectId": object, "relation": relation,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// spaceMemberRoleKey assigns a member's display role.
//
// The rank check is the reason this is not a one-line UPDATE. A role_key whose
// catalog rank differs from the member's actual role resolves to NOTHING at
// permission time (groups.CatalogLayer requires the ranks to match), so storing
// a mismatched key would silently strip the member's permissions and look like a
// bug in the resolver. Refuse it at the door instead, and say which rank the
// role needs.
func spaceMemberRoleKey(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	targetID := r.PathValue("userId")

	mem := chatsRequirePerm(w, r, groups.PermManageRoster,
		"You cannot manage this space's roster", "Failed to set role")
	if mem == nil {
		return
	}
	if !mem.isTypedGroup() {
		httpx.Err(w, 400, "Only a typed space has display roles")
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	key := strings.TrimSpace(chatsStrOr(b["roleKey"], ""))

	var targetRole string
	err := chatsQRow(ctx, user.ID,
		`SELECT role FROM chat_members
		  WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		[]any{chatID, targetID}, &targetRole)
	if db.NoRows(err) {
		httpx.Err(w, 404, "That person is not in this space")
		return
	}
	if err != nil {
		log.Printf("[space role-key target] %v", err)
		httpx.Err(w, 500, "Failed to set role")
		return
	}

	// Rank still gates rank. Without this, someone holding manage_roster could
	// hand the "Principal" label to themselves — harmless as a label, but it is
	// the label the whole UI reads.
	if !groups.CanRemoveMember(mem.Role, targetRole) && targetID != user.ID {
		httpx.Err(w, 403, "You cannot change that person's role")
		return
	}

	var stored *string
	if key != "" {
		def := groups.FindRole(mem.roleCatalog, key)
		if def == nil {
			httpx.Err(w, 400, "Unknown role for this space type")
			return
		}
		if def.Rank != targetRole {
			httpx.Err(w, 409, "That role needs the "+def.Rank+" rank; change the member's rank first")
			return
		}
		stored = &key
	}

	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET role_key = $3 WHERE chat_id = $1 AND user_id = $2`,
		chatID, targetID, stored); err != nil {
		log.Printf("[space role-key] %v", err)
		httpx.Err(w, 500, "Failed to set role")
		return
	}

	chatsAudit(ctx, user.ID, chatID, "role_key_set", &targetID, map[string]any{"roleKey": key})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
