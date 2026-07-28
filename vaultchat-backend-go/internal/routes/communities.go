// communities.go ← routes/communities.js — WhatsApp-style Communities.
// Member-scoped reads run under RLS via db.WithUser, exactly like Node's
// req.dbQuery/req.dbTx.
package routes

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

func RegisterCommunities(mux *http.ServeMux) {
	mux.HandleFunc("POST /communities", httpx.RequireAuth(communitiesCreate))
	mux.HandleFunc("GET /communities", httpx.RequireAuth(communitiesList))
	mux.HandleFunc("GET /communities/{id}", httpx.RequireAuth(communitiesGet))
	mux.HandleFunc("POST /communities/{id}/groups", httpx.RequireAuth(communitiesCreateGroup))
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
