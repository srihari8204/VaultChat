// chats_helpers.go — second half of the routes/chats.js port: single-chat
// fetch, message CRUD, receipts, membership admin, per-user toggles, polls,
// pin-message, sender keys, and the content-free message push (F2).
package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/fcm"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/realtime"
	"vaultchat/backend-go/internal/vault"
	"vaultchat/backend-go/internal/workx"
)

// ─── GET /chats/{id} — chat + members ──────────────────────────────────

type chatsPublicMember struct {
	UserID                 string        `json:"userId"`
	Role                   string        `json:"role"`
	JoinedAt               httpx.JSTime  `json:"joinedAt"`
	LastReadMessageID      *string       `json:"lastReadMessageId"`
	LastDeliveredMessageID *string       `json:"lastDeliveredMessageId"`
	Muted                  bool          `json:"muted"`
	LeftAt                 *httpx.JSTime `json:"leftAt"`
	Email                  *string       `json:"email"`
	Name                   *string       `json:"name"`
	PhotoURL               *string       `json:"photoURL"`
	Online                 bool          `json:"online"`
	LastSeenAt             *httpx.JSTime `json:"lastSeenAt"`
	Status                 *string       `json:"status"`
}

func chatsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 404, "Chat not found", "Failed to fetch chat")
	if mem == nil {
		return
	}

	var (
		cID, cType                                   string
		cName, cDescription, cPhotoURL, cCreatedBy   *string
		cCreatedAt, cUpdatedAt                       time.Time
		cLastMessageID, cPinnedMessageID             *int64
		cLastMessageAt                               *time.Time
		cDisappearing                                *int64
		cSlowMode                                    int64
		cSendPolicy, cMediaPolicy, cAddMembersPolicy *string
		cAntiSpamLinks, cApproveMembers              bool
		cIcon, cColor                                *string
		cPrivacy                                     string
	)
	err := chatsQRow(ctx, user.ID,
		`SELECT id, type, name, description, photo_url, created_by, created_at, updated_at,
		        last_message_id, last_message_at, pinned_message_id, disappearing_seconds,
		        slow_mode_seconds, send_policy, media_policy, add_members_policy,
		        anti_spam_links, approve_members, icon, color, privacy
		   FROM chats WHERE id = $1`, []any{chatID},
		&cID, &cType, &cName, &cDescription, &cPhotoURL, &cCreatedBy, &cCreatedAt, &cUpdatedAt,
		&cLastMessageID, &cLastMessageAt, &cPinnedMessageID, &cDisappearing,
		&cSlowMode, &cSendPolicy, &cMediaPolicy, &cAddMembersPolicy,
		&cAntiSpamLinks, &cApproveMembers, &cIcon, &cColor, &cPrivacy)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Chat not found")
		return
	}
	if err != nil {
		log.Printf("[chats GET/:id] %v", err)
		httpx.Err(w, 500, "Failed to fetch chat")
		return
	}

	type memberRow struct {
		pub          chatsPublicMember
		leftAt       *time.Time
		readReceipts bool
	}
	members := []memberRow{}
	err = chatsQueryU(ctx, user.ID,
		`SELECT cm.user_id, cm.role, cm.joined_at, cm.last_read_message_id, cm.last_delivered_message_id,
		        cm.muted, cm.left_at,
		        u.email, u.name, u.first_name_cipher, u.last_name_cipher, u.email_cipher,
		        u.photo_url, u.online, u.last_seen_at, u.last_seen_visible, u.status, u.read_receipts
		 FROM chat_members cm
		 JOIN users u ON u.id = cm.user_id
		 WHERE cm.chat_id = $1
		 ORDER BY cm.joined_at`,
		[]any{chatID}, func(rows pgx.Rows) error {
			var (
				userID, role              string
				joinedAt                  time.Time
				lastRead, lastDelivered   *int64
				muted                     bool
				leftAt, lastSeenAt        *time.Time
				email, name, fnc, lnc, ec *string
				photoURL, status          *string
				online, lastSeenVisible   *bool
				readReceipts              *bool
			)
			if e := rows.Scan(&userID, &role, &joinedAt, &lastRead, &lastDelivered,
				&muted, &leftAt,
				&email, &name, &fnc, &lnc, &ec,
				&photoURL, &online, &lastSeenAt, &lastSeenVisible, &status, &readReceipts); e != nil {
				return e
			}
			ident := vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, name, email, nil, nil, nil)
			m := chatsPublicMember{
				UserID: userID, Role: role, JoinedAt: httpx.JSTime(joinedAt),
				LastReadMessageID:      userBigStr(lastRead),
				LastDeliveredMessageID: userBigStr(lastDelivered),
				Muted:                  muted, LeftAt: httpx.JST(leftAt),
				Email: ident.Email, Name: ident.Name, PhotoURL: photoURL,
				Status: status,
			}
			if online != nil {
				m.Online = *online
			}
			// last_seen_visible === false → blank lastSeenAt (privacy).
			if lastSeenVisible == nil || *lastSeenVisible {
				m.LastSeenAt = httpx.JST(lastSeenAt)
			}
			rr := readReceipts == nil || *readReceipts // !== false
			members = append(members, memberRow{pub: m, leftAt: leftAt, readReceipts: rr})
			return nil
		})
	if err != nil {
		log.Printf("[chats GET/:id] %v", err)
		httpx.Err(w, 500, "Failed to fetch chat")
		return
	}

	// Read-receipt reciprocity: DIRECT chats hide peers' read pointers unless
	// every active participant keeps read receipts ON. Groups exempt.
	receiptsMutual := cType != "direct"
	if !receiptsMutual {
		receiptsMutual = true
		for _, m := range members {
			if m.leftAt == nil && !m.readReceipts {
				receiptsMutual = false
				break
			}
		}
	}
	pubMembers := make([]chatsPublicMember, 0, len(members))
	for _, m := range members {
		p := m.pub
		if !receiptsMutual && p.UserID != user.ID {
			p.LastReadMessageID = nil
		}
		pubMembers = append(pubMembers, p)
	}

	gm := chatsBuildGroupMeta(mem, cIcon, cColor, cPrivacy)
	httpx.JSON(w, 200, map[string]any{
		"id":                  cID,
		"type":                cType,
		"name":                cName,
		"description":         cDescription,
		"photoURL":            cPhotoURL,
		"createdBy":           cCreatedBy,
		"createdAt":           httpx.JSTime(cCreatedAt),
		"updatedAt":           httpx.JSTime(cUpdatedAt),
		"lastMessageId":       userBigStr(cLastMessageID),
		"lastMessageAt":       httpx.JST(cLastMessageAt),
		"pinnedMessageId":     userBigStr(cPinnedMessageID),
		"disappearingSeconds": cDisappearing,
		"slowModeSeconds":     cSlowMode,
		"sendPolicy":          chatsStrDefault(cSendPolicy, "everyone"),
		"mediaPolicy":         chatsStrDefault(cMediaPolicy, "everyone"),
		"addMembersPolicy":    chatsStrDefault(cAddMembersPolicy, "admins"),
		"antiSpamLinks":       cAntiSpamLinks,
		"approveMembers":      cApproveMembers,
		"members":             pubMembers,
		// Groups & Circles: the group's identity plus THIS CALLER's resolved
		// permission set, so the client can gate its own UI. Advisory only —
		// every mutating endpoint re-resolves server-side.
		"groupType":      gm.GroupType,
		"icon":           gm.Icon,
		"color":          gm.Color,
		"privacy":        gm.Privacy,
		"maxMembers":     gm.MaxMembers,
		"permissions":    gm.Permissions,
		"myRole":         mem.Role,
		"myLastReadId":   userBigStr(mem.LastReadMessageID),
		"hidden":         mem.Hidden,
		"screenshotMode": chatsStrDefault(mem.ScreenshotMode, "block"),
		"vanishMode":     mem.VanishMode,
	})
}

