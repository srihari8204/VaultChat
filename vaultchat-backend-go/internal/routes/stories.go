// stories.go ← routes/stories.js — 24-hour ephemeral posts. Same visibility
// model (shared active chat minus blocks, plus status_privacy modes), same
// statuses/error strings/shapes. story_posted pushes bridge via emitx.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/vault"
)

const maxCaption = 200

func RegisterStories(mux *http.ServeMux) {
	mux.HandleFunc("POST /stories", httpx.RequireAuth(storiesPost))
	mux.HandleFunc("GET /stories/feed", httpx.RequireAuth(storiesFeed))
	mux.HandleFunc("GET /stories/privacy", httpx.RequireAuth(storiesPrivacyGet))
	mux.HandleFunc("PUT /stories/privacy", httpx.RequireAuth(storiesPrivacyPut))
	mux.HandleFunc("GET /stories/audience", httpx.RequireAuth(storiesAudience))
	mux.HandleFunc("GET /stories/{id}/views", httpx.RequireAuth(storiesViews))
	mux.HandleFunc("POST /stories/{id}/viewed", httpx.RequireAuth(storiesViewed))
	mux.HandleFunc("GET /stories/{id}/key", httpx.RequireAuth(storiesKey))
	mux.HandleFunc("DELETE /stories/{id}", httpx.RequireAuth(storiesDelete))
}

// audienceIDs mirrors stories.js audienceIds: shared-active-chat peers minus
// blocks, filtered by the author's status_privacy mode.
func audienceIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := db.SysPool.Query(ctx,
		`SELECT DISTINCT cm_them.user_id AS id
		   FROM chat_members cm_me
		   JOIN chat_members cm_them ON cm_them.chat_id = cm_me.chat_id
		  WHERE cm_me.user_id   = $1 AND cm_me.left_at   IS NULL
		    AND cm_them.user_id <> $1 AND cm_them.left_at IS NULL
		    AND NOT EXISTS (
		      SELECT 1 FROM user_blocks ub
		       WHERE (ub.blocker_id = $1 AND ub.blocked_id = cm_them.user_id)
		          OR (ub.blocker_id = cm_them.user_id AND ub.blocked_id = $1)
		    )`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	base := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		base = append(base, id)
	}

	var mode *string
	if err := db.Pool.QueryRow(ctx,
		`SELECT status_privacy FROM users WHERE id = $1`, userID).Scan(&mode); err != nil {
		return nil, err
	}
	m := "contacts"
	if mode != nil && *mode != "" {
		m = *mode
	}
	if m == "contacts" {
		return base, nil
	}
	lr, err := db.Pool.Query(ctx,
		`SELECT user_id FROM status_audience WHERE owner_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer lr.Close()
	listed := map[string]bool{}
	for lr.Next() {
		var id string
		if err := lr.Scan(&id); err != nil {
			return nil, err
		}
		listed[id] = true
	}
	out := []string{}
	for _, id := range base {
		if (m == "except" && !listed[id]) || (m == "only" && listed[id]) {
			out = append(out, id)
		}
	}
	if m != "except" && m != "only" {
		return base, nil
	}
	return out, nil
}

func broadcastStoryPosted(userID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		aud, err := audienceIDs(ctx, userID)
		if err != nil {
			return
		}
		emitx.ToUids(aud, "story_posted", map[string]any{"userId": userID})
	}()
}

type storyRow struct {
	ID           int64
	UserID       string
	AttachmentID *string
	MediaType    string
	Caption      *string
	TextContent  *string
	BgColor      *string
	Encrypted    bool
	CreatedAt    time.Time
	ExpiresAt    time.Time
}

type publicStory struct {
	ID           string       `json:"id"`
	UserID       string       `json:"userId"`
	AttachmentID *string      `json:"attachmentId"`
	MediaType    string       `json:"mediaType"`
	Caption      *string      `json:"caption"`
	Text         *string      `json:"text"`
	BgColor      *string      `json:"bgColor"`
	Encrypted    bool         `json:"encrypted"`
	CreatedAt    httpx.JSTime `json:"createdAt"`
	ExpiresAt    httpx.JSTime `json:"expiresAt"`
}

func (s storyRow) public() publicStory {
	return publicStory{
		ID: fmt.Sprintf("%d", s.ID), UserID: s.UserID, AttachmentID: s.AttachmentID,
		MediaType: s.MediaType, Caption: s.Caption, Text: s.TextContent,
		BgColor: s.BgColor, Encrypted: s.Encrypted,
		CreatedAt: httpx.JSTime(s.CreatedAt), ExpiresAt: httpx.JSTime(s.ExpiresAt),
	}
}

func storiesPrivacyGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var mode *string
	if err := db.Pool.QueryRow(ctx,
		`SELECT status_privacy FROM users WHERE id = $1`, user.ID).Scan(&mode); err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT user_id FROM status_audience WHERE owner_id = $1`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			httpx.Err(w, 500, "Failed")
			return
		}
		ids = append(ids, id)
	}
	m := "contacts"
	if mode != nil && *mode != "" {
		m = *mode
	}
	httpx.JSON(w, 200, map[string]any{"mode": m, "userIds": ids})
}

