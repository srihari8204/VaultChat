// channels.go ← routes/channels.js — broadcast channels (Telegram-style
// one-to-many). Same endpoints, statuses, error strings, shapes. Realtime
// fan-out bridges to room channel:<id> via emitx.ToRooms; the content-free
// Expo push to subscribers is ported from push.js (batch 100, retry 3,
// dead-token prune).
package routes

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/vault"
)

func RegisterChannels(mux *http.ServeMux) {
	mux.HandleFunc("GET /channels", httpx.RequireAuth(channelList))
	mux.HandleFunc("POST /channels", httpx.RequireAuth(channelCreate))
	mux.HandleFunc("POST /channels/join", httpx.RequireAuth(channelJoin))
	mux.HandleFunc("GET /channels/{id}/posts", httpx.RequireAuth(channelPostsGet))
	mux.HandleFunc("POST /channels/{id}/posts", httpx.RequireAuth(channelPostsPost))
}

const channelCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no ambiguous chars

func genChannelCode() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	var sb strings.Builder
	for i := 0; i < 8; i++ {
		if i == 4 {
			sb.WriteByte('-')
		}
		sb.WriteByte(channelCodeAlphabet[int(b[i])%len(channelCodeAlphabet)])
	}
	return sb.String() // e.g. "ABCD-2F9K"
}

type channelRow struct {
	ID          string
	Name        string
	Description *string
	AdminID     string
	InviteCode  string
	CreatedAt   time.Time
	LastPostAt  *time.Time
	LastPost    *string
}

type channelPublic struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Description     *string       `json:"description"`
	AdminID         string        `json:"adminId"`
	IsAdmin         bool          `json:"isAdmin"`
	InviteCode      string        `json:"inviteCode"`
	CreatedAt       httpx.JSTime  `json:"createdAt"`
	LastPostAt      *httpx.JSTime `json:"lastPostAt"`
	LastPost        *string       `json:"lastPost"`
	SubscriberCount *int64        `json:"subscriberCount,omitempty"` // Node: undefined when absent
}

func (c channelRow) public(myID string, subCount *int64) channelPublic {
	return channelPublic{
		ID: c.ID, Name: c.Name, Description: c.Description, AdminID: c.AdminID,
		IsAdmin: c.AdminID == myID, InviteCode: c.InviteCode,
		CreatedAt: httpx.JSTime(c.CreatedAt), LastPostAt: httpx.JST(c.LastPostAt),
		LastPost: c.LastPost, SubscriberCount: subCount,
	}
}

type channelPostOut struct {
	ID         string       `json:"id"` // BIGSERIAL → node-pg string
	Text       string       `json:"text"`
	AuthorID   string       `json:"authorId"`
	AuthorName *string      `json:"authorName"`
	CreatedAt  httpx.JSTime `json:"createdAt"`
}

func channelLoad(ctx context.Context, id string) (*channelRow, error) {
	c := &channelRow{}
	err := db.Pool.QueryRow(ctx,
		`SELECT id, name, description, admin_id, invite_code, created_at, last_post_at, last_post
		   FROM channels WHERE id = $1 LIMIT 1`, id).
		Scan(&c.ID, &c.Name, &c.Description, &c.AdminID, &c.InviteCode,
			&c.CreatedAt, &c.LastPostAt, &c.LastPost)
	if err != nil {
		return nil, err
	}
	return c, nil
}

// GET /channels — channels the caller admins or is subscribed to
func channelList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(ctx,
		`SELECT c.id, c.name, c.description, c.admin_id, c.invite_code, c.created_at,
		        c.last_post_at, c.last_post,
		        (SELECT COUNT(*) FROM channel_subscribers cs WHERE cs.channel_id = c.id) AS subscriber_count
		   FROM channels c
		  WHERE c.admin_id = $1
		     OR EXISTS (SELECT 1 FROM channel_subscribers cs WHERE cs.channel_id = c.id AND cs.user_id = $1)
		  ORDER BY c.last_post_at DESC NULLS LAST, c.created_at DESC
		  LIMIT 200`, user.ID)
	if err != nil {
		httpx.Err(w, 500, "Failed to list channels")
		return
	}
	defer rows.Close()
	out := []channelPublic{}
	for rows.Next() {
		var c channelRow
		var n int64
		if err := rows.Scan(&c.ID, &c.Name, &c.Description, &c.AdminID, &c.InviteCode,
			&c.CreatedAt, &c.LastPostAt, &c.LastPost, &n); err != nil {
			httpx.Err(w, 500, "Failed to list channels")
			return
		}
		out = append(out, c.public(user.ID, &n))
	}
	httpx.JSON(w, 200, out)
}