// ─── POST /chats/{id}/messages — send ──────────────────────────────────

var (
	chatsMsgTypes = map[string]bool{"text": true, "image": true, "video": true, "audio": true,
		"file": true, "location": true, "system": true, "sticker": true, "poll": true,
		"reaction": true, "vaultbeam": true}
	chatsGifURLRe = regexp.MustCompile(`^https://\S+$`)
	chatsLinkRe   = regexp.MustCompile(`(?i)https?://`)
)

func chatsMessagePost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member of this chat", "Failed to send message")
	if mem == nil {
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	msgType := chatsStrOr(b["type"], "text")

	// Group admin controls — enforced for non-admins only.
	if !mem.isAdmin() {
		bContent, _ := b["content"].(string)
		if mem.SendPolicy != nil && *mem.SendPolicy == "admins" {
			httpx.Err(w, 403, "Only admins can send messages in this group")
			return
		}
		if mem.MediaPolicy != nil && *mem.MediaPolicy == "admins" &&
			(msgType == "image" || msgType == "video" || msgType == "file") {
			httpx.Err(w, 403, "Only admins can send media in this group")
			return
		}
		if mem.AntiSpamLinks {
			newish := time.Since(mem.JoinedAt) < 24*time.Hour
			if newish && chatsLinkRe.MatchString(bContent) {
				httpx.Err(w, 403, "New members can’t post links yet (anti-spam)")
				return
			}
		}
		if slow := mem.SlowModeSeconds; slow > 0 {
			var lastCreated time.Time
			err := chatsQRow(ctx, user.ID,
				`SELECT created_at FROM messages
				  WHERE chat_id = $1 AND sender_id = $2 AND deleted_at IS NULL
				  ORDER BY id DESC LIMIT 1`,
				[]any{chatID, user.ID}, &lastCreated)
			if err != nil && !db.NoRows(err) {
				log.Printf("[messages POST] %v", err)
				httpx.Err(w, 500, "Failed to send message")
				return
			}
			if err == nil {
				elapsed := time.Since(lastCreated).Seconds()
				if elapsed < float64(slow) {
					httpx.Err(w, 429, "Slow mode is on",
						map[string]any{"retryAfter": int64(math.Ceil(float64(slow) - elapsed))})
					return
				}
			}
		}
	}

	contentRaw, contentIsStr := b["content"].(string)
	var content any
	if b["content"] != nil {
		content = b["content"]
	}
	var meta map[string]any
	var metaParam any
	// Marshal to a JSON string, never pass the raw map: under
	// default_query_exec_mode=exec (P2.3, PgBouncer) pgx cannot infer a type
	// for map[string]any and every media send 500s with "cannot find encode
	// plan". Postgres casts the text param to jsonb from the column type.
	switch mv := b["meta"].(type) {
	case map[string]any:
		meta = mv
		if j, err := json.Marshal(mv); err == nil {
			metaParam = string(j)
		}
	case []any:
		if j, err := json.Marshal(mv); err == nil {
			metaParam = string(j) // typeof [] === 'object' in JS
		}
	}
	var replyTo *int64
	if chatsTruthy(b["replyToId"]) {
		if n, ok := chatsParseInt(b["replyToId"]); ok {
			replyTo = &n
		} else {
			// Node: parseInt → NaN → pg rejects the param → catch-all 500.
			httpx.Err(w, 500, "Failed to send message")
			return
		}
	}
	var clientID *string
	if s, ok := b["clientId"].(string); ok && s != "" && len(s) <= 128 {
		clientID = &s
	}

	if !chatsMsgTypes[msgType] {
		httpx.Err(w, 400, "invalid type")
		return
	}

	isMedia := msgType == "image" || msgType == "video" || msgType == "audio" || msgType == "file"
	switch {
	case msgType == "text":
		if !contentIsStr || contentRaw == "" {
			httpx.Err(w, 400, "content required for text messages")
			return
		}
	case msgType == "sticker":
		if !contentIsStr || contentRaw == "" {
			httpx.Err(w, 400, "content (sticker id) required")
			return
		}
		if len([]rune(contentRaw)) > 64 {
			httpx.Err(w, 400, "sticker id too long")
			return
		}
	case msgType == "reaction":
		if !contentIsStr || contentRaw == "" {
			httpx.Err(w, 400, "content (encrypted reaction) required")
			return
		}
		if len([]rune(contentRaw)) > 4096 {
			httpx.Err(w, 400, "reaction payload too long")
			return
		}
	case msgType == "poll":
		if !contentIsStr || contentRaw == "" {
			httpx.Err(w, 400, "content (poll question) required")
			return
		}
		if len([]rune(contentRaw)) > 200 {
			httpx.Err(w, 400, "poll question too long (max 200)")
			return
		}
		opts, ok := meta["options"].([]any)
		if !ok || len(opts) < 2 || len(opts) > 10 {
			httpx.Err(w, 400, "meta.options must be an array of 2-10 strings")
			return
		}
		for _, o := range opts {
			s, ok := o.(string)
			if !ok || s == "" || len([]rune(s)) > 100 {
				httpx.Err(w, 400, "each option must be a non-empty string ≤ 100 chars")
				return
			}
		}
	case isMedia:
		// External GIFs carry a remote URL in meta.gifUrl — exempt from attachmentId.
		gifURL, _ := meta["gifUrl"].(string)
		isExternalGif := msgType == "image" && gifURL != "" &&
			chatsGifURLRe.MatchString(gifURL) && len([]rune(gifURL)) <= 2048
		if !isExternalGif && (meta == nil || !chatsTruthy(meta["attachmentId"])) {
			httpx.Err(w, 400, "meta.attachmentId required for media messages")
			return
		}
		if content != nil && !contentIsStr {
			httpx.Err(w, 400, "content must be a string if provided")
			return
		}
		if contentIsStr && contentRaw == "" {
			content = nil // empty caption → NULL
		}
	default:
		if content != nil && !contentIsStr {
			httpx.Err(w, 400, "content must be a string if provided")
			return
		}
	}

	if s, ok := content.(string); ok && len([]rune(s)) > 1_000_000 {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "content too large (max 1 MB)")
		return
	}

	var row chatsMsgRow
	duplicate := false
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx,
			`INSERT INTO messages (chat_id, sender_id, type, content, meta, reply_to_id, client_id, expires_at, vanish_after_read)
			 SELECT $1, $2, $3, $4, $5, $6, $7,
			        CASE WHEN c.disappearing_seconds IS NOT NULL
			             THEN NOW() + (c.disappearing_seconds || ' seconds')::INTERVAL
			             ELSE NULL END,
			        COALESCE(cm.vanish_mode, FALSE)
			   FROM chats c
			   LEFT JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
			  WHERE c.id = $1
			 ON CONFLICT (chat_id, sender_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
			 RETURNING `+chatsMsgCols,
			chatID, user.ID, msgType, content, metaParam, replyTo, clientID).Scan(row.dest()...)
		if db.NoRows(e) {
			if clientID == nil {
				return errors.New("insert returned no row")
			}
			// Retry of the same clientId (F7) — return the ORIGINAL row.
			e2 := tx.QueryRow(ctx,
				`SELECT `+chatsMsgCols+` FROM messages WHERE chat_id = $1 AND sender_id = $2 AND client_id = $3`,
				chatID, user.ID, *clientID).Scan(row.dest()...)
			if db.NoRows(e2) {
				return errors.New("dedup lookup miss")
			}
			if e2 != nil {
				return e2
			}
			duplicate = true
			return nil
		}
		if e != nil {
			return e
		}
		// Reactions never become the chat's "last message" or resurface hidden chats.
		if msgType != "reaction" {
			if _, e := tx.Exec(ctx,
				`UPDATE chats SET last_message_id = $1, last_message_at = $2 WHERE id = $3`,
				row.ID, row.CreatedAt, chatID); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx,
				`UPDATE chat_members SET hidden = FALSE WHERE chat_id = $1 AND user_id <> $2 AND hidden = TRUE`,
				chatID, user.ID); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		log.Printf("[messages POST] %v", err)
		httpx.Err(w, 500, "Failed to send message")
		return
	}

	msg := row.public()
	// Re-broadcast even on a duplicate: recipients dedup by id.
	emitx.ChatNewMessage(chatID, msg)
	httpx.JSON(w, 200, msg)

	if !duplicate && msgType != "reaction" {
		// P2.2: pool-submitted, not raw-spawned — every message send used to
		// fork two goroutines (each holding a DB pool conn); a burst could
		// spawn tens of thousands. workx bounds concurrency + queues overflow.
		workx.Submit(func() {
			bctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if _, err := db.Pool.Exec(bctx, `SELECT vc_bump_unread($1, $2)`, chatID, user.ID); err != nil {
				log.Printf("[unread bump] %v", err)
			}
		})
		workx.Submit(func() { chatsSendMessagePush(chatID, user.ID, msg) })
	}
}