func storiesPrivacyPut(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var body struct {
		Mode    string `json:"mode"`
		UserIds []any  `json:"userIds"`
	}
	_ = httpx.Body(r, &body)
	mode := "contacts"
	if body.Mode == "except" || body.Mode == "only" {
		mode = body.Mode
	}
	ids := []string{}
	for _, v := range body.UserIds {
		if s, ok := v.(string); ok && len(ids) < 1000 {
			ids = append(ids, s)
		}
	}
	if _, err := db.Pool.Exec(ctx,
		`UPDATE users SET status_privacy = $1 WHERE id = $2`, mode, user.ID); err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM status_audience WHERE owner_id = $1`, user.ID); err != nil {
		httpx.Err(w, 500, "Failed")
		return
	}
	if mode != "contacts" {
		for _, uid := range ids {
			if _, err := db.Pool.Exec(ctx,
				`INSERT INTO status_audience (owner_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
				user.ID, uid); err != nil {
				httpx.Err(w, 500, "Failed")
				return
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func storiesAudience(w http.ResponseWriter, r *http.Request) {
	aud, err := audienceIDs(r.Context(), httpx.UserFrom(r).ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load audience")
		return
	}
	httpx.JSON(w, 200, map[string]any{"viewerIds": aud})
}

func storiesPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		AttachmentID any   `json:"attachmentId"`
		MediaType    any   `json:"mediaType"`
		Caption      any   `json:"caption"`
		Encrypted    any   `json:"encrypted"`
		Keys         []any `json:"keys"`
		Text         any   `json:"text"`
		BgColor      any   `json:"bgColor"`
	}
	_ = httpx.Body(r, &b)
	attachmentID := fmt.Sprintf("%v", orEmpty(b.AttachmentID))
	mediaType := fmt.Sprintf("%v", orEmpty(b.MediaType))
	var caption *string
	if b.Caption != nil {
		c := truncRunes(fmt.Sprintf("%v", b.Caption), maxCaption)
		caption = &c
	}
	encrypted := b.Encrypted == true

	if mediaType == "text" {
		text := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.Text))), 700)
		bg := fmt.Sprintf("%v", orEmpty(b.BgColor))
		if bg == "" {
			bg = "#0B0B10"
		}
		bg = truncRunes(bg, 16)
		if text == "" {
			httpx.Err(w, 400, "text required")
			return
		}
		var s storyRow
		err := db.Pool.QueryRow(ctx,
			`INSERT INTO stories (user_id, media_type, text_content, bg_color, encrypted)
			 VALUES ($1, 'text', $2, $3, FALSE)
			 RETURNING id, user_id, attachment_id, media_type, caption, text_content, bg_color, encrypted, created_at, expires_at`,
			user.ID, text, bg).Scan(&s.ID, &s.UserID, &s.AttachmentID, &s.MediaType,
			&s.Caption, &s.TextContent, &s.BgColor, &s.Encrypted, &s.CreatedAt, &s.ExpiresAt)
		if err != nil {
			httpx.Err(w, 500, "Failed to post story")
			return
		}
		broadcastStoryPosted(user.ID)
		httpx.JSON(w, 200, struct {
			ID        string       `json:"id"`
			MediaType string       `json:"mediaType"`
			Text      *string      `json:"text"`
			BgColor   *string      `json:"bgColor"`
			Caption   *string      `json:"caption"`
			CreatedAt httpx.JSTime `json:"createdAt"`
		}{fmt.Sprintf("%d", s.ID), "text", s.TextContent, s.BgColor, nil, httpx.JSTime(s.CreatedAt)})
		return
	}

	if attachmentID == "" {
		httpx.Err(w, 400, "attachmentId required")
		return
	}
	if mediaType != "image" && mediaType != "video" {
		httpx.Err(w, 400, "mediaType must be image or video")
		return
	}

	var ownerID *string
	err := db.SysPool.QueryRow(ctx,
		`SELECT owner_user_id FROM attachments WHERE id = $1 LIMIT 1`, attachmentID).Scan(&ownerID)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "attachment not found")
		} else {
			httpx.Err(w, 500, "Failed to post story") // invalid uuid etc. — Node 500s the same way
		}
		return
	}
	if ownerID == nil || *ownerID != user.ID {
		httpx.Err(w, 403, "attachment not owned by caller")
		return
	}

	var s storyRow
	err = db.Pool.QueryRow(ctx,
		`INSERT INTO stories (user_id, attachment_id, media_type, caption, encrypted)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, user_id, attachment_id, media_type, caption, text_content, bg_color, encrypted, created_at, expires_at`,
		user.ID, attachmentID, mediaType, caption, encrypted).Scan(&s.ID, &s.UserID,
		&s.AttachmentID, &s.MediaType, &s.Caption, &s.TextContent, &s.BgColor,
		&s.Encrypted, &s.CreatedAt, &s.ExpiresAt)
	if err != nil {
		httpx.Err(w, 500, "Failed to post story")
		return
	}

	if encrypted && len(b.Keys) > 0 {
		aud, err := audienceIDs(ctx, user.ID)
		if err == nil {
			allowed := map[string]bool{}
			for _, id := range aud {
				allowed[id] = true
			}
			for _, k := range b.Keys {
				km, _ := k.(map[string]any)
				viewerID, _ := km["viewerId"].(string)
				wrappedKey, _ := km["wrappedKey"].(string)
				if viewerID == "" || wrappedKey == "" || !allowed[viewerID] {
					continue
				}
				_, _ = db.Pool.Exec(ctx,
					`INSERT INTO story_keys (story_id, viewer_id, wrapped_key)
					 VALUES ($1, $2, $3)
					 ON CONFLICT (story_id, viewer_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key`,
					s.ID, viewerID, wrappedKey)
			}
		}
	}
	broadcastStoryPosted(user.ID)
	httpx.JSON(w, 200, s.public())
}