// POST /channels — create { name, description? }
func channelCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Name        any `json:"name"`
		Description any `json:"description"`
	}
	_ = httpx.Body(r, &b)
	name := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.Name))), 100)
	var description *string
	if d := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.Description))), 500); d != "" {
		description = &d
	}
	if name == "" {
		httpx.Err(w, 400, "name required")
		return
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		httpx.Err(w, 500, "Failed to create channel")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after Commit

	var created channelRow
	inserted := false
	// Retry unique invite_code collisions (Node loops 5×; a real collision
	// aborts the tx in both backends — negligible probability either way).
	for i := 0; i < 5; i++ {
		err = tx.QueryRow(ctx,
			`INSERT INTO channels (name, description, admin_id, invite_code, last_post_at)
			 VALUES ($1, $2, $3, $4, NOW())
			 RETURNING id, name, description, admin_id, invite_code, created_at, last_post_at, last_post`,
			name, description, user.ID, genChannelCode()).
			Scan(&created.ID, &created.Name, &created.Description, &created.AdminID,
				&created.InviteCode, &created.CreatedAt, &created.LastPostAt, &created.LastPost)
		if err == nil {
			inserted = true
			break
		}
	}
	if !inserted {
		httpx.Err(w, 500, "Failed to create channel")
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		created.ID, user.ID); err != nil {
		httpx.Err(w, 500, "Failed to create channel")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		httpx.Err(w, 500, "Failed to create channel")
		return
	}
	one := int64(1)
	httpx.JSON(w, 200, created.public(user.ID, &one))
}