// ─── content-free push (F2) — system-level reads on db.Pool like Node ──

func chatsSendMessagePush(chatID, senderID string, msg chatsPublicMsg) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	meta, _ := msg.Meta.(map[string]any)
	// Silent send (W15): the sender chose not to ring anyone.
	if meta != nil && chatsTruthy(meta["silent"]) {
		return
	}
	mentionedIds := []string{}
	if arr, ok := meta["mentions"].([]any); ok {
		for _, m := range arr {
			if mm, ok := m.(map[string]any); ok {
				if uid, ok := mm["userId"].(string); ok && uid != "" {
					mentionedIds = append(mentionedIds, uid)
				}
			}
		}
	}
	rows, err := db.SysPool.Query(ctx,
		`SELECT cm.user_id FROM chat_members cm
		  WHERE cm.chat_id = $1
		    AND cm.user_id <> $2
		    AND cm.left_at IS NULL
		    AND (cm.muted = FALSE OR cm.user_id = ANY($3::uuid[]))
		    AND NOT EXISTS (
		      SELECT 1 FROM user_blocks ub
		       WHERE ub.blocker_id = cm.user_id AND ub.blocked_id = $2
		    )`, chatID, senderID, mentionedIds)
	if err != nil {
		log.Printf("[sendChatMessagePush] %v", err)
		return
	}
	recipientIds := []string{}
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			rows.Close()
			log.Printf("[sendChatMessagePush] %v", err)
			return
		}
		recipientIds = append(recipientIds, uid)
	}
	rows.Close()
	if rows.Err() != nil || len(recipientIds) == 0 {
		return
	}

	tok, err := db.SysPool.Query(ctx,
		`SELECT d.push_token, d.fcm_token, cm.notif_sound
		   FROM devices d
		   JOIN chat_members cm ON cm.user_id = d.user_id AND cm.chat_id = $2
		  WHERE d.user_id = ANY($1::uuid[]) AND cm.left_at IS NULL`,
		recipientIds, chatID)
	if err != nil {
		log.Printf("[sendChatMessagePush] %v", err)
		return
	}
	fcmByChannel := map[string]map[string]bool{}
	expoByChannel := map[string][]string{}
	for tok.Next() {
		var pushToken, fcmToken, notifSound *string
		if err := tok.Scan(&pushToken, &fcmToken, &notifSound); err != nil {
			tok.Close()
			log.Printf("[sendChatMessagePush] %v", err)
			return
		}
		ch := "default"
		if notifSound != nil && *notifSound != "" {
			ch = *notifSound
		}
		if fcmToken != nil && *fcmToken != "" {
			if fcmByChannel[ch] == nil {
				fcmByChannel[ch] = map[string]bool{}
			}
			fcmByChannel[ch][*fcmToken] = true
		} else if pushToken != nil && *pushToken != "" {
			expoByChannel[ch] = append(expoByChannel[ch], *pushToken)
		}
	}
	tok.Close()
	if len(fcmByChannel) == 0 && len(expoByChannel) == 0 {
		return
	}

	// Devices WITH a native fcm_token: DATA-ONLY high-priority FCM; the client
	// renders the notification locally (nothing readable transits Google).
	for channelID, tokens := range fcmByChannel {
		list := make([]string, 0, len(tokens))
		for t := range tokens {
			list = append(list, t)
		}
		res := fcm.SendCallMessage(list,
			map[string]string{"type": "message", "chatId": chatID, "channelId": channelID}, 60_000)
		if len(res.Dead) > 0 {
			if _, err := db.Pool.Exec(ctx,
				`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, res.Dead); err != nil {
				log.Printf("[sendChatMessagePush] %v", err)
			}
		}
	}
	// Legacy Expo devices: generic title/body, per-chat sound channel.
	data := map[string]any{"chatId": chatID, "type": "message"}
	for channelID, tokens := range expoByChannel {
		chatsSendExpoPush(ctx, tokens, "VaultChat", "New message", data, channelID)
	}
}

// chatsSendExpoPush = push.js sendPushToTokens with a per-chat channelId.
// Transport (batching/retries/ticket parsing) reuses channelPostExpoBatch.
func chatsSendExpoPush(ctx context.Context, tokens []string, title, body string, data map[string]any, channelID string) {
	valid := []string{}
	for _, t := range tokens {
		if strings.HasPrefix(t, "Expo") {
			valid = append(valid, t)
		}
	}
	if len(valid) == 0 {
		return
	}
	if channelID == "" {
		channelID = "default"
	}
	dead := []string{}
	for i := 0; i < len(valid); i += 100 {
		slice := valid[i:min(i+100, len(valid))]
		chunk := make([]map[string]any, 0, len(slice))
		for _, token := range slice {
			chunk = append(chunk, map[string]any{
				"to": token, "sound": "default", "title": title, "body": body,
				"data": data, "priority": "high", "channelId": channelID,
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
	if len(dead) > 0 {
		if _, err := db.Pool.Exec(ctx,
			`DELETE FROM devices WHERE push_token = ANY($1::text[])`, dead); err != nil {
			log.Printf("[push] prune dead tokens: %v", err)
		}
	}
}

// ─── GET /chats/{id}/messages — keyset pagination ──────────────────────

func chatsMessagesGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member of this chat", "Failed to load messages")
	if mem == nil {
		return
	}

	q := r.URL.Query()
	var before, after int64
	if s := q.Get("before"); s != "" {
		if n, ok := httpx.ParseIntPrefix(s); ok {
			before = n
		}
	}
	if s := q.Get("after"); s != "" {
		if n, ok := httpx.ParseIntPrefix(s); ok {
			after = n
		}
	}
	limitStr := q.Get("limit")
	if limitStr == "" {
		limitStr = fmt.Sprintf("%d", chatsDefaultPage)
	}
	limit, ok := httpx.ParseIntPrefix(limitStr)
	if !ok {
		// Node: LIMIT NaN → query error → catch-all 500.
		httpx.Err(w, 500, "Failed to load messages")
		return
	}
	if limit > chatsMaxPage {
		limit = chatsMaxPage
	}

	args := []any{chatID}
	where := `chat_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`
	order := "DESC"
	if after != 0 {
		args = append(args, after)
		where += fmt.Sprintf(" AND id > $%d", len(args))
		order = "ASC"
	} else if before != 0 {
		args = append(args, before)
		where += fmt.Sprintf(" AND id < $%d", len(args))
	}
	args = append(args, limit)

	out := []chatsPublicMsg{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT `+chatsMsgCols+` FROM messages WHERE `+where+
			fmt.Sprintf(` ORDER BY id %s LIMIT $%d`, order, len(args)),
		args, func(rows pgx.Rows) error {
			var m chatsMsgRow
			if e := rows.Scan(m.dest()...); e != nil {
				return e
			}
			out = append(out, m.public())
			return nil
		})
	if err != nil {
		log.Printf("[messages GET] %v", err)
		httpx.Err(w, 500, "Failed to load messages")
		return
	}
	httpx.JSON(w, 200, out)
}

// GET /chats/{id}/messages/search — zero-knowledge: membership-gated, no hits.
func chatsInChatSearch(w http.ResponseWriter, r *http.Request) {
	mem := chatsRequireMem(w, r, 403, "Not a member of this chat", "Search failed")
	if mem == nil {
		return
	}
	httpx.JSON(w, 200, map[string]any{"messages": []any{}})
}

// ─── PATCH /chats/{id}/messages/{msgId} — edit (sender, 15-min window) ─

func chatsMessagePatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to edit message")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	content, ok := b["content"].(string)
	if !ok || content == "" {
		httpx.Err(w, 400, "content required")
		return
	}

	var row chatsMsgRow
	err := chatsQRow(ctx, user.ID,
		fmt.Sprintf(`UPDATE messages
		 SET content = $1, edited_at = NOW()
		 WHERE id = $2 AND chat_id = $3 AND sender_id = $4 AND deleted_at IS NULL
		   AND created_at > NOW() - INTERVAL '%d milliseconds'
		 RETURNING `, chatsEditWindowMS)+chatsMsgCols,
		[]any{content, r.PathValue("msgId"), chatID, user.ID}, row.dest()...)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Message not found, not yours, or edit window expired")
		return
	}
	if err != nil {
		log.Printf("[messages PATCH] %v", err)
		httpx.Err(w, 500, "Failed to edit message")
		return
	}
	msg := row.public()
	emitx.ChatEvent(chatID, "message_edited", map[string]any{
		"id": msg.ID, "content": msg.Content, "editedAt": msg.EditedAt,
	})
	httpx.JSON(w, 200, msg)
}

