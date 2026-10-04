// communities.go ← routes/communities.js — WhatsApp-style Communities.
// Member-scoped reads run under RLS via db.WithUser, exactly like Node's
// req.dbQuery/req.dbTx.
package routes

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/realtime"
)

func RegisterCommunities(mux *http.ServeMux) {
	mux.HandleFunc("POST /communities", httpx.RequireAuth(communitiesCreate))
	mux.HandleFunc("GET /communities", httpx.RequireAuth(communitiesList))
	mux.HandleFunc("GET /communities/{id}", httpx.RequireAuth(communitiesGet))
	mux.HandleFunc("POST /communities/{id}/groups", httpx.RequireAuth(communitiesCreateGroup))
	mux.HandleFunc("PATCH /communities/{id}", httpx.RequireAuth(communitiesPatch))
	mux.HandleFunc("DELETE /communities/{id}", httpx.RequireAuth(communitiesDelete))
	mux.HandleFunc("DELETE /communities/{id}/members/me", httpx.RequireAuth(communitiesLeave))
	mux.HandleFunc("POST /communities/{id}/groups/{chatId}", httpx.RequireAuth(communitiesAttachGroup))
}

type communityStub struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	PhotoURL    *string `json:"photoURL"`
}

func communitiesCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var body struct {
		Name        any `json:"name"`
		Description any `json:"description"`
	}
	_ = httpx.Body(r, &body)
	name := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(body.Name))), 100)
	var description *string
	if d := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(body.Description))), 512); d != "" {
		description = &d
	}
	if name == "" {
		httpx.Err(w, 400, "name required")
		return
	}

	var out struct {
		communityStub
		AnnouncementChatID string `json:"announcementChatId"`
	}
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO communities (name, description, created_by) VALUES ($1, $2, $3)
			 RETURNING id, name, description, photo_url`,
			name, description, user.ID).Scan(&out.ID, &out.Name, &out.Description, &out.PhotoURL); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO chats (type, name, created_by, community_id, is_announcement, send_policy)
			 VALUES ('group', $1, $2, $3, TRUE, 'admins') RETURNING id`,
			name+" Announcements", user.ID, out.ID).Scan(&out.AnnouncementChatID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
			out.AnnouncementChatID, user.ID)
		return err
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to create community")
		return
	}
	httpx.JSON(w, 200, out)
}

func communitiesList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	type item struct {
		communityStub
		GroupCount int `json:"groupCount"`
	}
	out := []item{}
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT DISTINCT co.id, co.name, co.description, co.photo_url, co.created_at,
			        (SELECT COUNT(*) FROM chats ch WHERE ch.community_id = co.id) AS group_count
			   FROM communities co
			   JOIN chats c       ON c.community_id = co.id
			   JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
			  ORDER BY co.created_at DESC`, user.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var it item
			var createdAt any
			var groupCount int64
			if err := rows.Scan(&it.ID, &it.Name, &it.Description, &it.PhotoURL, &createdAt, &groupCount); err != nil {
				return err
			}
			it.GroupCount = int(groupCount)
			out = append(out, it)
		}
		return rows.Err()
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to load communities")
		return
	}
	httpx.JSON(w, 200, map[string]any{"communities": out})
}

func communitiesGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id := r.PathValue("id")

	type group struct {
		ID             string  `json:"id"`
		Name           *string `json:"name"`
		PhotoURL       *string `json:"photoURL"`
		IsAnnouncement bool    `json:"isAnnouncement"`
		Members        int     `json:"members"`
	}
	var stub communityStub
	var createdBy string
	groups := []group{}
	status, msg := 0, ""
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`SELECT id, name, description, photo_url, created_by FROM communities WHERE id = $1`,
			id).Scan(&stub.ID, &stub.Name, &stub.Description, &stub.PhotoURL, &createdBy); err != nil {
			if db.NoRows(err) {
				status, msg = 404, "Community not found"
				return nil
			}
			return err
		}
		rows, err := tx.Query(ctx,
			`SELECT c.id, c.name, c.photo_url, c.is_announcement,
			        (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id AND m.left_at IS NULL) AS members
			   FROM chats c
			   JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
			  WHERE c.community_id = $2
			  ORDER BY c.is_announcement DESC, c.created_at`, user.ID, id)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var g group
			var members int64
			if err := rows.Scan(&g.ID, &g.Name, &g.PhotoURL, &g.IsAnnouncement, &members); err != nil {
				return err
			}
			g.Members = int(members)
			groups = append(groups, g)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if len(groups) == 0 {
			status, msg = 403, "Not a community member"
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to load community") // invalid uuid included, same as Node
		return
	}
	if status != 0 {
		httpx.Err(w, status, msg)
		return
	}
	httpx.JSON(w, 200, struct {
		communityStub
		IsOwner bool    `json:"isOwner"`
		Groups  []group `json:"groups"`
	}{stub, createdBy == user.ID, groups})
}

func communitiesCreateGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id := r.PathValue("id")
	var body struct {
		Name any `json:"name"`
	}
	_ = httpx.Body(r, &body)
	name := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(body.Name))), 100)
	if name == "" {
		httpx.Err(w, 400, "name required")
		return
	}

	var chatID string
	status, msg := 0, ""
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var one int
		if err := tx.QueryRow(ctx,
			`SELECT 1 FROM chats c
			   JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
			  WHERE c.community_id = $2 LIMIT 1`, user.ID, id).Scan(&one); err != nil {
			if db.NoRows(err) {
				status, msg = 403, "Not a community member"
				return nil
			}
			return err
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO chats (type, name, created_by, community_id) VALUES ('group', $1, $2, $3) RETURNING id`,
			name, user.ID, id).Scan(&chatID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
			chatID, user.ID)
		return err
	})
	if err != nil {
		httpx.Err(w, 500, "Failed to create group")
		return
	}
	if status != 0 {
		httpx.Err(w, status, msg)
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": chatID, "name": name})
}