// POST /channels/join — subscribe { code }
func channelJoin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Code any `json:"code"`
	}
	_ = httpx.Body(r, &b)
	code := strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.Code))))
	if code == "" {
		httpx.Err(w, 400, "code required")
		return
	}
	var ch channelRow
	err := db.Pool.QueryRow(ctx,
		`SELECT id, name, description, admin_id, invite_code, created_at, last_post_at, last_post
		   FROM channels WHERE invite_code = $1 LIMIT 1`, code).
		Scan(&ch.ID, &ch.Name, &ch.Description, &ch.AdminID, &ch.InviteCode,
			&ch.CreatedAt, &ch.LastPostAt, &ch.LastPost)
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "No channel with that code")
		} else {
			httpx.Err(w, 500, "Failed to join channel")
		}
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		ch.ID, user.ID); err != nil {
		httpx.Err(w, 500, "Failed to join channel")
		return
	}
	var n int64
	if err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) AS n FROM channel_subscribers WHERE channel_id = $1`, ch.ID).Scan(&n); err != nil {
		httpx.Err(w, 500, "Failed to join channel")
		return
	}
	httpx.JSON(w, 200, ch.public(user.ID, &n))
}

// GET /channels/:id/posts — newest first, keyset paginated
func channelPostsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	ch, err := channelLoad(ctx, r.PathValue("id"))
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Channel not found")
		} else {
			httpx.Err(w, 500, "Failed to load posts") // invalid uuid etc. — Node 500s the same way
		}
		return
	}
	if ch.AdminID != user.ID {
		var one int
		err := db.Pool.QueryRow(ctx,
			`SELECT 1 FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2`,
			ch.ID, user.ID).Scan(&one)
		if err != nil {
			if db.NoRows(err) {
				httpx.Err(w, 403, "Not subscribed")
			} else {
				httpx.Err(w, 500, "Failed to load posts")
			}
			return
		}
	}

	q := r.URL.Query()
	var before int64
	hasBefore := false
	if bs := q.Get("before"); bs != "" {
		if n, ok := httpx.ParseIntPrefix(bs); ok && n != 0 { // Node: `before &&` — 0/NaN skip the filter
			before, hasBefore = n, true
		}
	}
	limit := int64(50)
	if ls := q.Get("limit"); ls != "" {
		n, ok := httpx.ParseIntPrefix(ls)
		if !ok {
			// Node: parseInt→NaN → LIMIT NaN → pg error → 500
			httpx.Err(w, 500, "Failed to load posts")
			return
		}
		limit = n
	}
	if limit > 100 {
		limit = 100
	}

	sql := `SELECT p.id, p.text, p.author_id, p.created_at,
	               u.name AS author_name, u.first_name_cipher AS author_fnc,
	               u.last_name_cipher AS author_lnc, u.email_cipher AS author_ec
	          FROM channel_posts p JOIN users u ON u.id = p.author_id
	         WHERE p.channel_id = $1`
	args := []any{ch.ID}
	if hasBefore {
		args = append(args, before)
		sql += fmt.Sprintf(" AND p.id < $%d", len(args))
	}
	args = append(args, limit)
	sql += fmt.Sprintf(" ORDER BY p.id DESC LIMIT $%d", len(args))

	rows, err := db.Pool.Query(ctx, sql, args...)
	if err != nil {
		httpx.Err(w, 500, "Failed to load posts")
		return
	}
	defer rows.Close()
	out := []channelPostOut{}
	for rows.Next() {
		var id int64
		var text, authorID string
		var createdAt time.Time
		var name, fnc, lnc, ec *string
		if err := rows.Scan(&id, &text, &authorID, &createdAt, &name, &fnc, &lnc, &ec); err != nil {
			httpx.Err(w, 500, "Failed to load posts")
			return
		}
		ident := vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, name, nil, nil, nil, nil)
		out = append(out, channelPostOut{
			ID: fmt.Sprintf("%d", id), Text: text, AuthorID: authorID,
			AuthorName: ident.Name, CreatedAt: httpx.JSTime(createdAt),
		})
	}
	httpx.JSON(w, 200, out)
}

// POST /channels/:id/posts — admin only { text }
func channelPostsPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	ch, err := channelLoad(ctx, r.PathValue("id"))
	if err != nil {
		if db.NoRows(err) {
			httpx.Err(w, 404, "Channel not found")
		} else {
			httpx.Err(w, 500, "Failed to post")
		}
		return
	}
	if ch.AdminID != user.ID {
		httpx.Err(w, 403, "Only the admin can post")
		return
	}
	var b struct {
		Text any `json:"text"`
	}
	_ = httpx.Body(r, &b)
	text := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b.Text)))
	if text == "" {
		httpx.Err(w, 400, "text required")
		return
	}
	if len(utf16.Encode([]rune(text))) > 4000 { // JS .length = UTF-16 units
		httpx.Err(w, 413, "post too long (max 4000)")
		return
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		httpx.Err(w, 500, "Failed to post")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after Commit
	var postID int64
	var postText, postAuthorID string
	var postCreatedAt time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO channel_posts (channel_id, author_id, text) VALUES ($1, $2, $3)
		 RETURNING id, text, author_id, created_at`,
		ch.ID, user.ID, text).Scan(&postID, &postText, &postAuthorID, &postCreatedAt); err != nil {
		httpx.Err(w, 500, "Failed to post")
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE channels SET last_post = $1, last_post_at = $2 WHERE id = $3`,
		truncRunes(text, 80), postCreatedAt, ch.ID); err != nil {
		httpx.Err(w, 500, "Failed to post")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		httpx.Err(w, 500, "Failed to post")
		return
	}

	// Realtime: push the new post to every subscriber currently viewing.
	var name, fnc, lnc, ec *string
	err = db.Pool.QueryRow(ctx,
		`SELECT name, first_name_cipher, last_name_cipher, email_cipher FROM users WHERE id = $1`,
		user.ID).Scan(&name, &fnc, &lnc, &ec)
	if err != nil && !db.NoRows(err) { // Node: rows[0] || {} — missing row is fine
		httpx.Err(w, 500, "Failed to post")
		return
	}
	out := channelPostOut{
		ID: fmt.Sprintf("%d", postID), Text: postText, AuthorID: postAuthorID,
		AuthorName: vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, name, nil, nil, nil, nil).Name,
		CreatedAt:  httpx.JSTime(postCreatedAt),
	}
	emitx.ToRooms([]string{"channel:" + ch.ID}, "channel_post", out)
	httpx.JSON(w, 200, out)

	// Fire-and-forget push to subscribers (excluding the author).
	chID := ch.ID
	authorID := user.ID
	go func() {
		bctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		rows, err := db.Pool.Query(bctx,
			`SELECT user_id FROM channel_subscribers WHERE channel_id = $1 AND user_id <> $2`,
			chID, authorID)
		if err != nil {
			log.Printf("[channel push] %v", err)
			return
		}
		uids := []string{}
		for rows.Next() {
			var uid string
			if err := rows.Scan(&uid); err != nil {
				rows.Close()
				log.Printf("[channel push] %v", err)
				return
			}
			uids = append(uids, uid)
		}
		rows.Close()
		if len(uids) == 0 {
			return
		}
		tr, err := db.Pool.Query(bctx,
			`SELECT push_token FROM devices WHERE user_id = ANY($1::uuid[])`, uids)
		if err != nil {
			log.Printf("[channel push] %v", err)
			return
		}
		tokens := []string{}
		for tr.Next() {
			var tok *string
			if err := tr.Scan(&tok); err != nil {
				tr.Close()
				log.Printf("[channel push] %v", err)
				return
			}
			if tok != nil && *tok != "" {
				tokens = append(tokens, *tok)
			}
		}
		tr.Close()
		if len(tokens) == 0 {
			return
		}
		// Content-free (F2): never put the post text or channel name in the
		// push — it transits Expo + FCM/APNs in the clear. Routing data only.
		channelSendExpoPush(bctx, tokens, "VaultChat", "New channel post",
			map[string]any{"type": "channel_post", "channelId": chID})
	}()
}

// ── Expo push (port of push.js sendPushToTokens for the channel route) ──

const channelExpoPushURL = "https://exp.host/--/api/v2/push/send"

var channelPushClient = &http.Client{Timeout: 15 * time.Second}

// channelPostExpoBatch mirrors push.js postBatch: 3 attempts, 5xx retried
// with backoff, 4xx not retryable. Returns the ticket array or nil.
func channelPostExpoBatch(ctx context.Context, chunk []map[string]any) []struct {
	Status  string `json:"status"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
} {
	body, _ := json.Marshal(chunk)
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, "POST", channelExpoPushURL, bytes.NewReader(body))
		if err != nil {
			return nil
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Accept-encoding", "gzip, deflate")
		resp, err := channelPushClient.Do(req)
		if err == nil {
			if resp.StatusCode >= 500 { // transient server error → retry
				resp.Body.Close()
			} else if resp.StatusCode >= 400 {
				txt, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
				resp.Body.Close()
				log.Printf("[push] Expo Push returned %d %s", resp.StatusCode, txt)
				return nil // 4xx → not retryable
			} else {
				var out struct {
					Data []struct {
						Status  string `json:"status"`
						Details struct {
							Error string `json:"error"`
						} `json:"details"`
					} `json:"data"`
				}
				err := json.NewDecoder(resp.Body).Decode(&out)
				resp.Body.Close()
				if err != nil {
					return nil
				}
				return out.Data
			}
		}
		if attempt < 3 {
			time.Sleep(time.Duration(300*attempt) * time.Millisecond)
		}
	}
	log.Printf("[push] batch failed after retries")
	return nil
}