// ─── DELETE /chats/{id}/messages/{msgId} — delete-for-everyone ─────────

func chatsMessageDelete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to delete message")
	if mem == nil {
		return
	}
	var id int64
	var deletedAt time.Time
	err := chatsQRow(ctx, user.ID,
		fmt.Sprintf(`UPDATE messages
		 SET deleted_at = NOW(), content = NULL, meta = NULL, type = 'system'
		 WHERE id = $1 AND chat_id = $2 AND sender_id = $3 AND deleted_at IS NULL
		   AND created_at > NOW() - INTERVAL '%d milliseconds'
		 RETURNING id, chat_id, deleted_at`, chatsRevokeWindowMS),
		[]any{r.PathValue("msgId"), chatID, user.ID}, &id, &chatID, &deletedAt)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Message not found, not yours, or the delete window has expired")
		return
	}
	if err != nil {
		log.Printf("[messages DELETE] %v", err)
		httpx.Err(w, 500, "Failed to delete message")
		return
	}
	idStr := fmt.Sprintf("%d", id)
	emitx.ChatEvent(chatID, "message_deleted", map[string]any{
		"id": idStr, "deletedAt": httpx.JSTime(deletedAt),
	})
	httpx.JSON(w, 200, map[string]any{"id": idStr, "deletedAt": httpx.JSTime(deletedAt)})
}

// ─── POST /chats/{id}/delivered — delivery pointer (grey → double tick) ─

