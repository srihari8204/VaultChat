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
		// Migration 120: the whole chat self-destructs at this time. NULL = never.
		cExpiresAt                                   *time.Time
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
		        anti_spam_links, approve_members, icon, color, privacy, expires_at
		   FROM chats WHERE id = $1`, []any{chatID},
		&cID, &cType, &cName, &cDescription, &cPhotoURL, &cCreatedBy, &cCreatedAt, &cUpdatedAt,
		&cLastMessageID, &cLastMessageAt, &cPinnedMessageID, &cDisappearing,
		&cSlowMode, &cSendPolicy, &cMediaPolicy, &cAddMembersPolicy,
		&cAntiSpamLinks, &cApproveMembers, &cIcon, &cColor, &cPrivacy, &cExpiresAt)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Chat not found")
		return
	}
	if err != nil {
		log.Printf("[chats GET/:id] %v", err)
		httpx.Err(w, 500, "Failed to fetch chat")
		return
	}

	// Anonymous chat opened by code, not yet mutually saved (migration 119).
	// Resolved once for the whole member list rather than per member.
	anonMasked := chatsAnonMasked(ctx, chatID)

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
			// Anonymous chat, not yet mutually saved (migration 119). This member
			// list is the WORST leak of the four: it carries the EMAIL as well as
			// the name, so a masked chat that forgot this one would hand over more
			// than the chat list ever showed. Status goes too — people put their
			// name in it.
			//
			// The caller is masked along with everyone else. Their own identity is
			// not a secret from themselves, but the client renders this list
			// uniformly and a self-row that alone carried a real name would be a
			// tell about which row is which.
			if anonMasked {
				anonName := chatsAnonName
				m.Name, m.Email, m.PhotoURL, m.Status = &anonName, nil, nil, nil
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

	// WHAT THE OTHER MEMBERS REQUIRE OF THIS DEVICE.
	//
	// screenshotMode below is the CALLER'S OWN row, and the client was using it
	// to decide whether to block capture and whether to report its own captures.
	// That made the setting mean "when I screenshot, tell them" — the exact
	// inverse of how it reads. Setting "block screenshots and notify me" changed
	// nothing about what the other person's phone did, so the person who asked
	// for the protection was the only one it never protected.
	//
	// Two booleans rather than one "effective mode" because in a group the
	// requirements COMPOSE and a single ordinal cannot express that: one member
	// on block_silent (block, stay quiet) and another on allow_notify (allow,
	// but tell me) together mean block AND notify, which is neither of them.
	//
	// COALESCE to 'block' matches the app-side default for an unset column, so a
	// member who never touched the setting still gets the protective posture.
	var peerBlocks, peerNotify bool
	if e := chatsQRow(ctx, user.ID,
		`SELECT
		   COALESCE(bool_or(COALESCE(screenshot_mode,'block') IN ('block','block_silent')), FALSE),
		   COALESCE(bool_or(COALESCE(screenshot_mode,'block') IN ('block','allow_notify')), FALSE)
		 FROM chat_members
		  WHERE chat_id = $1 AND user_id <> $2 AND left_at IS NULL`,
		[]any{chatID, user.ID}, &peerBlocks, &peerNotify); e != nil {
		// Fail PROTECTIVE, never permissive: a lookup failure must not silently
		// turn someone's screenshot protection off.
		log.Printf("[chats get] peer screenshot policy: %v", e)
		peerBlocks, peerNotify = true, true
	}

	gm := chatsBuildGroupMeta(mem, cIcon, cColor, cPrivacy)
	httpx.JSON(w, 200, map[string]any{
		// What OTHERS require of me — drives this device's capture policy.
		"peerBlocksCapture":      peerBlocks,
		"peerWantsCaptureNotice": peerNotify,
		// Migration 119: opened by code, not yet mutually saved, so every name
		// and photo in `members` below is a placeholder. The client shows a ghost
		// and offers "Save contact" off this flag rather than by recognising the
		// placeholder name, which somebody could genuinely be called.
		"anonMasked": anonMasked,
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
		// Migration 120: when this whole conversation deletes itself. The client
		// counts down against it; null means it never does.
		"expiresAt":           httpx.JST(cExpiresAt),
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
		"groupType":    gm.GroupType,
		"icon":         gm.Icon,
		"color":        gm.Color,
		"privacy":      gm.Privacy,
		"maxMembers":   gm.MaxMembers,
		"approvalMode": gm.ApprovalMode,
		"permissions":  gm.Permissions,
		// The caller's rank and display role, and the space type's catalog.
		//
		// These were added to chatsGroupMeta but not to THIS map, and chatsGet
		// serialises the map rather than the struct — so `role`, `roleKey` and
		// `roleCatalog` never reached any client. The admin console could not
		// show a job title and had no catalog to offer when assigning one.
		"role":           gm.Role,
		"roleKey":        gm.RoleKey,
		"roleCatalog":    gm.RoleCatalog,
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
		"reaction": true, "vaultbeam": true, "group_ref": true, "game_invite": true}
	chatsGifURLRe = regexp.MustCompile(`^https://\S+$`)
	chatsLinkRe   = regexp.MustCompile(`(?i)https?://`)

	// The four games the app ships. The games server implements others; the app
	// exposes exactly these, so a card naming anything else would open a screen
	// that falls back to the menu — an invite that goes nowhere.
	chatsGameKinds = map[string]bool{"chess": true, "rummy": true, "ludo": true, "tictactoe": true}
	// A room id the games server would mint. It ends up inside a URL other
	// people open, so a slash, a quote, a '?' or a '#' would REWRITE the link
	// rather than fill it in. Same shape gamesNotifySlug enforces on the
	// notification path — the two must not disagree about what an id is.
	chatsGameRoomRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// chatsBlockedDirect reports whether this is a DIRECT chat in which either side