// ── management (round 4) ─────────────────────────────────────────────
//
// Ownership is communities.created_by, the one owner role a community has; the
// per-group rules stay with each group (chatsLoadMem / mem.can). A community
// has no members table: membership is "a current member of any of its chats",
// as communitiesList and communitiesGet already define it.

// communityOwner loads created_by. ok=false has already answered (404/500).
func communityOwner(w http.ResponseWriter, r *http.Request, errMsg string) (owner string, ok bool) {
	err := db.Pool.QueryRow(r.Context(), `SELECT created_by FROM communities WHERE id = $1`, r.PathValue("id")).Scan(&owner)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Community not found")
		return "", false
	}
	if err != nil {
		httpx.Err(w, 500, errMsg) // invalid uuid included, same as communitiesGet
		return "", false
	}
	return owner, true
}

// PATCH /communities/{id} — owner only. { name?, description? }; the same
// limits as create. An empty description clears it; an empty name is refused.
func communitiesPatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	owner, ok := communityOwner(w, r, "Failed to update community")
	if !ok {
		return
	}
	if owner != user.ID {
		httpx.Err(w, 403, "Only the community owner can edit it")
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	sets, args := []string{}, []any{r.PathValue("id")}
	if v, present := b["name"]; present {
		name := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(v))), 100)
		if name == "" {
			httpx.Err(w, 400, "name cannot be empty")
			return
		}
		args = append(args, name)
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if v, present := b["description"]; present {
		var d *string
		if s := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(v))), 512); s != "" {
			d = &s
		}
		args = append(args, d)
		sets = append(sets, fmt.Sprintf("description = $%d", len(args)))
	}
	if len(sets) == 0 {
		httpx.Err(w, 400, "name or description required")
		return
	}
	var out communityStub
	if err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `UPDATE communities SET `+strings.Join(sets, ", ")+` WHERE id = $1
		 RETURNING id, name, description, photo_url`, args...).Scan(&out.ID, &out.Name, &out.Description, &out.PhotoURL)
	}); err != nil {
		log.Printf("[communities PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update community")
		return
	}
	httpx.JSON(w, 200, out)
}