func chatsDelivered(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	var b map[string]any
	_ = httpx.Body(r, &b)
	var id int64
	if chatsTruthy(b["lastDeliveredMessageId"]) {
		id, _ = chatsParseInt(b["lastDeliveredMessageId"])
	}
	if id == 0 {
		httpx.Err(w, 400, "lastDeliveredMessageId required")
		return
	}
	var updated int64
	err := chatsQRow(ctx, user.ID,
		`UPDATE chat_members
		 SET last_delivered_message_id = $1
		 WHERE chat_id = $2 AND user_id = $3
		   AND (last_delivered_message_id IS NULL OR last_delivered_message_id < $1)
		 RETURNING last_delivered_message_id`,
		[]any{id, chatID, user.ID}, &updated)
	if err != nil && !db.NoRows(err) {
		log.Printf("[delivered POST] %v", err)
		httpx.Err(w, 500, "Failed to mark delivered")
		return
	}
	if err == nil {
		emitx.ChatEvent(chatID, "message_delivered", map[string]any{
			"userId":                 user.ID,
			"lastDeliveredMessageId": fmt.Sprintf("%d", updated),
		})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ─── POST /chats/{id}/read — read pointer + vanish sweep ───────────────

func chatsRead(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	var b map[string]any
	_ = httpx.Body(r, &b)
	var id int64
	if chatsTruthy(b["lastReadMessageId"]) {
		id, _ = chatsParseInt(b["lastReadMessageId"])
	}
	if id == 0 {
		httpx.Err(w, 400, "lastReadMessageId required")
		return
	}
	var lastRead int64
	var chatType *string
	var receiptsMutual *bool
	err := chatsQRow(ctx, user.ID,
		`UPDATE chat_members
		 SET last_read_message_id = $1,
		     unread_count = (
		       SELECT COUNT(*) FROM messages m
		        WHERE m.chat_id = $2 AND m.id > $1
		          AND m.sender_id <> $3 AND m.deleted_at IS NULL
		          AND m.type <> 'reaction'
		     )
		 WHERE chat_id = $2 AND user_id = $3
		   AND (last_read_message_id IS NULL OR last_read_message_id < $1)
		 RETURNING last_read_message_id,
		   (SELECT c.type FROM chats c WHERE c.id = $2) AS chat_type,
		   (SELECT bool_and(u.read_receipts)
		      FROM chat_members cm2 JOIN users u ON u.id = cm2.user_id
		     WHERE cm2.chat_id = $2 AND cm2.left_at IS NULL) AS receipts_mutual`,
		[]any{id, chatID, user.ID}, &lastRead, &chatType, &receiptsMutual)
	if err != nil && !db.NoRows(err) {
		log.Printf("[read POST] %v", err)
		httpx.Err(w, 500, "Failed to mark read")
		return
	}
	if err == nil {
		// Read-receipt reciprocity (server-side, WhatsApp).
		suppressReceipt := chatType != nil && *chatType == "direct" &&
			receiptsMutual != nil && !*receiptsMutual
		if !suppressReceipt {
			emitx.ChatEvent(chatID, "message_read", map[string]any{
				"userId":            user.ID,
				"lastReadMessageId": fmt.Sprintf("%d", lastRead),
			})
		}
		// Vanish-Mode trigger — unconditional, independent of receipt visibility.
		if err := chatsExecU(ctx, user.ID,
			`UPDATE messages m SET expires_at = NOW()
			  WHERE m.chat_id = $1
			    AND m.vanish_after_read = TRUE
			    AND m.expires_at IS NULL
			    AND m.id <= $2
			    AND NOT EXISTS (
			      SELECT 1 FROM chat_members cm2
			       WHERE cm2.chat_id = m.chat_id
			         AND cm2.user_id <> m.sender_id
			         AND cm2.left_at IS NULL
			         AND COALESCE(cm2.last_read_message_id, 0) < m.id
			    )`, chatID, id); err != nil {
			log.Printf("[read POST] %v", err)
			httpx.Err(w, 500, "Failed to mark read")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ─── POST /chats/{id}/members — add (policy-gated) ─────────────────────

func chatsMembersAdd(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to add members")
	if mem == nil {
		return
	}
	if mem.ChatType != "group" {
		httpx.Err(w, 400, "Only group chats support add")
		return
	}
	// A typed group answers this from its permission matrix; an untyped legacy
	// group keeps the old admin-or-open-policy rule exactly (see chatsMem.can).
	canAdd := mem.can(groups.PermInviteMembers) ||
		(mem.AddMembersPolicy != nil && *mem.AddMembersPolicy == "everyone")
	if !canAdd {
		httpx.Err(w, 403, "You do not have permission to add members")
		return
	}

	var b map[string]any
	_ = httpx.Body(r, &b)
	ids := []string{}
	if arr, ok := b["userIds"].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok {
				ids = append(ids, s)
			}
		}
	}
	if len(ids) == 0 {
		httpx.Err(w, 400, "userIds required")
		return
	}

	var size int
	if err := chatsQRow(ctx, user.ID,
		`SELECT COUNT(*)::int AS n FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`,
		[]any{chatID}, &size); err != nil {
		log.Printf("[members POST] %v", err)
		httpx.Err(w, 500, "Failed to add members")
		return
	}
	// A typed group's cap comes from group_type_config and is usually far below
	// the global ceiling; untyped legacy groups keep the global one. This is an
	// EARLY, friendly rejection only — the authoritative check is the database
	// trigger from migration 066, which serialises on the group row. An
	// application-level count cannot be the gate: two concurrent adds both read
	// the same `size` and both pass.
	cap := chatsMaxGroupSize
	if mem.MaxMembers != nil && int(*mem.MaxMembers) > 0 && int(*mem.MaxMembers) < cap {
		cap = int(*mem.MaxMembers)
	}
	if size+len(ids) > cap {
		httpx.Err(w, 409, fmt.Sprintf("Group would exceed its limit of %d members", cap))
		return
	}

	// Honor each invitee's "who can add me to groups" privacy (WhatsApp).
	policy := map[string]string{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT id, group_add_policy FROM users WHERE id = ANY($1::uuid[])`,
		[]any{ids}, func(rows pgx.Rows) error {
			var id string
			var p *string
			if e := rows.Scan(&id, &p); e != nil {
				return e
			}
			policy[id] = chatsStrDefault(p, "everyone")
			return nil
		})
	if err != nil {
		log.Printf("[members POST] %v", err)
		httpx.Err(w, 500, "Failed to add members")
		return
	}
	contactReq := []string{}
	for _, uid := range ids {
		if policy[uid] == "contacts" {
			contactReq = append(contactReq, uid)
		}
	}
	known := map[string]bool{}
	if len(contactReq) > 0 {
		err := chatsQueryU(ctx, user.ID,
			`SELECT DISTINCT m2.user_id FROM chat_members m1
			   JOIN chats c ON c.id = m1.chat_id AND c.type = 'direct'
			   JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id <> $1
			  WHERE m1.user_id = $1 AND m2.user_id = ANY($2::uuid[])`,
			[]any{user.ID, contactReq}, func(rows pgx.Rows) error {
				var uid string
				if e := rows.Scan(&uid); e != nil {
					return e
				}
				known[uid] = true
				return nil
			})
		if err != nil {
			log.Printf("[members POST] %v", err)
			httpx.Err(w, 500, "Failed to add members")
			return
		}
	}
	allowed := []string{}
	allowedSet := map[string]bool{}
	for _, uid := range ids {
		p := policy[uid]
		if p == "" {
			p = "everyone"
		}
		if p == "nobody" || (p == "contacts" && !known[uid]) {
			continue
		}
		allowed = append(allowed, uid)
		allowedSet[uid] = true
	}
	blocked := []string{}
	for _, uid := range ids {
		if !allowedSet[uid] {
			blocked = append(blocked, uid)
		}
	}
	if len(allowed) == 0 {
		httpx.Err(w, 403, "Those users don't allow being added to groups by you")
		return
	}

	added := []string{}
	for _, uid := range allowed {
		if err := chatsExecU(ctx, user.ID,
			`INSERT INTO chat_members (chat_id, user_id, role)
			 VALUES ($1, $2, 'member')
			 ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
			chatID, uid); err != nil {
			// The cap trigger firing here is not a server fault: it means
			// another add won the race for the last seat. Report the seats,
			// and keep whoever already went in — partial success beats
			// rolling back members who were legitimately added.
			if chatsCapExceeded(err) {
				if len(added) > 0 {
					realtime.InvalidateChatMembers(ctx, chatID)
					emitx.ChatEvent(chatID, "members_added", map[string]any{"added": added, "by": user.ID})
				}
				httpx.Err(w, 409, "Group is full")
				return
			}
			log.Printf("[members POST] %v", err)
			httpx.Err(w, 500, "Failed to add members")
			return
		}
		added = append(added, uid)
		chatsAudit(ctx, user.ID, chatID, "member_added", &uid, nil)
	}
	allowed = added
	// P2.2: drop the cached roster BEFORE the fan-out so members_added reaches
	// the users just added (a stale cache would exclude them).
	realtime.InvalidateChatMembers(ctx, chatID)
	emitx.ChatEvent(chatID, "members_added", map[string]any{"added": allowed, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"added": allowed, "blocked": blocked})
}

// ─── PATCH /chats/{id}/members/{userId}/role — promote/demote ──────────

func chatsMemberRole(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to change role")
	if mem == nil {
		return
	}
	if mem.ChatType != "group" {
		httpx.Err(w, 400, "Only group chats have roles")
		return
	}
	if !mem.can(groups.PermRemoveMembers) {
		httpx.Err(w, 403, "You do not have permission to change roles")
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	role := fmt.Sprintf("%v", orEmpty(b["role"]))
	// 'guest' joins the accepted set for typed groups only: an untyped legacy
	// group has no guest semantics and must keep its original two-role world.
	validRole := role == "admin" || role == "member" || (role == "guest" && mem.isTypedGroup())
	if !validRole {
		if mem.isTypedGroup() {
			httpx.Err(w, 400, "role must be 'admin', 'member' or 'guest'")
		} else {
			httpx.Err(w, 400, "role must be 'admin' or 'member'")
		}
		return
	}
	target := r.PathValue("userId")
	if target == user.ID {
		httpx.Err(w, 400, "Cannot change your own role")
		return
	}

	var targetRole string
	err := chatsQRow(ctx, user.ID,
		`SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		[]any{chatID, target}, &targetRole)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Member not found")
		return
	}
	if err != nil {
		log.Printf("[member role PATCH] %v", err)
		httpx.Err(w, 500, "Failed to change role")
		return
	}
	// One rule, shared with the client mirror: nobody edits an owner, nobody is
	// promoted TO owner through this path, and an admin cannot demote a peer
	// admin (otherwise two admins can demote each other in a loop).
	if !groups.CanManageRole(mem.Role, targetRole, role) {
		httpx.Err(w, 403, "You cannot change this member's role")
		return
	}

	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET role = $1 WHERE chat_id = $2 AND user_id = $3 AND left_at IS NULL`,
		role, chatID, target); err != nil {
		log.Printf("[member role PATCH] %v", err)
		httpx.Err(w, 500, "Failed to change role")
		return
	}
	chatsAudit(ctx, user.ID, chatID, "member_role_changed", &target,
		map[string]any{"from": targetRole, "to": role})
	emitx.ChatEvent(chatID, "member_role_changed", map[string]any{"userId": target, "role": role, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "userId": target, "role": role})
}

// ─── Invite links (admin) ──────────────────────────────────────────────

func chatsInviteCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to create invite link")
	if mem == nil {
		return
	}
	if mem.ChatType != "group" {
		httpx.Err(w, 400, "Only group chats have invite links")
		return
	}
	if !mem.can(groups.PermInviteMembers) {
		httpx.Err(w, 403, "You do not have permission to manage invites")
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	var expiresAt *time.Time
	if hours, ok := chatsParseInt(b["expiresInHours"]); ok && hours > 0 {
		t := time.Now().Add(time.Duration(min(hours, 24*365)) * time.Hour)
		expiresAt = &t
	}
	maxUses, ok := chatsParseInt(b["maxUses"])
	if !ok || maxUses < 0 {
		maxUses = 0
	}

	var lastErr error
	for i := 0; i < 5; i++ {
		var row chatsInviteRow
		lastErr = chatsQRow(ctx, user.ID,
			`INSERT INTO invite_links (code, chat_id, created_by, expires_at, max_uses)
			 VALUES ($1, $2, $3, $4, $5) RETURNING `+chatsInviteCols,
			[]any{chatsGenInviteCode(), chatID, user.ID, expiresAt, maxUses}, row.dest()...)
		if lastErr == nil {
			httpx.JSON(w, 200, row.public())
			return
		}
	}
	log.Printf("[invite-links POST] %v", lastErr)
	httpx.Err(w, 500, "Failed to create invite link")
}

func chatsInviteList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to list invite links")
	if mem == nil {
		return
	}
	if !mem.can(groups.PermInviteMembers) {
		httpx.Err(w, 403, "You do not have permission to manage invites")
		return
	}
	out := []chatsPublicInvite{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT `+chatsInviteCols+` FROM invite_links WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 50`,
		[]any{r.PathValue("id")}, func(rows pgx.Rows) error {
			var row chatsInviteRow
			if e := rows.Scan(row.dest()...); e != nil {
				return e
			}
			out = append(out, row.public())
			return nil
		})
	if err != nil {
		log.Printf("[invite-links GET] %v", err)
		httpx.Err(w, 500, "Failed to list invite links")
		return
	}
	httpx.JSON(w, 200, out)
}

func chatsInviteRevoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to revoke invite link")
	if mem == nil {
		return
	}
	if !mem.can(groups.PermInviteMembers) {
		httpx.Err(w, 403, "You do not have permission to manage invites")
		return
	}
	linkID, ok := httpx.ParseIntPrefix(r.PathValue("linkId"))
	if !ok {
		httpx.Err(w, 400, "invalid linkId")
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE invite_links SET revoked = TRUE WHERE id = $1 AND chat_id = $2`,
		linkID, r.PathValue("id")); err != nil {
		log.Printf("[invite-links DELETE] %v", err)
		httpx.Err(w, 500, "Failed to revoke invite link")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ─── PATCH /chats/{id} — settings (name/photo/policies/timers) ─────────

func chatsPatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update chat")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	isGroup := mem.ChatType == "group"

	sets := []string{}
	params := []any{chatID}
	push := func(col string, v any) {
		params = append(params, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(params)))
	}
	// Settings edits are one permission. On an untyped legacy group can() is
	// exactly isAdmin, so nothing about existing groups changes.
	canEdit := mem.can(groups.PermEditSettings)
	adminGroupGate := func(directErr string) bool {
		if !isGroup {
			httpx.Err(w, 400, directErr)
			return false
		}
		if !canEdit {
			httpx.Err(w, 403, "You do not have permission to edit this group")
			return false
		}
		return true
	}

	if s, ok := b["name"].(string); ok {
		if !adminGroupGate("Direct chats cannot be renamed") {
			return
		}
		n := truncRunes(strings.TrimSpace(s), 100)
		if n == "" {
			httpx.Err(w, 400, "name cannot be empty")
			return
		}
		push("name", n)
	}
	if s, ok := b["photoURL"].(string); ok {
		if !adminGroupGate("Direct chats use peer photo") {
			return
		}
		p := truncRunes(strings.TrimSpace(s), 1024)
		var v *string
		if p != "" {
			v = &p
		}
		push("photo_url", v)
	}
	if s, ok := b["description"].(string); ok {
		if !adminGroupGate("Direct chats have no description") {
			return
		}
		d := truncRunes(strings.TrimSpace(s), 512)
		var v *string
		if d != "" {
			v = &d
		}
		push("description", v)
	}

	// ── Groups & Circles metadata (migration 066) ──
	// This is also how an existing Family Space circle becomes a typed group:
	// the client stamps groupType on first run after upgrade, because the
	// server has no way to know which of its groups were circles.
	if s, ok := b["groupType"].(string); ok {
		if !adminGroupGate("Direct chats have no group type") {
			return
		}
		t := strings.ToLower(strings.TrimSpace(s))
		if t == "" {
			httpx.Err(w, 400, "groupType cannot be empty")
			return
		}
		known, err := chatsKnownGroupType(ctx, user.ID, t)
		if err != nil {
			log.Printf("[chats PATCH] group type lookup: %v", err)
			httpx.Err(w, 500, "Failed to update chat")
			return
		}
		if !known {
			httpx.Err(w, 400, "Unknown group type")
			return
		}
		push("group_type", t)
	}
	if s, ok := b["icon"].(string); ok {
		if !adminGroupGate("Direct chats have no icon") {
			return
		}
		v := truncRunes(strings.TrimSpace(s), chatsGroupIconMax)
		push("icon", chatsNilIfEmpty(v))
	}
	if s, ok := b["color"].(string); ok {
		if !adminGroupGate("Direct chats have no color") {
			return
		}
		v := truncRunes(strings.TrimSpace(s), chatsGroupColorMax)
		push("color", chatsNilIfEmpty(v))
	}
	if s, ok := b["privacy"].(string); ok {
		if !adminGroupGate("Direct chats have no privacy setting") {
			return
		}
		p := strings.ToLower(strings.TrimSpace(s))
		if !chatsValidPrivacy(p) {
			httpx.Err(w, 400, "privacy must be 'private' or 'invite_only'")
			return
		}
		push("privacy", p)
	}

	// Disappearing-messages timer: any member can set/clear it.
	if raw, present := b["disappearingSeconds"]; present {
		if raw == nil || raw == float64(0) {
			push("disappearing_seconds", nil)
		} else if f, ok := raw.(float64); !ok || f < 0 {
			httpx.Err(w, 400, "disappearingSeconds must be a non-negative number or null")
			return
		} else {
			push("disappearing_seconds", min(int64(math.Round(f)), 365*24*60*60))
		}
	}
	if raw, present := b["slowModeSeconds"]; present {
		if !adminGroupGate("Slow mode is group-only") {
			return
		}
		sm, ok := chatsParseInt(raw)
		if !ok || sm < 0 {
			sm = 0
		}
		push("slow_mode_seconds", min(sm, 24*60*60))
	}
	if s, ok := b["sendPolicy"].(string); ok {
		if !adminGroupGate("Send policy is group-only") {
			return
		}
		v := "everyone"
		if s == "admins" {
			v = "admins"
		}
		push("send_policy", v)
	}
	if s, ok := b["mediaPolicy"].(string); ok {
		if !adminGroupGate("Media policy is group-only") {
			return
		}
		v := "everyone"
		if s == "admins" {
			v = "admins"
		}
		push("media_policy", v)
	}
	if s, ok := b["addMembersPolicy"].(string); ok {
		if !adminGroupGate("Add-members policy is group-only") {
			return
		}
		v := "admins"
		if s == "everyone" {
			v = "everyone"
		}
		push("add_members_policy", v)
	}
	if raw, present := b["antiSpamLinks"]; present {
		if !adminGroupGate("Anti-spam is group-only") {
			return
		}
		push("anti_spam_links", chatsTruthy(raw))
	}
	if raw, present := b["approveMembers"]; present {
		if !adminGroupGate("Approve-members is group-only") {
			return
		}
		push("approve_members", chatsTruthy(raw))
	}

	if len(sets) == 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "noop": true})
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chats SET `+strings.Join(sets, ", ")+` WHERE id = $1`, params...); err != nil {
		log.Printf("[chats PATCH] %v", err)
		httpx.Err(w, 500, "Failed to update chat")
		return
	}
	// Node's payload literal — absent body keys serialize away (undefined).
	payload := map[string]any{"chatId": chatID}
	for _, k := range []string{"name", "photoURL", "disappearingSeconds"} {
		if v, present := b[k]; present {
			payload[k] = v
		}
	}
	emitx.ChatEvent(chatID, "chat_updated", payload)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ─── per-user toggles ──────────────────────────────────────────────────

func chatsPin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to pin chat")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	pinned := chatsTruthy(b["pinned"])
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members
		    SET pinned = $1,
		        pinned_at = CASE WHEN $1 THEN NOW() ELSE NULL END
		  WHERE chat_id = $2 AND user_id = $3`,
		pinned, r.PathValue("id"), user.ID); err != nil {
		log.Printf("[chats pin] %v", err)
		httpx.Err(w, 500, "Failed to pin chat")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "pinned": pinned})
}