type feedStory struct {
	ID           string       `json:"id"`
	AttachmentID *string      `json:"attachmentId"`
	MediaType    string       `json:"mediaType"`
	Caption      *string      `json:"caption"`
	Text         *string      `json:"text"`
	BgColor      *string      `json:"bgColor"`
	Encrypted    bool         `json:"encrypted"`
	CreatedAt    httpx.JSTime `json:"createdAt"`
	ExpiresAt    httpx.JSTime `json:"expiresAt"`
	Seen         bool         `json:"seen"`
}

type feedBucket struct {
	UserID   string       `json:"userId"`
	Name     *string      `json:"name"`
	Email    *string      `json:"email"`
	PhotoURL *string      `json:"photoURL"`
	IsMine   bool         `json:"isMine"`
	Stories  []feedStory  `json:"stories"`
	SeenAll  bool         `json:"seenAll"`
	LatestAt httpx.JSTime `json:"latestAt"`

	latest time.Time
}

func storiesFeed(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT s.id, s.user_id, s.attachment_id, s.media_type, s.caption, s.text_content, s.bg_color, s.encrypted,
		        s.created_at, s.expires_at,
		        u.name, u.email, u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.photo_url,
		        EXISTS (SELECT 1 FROM story_views sv
		                 WHERE sv.story_id = s.id AND sv.viewer_id = $1) AS seen
		   FROM stories s
		   JOIN users u ON u.id = s.user_id
		  WHERE s.expires_at > NOW()
		    AND (
		      s.user_id = $1
		      OR (
		        EXISTS (
		          SELECT 1 FROM chat_members cm_me
		           JOIN chat_members cm_them ON cm_them.chat_id = cm_me.chat_id
		           WHERE cm_me.user_id   = $1 AND cm_me.left_at   IS NULL
		             AND cm_them.user_id = s.user_id AND cm_them.left_at IS NULL
		        )
		        AND NOT EXISTS (
		          SELECT 1 FROM user_blocks ub
		           WHERE (ub.blocker_id = s.user_id AND ub.blocked_id = $1)
		              OR (ub.blocker_id = $1        AND ub.blocked_id = s.user_id)
		        )
		      )
		    )
		  ORDER BY s.user_id, s.created_at ASC`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to load story feed")
		return
	}
	defer rows.Close()

	order := []string{}
	byUser := map[string]*feedBucket{}
	for rows.Next() {
		var s storyRow
		var name, email, firstC, lastC, emailC, photoURL *string
		var seen bool
		if err := rows.Scan(&s.ID, &s.UserID, &s.AttachmentID, &s.MediaType, &s.Caption,
			&s.TextContent, &s.BgColor, &s.Encrypted, &s.CreatedAt, &s.ExpiresAt,
			&name, &email, &firstC, &lastC, &emailC, &photoURL, &seen); err != nil {
			httpx.Err(w, 500, "Failed to load story feed")
			return
		}
		bucket := byUser[s.UserID]
		if bucket == nil {
			ident := vault.IdentityFromRow(firstC, lastC, emailC, nil, nil, nil, name, email, nil, nil, nil)
			bucket = &feedBucket{
				UserID: s.UserID, Name: ident.Name, Email: ident.Email, PhotoURL: photoURL,
				IsMine: s.UserID == user.ID, Stories: []feedStory{}, SeenAll: true,
				latest: s.CreatedAt,
			}
			byUser[s.UserID] = bucket
			order = append(order, s.UserID)
		}
		bucket.Stories = append(bucket.Stories, feedStory{
			ID: fmt.Sprintf("%d", s.ID), AttachmentID: s.AttachmentID, MediaType: s.MediaType,
			Caption: s.Caption, Text: s.TextContent, BgColor: s.BgColor, Encrypted: s.Encrypted,
			CreatedAt: httpx.JSTime(s.CreatedAt), ExpiresAt: httpx.JSTime(s.ExpiresAt), Seen: seen,
		})
		if !seen {
			bucket.SeenAll = false
		}
		if s.CreatedAt.After(bucket.latest) {
			bucket.latest = s.CreatedAt
		}
	}

	list := make([]*feedBucket, 0, len(order))
	for _, uid := range order {
		b := byUser[uid]
		b.LatestAt = httpx.JSTime(b.latest)
		list = append(list, b)
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.IsMine != b.IsMine {
			return a.IsMine
		}
		if a.SeenAll != b.SeenAll {
			return !a.SeenAll
		}
		return a.latest.After(b.latest)
	})
	httpx.JSON(w, 200, list)
}

func storiesViews(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "invalid id")
		return
	}
	var ownerID string
	if err := db.Pool.QueryRow(ctx,
		`SELECT user_id FROM stories WHERE id = $1`, id).Scan(&ownerID); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "story not found")
		} else {
			httpx.Err(w, 500, "Failed to load views")
		}
		return
	}
	if ownerID != user.ID {
		httpx.Err(w, 403, "author only")
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT sv.viewer_id, sv.viewed_at, u.name, u.email, u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.photo_url
		   FROM story_views sv
		   JOIN users u ON u.id = sv.viewer_id
		  WHERE sv.story_id = $1
		  ORDER BY sv.viewed_at DESC`, id)
	if err != nil {
		httpx.Err(w, 500, "Failed to load views")
		return
	}
	defer rows.Close()
	type viewer struct {
		UserID   string       `json:"userId"`
		Name     *string      `json:"name"`
		Email    *string      `json:"email"`
		PhotoURL *string      `json:"photoURL"`
		ViewedAt httpx.JSTime `json:"viewedAt"`
	}
	out := []viewer{}
	for rows.Next() {
		var viewerID string
		var viewedAt time.Time
		var name, email, firstC, lastC, emailC, photoURL *string
		if err := rows.Scan(&viewerID, &viewedAt, &name, &email, &firstC, &lastC, &emailC, &photoURL); err != nil {
			httpx.Err(w, 500, "Failed to load views")
			return
		}
		ident := vault.IdentityFromRow(firstC, lastC, emailC, nil, nil, nil, name, email, nil, nil, nil)
		out = append(out, viewer{UserID: viewerID, Name: ident.Name, Email: ident.Email,
			PhotoURL: photoURL, ViewedAt: httpx.JSTime(viewedAt)})
	}
	httpx.JSON(w, 200, out)
}