// has blocked the other.
//
// Groups are deliberately excluded: blocking is a 1:1 relationship, and a
// blocked member posting to a shared group is handled by the existing fan-out
// and push filters, not by refusing the write for everyone else in the room.
//
// Fails CLOSED only on a positive match — any query error leaves the message
// deliverable, because a transient database problem must not look like a block.
func chatsBlockedDirect(ctx context.Context, chatID, senderID string) bool {
	var one int
	err := db.Pool.QueryRow(ctx,
		`SELECT 1
		   FROM chats c
		   JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id <> $2 AND cm.left_at IS NULL
		   JOIN user_blocks ub
		     ON (ub.blocker_id = cm.user_id AND ub.blocked_id = $2)
		     OR (ub.blocker_id = $2 AND ub.blocked_id = cm.user_id)
		  WHERE c.id = $1 AND c.type = 'direct'
		  LIMIT 1`, chatID, senderID).Scan(&one)
	if err == nil {
		return true
	}
	if !db.NoRows(err) {
		log.Printf("[chatsBlockedDirect] %v", err)
	}
	return false
}

func chatsMessagePost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member of this chat", "Failed to send message")
	if mem == nil {
		return
	}

	// A blocked sender must not be able to write into this chat at all.
	//
	// Blocking was enforced everywhere EXCEPT here: creating a direct chat
	// checked it (chats.go), push suppressed it, realtime fan-out suppressed it
	// — but the INSERT itself did not. So a blocked person's message was still
	// stored, and the un-hide below then dragged the chat back into the
	// recipient's list with an unread badge and no notification to explain it.
	// A user who blocked someone and deleted the chat watched it reappear.
	//
	// Suppressing the symptoms downstream could never fix that; the row should
	// never have existed. Same both-directions test as chat creation, so the
	// two paths cannot disagree.
	if chatsBlockedDirect(ctx, chatID, user.ID) {
		httpx.Err(w, 403, "Blocked")
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

	// Groups & Circles: an ANNOUNCEMENT is an ordinary encrypted message flagged
	// in `meta`. The server can read meta (it is deliberately PII-free) even
	// though the body is ciphertext, which is what makes send_announcements a
	// REAL permission rather than a client-side decoration — gating only in the
	// UI would let any modified client post one.
	//
	// The flag discloses that a message IS an announcement, never what it says.
	// Checked here, before the per-type validation, so it applies to every
	// message kind rather than only the one branch it happens to sit in.
	if meta != nil && chatsTruthy(meta["announcement"]) {
		if !mem.can(groups.PermSendAnnouncement) {
			httpx.Err(w, 403, "You do not have permission to send announcements")
			return
		}
		// Spaces & Operations: an announcement may be addressed to a run, a role
		// or a subtree. Validated HERE, beside the permission, for the same
		// reason — a modified client that skipped the composer must not be able
		// to attach an audience its sender is not entitled to address.
		//
		// The audience forms mirror the visibility rule one-for-one, so
		// "message my department" and "see my department" resolve identically.
		if msg := chatsAudienceAllowed(ctx, user.ID, chatID, mem,
			strings.TrimSpace(chatsStrOr(meta["audience"], ""))); msg != "" {
			httpx.Err(w, 403, msg)
			return
		}
	}

	// Groups & Circles: a group_ref card is the in-app replacement for an invite
	// link, and the two guarantees that make it not-a-link are enforced HERE.
	// Validating it client-side would leave both to a modified client.
	if msgType == "group_ref" {
		if msg := chatsValidateGroupRef(ctx, user.ID, meta); msg != "" {
			httpx.Err(w, 403, msg)
			return
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
	case msgType == "group_ref":
		// The card lives entirely in meta, which the server can read and has
		// already validated. There is no body to encrypt: everything it says is
		// something the recipient is about to be shown anyway.
		if meta == nil || strings.TrimSpace(chatsStrOr(meta["groupId"], "")) == "" {
			httpx.Err(w, 400, "meta.groupId required for a group reference")
			return
		}
	case msgType == "game_invite":
		// A card pointing at a table on the games server (migration 124). Unlike
		// group_ref there is nothing here to enrich: the rooms belong to a
		// separate deployment this database has never heard of. So the server
		// VALIDATES instead of rewriting, and both checks are the reason the
		// card is not a link — a modified client must not be able to put
		// anything in `room` that rewrites the URL the recipient opens.
		//
		// The `content` is the ordinary E2EE body and carries the readable
		// fallback line for a client too old to know this type; the server
		// neither reads it nor requires it.
		if meta == nil {
			httpx.Err(w, 400, "meta.game and meta.room required for a game invite")
			return
		}
		if !chatsGameKinds[strings.TrimSpace(chatsStrOr(meta["game"], ""))] {
			httpx.Err(w, 400, "meta.game must be one of chess, rummy, ludo, tictactoe")
			return
		}
		if !chatsGameRoomRe.MatchString(strings.TrimSpace(chatsStrOr(meta["room"], ""))) {
			httpx.Err(w, 400, "meta.room is not a room id")
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
		// The question arrives ENCRYPTED, so its length here is the length of a
		// Double Ratchet envelope and says nothing about the question. The old
		// 200-rune limit was written when the question was plaintext; against
		// ciphertext it is an arbitrary bound that rejects valid polls. The
		// 200-character UX limit belongs to the composer; this stays only as a
		// sanity ceiling on the payload.
		if len([]rune(contentRaw)) > 8192 {
			httpx.Err(w, 400, "poll question payload too large")
			return
		}
		// OPTION TEXT IS CONTENT and no longer reaches the server: the client
		// sends the COUNT and keeps the options inside the ciphertext (see
		// lib/msgEnvelope). The count is all the server ever needed — it exists
		// to bounds-check `optionIndex` on a vote.
		//
		// `options` is still accepted so an older client keeps working; when it
		// is present the text is validated exactly as before and the count is
		// derived from it.
		optionCount := 0
		if opts, ok := meta["options"].([]any); ok {
			for _, o := range opts {
				s, ok := o.(string)
				if !ok || s == "" || len([]rune(s)) > 100 {
					httpx.Err(w, 400, "each option must be a non-empty string ≤ 100 chars")
					return
				}
			}
			optionCount = len(opts)
		} else if n, ok := chatsParseInt(meta["optionCount"]); ok {
			optionCount = int(n)
		}
		if optionCount < 2 || optionCount > 10 {
			httpx.Err(w, 400, "a poll needs between 2 and 10 options")
			return
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

	// ── ephemeral-body split (migration 099) ──────────────────────────
	// When bodies are on, the spine row carries NO ciphertext and only the
	// routing subset of meta; the payload and the private metadata go to
	// message_bodies inside the same transaction. When off, both of these are
	// the original values and the INSERT below is byte-identical to before.
	spineContent := content
	spineMetaParam := metaParam
	var bodyMetaPrivate map[string]any
	if bodiesEnabled() {
		pub, priv := chatsSplitMeta(meta)
		spineContent = nil
		spineMetaParam = chatsJSONParam(pub)
		bodyMetaPrivate = priv
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
			chatID, user.ID, msgType, spineContent, spineMetaParam, replyTo, clientID).Scan(row.dest()...)
		if db.NoRows(e) {
			if clientID == nil {
				return errors.New("insert returned no row")
			}
			// Retry of the same clientId (F7) — return the ORIGINAL row.
			//
			// Body-aware: the retry must echo back whatever content the message
			// actually has NOW. If the original body has already been delivered
			// and reclaimed, this correctly returns NULL rather than resurrecting
			// ciphertext the retention policy has removed — the retry is a
			// duplicate-suppression path, not a recovery path. Recovery is the
			// sender outbox's job, through re-body.
			e2 := tx.QueryRow(ctx,
				`SELECT `+chatsMsgSelBody("m")+` FROM messages m`+chatsBodyJoin+`
				  WHERE m.chat_id = $1 AND m.sender_id = $2 AND m.client_id = $3`,
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
		// The ephemeral half, in the SAME transaction. message_bodies has no FK
		// to messages (an FK would make DROP PARTITION validate on every drop),
		// so atomicity here is the only thing guaranteeing a spine row never
		// exists without its body.
		if bodiesEnabled() {
			if e := chatsInsertBody(ctx, tx, row.ID, chatID, row.CreatedAt, content, bodyMetaPrivate); e != nil {
				return e
			}
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
	// Put back what the spine no longer holds.
	//
	// With bodies on, the INSERT ... RETURNING above reads the SPINE row, whose
	// content is NULL and whose meta is the routing subset. Shipping that as-is
	// would be a visible regression in two places at once:
	//
	//   • the POST response is what replaces the sender's optimistic bubble —
	//     a null content blanks the message the user just sent
	//   • emitx.ChatNewMessage is the recipient's live delivery — a null content
	//     means every online recipient receives an empty message and only
	//     recovers it on a later delta sync
	//
	// Nothing needs to be re-read to fix this: `content` and `meta` are the
	// values this request just wrote. Echoing them keeps the wire byte-identical
	// to the pre-split behaviour, which is what lets already-deployed clients
	// keep working through the cutover.
	//
	// The duplicate path is deliberately excluded: it re-read the row through
	// chatsMsgSelBody, which already merged body+spine, so its values are
	// authoritative — and if that body has since been reclaimed, NULL is the
	// honest answer rather than a resurrection.
	if bodiesEnabled() && !duplicate {
		if s, ok := content.(string); ok {
			msg.Content = &s
		}
		if meta != nil {
			msg.Meta = meta
		}
	}
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
		// EVERY error status is acted on or REPORTED — none are read and dropped.
		//
		// Only DeviceNotRegistered was inspected. Expo returns per-ticket errors
		// for MismatchSenderId, InvalidCredentials, MessageTooBig and
		// MessageRateExceeded too, and all of those fell through this loop
		// silently: a project-level misconfiguration delivered nothing, forever,
		// and produced not one line to find it by. "Push notifications are not
		// working" is exactly the report that costs, because the server's own
		// logs said everything was fine.
		//
		// Note this is the ACCEPTANCE ticket, not delivery. Expo reports real
		// delivery outcomes on its receipts endpoint, which nothing here polls,
		// so a clean run below still does not prove a phone buzzed.
		other := map[string]int{}
		for idx, t := range tickets {
			if idx >= len(slice) || t.Status != "error" {
				continue
			}
			if t.Details.Error == "DeviceNotRegistered" {
				dead = append(dead, slice[idx])
				continue
			}
			reason := t.Details.Error
			if reason == "" {
				reason = "unspecified"
			}
			other[reason]++
		}
		for reason, n := range other {
			log.Printf("[push] Expo rejected %d chat notification(s): %s", n, reason)
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

	// Every predicate is qualified with the `m.` alias now that message_bodies
	// is joined in. It shares three column NAMES with messages — chat_id,
	// created_at and content — so an unqualified `chat_id = $1` is an ambiguous
	// reference and Postgres rejects the statement outright. Qualifying is not
	// style here; leaving one bare would 500 the chat-open path.
	args := []any{chatID}
	where := `m.chat_id = $1 AND (m.expires_at IS NULL OR m.expires_at > NOW())`
	order := "DESC"
	if after != 0 {
		args = append(args, after)
		where += fmt.Sprintf(" AND m.id > $%d", len(args))
		order = "ASC"
	} else if before != 0 {
		args = append(args, before)
		where += fmt.Sprintf(" AND m.id < $%d", len(args))
	}
	args = append(args, limit)

	out := []chatsPublicMsg{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT `+chatsMsgSelBody("m")+` FROM messages m`+chatsBodyJoin+` WHERE `+where+
			fmt.Sprintf(` ORDER BY m.id %s LIMIT $%d`, order, len(args)),
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

	// The edit guard is unchanged: sender-owned, not deleted, inside the
	// 15-minute window, enforced by the WHERE clause rather than by a check
	// beside it. Only WHERE the new text lands changes.
	//
	// EDITING MUST NOT EXTEND SERVER RETENTION. It cannot, structurally: the
	// body's deadline is derived from the message's immutable created_at, and
	// chatsInsertBody's ON CONFLICT updates content and meta_private while
	// deliberately leaving body_expires_at alone. A message created at 10:00 and
	// edited at 10:10 still expires at 13:00 — there is no code path that could
	// make it 13:10, which is stronger than remembering not to write one.
	var row chatsMsgRow
	var err error
	if bodiesEnabled() {
		err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
			e := tx.QueryRow(ctx,
				fmt.Sprintf(`UPDATE messages
				 SET edited_at = NOW()
				 WHERE id = $1 AND chat_id = $2 AND sender_id = $3 AND deleted_at IS NULL
				   AND created_at > NOW() - INTERVAL '%d milliseconds'
				 RETURNING `, chatsEditWindowMS)+chatsMsgCols,
				r.PathValue("msgId"), chatID, user.ID).Scan(row.dest()...)
			if e != nil {
				return e
			}
			// Re-body with the edited ciphertext. If the original body has
			// already been reclaimed this INSERTs a fresh one — correct, and
			// still bounded by the original created_at, so an edit can never buy
			// a message a second retention window.
			return chatsInsertBody(ctx, tx, row.ID, chatID, row.CreatedAt, content, nil)
		})
	} else {
		err = chatsQRow(ctx, user.ID,
			fmt.Sprintf(`UPDATE messages
			 SET content = $1, edited_at = NOW()
			 WHERE id = $2 AND chat_id = $3 AND sender_id = $4 AND deleted_at IS NULL
			   AND created_at > NOW() - INTERVAL '%d milliseconds'
			 RETURNING `, chatsEditWindowMS)+chatsMsgCols,
			[]any{content, r.PathValue("msgId"), chatID, user.ID}, row.dest()...)
	}
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
	// Same echo as the send path: the spine RETURNING carries no ciphertext, and
	// `message_edited` is how every open client learns the new text. Without
	// this the edit would blank the message on every device instead of changing
	// it.
	if bodiesEnabled() {
		msg.Content = &content
	}
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
	// Delete-for-everyone keeps its full 60-hour window — that window governs the
	// USER ACTION and the tombstone, not how long ciphertext survives.
	//
	// The two are now independent, which is the point of the split: at 15:00 a
	// user can still delete a message sent at 10:00 whose body was reclaimed at
	// 10:01. The tombstone is written to the durable spine exactly as before,
	// every device syncs it exactly as before, and there is simply no ciphertext
	// left to remove. When the body IS still present, it goes now rather than
	// waiting for the retention sweep — a user asking for deletion should not
	// have to wait out a TTL.
	var id int64
	var deletedAt time.Time
	var createdAt time.Time
	err := chatsQRow(ctx, user.ID,
		fmt.Sprintf(`UPDATE messages
		 SET deleted_at = NOW(), content = NULL, meta = NULL, type = 'system'
		 WHERE id = $1 AND chat_id = $2 AND sender_id = $3 AND deleted_at IS NULL
		   AND created_at > NOW() - INTERVAL '%d milliseconds'
		 RETURNING id, chat_id, deleted_at, created_at`, chatsRevokeWindowMS),
		[]any{r.PathValue("msgId"), chatID, user.ID}, &id, &chatID, &deletedAt, &createdAt)
	if err == nil && bodiesEnabled() {
		// Best-effort and deliberately non-fatal: the tombstone is already
		// committed and is what the product guarantees. A body that survives
		// this call is still bounded by its own 3-hour ceiling, so failing the
		// user's delete because a cleanup query errored would trade a real
		// guarantee for a cosmetic one.
		if e := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
			return chatsDeleteBody(ctx, tx, id, createdAt)
		}); e != nil {
			log.Printf("[messages DELETE] body cleanup id=%d: %v", id, e)
		}
	}
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
	// Record the pointer for THIS DEVICE as well as the account.
	//
	// chat_members.last_delivered_message_id is per (chat, user), so on a
	// multi-device account the first device to ack advances it for everyone —
	// and delete-on-delivery would then null a body a second device never
	// received. The per-device row (migration 078) is what lets the sweep wait
	// for every active install. Best-effort and non-fatal: a missing X-Device-Id
	// (older client) simply leaves no row, and the sweep treats an account with
	// no device rows as "unknown", falling back to the account-level pointer.
	if deviceID := strings.TrimSpace(r.Header.Get("X-Device-Id")); deviceID != "" {
		if _, e := db.SysPool.Exec(ctx,
			`INSERT INTO chat_device_delivery (chat_id, user_id, device_id, last_delivered_message_id)
			      VALUES ($1, $2, $3, $4)
			 ON CONFLICT (chat_id, user_id, device_id) DO UPDATE
			    SET last_delivered_message_id = GREATEST(chat_device_delivery.last_delivered_message_id, EXCLUDED.last_delivered_message_id),
			        updated_at = NOW()`,
			chatID, user.ID, deviceID, id); e != nil {
			log.Printf("[delivered POST] device pointer: %v", e)
		}
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
	// trigger from migration 070, which serialises on the group row. An
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
	// 'guest' and 'moderator' join the accepted set for typed groups only: an
	// untyped legacy group has no semantics for either and must keep its
	// original two-role world.
	validRole := role == "admin" || role == "member" ||
		((role == "guest" || role == groups.RoleModerator) && mem.isTypedGroup())
	if !validRole {
		if mem.isTypedGroup() {
			httpx.Err(w, 400, "role must be 'admin', 'moderator', 'member' or 'guest'")
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
	// A group photo is reference-counted, not aged out. The sweep will never
	// reclaim it (purpose='group'), so the ONLY thing that can retire a
	// superseded one is this handler — see attachment_lifecycle.go.
	oldGroupPhoto, newGroupPhoto := "", ""
	changingGroupPhoto := false
	if s, ok := b["photoURL"].(string); ok {
		if !adminGroupGate("Direct chats use peer photo") {
			return
		}
		p := truncRunes(strings.TrimSpace(s), 1024)
		var v *string
		if p != "" {
			v = &p
		}
		// Verify BEFORE the update, and classify server-side as 'group' so an
		// old client that sends no `purpose` still lands in the right class.
		// A foreign or purged id is refused with the existing photo intact,
		// which also stops a member pointing the group at someone else's object.
		if p != "" {
			if e := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
				return attVerifyOwned(ctx, tx, p, user.ID, "group")
			}); e != nil {
				httpx.Err(w, 400, "That photo is not available")
				return
			}
		}
		if err := chatsQRow(ctx, user.ID,
			`SELECT COALESCE(photo_url, '') FROM chats WHERE id = $1`,
			[]any{chatID}, &oldGroupPhoto); err != nil && !db.NoRows(err) {
			log.Printf("[chats PATCH] read old photo: %v", err)
		}
		newGroupPhoto, changingGroupPhoto = p, true
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

	// ── Groups & Circles metadata (migration 070) ──
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
	// Reference moved and committed — the superseded object is now unreferenced
	// and safe to reclaim. After the update, never before: a failure above must
	// leave the old photo both referenced and present.
	if changingGroupPhoto && oldGroupPhoto != "" && oldGroupPhoto != newGroupPhoto {
		attRetire(ctx, oldGroupPhoto)
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
	// The socket event above only reaches someone who has THIS chat open right
	// now. Everyone else — app backgrounded, killed, or simply on another
	// screen — learned nothing, which for a "your content was captured" notice
	// is the case that matters most: you are least likely to be staring at the
	// chat at the moment somebody screenshots it.
	workx.Submit(func() { chatsSendScreenshotPush(chatID, user.ID) })
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// chatsSendScreenshotPush wakes the members who asked to be told.
//
// Audience is NOT everyone in the chat: only members whose own screenshot_mode
// requests a notice ('block' or 'allow_notify'). Someone who set 'allow' or
// 'block_silent' deliberately opted out of being pinged, and a security notice
// that ignores the setting meant to control it is just noise.
//
// Mute is deliberately NOT honoured. Muting a chat silences a CONVERSATION;
// this is a notice that someone captured your content, and the person who
// muted a chat is exactly the person not watching it. Flip the WHERE clause if
// that ever proves too loud in practice.
func chatsSendScreenshotPush(chatID, capturerID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	rows, err := db.SysPool.Query(ctx,
		`SELECT d.push_token, d.fcm_token
		   FROM chat_members cm
		   JOIN devices d ON d.user_id = cm.user_id
		  WHERE cm.chat_id = $1
		    AND cm.user_id <> $2
		    AND cm.left_at IS NULL
		    AND COALESCE(cm.screenshot_mode,'block') IN ('block','allow_notify')
		    AND NOT EXISTS (
		      SELECT 1 FROM user_blocks ub
		       WHERE ub.blocker_id = cm.user_id AND ub.blocked_id = $2
		    )`, chatID, capturerID)
	if err != nil {
		log.Printf("[screenshot push] %v", err)
		return
	}
	fcmTokens := map[string]bool{}
	expoTokens := []string{}
	for rows.Next() {
		var pushToken, fcmToken *string
		if err := rows.Scan(&pushToken, &fcmToken); err != nil {
			rows.Close()
			log.Printf("[screenshot push] %v", err)
			return
		}
		if fcmToken != nil && *fcmToken != "" {
			fcmTokens[*fcmToken] = true
		} else if pushToken != nil && *pushToken != "" {
			expoTokens = append(expoTokens, *pushToken)
		}
	}
	rows.Close()

	// Data-only for native devices, exactly like the message doorbell: the body
	// carries no chat name and no capturer name, so nothing readable transits
	// Google. The client resolves the title locally and suppresses the
	// notification when that chat is already on screen.
	if len(fcmTokens) > 0 {
		list := make([]string, 0, len(fcmTokens))
		for t := range fcmTokens {
			list = append(list, t)
		}
		res := fcm.SendCallMessage(list,
			map[string]string{"type": "screenshot", "chatId": chatID}, 60_000)
		if len(res.Dead) > 0 {
			if _, err := db.Pool.Exec(ctx,
				`UPDATE devices SET fcm_token = NULL WHERE fcm_token = ANY($1::text[])`, res.Dead); err != nil {
				log.Printf("[screenshot push] %v", err)
			}
		}
	}
	if len(expoTokens) > 0 {
		chatsSendExpoPush(ctx, expoTokens, "VaultChat",
			"Someone took a screenshot of your chat",
			map[string]any{"chatId": chatID, "type": "screenshot"}, "default")
	}
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

	// Leaving is always your own right; removing someone else needs both the
	// permission AND the rank.
	if !isSelf {
		if !mem.can(groups.PermRemoveMembers) {
			httpx.Err(w, 403, "You do not have permission to remove members")
			return
		}
		var targetRole string
		var leftAt *time.Time
		err := chatsQRow(ctx, user.ID,
			`SELECT role, left_at FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
			[]any{chatID, target}, &targetRole, &leftAt)
		if db.NoRows(err) || (err == nil && leftAt != nil) {
			httpx.Err(w, 404, "They are not in this group")
			return
		}
		if err != nil {
			log.Printf("[members DELETE] role: %v", err)
			httpx.Err(w, 500, "Failed to remove member")
			return
		}
		// The permission alone is not enough. Migration 069 gives moderators
		// remove_members, so without this a moderator could remove the OWNER and
		// orphan the group, and two admins could remove each other in a race.
		if !groups.CanRemoveMember(mem.Role, targetRole) {
			httpx.Err(w, 403, "You cannot remove someone at or above your own role")
			return
		}
	}

	if err := chatsExecU(ctx, user.ID,
		`UPDATE chat_members SET left_at = NOW()
		 WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		chatID, target); err != nil {
		log.Printf("[members DELETE] %v", err)
		httpx.Err(w, 500, "Failed to remove member")
		return
	}

	// A REMOVAL starts a cooldown; leaving does not. Without this, being removed
	// only stops someone until anyone with invite rights taps once — which makes
	// the removal a formality rather than a decision. Recorded after the fact and
	// best-effort: a member who cannot be removed because the cooldown write
	// hiccuped is worse than a cooldown that was not applied.
	var cooldownUntil *time.Time
	if !isSelf {
		cooldownUntil = chatsRecordRemoval(ctx, user.ID, chatID, target)
	}

	realtime.InvalidateChatMembers(ctx, chatID) // P2.2: fresh roster before the fan-out
	event := "member_removed"
	if isSelf {
		event = "member_left"
	}
	chatsAudit(ctx, user.ID, chatID, event, &target, nil)
	emitx.ChatEvent(chatID, event, map[string]any{"userId": target, "by": user.ID})
	out := map[string]any{"ok": true}
	if cooldownUntil != nil {
		out["cooldownUntil"] = httpx.JSTime(*cooldownUntil)
	}
	httpx.JSON(w, 200, out)
}

// chatsRecordRemoval writes the group_removals row that gates re-invitation,
// returning when the removed member may return (nil = immediately).
//
// The WINDOW comes from group_type_config.removal_cooldown_hours (migration
// 070), not from a constant here, so it can be tuned per kind of group without
// a release. Zero — the default for every existing type — means no cooldown, so
// this changes nothing until somebody sets one.
//
// Best-effort by design, like the audit log: it runs after the member is
// already out, and a failure is logged rather than surfaced.
func chatsRecordRemoval(ctx context.Context, actorID, chatID, target string) *time.Time {
	var until *time.Time
	err := chatsQRow(ctx, actorID,
		`INSERT INTO group_removals (chat_id, user_id, removed_by, removed_at, cooldown_until)
		 SELECT $1, $2, $3, NOW(),
		        CASE WHEN COALESCE(g.removal_cooldown_hours, 0) > 0
		             THEN NOW() + make_interval(hours => g.removal_cooldown_hours)
		             ELSE NULL END
		   FROM chats c
		   LEFT JOIN group_type_config g ON g.group_type = c.group_type
		  WHERE c.id = $1
		 ON CONFLICT (chat_id, user_id) DO UPDATE
		    SET removed_by = EXCLUDED.removed_by,
		        removed_at = EXCLUDED.removed_at,
		        cooldown_until = EXCLUDED.cooldown_until
		 RETURNING cooldown_until`,
		[]any{chatID, target, actorID}, &until)
	if err != nil && !db.NoRows(err) {
		log.Printf("[members DELETE] cooldown record on %s: %v", chatID, err)
	}
	return until
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
	// Validate the index against the option COUNT, not the option TEXT.
	//
	// This read hits the spine, where poll options no longer live — their text
	// moved into the ephemeral body with the rest of the private metadata, so
	// the server stops holding what the choices SAY. What it still needs is the
	// single number that makes `0 <= index < n` enforceable, and chatsSplitMeta
	// derives that at write time from whatever the client already sends.
	//
	// The len(options) fallback keeps every pre-split message votable: those
	// rows still carry the full options array on the spine and have no
	// optionCount. Both shapes work, so no backfill is required and voting on
	// old polls is unaffected.
	//
	// Net effect: a poll remains votable for its whole life — the count outlives
	// the body by design — while the option text becomes as ephemeral as any
	// other message content.
	optionCount := int64(0)
	if n, ok := chatsParseInt(metaMap["optionCount"]); ok {
		optionCount = n
	} else if options, ok := metaMap["options"].([]any); ok {
		optionCount = int64(len(options))
	}
	if optionIndex >= optionCount {
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