func chatsArchive(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to archive chat")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	archived := chatsTruthy(b["archived"])
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET archived = $1
		  WHERE chat_id = $2 AND user_id = $3`,
		archived, r.PathValue("id"), user.ID); err != nil {
		log.Printf("[chats archive] %v", err)
		httpx.Err(w, 500, "Failed to archive chat")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "archived": archived})
}

func chatsHidden(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update hidden state")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	hidden := chatsTruthy(b["hidden"])
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET hidden = $1 WHERE chat_id = $2 AND user_id = $3`,
		hidden, r.PathValue("id"), user.ID); err != nil {
		log.Printf("[chats hidden] %v", err)
		httpx.Err(w, 500, "Failed to update hidden state")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "hidden": hidden})
}

var chatsScreenshotModes = []string{"allow", "allow_notify", "block", "block_silent"}

func chatsScreenshotMode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update screenshot mode")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	mode := fmt.Sprintf("%v", orEmpty(b["mode"]))
	valid := false
	for _, m := range chatsScreenshotModes {
		if m == mode {
			valid = true
			break
		}
	}
	if !valid {
		httpx.Err(w, 400, "mode must be one of "+strings.Join(chatsScreenshotModes, ", "))
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET screenshot_mode = $1 WHERE chat_id = $2 AND user_id = $3`,
		mode, r.PathValue("id"), user.ID); err != nil {
		log.Printf("[chats screenshot-mode] %v", err)
		httpx.Err(w, 500, "Failed to update screenshot mode")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "mode": mode})
}

func chatsScreenshotCaptured(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to report screenshot")
	if mem == nil {
		return
	}
	emitx.ChatEvent(chatID, "screenshot_captured", map[string]any{
		"chatId":     chatID,
		"capturedBy": user.ID,
		"capturedAt": httpx.JSTime(time.Now()),
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func chatsVanishMode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update vanish mode")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	enabled := chatsTruthy(b["enabled"])
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET vanish_mode = $1 WHERE chat_id = $2 AND user_id = $3`,
		enabled, r.PathValue("id"), user.ID); err != nil {
		log.Printf("[chats vanish-mode] %v", err)
		httpx.Err(w, 500, "Failed to update vanish mode")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "enabled": enabled})
}

