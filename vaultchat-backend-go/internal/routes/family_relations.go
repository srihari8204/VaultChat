// family_relations.go — "Mother", "Father", "Brother" on the family roster.
//
// Server-side on purpose (owner directive: maximum logic in the backend, keep
// the app light). The client PUTs a label and GETs a ready map; it holds no
// rules about relationships and computes nothing. Labels also outlive the
// device this way — a reinstall keeps the family's labels, which a device-local
// store could never do.
//
// THE KEY IS (chat, viewer, member), not (chat, member). A relationship is a
// property of a PAIR: the same person is "Mother" to one member, "Wife" to
// another and "Daughter" to a third, all true at once in one space. A single
// label per member would make those three overwrite each other. See migration
// 109 for the schema and the same reasoning.
//
// AUTHORIZATION IS ENFORCED HERE, IN THE HANDLER. Postgres RLS is inert in
// production because the API connects as a superuser, so every policy is
// bypassed — a query that "relies on RLS" relies on nothing. Every statement
// below therefore carries its own membership predicate.
package routes

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"vaultchat/backend-go/internal/httpx"
)

// Long enough for "Grandmother" or "Chinnanna", short enough that the column is
// a label and not a free-text field someone pastes an essay into. Mirrors the
// CHECK in migration 109 so a bad request fails at 400 rather than as a 500
// from the database.
const maxRelationLen = 40

func RegisterFamilyRelationsOnID(id *http.ServeMux) {
	id.HandleFunc("GET /chats/{id}/relations", httpx.RequireAuth(relationsList))
	id.HandleFunc("PUT /chats/{id}/relations/{memberId}", httpx.RequireAuth(relationsSet))
}

// ─── GET /chats/{id}/relations ────────────────────────────────────────
//
// Every label THIS viewer holds in this space, as {memberId: relation}. Shaped
// as a map rather than a list because the only thing the client does with it is
// look up one member at a time while rendering a row — a list would make the
// app build this map itself, which is exactly the work being moved off it.
func relationsList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")

	out := map[string]string{}
	// The EXISTS clause is the authorization: a non-member's viewer_id can
	// never match a row they are entitled to, and the subquery makes that
	// explicit rather than trusting that only members hold rows.
	err := chatsQueryU(ctx, user.ID,
		`SELECT member_id, relation
		   FROM family_relations
		  WHERE chat_id = $1
		    AND viewer_id = $2
		    AND EXISTS (SELECT 1 FROM chat_members cm
		                 WHERE cm.chat_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL)`,
		[]any{chatID, user.ID},
		func(rows pgx.Rows) error {
			var member, rel string
			if err := rows.Scan(&member, &rel); err != nil {
				return err
			}
			out[member] = rel
			return nil
		})
	if err != nil {
		httpx.Err(w, 500, "Could not read relations")
		return
	}
	httpx.JSON(w, 200, map[string]any{"relations": out})
}

// ─── PUT /chats/{id}/relations/{memberId} ─────────────────────────────
//
// Set or clear one label. An empty/whitespace relation DELETES the row rather
// than storing a blank, so "clear this label" needs no second endpoint and the
// table never accumulates rows that render as nothing.
func relationsSet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	memberID := r.PathValue("memberId")

	if memberID == "" || memberID == user.ID {
		// Labelling yourself is meaningless — the UI never offers it, and the
		// schema refuses it too.
		httpx.Err(w, 400, "Pick another member")
		return
	}

	var body struct {
		Relation string `json:"relation"`
	}
	_ = httpx.Body(r, &body)
	rel := strings.TrimSpace(body.Relation)
	if len([]rune(rel)) > maxRelationLen {
		httpx.Err(w, 400, "Relation too long", map[string]any{"max": maxRelationLen})
		return
	}

	if rel == "" {
		// Clear. Scoped by viewer_id, so one member can never delete another's
		// labels even by guessing ids.
		if err := chatsExecU(ctx, user.ID,
			`DELETE FROM family_relations
			  WHERE chat_id = $1 AND viewer_id = $2 AND member_id = $3`,
			chatID, user.ID, memberID); err != nil {
			httpx.Err(w, 500, "Could not clear the relation")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "relation": ""})
		return
	}

	// BOTH parties must be current members of this space, checked in the
	// statement itself. Without the second EXISTS a member could label someone
	// who was never in the space — writing rows keyed to a stranger's user id,
	// which is a (small) way to probe whether an id exists.
	affected, err := chatsExecAffected(ctx, user.ID,
		`INSERT INTO family_relations (chat_id, viewer_id, member_id, relation, updated_at)
		 SELECT $1, $2, $3, $4, now()
		  WHERE EXISTS (SELECT 1 FROM chat_members cm
		                 WHERE cm.chat_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL)
		    AND EXISTS (SELECT 1 FROM chat_members cm
		                 WHERE cm.chat_id = $1 AND cm.user_id = $3 AND cm.left_at IS NULL)
		 ON CONFLICT (chat_id, viewer_id, member_id)
		 DO UPDATE SET relation = EXCLUDED.relation, updated_at = now()`,
		chatID, user.ID, memberID, rel)
	if err != nil {
		httpx.Err(w, 500, "Could not save the relation")
		return
	}
	if affected == 0 {
		// One of the two EXISTS failed. Deliberately not distinguishing which:
		// "you are not in this space" and "they are not in this space" are the
		// same answer to anyone not entitled to ask.
		httpx.Err(w, 403, "Not a member of this space")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "relation": rel})
}