func storiesViewed(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "invalid id")
		return
	}
	var authorID string
	var expiresAt time.Time
	if err := db.Pool.QueryRow(ctx,
		`SELECT user_id, expires_at FROM stories WHERE id = $1`, id).Scan(&authorID, &expiresAt); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "story not found")
		} else {
			httpx.Err(w, 500, "Failed to mark viewed")
		}
		return
	}
	if authorID == user.ID {
		httpx.JSON(w, 200, map[string]any{"ok": true, "noop": true})
		return
	}
	if !expiresAt.After(time.Now()) {
		httpx.Err(w, http.StatusGone, "story expired")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`, id, user.ID); err != nil {
		httpx.Err(w, 500, "Failed to mark viewed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func storiesKey(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "invalid id")
		return
	}
	var expiresAt time.Time
	if err := db.Pool.QueryRow(ctx,
		`SELECT expires_at FROM stories WHERE id = $1`, id).Scan(&expiresAt); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "story not found")
		} else {
			httpx.Err(w, 500, "Failed to load key")
		}
		return
	}
	if !expiresAt.After(time.Now()) {
		httpx.Err(w, http.StatusGone, "story expired")
		return
	}
	var wrapped string
	if err := db.Pool.QueryRow(ctx,
		`SELECT wrapped_key FROM story_keys WHERE story_id = $1 AND viewer_id = $2`,
		id, user.ID).Scan(&wrapped); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "no key for viewer")
		} else {
			httpx.Err(w, 500, "Failed to load key")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{"wrappedKey": wrapped})
}

func storiesDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id, ok := httpx.ParseIntPrefix(r.PathValue("id"))
	if !ok {
		httpx.Err(w, 400, "invalid id")
		return
	}
	var deleted int64
	if err := db.Pool.QueryRow(ctx,
		`DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING id`,
		id, user.ID).Scan(&deleted); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "not found or not author")
		} else {
			httpx.Err(w, 500, "Failed to delete story")
		}
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func truncRunes(s string, n int) string {
	if runes := []rune(s); len(runes) > n {
		return string(runes[:n])
	}
	return s
}