func chatsMute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update mute")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	muted := chatsTruthy(b["muted"])
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET muted = $1
		  WHERE chat_id = $2 AND user_id = $3`,
		muted, r.PathValue("id"), user.ID); err != nil {
		log.Printf("[chats mute] %v", err)
		httpx.Err(w, 500, "Failed to update mute")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "muted": muted})
}

func chatsNotifSound(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to update notification sound")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	raw := fmt.Sprintf("%v", orEmpty(b["sound"]))
	var sound *string
	if raw == "chime" || raw == "bell" { // whitelist; 'default'/other clears
		sound = &raw
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET notif_sound = $1 WHERE chat_id = $2 AND user_id = $3`,
		sound, r.PathValue("id"), user.ID); err != nil {
		log.Printf("[chats notif-sound] %v", err)
		httpx.Err(w, 500, "Failed to update notification sound")
		return
	}
	out := "default"
	if sound != nil {
		out = *sound
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "sound": out})
}

// ─── DELETE /chats/{id}/members/{userId} — remove or leave ─────────────

func chatsMemberRemove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to remove member")
	if mem == nil {
		return
	}
	target := r.PathValue("userId")
	isSelf := target == user.ID
	// Leaving is always your own right; removing someone else is a permission.
	if !isSelf && !mem.can(groups.PermRemoveMembers) {
		httpx.Err(w, 403, "You do not have permission to remove members")
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET left_at = NOW()
		 WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		chatID, target); err != nil {
		log.Printf("[members DELETE] %v", err)
		httpx.Err(w, 500, "Failed to remove member")
		return
	}
	realtime.InvalidateChatMembers(ctx, chatID) // P2.2: fresh roster before the fan-out
	event := "member_removed"
	if isSelf {
		event = "member_left"
	}
	chatsAudit(ctx, user.ID, chatID, event, &target, nil)
	emitx.ChatEvent(chatID, event, map[string]any{"userId": target, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ─── Polls ─────────────────────────────────────────────────────────────

func chatsPollVote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to vote")
	if mem == nil {
		return
	}
	msgID, msgOK := httpx.ParseIntPrefix(r.PathValue("msgId"))
	if !msgOK {
		httpx.Err(w, 400, "invalid msgId")
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	optionIndex, optOK := chatsParseInt(b["optionIndex"])
	if !optOK || optionIndex < 0 {
		httpx.Err(w, 400, "optionIndex must be a non-negative integer")
		return
	}

	var mType string
	var mMeta any
	err := chatsQRow(ctx, user.ID,
		`SELECT type, meta FROM messages WHERE id = $1 AND chat_id = $2 LIMIT 1`,
		[]any{msgID, chatID}, &mType, &mMeta)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Poll not found")
		return
	}
	if err != nil {
		log.Printf("[poll vote POST] %v", err)
		httpx.Err(w, 500, "Failed to vote")
		return
	}
	if mType != "poll" {
		httpx.Err(w, 400, "Not a poll message")
		return
	}
	metaMap, _ := mMeta.(map[string]any)
	options, _ := metaMap["options"].([]any)
	if optionIndex >= int64(len(options)) {
		httpx.Err(w, 400, "optionIndex out of range")
		return
	}
	allowMultiple := metaMap != nil && chatsTruthy(metaMap["allowMultiple"])

	q := `WITH cleared AS (
	       DELETE FROM poll_votes
	        WHERE message_id = $1 AND user_id = $2 AND option_index <> $3
	     )
	     INSERT INTO poll_votes (message_id, user_id, option_index)
	     VALUES ($1, $2, $3)
	     ON CONFLICT DO NOTHING`
	if allowMultiple {
		q = `INSERT INTO poll_votes (message_id, user_id, option_index)
		     VALUES ($1, $2, $3)
		     ON CONFLICT DO NOTHING`
	}
	if err := chatsExecU(ctx, user.ID, q, msgID, user.ID, optionIndex); err != nil {
		log.Printf("[poll vote POST] %v", err)
		httpx.Err(w, 500, "Failed to vote")
		return
	}
	emitx.ChatEvent(chatID, "poll_voted", map[string]any{
		"chatId": chatID, "messageId": msgID, "userId": user.ID, "optionIndex": optionIndex,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func chatsPollUnvote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to un-vote")
	if mem == nil {
		return
	}
	msgID, msgOK := httpx.ParseIntPrefix(r.PathValue("msgId"))
	optionIndex, optOK := httpx.ParseIntPrefix(r.PathValue("optionIndex"))
	if !msgOK || !optOK {
		httpx.Err(w, 400, "invalid id or optionIndex")
		return
	}
	if err := chatsExecU(ctx, user.ID,
		`DELETE FROM poll_votes
		  WHERE message_id = $1 AND user_id = $2 AND option_index = $3`,
		msgID, user.ID, optionIndex); err != nil {
		log.Printf("[poll vote DELETE] %v", err)
		httpx.Err(w, 500, "Failed to un-vote")
		return
	}
	emitx.ChatEvent(chatID, "poll_unvoted", map[string]any{
		"chatId": chatID, "messageId": msgID, "userId": user.ID, "optionIndex": optionIndex,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

type chatsPollBucket struct {
	Counts map[string]int `json:"counts"`
	Mine   []int64        `json:"mine"`
	Total  int            `json:"total"`
}

func chatsPollVotes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load votes")
	if mem == nil {
		return
	}
	msgID, ok := httpx.ParseIntPrefix(r.PathValue("msgId"))
	if !ok {
		httpx.Err(w, 400, "invalid msgId")
		return
	}
	counts := map[string]int{}
	mine := []int64{}
	total := 0
	err := chatsQueryU(ctx, user.ID,
		`SELECT option_index, user_id FROM poll_votes WHERE message_id = $1`,
		[]any{msgID}, func(rows pgx.Rows) error {
			var optionIndex int64
			var userID string
			if e := rows.Scan(&optionIndex, &userID); e != nil {
				return e
			}
			counts[fmt.Sprintf("%d", optionIndex)]++
			total++
			if userID == user.ID {
				mine = append(mine, optionIndex)
			}
			return nil
		})
	if err != nil {
		log.Printf("[poll votes GET] %v", err)
		httpx.Err(w, 500, "Failed to load votes")
		return
	}
	httpx.JSON(w, 200, chatsPollBucket{Counts: counts, Mine: mine, Total: total})
}

func chatsPollVotesBulk(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load votes")
	if mem == nil {
		return
	}
	ids := []int64{}
	for _, s := range strings.Split(r.URL.Query().Get("messageIds"), ",") {
		if n, ok := httpx.ParseIntPrefix(strings.TrimSpace(s)); ok && len(ids) < 500 {
			ids = append(ids, n)
		}
	}
	if len(ids) == 0 {
		httpx.JSON(w, 200, map[string]any{})
		return
	}
	out := map[string]*chatsPollBucket{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT pv.message_id, pv.option_index, pv.user_id
		   FROM poll_votes pv
		   JOIN messages m ON m.id = pv.message_id
		  WHERE m.chat_id = $1 AND pv.message_id = ANY($2::bigint[])`,
		[]any{r.PathValue("id"), ids}, func(rows pgx.Rows) error {
			var messageID, optionIndex int64
			var userID string
			if e := rows.Scan(&messageID, &optionIndex, &userID); e != nil {
				return e
			}
			k := fmt.Sprintf("%d", messageID)
			bucket := out[k]
			if bucket == nil {
				bucket = &chatsPollBucket{Counts: map[string]int{}, Mine: []int64{}}
				out[k] = bucket
			}
			bucket.Counts[fmt.Sprintf("%d", optionIndex)]++
			bucket.Total++
			if userID == user.ID {
				bucket.Mine = append(bucket.Mine, optionIndex)
			}
			return nil
		})
	if err != nil {
		log.Printf("[poll votes bulk] %v", err)
		httpx.Err(w, 500, "Failed to load votes")
		return
	}
	httpx.JSON(w, 200, out)
}

// ─── POST /chats/{id}/pin-message — chat-wide pinned message ───────────

func chatsPinMessage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "not a member", "Failed to pin")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	var messageID *int64
	if raw := b["messageId"]; raw != nil {
		n, ok := chatsParseInt(raw)
		if !ok {
			// Node: parseInt → NaN → pg rejects the param → catch-all 500.
			httpx.Err(w, 500, "Failed to pin")
			return
		}
		messageID = &n
	}
	if messageID != nil {
		var one int
		err := chatsQRow(ctx, user.ID,
			`SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL LIMIT 1`,
			[]any{*messageID, chatID}, &one)
		if db.NoRows(err) {
			httpx.Err(w, 404, "message not found")
			return
		}
		if err != nil {
			log.Printf("[chats pin] %v", err)
			httpx.Err(w, 500, "Failed to pin")
			return
		}
	}
	if err := chatsExecU(ctx, user.ID,
		`UPDATE chats SET pinned_message_id = $1 WHERE id = $2`, messageID, chatID); err != nil {
		log.Printf("[chats pin] %v", err)
		httpx.Err(w, 500, "Failed to pin")
		return
	}
	emitx.ChatEvent(chatID, "message_pinned", map[string]any{"messageId": userBigStr(messageID)})
	httpx.JSON(w, 200, map[string]any{"ok": true, "pinnedMessageId": userBigStr(messageID)})
}

// ─── Group E2EE sender-key distribution (W5) — opaque SKDM relay ───────

func chatsSenderKeysPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "not a member", "Failed to publish sender keys")
	if mem == nil {
		return
	}
	var b map[string]any
	_ = httpx.Body(r, &b)
	dists, _ := b["distributions"].([]any)
	if len(dists) == 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "stored": 0})
		return
	}

	active := map[string]bool{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT user_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL`,
		[]any{chatID}, func(rows pgx.Rows) error {
			var uid string
			if e := rows.Scan(&uid); e != nil {
				return e
			}
			active[uid] = true
			return nil
		})
	if err != nil {
		log.Printf("[sender-keys POST] %v", err)
		httpx.Err(w, 500, "Failed to publish sender keys")
		return
	}

	stored := 0
	for _, dv := range dists {
		d, _ := dv.(map[string]any)
		recipientID, skdm := "", ""
		if d != nil && chatsTruthy(d["recipientId"]) {
			recipientID = fmt.Sprintf("%v", d["recipientId"])
		}
		if d != nil && chatsTruthy(d["skdm"]) {
			skdm = fmt.Sprintf("%v", d["skdm"])
		}
		if recipientID == "" || skdm == "" || recipientID == user.ID || !active[recipientID] {
			continue
		}
		if err := chatsExecU(ctx, user.ID,
			`INSERT INTO group_sender_keys (chat_id, sender_id, recipient_id, skdm)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (chat_id, sender_id, recipient_id)
			   DO UPDATE SET skdm = EXCLUDED.skdm, updated_at = NOW()`,
			chatID, user.ID, recipientID, skdm); err != nil {
			log.Printf("[sender-keys POST] %v", err)
			httpx.Err(w, 500, "Failed to publish sender keys")
			return
		}
		stored++
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "stored": stored})
}

func chatsSenderKeysGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	mem := chatsRequireMem(w, r, 403, "not a member", "Failed to load sender keys")
	if mem == nil {
		return
	}
	type sk struct {
		SenderID string `json:"senderId"`
		Skdm     string `json:"skdm"`
	}
	out := []sk{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT sender_id, skdm FROM group_sender_keys
		  WHERE chat_id = $1 AND recipient_id = $2`,
		[]any{r.PathValue("id"), user.ID}, func(rows pgx.Rows) error {
			var row sk
			if e := rows.Scan(&row.SenderID, &row.Skdm); e != nil {
				return e
			}
			out = append(out, row)
			return nil
		})
	if err != nil {
		log.Printf("[sender-keys GET] %v", err)
		httpx.Err(w, 500, "Failed to load sender keys")
		return
	}
	httpx.JSON(w, 200, out)
}

// chatsStrOr mirrors (v || def).toString() over a JSON any.
func chatsStrOr(v any, def string) string {
	if !chatsTruthy(v) {
		return def
	}
	return fmt.Sprintf("%v", v)
}