// DELETE /communities/{id} — owner only. Removes the community umbrella; its
// groups (announcements included) are KEPT as ordinary standalone groups with
// their members and history (chats.community_id is ON DELETE SET NULL). The
// announcement group stops being flagged as one.
func communitiesDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	owner, ok := communityOwner(w, r, "Failed to delete community")
	if !ok {
		return
	}
	if owner != user.ID {
		httpx.Err(w, 403, "Only the community owner can delete it")
		return
	}
	id := r.PathValue("id")
	if err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE chats SET is_announcement = FALSE WHERE community_id = $1`, id); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM communities WHERE id = $1`, id)
		return err
	}); err != nil {
		log.Printf("[communities DELETE] %v", err)
		httpx.Err(w, 500, "Failed to delete community")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// DELETE /communities/{id}/members/me — leave every group of the community
// the caller is in (announcements included), each exactly as a self-leave of
// that group (member_left event, audit row, no cooldown). The owner cannot
// leave: nobody else could edit or delete the community; delete it instead.
func communitiesLeave(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	owner, ok := communityOwner(w, r, "Failed to leave community")
	if !ok {
		return
	}
	if owner == user.ID {
		httpx.Err(w, 409, "The owner cannot leave the community. Delete it instead.",
			map[string]any{"code": "owner_cannot_leave"})
		return
	}
	left := []string{}
	if err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`UPDATE chat_members cm SET left_at = NOW()
			   FROM chats c
			  WHERE c.id = cm.chat_id AND c.community_id = $1
			    AND cm.user_id = $2 AND cm.left_at IS NULL
			 RETURNING cm.chat_id::text`, r.PathValue("id"), user.ID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c string
			if err := rows.Scan(&c); err != nil {
				return err
			}
			left = append(left, c)
		}
		return rows.Err()
	}); err != nil {
		log.Printf("[communities leave] %v", err)
		httpx.Err(w, 500, "Failed to leave community")
		return
	}
	if len(left) == 0 {
		httpx.Err(w, 403, "Not a community member")
		return
	}
	uid := user.ID
	for _, chatID := range left {
		realtime.InvalidateChatMembers(ctx, chatID)
		chatsAudit(ctx, user.ID, chatID, "member_left", &uid, nil)
		emitx.ChatEvent(chatID, "member_left", map[string]any{"userId": user.ID, "by": user.ID})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "leftChatIds": left})
}

// POST /communities/{id}/groups/{chatId} — attach an existing group. The
// caller must be a community member (the same rule as creating a group in it)
// AND hold edit_settings in that group (owner/admin by default; the group's
// permission matrix decides, as for every other settings change).
func communitiesAttachGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	communityID, chatID := r.PathValue("id"), r.PathValue("chatId")
	if _, ok := communityOwner(w, r, "Failed to add group"); !ok {
		return
	}
	var one int
	err := db.Pool.QueryRow(ctx,
		`SELECT 1 FROM chats c
		   JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
		  WHERE c.community_id = $2 LIMIT 1`, user.ID, communityID).Scan(&one)
	if db.NoRows(err) {
		httpx.Err(w, 403, "Not a community member")
		return
	}
	if err != nil {
		httpx.Err(w, 500, "Failed to add group")
		return
	}
	mem, err := chatsLoadMem(ctx, user.ID, chatID)
	if err != nil {
		httpx.Err(w, 500, "Failed to add group")
		return
	}
	if mem == nil || mem.LeftAt != nil {
		httpx.Err(w, 404, "Group not found")
		return
	}
	if mem.ChatType != "group" {
		httpx.Err(w, 400, "Only groups can join a community")
		return
	}
	if !mem.can(groups.PermEditSettings) {
		httpx.Err(w, 403, "Only a group admin can add it to a community")
		return
	}
	var current *string
	var isAnnouncement bool
	if err := db.Pool.QueryRow(ctx,
		`SELECT community_id::text, is_announcement FROM chats WHERE id = $1`, chatID).Scan(&current, &isAnnouncement); err != nil {
		httpx.Err(w, 500, "Failed to add group")
		return
	}
	if current != nil && *current == communityID {
		httpx.JSON(w, 200, map[string]any{"ok": true, "id": chatID, "already": true})
		return
	}
	if current != nil || isAnnouncement {
		httpx.Err(w, 409, "This group already belongs to a community",
			map[string]any{"code": "already_in_community"})
		return
	}
	// The NULL guard makes a concurrent attach to another community lose cleanly.
	tag, err := db.Pool.Exec(ctx,
		`UPDATE chats SET community_id = $1 WHERE id = $2 AND community_id IS NULL`, communityID, chatID)
	if err != nil {
		log.Printf("[communities attach] %v", err)
		httpx.Err(w, 500, "Failed to add group")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, 409, "This group already belongs to a community",
			map[string]any{"code": "already_in_community"})
		return
	}
	chatsAudit(ctx, user.ID, chatID, "community_attached", nil, map[string]any{"communityId": communityID})
	emitx.ChatEvent(chatID, "chat_updated", map[string]any{"chatId": chatID, "communityId": communityID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "id": chatID})
}