func channelSendExpoPush(ctx context.Context, tokens []string, title, body string, data map[string]any) {
	valid := []string{}
	for _, t := range tokens {
		if strings.HasPrefix(t, "Expo") {
			valid = append(valid, t)
		}
	}
	if len(valid) == 0 {
		return
	}
	dead := []string{}
	for i := 0; i < len(valid); i += 100 {
		slice := valid[i:min(i+100, len(valid))]
		chunk := make([]map[string]any, 0, len(slice))
		for _, token := range slice {
			chunk = append(chunk, map[string]any{
				"to": token, "sound": "default", "title": title, "body": body,
				"data": data, "priority": "high", "channelId": "default",
				"_displayInForeground": true,
			})
		}
		tickets := channelPostExpoBatch(ctx, chunk)
		for idx, t := range tickets {
			if idx < len(slice) && t.Status == "error" && t.Details.Error == "DeviceNotRegistered" {
				dead = append(dead, slice[idx])
			}
		}
	}
	// Prune tokens for devices that no longer exist (uninstall / reinstall).
	if len(dead) > 0 {
		if _, err := db.Pool.Exec(ctx,
			`DELETE FROM devices WHERE push_token = ANY($1::text[])`, dead); err != nil {
			log.Printf("[push] prune dead tokens: %v", err)
		}
	}
}
