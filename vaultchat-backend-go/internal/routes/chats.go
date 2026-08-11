// chats.go ← routes/chats.js — the messaging core. Same endpoints, SQL,
// error strings, response shapes (BIGINT ids serialize as strings, exactly
// like node-pg). Broadcasts bridge to Node via emitx.ChatNewMessage /
// emitx.ChatEvent (POST /internal/chat-event → identical kafka-or-fanout
// path). Which queries run under RLS (db.WithUser) vs the plain pool
// (db.Pool) mirrors Node's req.dbQuery/req.dbTx vs db.query exactly.
package routes

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/groups"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/realtime"
	"vaultchat/backend-go/internal/vault"
)

const (
	chatsEditWindowMS   = 15 * 60 * 1000
	chatsRevokeWindowMS = 60 * 60 * 60 * 1000 // WhatsApp parity: 2 days 12 hours
	chatsMaxGroupSize   = 256
	chatsDefaultPage    = 50
	chatsMaxPage        = 200
)

func RegisterChats(mux *http.ServeMux) {
	// Top-level + literal-2nd-segment routes go on the main mux. The
	// {id}-family (3+ segments under /chats/{id}/…) goes on a private mux
	// forwarded via a subtree pattern. Go 1.22's ServeMux otherwise panics:
	// /chats/common/{userId} and /chats/join/{code} (literal seg-2, wildcard
	// seg-3) are un-orderable against /chats/{id}/join-requests etc. Express
	// resolved this by registration order; real requests never collide (an id
	// is a UUID, never "common"/"join"), so the specific literal routes win
	// on the main mux and the subtree serves the rest — identical behavior.
	mux.HandleFunc("GET /chats/delta", httpx.RequireAuth(chatsDelta))
	mux.HandleFunc("GET /chats", httpx.RequireAuth(chatsList))
	mux.HandleFunc("POST /chats", httpx.RequireAuth(chatsCreate))
	mux.HandleFunc("POST /chats/join/{code}", httpx.RequireAuth(chatsJoinByCode))
	mux.HandleFunc("GET /chats/search", httpx.RequireAuth(chatsSearch))
	mux.HandleFunc("GET /chats/common/{userId}", httpx.RequireAuth(chatsCommon))
	mux.HandleFunc("GET /chats/{id}", httpx.RequireAuth(chatsGet))
	mux.HandleFunc("PATCH /chats/{id}", httpx.RequireAuth(chatsPatch))

	id := http.NewServeMux()
	id.HandleFunc("GET /chats/{id}/join-requests", httpx.RequireAuth(chatsJoinRequestsGet))
	id.HandleFunc("POST /chats/{id}/join-requests/{userId}/approve", httpx.RequireAuth(chatsJoinRequestApprove))
	id.HandleFunc("DELETE /chats/{id}/join-requests/{userId}", httpx.RequireAuth(chatsJoinRequestReject))
	id.HandleFunc("POST /chats/{id}/messages", httpx.RequireAuth(chatsMessagePost))
	id.HandleFunc("GET /chats/{id}/messages", httpx.RequireAuth(chatsMessagesGet))
	id.HandleFunc("GET /chats/{id}/messages/search", httpx.RequireAuth(chatsInChatSearch))
	id.HandleFunc("PATCH /chats/{id}/messages/{msgId}", httpx.RequireAuth(chatsMessagePatch))
	id.HandleFunc("DELETE /chats/{id}/messages/{msgId}", httpx.RequireAuth(chatsMessageDelete))
	id.HandleFunc("POST /chats/{id}/delivered", httpx.RequireAuth(chatsDelivered))
	id.HandleFunc("POST /chats/{id}/read", httpx.RequireAuth(chatsRead))
	id.HandleFunc("POST /chats/{id}/members", httpx.RequireAuth(chatsMembersAdd))
	id.HandleFunc("PATCH /chats/{id}/members/{userId}/role", httpx.RequireAuth(chatsMemberRole))
	id.HandleFunc("POST /chats/{id}/invite-links", httpx.RequireAuth(chatsInviteCreate))
	id.HandleFunc("GET /chats/{id}/invite-links", httpx.RequireAuth(chatsInviteList))
	id.HandleFunc("DELETE /chats/{id}/invite-links/{linkId}", httpx.RequireAuth(chatsInviteRevoke))
	id.HandleFunc("POST /chats/{id}/pin", httpx.RequireAuth(chatsPin))
	id.HandleFunc("POST /chats/{id}/archive", httpx.RequireAuth(chatsArchive))
	id.HandleFunc("PATCH /chats/{id}/hidden", httpx.RequireAuth(chatsHidden))
	id.HandleFunc("PATCH /chats/{id}/screenshot-mode", httpx.RequireAuth(chatsScreenshotMode))
	id.HandleFunc("POST /chats/{id}/screenshot-captured", httpx.RequireAuth(chatsScreenshotCaptured))
	id.HandleFunc("PATCH /chats/{id}/vanish-mode", httpx.RequireAuth(chatsVanishMode))
	id.HandleFunc("POST /chats/{id}/mute", httpx.RequireAuth(chatsMute))
	id.HandleFunc("PATCH /chats/{id}/notif-sound", httpx.RequireAuth(chatsNotifSound))
	id.HandleFunc("DELETE /chats/{id}/members/{userId}", httpx.RequireAuth(chatsMemberRemove))
	id.HandleFunc("POST /chats/{id}/messages/{msgId}/vote", httpx.RequireAuth(chatsPollVote))
	id.HandleFunc("DELETE /chats/{id}/messages/{msgId}/vote/{optionIndex}", httpx.RequireAuth(chatsPollUnvote))
	id.HandleFunc("GET /chats/{id}/messages/{msgId}/votes", httpx.RequireAuth(chatsPollVotes))
	id.HandleFunc("GET /chats/{id}/poll-votes", httpx.RequireAuth(chatsPollVotesBulk))
	id.HandleFunc("POST /chats/{id}/pin-message", httpx.RequireAuth(chatsPinMessage))
	id.HandleFunc("POST /chats/{id}/sender-keys", httpx.RequireAuth(chatsSenderKeysPost))
	id.HandleFunc("GET /chats/{id}/sender-keys", httpx.RequireAuth(chatsSenderKeysGet))
	RegisterChatInvitationsOnID(id) // Groups & Circles per-invitee invitations
	RegisterChatMembershipOnID(id)  // Groups & Circles in-app membership (v2)
	RegisterChatCalendarOnID(id)    // Groups & Circles shared calendar
	RegisterSpaceRosterOnID(id)     // Spaces & Operations roster + visibility links
	RegisterSpaceRunsOnID(id)       // Spaces & Operations run engine
	RegisterSpaceOpsOnID(id)        // Spaces & Operations incidents, passes, shifts
	RegisterSpaceWorkforceOnID(id)  // Spaces & Operations attendance, leave, tasks, dashboard
	RegisterSpaceDevicesOnID(id)    // Spaces & Operations devices + theft protection
	mux.Handle("/chats/{id}/", id)  // subtree forward; `id` re-matches the full path
}

// ─── RLS plumbing (Node req.dbQuery = one withUser tx per query) ───────

func chatsQRow(ctx context.Context, uid, q string, args []any, dest ...any) error {
	return db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, q, args...).Scan(dest...)
	})
}

func chatsExecU(ctx context.Context, uid, q string, args ...any) error {
	return db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, q, args...)
		return err
	})
}

// chatsExecAffected is chatsExecU for writes whose guard lives in the SQL —
// an `INSERT ... SELECT ... WHERE EXISTS` that legitimately matches nothing.
//
// chatsExecU discards the command tag, so "wrote one row" and "the WHERE EXISTS
// rejected it" are indistinguishable, and the handler answers 200 either way.
// That turned a mistyped roster id into a link that reported success and did
// nothing — the parent then saw no child, forever, with nothing to look at.
// Callers that guard in SQL must use this and check the count.
func chatsExecAffected(ctx context.Context, uid, q string, args ...any) (int64, error) {
	var n int64
	err := db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, q, args...)
		n = tag.RowsAffected()
		return err
	})
	return n, err
}

func chatsQueryU(ctx context.Context, uid, q string, args []any, each func(pgx.Rows) error) error {
	return db.WithUser(ctx, uid, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, q, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := each(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	})
}

// ─── JS coercion helpers ───────────────────────────────────────────────

// chatsTruthy mirrors JS truthiness for JSON-decoded values.
func chatsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	}
	return true // objects/arrays
}

// chatsParseInt mirrors parseInt(v, 10) over a JSON any (number or string).
// false = NaN.
func chatsParseInt(v any) (int64, bool) {
	switch t := v.(type) {
	case float64:
		return int64(t), true
	case string:
		return httpx.ParseIntPrefix(t)
	}
	return 0, false
}

// ─── phone hashing (must stay in sync with routes/user.js) ─────────────

var chatsNonDigitRe = regexp.MustCompile(`\D`)

func chatsNormalizePhone(raw string) string {
	d := chatsNonDigitRe.ReplaceAllString(raw, "")
	if d == "" {
		return ""
	}
	if len(d) == 10 {
		d = "91" + d
	}
	return d
}

func chatsHashPhone(raw string) string {
	norm := chatsNormalizePhone(raw)
	if norm == "" {
		return ""
	}
	h, err := vault.DiscoveryHash(userSha256Hex(norm))
	if err != nil {
		return ""
	}
	return h
}

// ─── message row + serializer (publicMessage) ──────────────────────────

const chatsMsgCols = `id, chat_id, sender_id, type, content, meta, reply_to_id, edited_at, deleted_at, created_at, expires_at, vanish_after_read`

type chatsMsgRow struct {
	ID              int64
	ChatID          string
	SenderID        string
	Type            string
	Content         *string
	Meta            any
	ReplyToID       *int64
	EditedAt        *time.Time
	DeletedAt       *time.Time
	CreatedAt       time.Time
	ExpiresAt       *time.Time
	VanishAfterRead bool
}

func (m *chatsMsgRow) dest() []any {
	return []any{&m.ID, &m.ChatID, &m.SenderID, &m.Type, &m.Content, &m.Meta,
		&m.ReplyToID, &m.EditedAt, &m.DeletedAt, &m.CreatedAt, &m.ExpiresAt, &m.VanishAfterRead}
}

// chatsPublicMsg mirrors publicMessage: BIGINT ids as strings (node-pg),
// JSONB meta re-emitted as-is, timestamps as JS ISO strings.
type chatsPublicMsg struct {
	ID              string        `json:"id"`
	ChatID          string        `json:"chatId"`
	SenderID        string        `json:"senderId"`
	Type            string        `json:"type"`
	Content         *string       `json:"content"`
	Meta            any           `json:"meta"`
	ReplyToID       *string       `json:"replyToId"`
	EditedAt        *httpx.JSTime `json:"editedAt"`
	DeletedAt       *httpx.JSTime `json:"deletedAt"`
	CreatedAt       httpx.JSTime  `json:"createdAt"`
	ExpiresAt       *httpx.JSTime `json:"expiresAt"`
	VanishAfterRead bool          `json:"vanishAfterRead"`
}

func (m chatsMsgRow) public() chatsPublicMsg {
	return chatsPublicMsg{
		ID: fmt.Sprintf("%d", m.ID), ChatID: m.ChatID, SenderID: m.SenderID,
		Type: m.Type, Content: m.Content, Meta: m.Meta, ReplyToID: userBigStr(m.ReplyToID),
		EditedAt: httpx.JST(m.EditedAt), DeletedAt: httpx.JST(m.DeletedAt),
		CreatedAt: httpx.JSTime(m.CreatedAt), ExpiresAt: httpx.JST(m.ExpiresAt),
		VanishAfterRead: m.VanishAfterRead,
	}
}

// ─── membership (loadChatMembership) ───────────────────────────────────

type chatsMem struct {
	Role              string
	JoinedAt          time.Time
	LastReadMessageID *int64
	Muted             bool
	LeftAt            *time.Time
	Hidden            bool
	ScreenshotMode    *string
	VanishMode        bool
	ChatType          string
	SendPolicy        *string
	SlowModeSeconds   int64
	MediaPolicy       *string
	AddMembersPolicy  *string
	AntiSpamLinks     bool
	ApproveMembers    bool

	// ── membership v2 (migration 073) ──
	// How many gates stand between an invitation and membership. Read through
	// invites.NormalizeMode, never raw: an unrecognised value must resolve to
	// the strictest mode rather than the loosest.
	ApprovalModeRaw string

	// ── Groups & Circles (migration 070) ──
	// GroupType is NULL for every group created before that migration; those
	// keep the legacy admin-or-nothing rule. See can().
	GroupType  *string
	MaxMembers *int32
	// The three permission layers, raw as stored. Resolution lives in
	// internal/groups so the client mirror and the server cannot drift.
	typeDefaults   map[string][]string
	groupOverrides map[string][]string
	memberGrants   []string
	memberGrantSet bool

	// ── Spaces & Operations (migration 084) ──
	// RoleKey is the member's display role ("driver", "parent"); NULL for every
	// member created before 084, which resolves exactly as it does today.
	RoleKey     *string
	roleCatalog []groups.RoleDef
}

func (m *chatsMem) isAdmin() bool { return m.Role == "admin" || m.Role == "owner" }

// isTypedGroup reports whether this chat participates in the permission model.
func (m *chatsMem) isTypedGroup() bool { return m.GroupType != nil && *m.GroupType != "" }

// roleKey returns the member's display role key, or "".
func (m *chatsMem) roleKey() string {
	if m.RoleKey == nil {
		return ""
	}
	return *m.RoleKey
}

// perms resolves this member's effective permission set.
func (m *chatsMem) perms() groups.Set {
	catalog, catalogSet := groups.CatalogLayer(m.roleCatalog, m.roleKey(), m.Role)
	return groups.Resolve(m.Role, groups.Layers{
		TypeDefault:      m.typeDefaults,
		GroupOverride:    m.groupOverrides,
		RoleCatalog:      catalog,
		RoleCatalogIsSet: catalogSet,
		MemberGrant:      m.memberGrants,
		MemberGrantIsSet: m.memberGrantSet,
	})
}

// can reports whether this member holds p.
//
// BACKWARD COMPATIBILITY, deliberately: a chat with no group_type has no
// permission layers, so it keeps the EXACT pre-existing rule — owners and
// admins may act, everyone else may not. Every group that existed before
// migration 070 therefore behaves identically after it, and the new model only
// governs groups that opted into a type.
func (m *chatsMem) can(p groups.Permission) bool {
	if !m.isTypedGroup() {
		return m.isAdmin()
	}
	return m.perms().Has(p)
}

func chatsLoadMem(ctx context.Context, uid, chatID string) (*chatsMem, error) {
	m := &chatsMem{}
	var overridesRaw, grantsRaw, defaultsRaw, catalogRaw []byte
	err := chatsQRow(ctx, uid,
		`SELECT cm.role, cm.joined_at, cm.last_read_message_id, cm.muted, cm.left_at,
		        cm.hidden, cm.screenshot_mode, cm.vanish_mode,
		        c.type AS chat_type, c.send_policy, c.slow_mode_seconds,
		        c.media_policy, c.add_members_policy, c.anti_spam_links, c.approve_members,
		        c.approval_mode,
		        c.group_type, g.max_members, c.permission_overrides, cm.permission_grants,
		        g.default_permissions, cm.role_key, g.role_catalog
		 FROM chat_members cm
		 JOIN chats c ON c.id = cm.chat_id
		 LEFT JOIN group_type_config g ON g.group_type = c.group_type
		 WHERE cm.chat_id = $1 AND cm.user_id = $2`,
		[]any{chatID, uid},
		&m.Role, &m.JoinedAt, &m.LastReadMessageID, &m.Muted, &m.LeftAt,
		&m.Hidden, &m.ScreenshotMode, &m.VanishMode,
		&m.ChatType, &m.SendPolicy, &m.SlowModeSeconds,
		&m.MediaPolicy, &m.AddMembersPolicy, &m.AntiSpamLinks, &m.ApproveMembers,
		&m.ApprovalModeRaw,
		&m.GroupType, &m.MaxMembers, &overridesRaw, &grantsRaw, &defaultsRaw,
		&m.RoleKey, &catalogRaw)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.typeDefaults = chatsPermMap(defaultsRaw)
	m.groupOverrides = chatsPermMap(overridesRaw)
	m.memberGrants, m.memberGrantSet = chatsPermList(grantsRaw)
	m.roleCatalog = chatsRoleCatalog(catalogRaw)
	return m, nil
}

// chatsRoleCatalog decodes a type's role catalog. A catalog that fails to parse
// yields nil — the layer is absent and the rank default applies — because a
// permission layer that cannot be READ must never be a layer that GRANTS. The
// log line is loud because this state means someone hand-edited the config.
func chatsRoleCatalog(raw []byte) []groups.RoleDef {
	defs, err := groups.ParseRoleCatalog(raw)
	if err != nil {
		log.Printf("[chats perms] bad role catalog, ignoring layer: %v", err)
		return nil
	}
	return defs
}

// chatsPermMap decodes a role→permissions JSONB column. Malformed JSON yields
// nil (layer absent) rather than an error: a permission layer that cannot be
// read must fall through to the layer beneath, never grant anything.
func chatsPermMap(raw []byte) map[string][]string {
	if len(raw) == 0 {
		return nil
	}
	var out map[string][]string
	if err := json.Unmarshal(raw, &out); err != nil {
		log.Printf("[chats perms] bad permission map, ignoring layer: %v", err)
		return nil
	}
	return out
}

// chatsPermList decodes a per-member grant. The bool distinguishes "no grant
// row" (fall through) from "granted nothing" (explicit revoke) — collapsing
// those would make it impossible to strip one member's rights.
func chatsPermList(raw []byte) ([]string, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		log.Printf("[chats perms] bad permission grant, ignoring: %v", err)
		return nil, false
	}
	return out, true
}

// chatsRequireMem loads membership and writes the route's error responses
// itself; nil = response already sent. notMember is that route's exact 403
// (or 404) text, errMsg the route's catch-all 500 string.
func chatsRequireMem(w http.ResponseWriter, r *http.Request, notMemberStatus int, notMember, errMsg string) *chatsMem {
	user := httpx.UserFrom(r)
	mem, err := chatsLoadMem(r.Context(), user.ID, r.PathValue("id"))
	if err != nil {
		httpx.Err(w, 500, errMsg)
		return nil
	}
	if mem == nil || mem.LeftAt != nil {
		httpx.Err(w, notMemberStatus, notMember)
		return nil
	}
	return mem
}

// ─── Cold-sync guard ────────────────────────────────────────────────────
//
// `since=0` on /chats/delta is a full-history export — the cursor matches every
// message the caller can see, and the client pages until it has all of them. A
// fresh install has a legitimate reason to ask; a stolen token issues the exact
// same request. The server cannot tell them apart from the request alone, so it
// uses the one signal it can keep: whether this INSTALL has synced before
// (user_sync_devices, migration 072).
//
// An unrecognised device gets a bounded window of recent history rather than
// everything. The client pages forward from that floor, so the cap bounds the
// whole cold sync, not merely the first page.
//
// Compatibility: clients that predate the X-Device-Id header send no device id.
// Those are recorded and logged but NEVER capped — hardening must not break the
// APKs already in the field. COLD_SYNC_WARN_ONLY keeps even identified devices
// uncapped until the new build has adoption.

// coldSyncMaxMessages is the recent-history window granted to an unrecognised
// device. 0 disables the cap entirely.
func coldSyncMaxMessages() int64 {
	v, err := strconv.ParseInt(os.Getenv("COLD_SYNC_MAX_MESSAGES"), 10, 64)
	if err != nil || v < 0 {
		return 2000
	}
	return v
}

// coldSyncWarnOnly reports the event without capping. Defaults to TRUE so that
// deploying this code changes no client's behaviour until it is switched off.
func coldSyncWarnOnly() bool {
	return os.Getenv("COLD_SYNC_WARN_ONLY") != "false"
}

// noteSyncDevice upserts the device row and reports whether this (user, device)
// pair had been seen BEFORE this call. A blank deviceID is never "known".
func noteSyncDevice(ctx context.Context, userID, deviceID string, cold bool) (known bool) {
	if deviceID == "" {
		return false
	}
	// xmax = 0 marks a freshly INSERTed row; non-zero means the row already
	// existed and was UPDATEd — i.e. we had seen this install before.
	var inserted bool
	err := db.SysPool.QueryRow(ctx,
		`INSERT INTO user_sync_devices (user_id, device_id, last_cold_sync_at, cold_sync_count)
		      VALUES ($1, $2, CASE WHEN $3 THEN NOW() END, CASE WHEN $3 THEN 1 ELSE 0 END)
		 ON CONFLICT (user_id, device_id) DO UPDATE
		    SET last_sync_at      = NOW(),
		        last_cold_sync_at = CASE WHEN $3 THEN NOW() ELSE user_sync_devices.last_cold_sync_at END,
		        cold_sync_count   = user_sync_devices.cold_sync_count + CASE WHEN $3 THEN 1 ELSE 0 END
		 RETURNING (xmax = 0)`,
		userID, deviceID, cold).Scan(&inserted)
	if err != nil {
		// Never fail a sync because the audit write failed — but do not silently
		// grant full history either: an unverifiable device is treated as unknown.
		log.Printf("[chats/delta] sync-device upsert failed: %v", err)
		return false
	}
	return !inserted
}

// coldSyncFloor returns the message id just below the newest `limit` messages
// visible to the user, so `m.id > floor` yields exactly that many rows. Returns
// 0 when the user has fewer messages than the cap (nothing to bound).
func coldSyncFloor(ctx context.Context, userID string, limit int64) int64 {
	var floor int64
	err := db.SysPool.QueryRow(ctx,
		`SELECT m.id FROM messages m
		   JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1 AND cm.left_at IS NULL
		  WHERE m.expires_at IS NULL OR m.expires_at > NOW()
		  ORDER BY m.id DESC
		  OFFSET $2 LIMIT 1`,
		userID, limit).Scan(&floor)
	if err != nil {
		return 0 // fewer messages than the cap, or unreadable — do not bound
	}
	return floor
}

// ─── GET /chats/delta — forward catch-up (plain pool, like Node db.query) ──

func chatsDelta(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	q := r.URL.Query()
	since, ok := httpx.ParseIntPrefix(q.Get("since"))
	if !ok || since < 0 {
		since = 0
	}

	// Cold start (since=0): bound an unrecognised install to recent history.
	if since == 0 {
		deviceID := strings.TrimSpace(r.Header.Get("X-Device-Id"))
		if !noteSyncDevice(ctx, user.ID, deviceID, true) {
			capN := coldSyncMaxMessages()
			enforce := capN > 0 && deviceID != "" && !coldSyncWarnOnly()
			if floor := coldSyncFloor(ctx, user.ID, capN); enforce && floor > 0 {
				since = floor
				log.Printf("[chats/delta] cold sync capped to %d msg(s) for user=%s device=%s", capN, user.ID, deviceID)
			} else {
				log.Printf("[chats/delta] cold sync (uncapped) user=%s device=%q warnOnly=%v", user.ID, deviceID, coldSyncWarnOnly())
			}
		}
	} else if deviceID := strings.TrimSpace(r.Header.Get("X-Device-Id")); deviceID != "" {
		noteSyncDevice(ctx, user.ID, deviceID, false)
	}
	limit, ok := httpx.ParseIntPrefix(q.Get("limit"))
	if !ok || limit == 0 {
		limit = 200
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := db.SysPool.Query(ctx,
		`SELECT `+chatsMsgSel("m")+` FROM messages m
		   JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1 AND cm.left_at IS NULL
		  WHERE m.id > $2 AND (m.expires_at IS NULL OR m.expires_at > NOW())
		  ORDER BY m.id ASC LIMIT $3`,
		user.ID, since, limit)
	if err != nil {
		log.Printf("[chats/delta] %v", err)
		httpx.Err(w, 500, "delta failed")
		return
	}
	messages := []chatsPublicMsg{}
	nextSince := since
	if err := chatsCollectMsgs(rows, &messages); err != nil {
		log.Printf("[chats/delta] %v", err)
		httpx.Err(w, 500, "delta failed")
		return
	}
	if len(messages) > 0 {
		// nextSince = Number(last row id)
		if n, ok := httpx.ParseIntPrefix(messages[len(messages)-1].ID); ok {
			nextSince = n
		}
	}

	var serverTime time.Time
	// Plain pool: reading the clock touches no table, so there is nothing for
	// RLS to gate. Marking it SysPool would be a false claim — that label means
	// "this must see rows no user may see", and a reviewer should be able to
	// trust it.
	if err := db.Pool.QueryRow(ctx, `SELECT NOW() AS now`).Scan(&serverTime); err != nil {
		log.Printf("[chats/delta] %v", err)
		httpx.Err(w, 500, "delta failed")
		return
	}
	mutations := []chatsPublicMsg{}
	if raw := q.Get("mutatedSince"); raw != "" {
		if mutatedSince, ok := userParseJSDate(raw); ok {
			mrows, err := db.SysPool.Query(ctx,
				`SELECT `+chatsMsgSel("m")+` FROM messages m
				   JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1 AND cm.left_at IS NULL
				  WHERE (m.edited_at > $2 OR m.deleted_at > $2) AND m.id <= $3
				  ORDER BY GREATEST(COALESCE(m.edited_at, 'epoch'), COALESCE(m.deleted_at, 'epoch')) ASC
				  LIMIT 500`,
				user.ID, mutatedSince, since)
			if err != nil {
				log.Printf("[chats/delta] %v", err)
				httpx.Err(w, 500, "delta failed")
				return
			}
			if err := chatsCollectMsgs(mrows, &mutations); err != nil {
				log.Printf("[chats/delta] %v", err)
				httpx.Err(w, 500, "delta failed")
				return
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{
		"messages":   messages,
		"nextSince":  nextSince,
		"more":       int64(len(messages)) == limit,
		"mutations":  mutations,
		"serverTime": httpx.JSTime(serverTime),
	})
}

// chatsMsgSel prefixes chatsMsgCols with a table alias (SELECT m.* parity).
func chatsMsgSel(alias string) string {
	cols := strings.Split(chatsMsgCols, ", ")
	for i, c := range cols {
		cols[i] = alias + "." + c
	}
	return strings.Join(cols, ", ")
}

func chatsCollectMsgs(rows pgx.Rows, out *[]chatsPublicMsg) error {
	defer rows.Close()
	for rows.Next() {
		var m chatsMsgRow
		if err := rows.Scan(m.dest()...); err != nil {
			return err
		}
		*out = append(*out, m.public())
	}
	return rows.Err()
}

// ─── GET /chats — list current user's chats, newest activity first ─────

type chatsListItem struct {
	ID                         string        `json:"id"`
	Type                       string        `json:"type"`
	Name                       *string       `json:"name"`
	PhotoURL                   *string       `json:"photoURL"`
	CreatedBy                  *string       `json:"createdBy"`
	CreatedAt                  httpx.JSTime  `json:"createdAt"`
	UpdatedAt                  httpx.JSTime  `json:"updatedAt"`
	LastMessageID              *string       `json:"lastMessageId"`
	LastMessageAt              *httpx.JSTime `json:"lastMessageAt"`
	MyRole                     string        `json:"myRole"`
	MyLastReadID               *string       `json:"myLastReadId"`
	Muted                      bool          `json:"muted"`
	Pinned                     bool          `json:"pinned"`
	Archived                   bool          `json:"archived"`
	Hidden                     bool          `json:"hidden"`
	ScreenshotMode             string        `json:"screenshotMode"`
	VanishMode                 bool          `json:"vanishMode"`
	UnreadCount                int64         `json:"unreadCount"`
	PeerUserID                 *string       `json:"peerUserId"`
	PeerName                   *string       `json:"peerName"`
	PeerPhotoURL               *string       `json:"peerPhotoURL"`
	PeerOnline                 bool          `json:"peerOnline"`
	PeerLastSeenAt             *httpx.JSTime `json:"peerLastSeenAt"`
	PeerLastReadMessageID      *int64        `json:"peerLastReadMessageId"`
	PeerLastDeliveredMessageID *int64        `json:"peerLastDeliveredMessageId"`
}

func chatsList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	ih := r.URL.Query().Get("includeHidden")
	wantHidden := ih == "1" || ih == "true"

	out := []chatsListItem{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT
		   c.id, c.type, c.name, c.photo_url, c.created_by, c.created_at,
		   c.last_message_id, c.last_message_at, c.updated_at,
		   cm.role, cm.last_read_message_id, cm.muted, cm.joined_at,
		   cm.pinned, cm.pinned_at, cm.archived, cm.hidden,
		   cm.screenshot_mode, cm.vanish_mode,
		   peer.user_id   AS peer_user_id,
		   peer.peer_name AS peer_name,
		   peer.peer_fnc  AS peer_fnc,
		   peer.peer_lnc  AS peer_lnc,
		   peer.peer_ec   AS peer_ec,
		   peer.peer_photo AS peer_photo,
		   peer.peer_online AS peer_online,
		   peer.peer_last_seen AS peer_last_seen,
		   peer.peer_last_read AS peer_last_read,
		   peer.peer_last_delivered AS peer_last_delivered,
		   cm.unread_count AS unread_count
		 FROM chats c
		 JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
		 LEFT JOIN LATERAL (
		   SELECT u.id AS user_id,
		          u.name AS peer_name,
		          u.first_name_cipher AS peer_fnc,
		          u.last_name_cipher  AS peer_lnc,
		          u.email_cipher      AS peer_ec,
		          u.photo_url AS peer_photo,
		          u.online   AS peer_online,
		          CASE WHEN u.read_receipts
		                AND (SELECT read_receipts FROM users WHERE id = $1)
		               THEN cm2.last_read_message_id ELSE NULL END AS peer_last_read,
		          cm2.last_delivered_message_id AS peer_last_delivered,
		          CASE
		            WHEN u.last_seen_visible
		             AND NOT COALESCE((
		               SELECT g.hide_last_seen FROM ghost_mode g
		                WHERE g.owner_id = u.id AND g.target_id = $1
		             ), FALSE)
		            THEN u.last_seen_at
		            ELSE NULL
		          END AS peer_last_seen
		     FROM chat_members cm2
		     JOIN users u ON u.id = cm2.user_id
		    WHERE cm2.chat_id = c.id
		      AND cm2.user_id <> $1
		      AND cm2.left_at IS NULL
		      AND c.type = 'direct'
		    LIMIT 1
		 ) peer ON TRUE
		 WHERE cm.left_at IS NULL
		   AND cm.hidden = $2
		 ORDER BY cm.pinned DESC,
		          cm.pinned_at DESC NULLS LAST,
		          COALESCE(c.last_message_at, c.created_at) DESC
		 LIMIT 200`,
		[]any{user.ID, wantHidden},
		func(rows pgx.Rows) error {
			var (
				id, ctype                                   string
				name, photoURL, createdBy                   *string
				createdAt, updatedAt, joinedAt              time.Time
				lastMessageID, lastReadID                   *int64
				lastMessageAt, pinnedAt                     *time.Time
				role                                        string
				muted, pinned, archived, hidden, vanishMode bool
				screenshotMode                              *string
				peerUserID, peerName, peerFnc, peerLnc      *string
				peerEc, peerPhoto                           *string
				peerOnline                                  *bool
				peerLastSeen                                *time.Time
				peerLastRead, peerLastDelivered             *int64
				unreadCount                                 int64
			)
			if err := rows.Scan(&id, &ctype, &name, &photoURL, &createdBy, &createdAt,
				&lastMessageID, &lastMessageAt, &updatedAt,
				&role, &lastReadID, &muted, &joinedAt,
				&pinned, &pinnedAt, &archived, &hidden,
				&screenshotMode, &vanishMode,
				&peerUserID, &peerName, &peerFnc, &peerLnc, &peerEc, &peerPhoto,
				&peerOnline, &peerLastSeen, &peerLastRead, &peerLastDelivered,
				&unreadCount); err != nil {
				return err
			}
			item := chatsListItem{
				ID: id, Type: ctype, Name: name, PhotoURL: photoURL, CreatedBy: createdBy,
				CreatedAt: httpx.JSTime(createdAt), UpdatedAt: httpx.JSTime(updatedAt),
				LastMessageID: userBigStr(lastMessageID), LastMessageAt: httpx.JST(lastMessageAt),
				MyRole: role, MyLastReadID: userBigStr(lastReadID), Muted: muted,
				Pinned: pinned, Archived: archived, Hidden: hidden,
				ScreenshotMode: chatsStrDefault(screenshotMode, "block"), VanishMode: vanishMode,
				UnreadCount: unreadCount,
				PeerUserID:  peerUserID, PeerPhotoURL: peerPhoto,
				PeerLastSeenAt:        httpx.JST(peerLastSeen),
				PeerLastReadMessageID: peerLastRead, PeerLastDeliveredMessageID: peerLastDelivered,
			}
			if peerOnline != nil {
				item.PeerOnline = *peerOnline
			}
			if peerUserID != nil && *peerUserID != "" {
				item.PeerName = vault.IdentityFromRow(peerFnc, peerLnc, peerEc,
					nil, nil, nil, peerName, nil, nil, nil, nil).Name
			}
			out = append(out, item)
			return nil
		})
	if err != nil {
		log.Printf("[chats GET] %v", err)
		httpx.Err(w, 500, "Failed to list chats")
		return
	}
	httpx.JSON(w, 200, out)
}

func chatsStrDefault(s *string, def string) string {
	if s == nil {
		return def
	}
	return *s
}

// ─── POST /chats — create a chat ───────────────────────────────────────

func chatsCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b map[string]any
	_ = httpx.Body(r, &b)

	switch b["type"] {
	case "direct":
		chatsCreateDirect(w, r, ctx, user, b)
	case "group":
		chatsCreateGroup(w, r, ctx, user, b)
	default:
		httpx.Err(w, 400, "type must be direct or group")
	}
}

func chatsCreateDirect(w http.ResponseWriter, _ *http.Request, ctx context.Context, user httpx.User, b map[string]any) {
	otherEmail := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b["otherEmail"]))))
	otherPhone := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b["otherPhone"])))
	otherUserID := strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b["otherUserId"])))
	if otherEmail == "" && otherPhone == "" && otherUserID == "" {
		httpx.Err(w, 400, "otherEmail, otherPhone, or otherUserId required")
		return
	}

	var otherID *string
	var lookupErr error
	if otherUserID != "" {
		var id string
		lookupErr = chatsQRow(ctx, user.ID,
			`SELECT id FROM users WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
			[]any{otherUserID}, &id)
		if lookupErr == nil {
			otherID = &id
		}
	} else if otherEmail != "" {
		var id string
		lookupErr = chatsQRow(ctx, user.ID,
			`SELECT id FROM users WHERE email = $1 AND is_deleted = FALSE LIMIT 1`,
			[]any{otherEmail}, &id)
		if lookupErr == nil {
			otherID = &id
		}
	} else {
		ph := chatsHashPhone(otherPhone)
		if ph == "" {
			httpx.Err(w, 400, "Invalid phone number")
			return
		}
		var id string
		lookupErr = chatsQRow(ctx, user.ID,
			`SELECT id FROM users WHERE phone_hash = $1 AND is_deleted = FALSE LIMIT 1`,
			[]any{ph}, &id)
		if lookupErr == nil {
			otherID = &id
		}
	}
	if lookupErr != nil && !db.NoRows(lookupErr) {
		log.Printf("[chats POST] %v", lookupErr)
		httpx.Err(w, 500, "Failed to create chat")
		return
	}
	if otherID == nil {
		httpx.Err(w, 404, "User not found")
		return
	}
	if *otherID == user.ID {
		httpx.Err(w, 400, "Cannot DM yourself")
		return
	}

	// Block check — either side blocking the other prevents a new direct chat.
	// System-level read (Node db.query → pool).
	var one int
	err := db.Pool.QueryRow(ctx,
		`SELECT 1 FROM user_blocks
		   WHERE (blocker_id = $1 AND blocked_id = $2)
		      OR (blocker_id = $2 AND blocked_id = $1)
		   LIMIT 1`, user.ID, *otherID).Scan(&one)
	if err == nil {
		httpx.Err(w, 403, "Blocked")
		return
	}
	if !db.NoRows(err) {
		log.Printf("[chats POST] %v", err)
		httpx.Err(w, 500, "Failed to create chat")
		return
	}

	var existingID string
	err = chatsQRow(ctx, user.ID,
		`SELECT c.id FROM chats c
		 WHERE c.type = 'direct'
		   AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $1 AND left_at IS NULL)
		   AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $2 AND left_at IS NULL)
		 LIMIT 1`, []any{user.ID, *otherID}, &existingID)
	if err == nil {
		httpx.JSON(w, 200, map[string]any{"id": existingID, "type": "direct", "existing": true})
		return
	}
	if !db.NoRows(err) {
		log.Printf("[chats POST] %v", err)
		httpx.Err(w, 500, "Failed to create chat")
		return
	}

	var defDis int64
	if err := chatsQRow(ctx, user.ID,
		`SELECT default_disappearing_seconds FROM users WHERE id = $1`,
		[]any{user.ID}, &defDis); err != nil && !db.NoRows(err) {
		log.Printf("[chats POST] %v", err)
		httpx.Err(w, 500, "Failed to create chat")
		return
	}
	var disParam *int64
	if defDis > 0 {
		disParam = &defDis
	}

	var chatID string
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO chats (type, created_by, disappearing_seconds) VALUES ('direct', $1, $2) RETURNING id`,
			user.ID, disParam).Scan(&chatID); e != nil {
			return e
		}
		// Insert creator FIRST as 'owner' so the bootstrap RLS clause allows it;
		// then the other party as 'member'.
		if _, e := tx.Exec(ctx,
			`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'owner')`,
			chatID, user.ID); e != nil {
			return e
		}
		_, e := tx.Exec(ctx,
			`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')`,
			chatID, *otherID)
		return e
	})
	if err != nil {
		log.Printf("[chats POST] %v", err)
		httpx.Err(w, 500, "Failed to create chat")
		return
	}
	realtime.InvalidateChatMembers(ctx, chatID) // P2.2: fresh roster before any fan-out
	httpx.JSON(w, 200, map[string]any{"id": chatID, "type": "direct", "existing": false})
}

func chatsCreateGroup(w http.ResponseWriter, _ *http.Request, ctx context.Context, user httpx.User, b map[string]any) {
	name := truncRunes(strings.TrimSpace(fmt.Sprintf("%v", orEmpty(b["name"]))), 100)
	memberIds := []string{}
	if arr, ok := b["memberIds"].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok {
				memberIds = append(memberIds, s)
			}
		}
	}
	memberEmails := []string{}
	if arr, ok := b["memberEmails"].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok {
				e := strings.ToLower(strings.TrimSpace(s))
				if e != "" {
					memberEmails = append(memberEmails, e)
				}
			}
		}
	}
	if name == "" {
		httpx.Err(w, 400, "Group name required")
		return
	}

	resolvedIds := append([]string{}, memberIds...)
	if len(memberEmails) > 0 {
		type emailRow struct{ id, email string }
		found := []emailRow{}
		err := chatsQueryU(ctx, user.ID,
			`SELECT id, email FROM users WHERE email = ANY($1::citext[]) AND is_deleted = FALSE`,
			[]any{memberEmails}, func(rows pgx.Rows) error {
				var er emailRow
				if e := rows.Scan(&er.id, &er.email); e != nil {
					return e
				}
				found = append(found, er)
				return nil
			})
		if err != nil {
			log.Printf("[chats POST] %v", err)
			httpx.Err(w, 500, "Failed to create chat")
			return
		}
		if len(found) != len(memberEmails) {
			set := map[string]bool{}
			for _, f := range found {
				set[strings.ToLower(f.email)] = true
			}
			missing := []string{}
			for _, e := range memberEmails {
				if !set[e] {
					missing = append(missing, e)
				}
			}
			httpx.Err(w, 400, "Unknown emails: "+strings.Join(missing, ", "))
			return
		}
		for _, f := range found {
			resolvedIds = append(resolvedIds, f.id)
		}
	}

	// A Family Circle is created solo and filled via invite links (allowEmpty).
	if len(resolvedIds) == 0 && b["allowEmpty"] != true {
		httpx.Err(w, 400, "Group needs at least one other member")
		return
	}
	if len(resolvedIds) >= chatsMaxGroupSize {
		httpx.Err(w, 400, fmt.Sprintf("Group capped at %d members", chatsMaxGroupSize))
		return
	}

	all := []string{}
	seen := map[string]bool{}
	for _, uid := range append([]string{user.ID}, resolvedIds...) {
		if !seen[uid] {
			seen[uid] = true
			all = append(all, uid)
		}
	}
	foundN := 0
	err := chatsQueryU(ctx, user.ID,
		`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND is_deleted = FALSE`,
		[]any{all}, func(rows pgx.Rows) error {
			var id string
			if e := rows.Scan(&id); e != nil {
				return e
			}
			foundN++
			return nil
		})
	if err != nil {
		log.Printf("[chats POST] %v", err)
		httpx.Err(w, 500, "Failed to create chat")
		return
	}
	if foundN != len(all) {
		httpx.Err(w, 400, "One or more memberIds invalid")
		return
	}

	// ── Groups & Circles metadata (migration 070) ──
	// All optional: a group created without a type is an untyped group and
	// behaves exactly as groups did before this change.
	gType := strings.ToLower(strings.TrimSpace(chatsStrOr(b["groupType"], "")))
	if gType != "" {
		known, e := chatsKnownGroupType(ctx, user.ID, gType)
		if e != nil {
			log.Printf("[chats POST] group type lookup: %v", e)
			httpx.Err(w, 500, "Failed to create chat")
			return
		}
		if !known {
			httpx.Err(w, 400, "Unknown group type")
			return
		}
	}
	gIcon := truncRunes(strings.TrimSpace(chatsStrOr(b["icon"], "")), chatsGroupIconMax)
	gColor := truncRunes(strings.TrimSpace(chatsStrOr(b["color"], "")), chatsGroupColorMax)
	gDesc := truncRunes(strings.TrimSpace(chatsStrOr(b["description"], "")), chatsGroupDescMax)
	gPrivacy := strings.ToLower(strings.TrimSpace(chatsStrOr(b["privacy"], "private")))
	if !chatsValidPrivacy(gPrivacy) {
		httpx.Err(w, 400, "privacy must be 'private' or 'invite_only'")
		return
	}

	var chatID string
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO chats (type, name, created_by, group_type, icon, color, description, privacy)
			 VALUES ('group', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
			name, user.ID, chatsNilIfEmpty(gType), chatsNilIfEmpty(gIcon),
			chatsNilIfEmpty(gColor), chatsNilIfEmpty(gDesc), gPrivacy).Scan(&chatID); e != nil {
			return e
		}
		for _, uid := range all {
			role := "member"
			if uid == user.ID {
				role = "owner"
			}
			if _, e := tx.Exec(ctx,
				`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)`,
				chatID, uid, role); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		log.Printf("[chats POST] %v", err)
		httpx.Err(w, 500, "Failed to create chat")
		return
	}
	realtime.InvalidateChatMembers(ctx, chatID) // P2.2: fresh roster before any fan-out
	httpx.JSON(w, 200, map[string]any{
		"id": chatID, "type": "group", "name": name,
		"groupType": chatsNilIfEmpty(gType), "privacy": gPrivacy,
	})
}

// ─── Invite links ──────────────────────────────────────────────────────

const chatsInviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"

func chatsGenInviteCode() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	s := make([]byte, 12)
	for i := 0; i < 12; i++ {
		s[i] = chatsInviteAlphabet[int(b[i])%len(chatsInviteAlphabet)]
	}
	return string(s)
}

type chatsInviteRow struct {
	ID        int64
	Code      string
	ChatID    string
	CreatedBy string
	CreatedAt time.Time
	ExpiresAt *time.Time
	MaxUses   int64
	Uses      int64
	Revoked   bool
}

const chatsInviteCols = `id, code, chat_id, created_by, created_at, expires_at, max_uses, uses, revoked`

func (l *chatsInviteRow) dest() []any {
	return []any{&l.ID, &l.Code, &l.ChatID, &l.CreatedBy, &l.CreatedAt, &l.ExpiresAt, &l.MaxUses, &l.Uses, &l.Revoked}
}

type chatsPublicInvite struct {
	ID        string        `json:"id"`
	Code      string        `json:"code"`
	ChatID    string        `json:"chatId"`
	CreatedBy string        `json:"createdBy"`
	CreatedAt httpx.JSTime  `json:"createdAt"`
	ExpiresAt *httpx.JSTime `json:"expiresAt"`
	MaxUses   int64         `json:"maxUses"`
	Uses      int64         `json:"uses"`
	Revoked   bool          `json:"revoked"`
}

func (l chatsInviteRow) public() chatsPublicInvite {
	return chatsPublicInvite{
		ID: fmt.Sprintf("%d", l.ID), Code: l.Code, ChatID: l.ChatID, CreatedBy: l.CreatedBy,
		CreatedAt: httpx.JSTime(l.CreatedAt), ExpiresAt: httpx.JST(l.ExpiresAt),
		MaxUses: l.MaxUses, Uses: l.Uses, Revoked: l.Revoked,
	}
}

// POST /chats/join/{code} — redeem an invite link (plain pool, like Node).
func chatsJoinByCode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	code := strings.TrimSpace(r.PathValue("code"))
	if code == "" {
		httpx.Err(w, 400, "code required")
		return
	}

	var (
		chatID         string
		revoked        bool
		expiresAt      *time.Time
		maxUses, uses  int64
		approveMembers bool
	)
	err := db.SysPool.QueryRow(ctx,
		`SELECT il.chat_id, il.revoked, il.expires_at, il.max_uses, il.uses, c.approve_members
		   FROM invite_links il JOIN chats c ON c.id = il.chat_id
		  WHERE il.code = $1 LIMIT 1`, code).Scan(&chatID, &revoked, &expiresAt, &maxUses, &uses, &approveMembers)
	if db.NoRows(err) || (err == nil && revoked) {
		httpx.Err(w, http.StatusGone, "Invalid or revoked link")
		return
	}
	if err != nil {
		log.Printf("[chats join] %v", err)
		httpx.Err(w, 500, "Failed to join via link")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		httpx.Err(w, http.StatusGone, "Link has expired")
		return
	}
	if maxUses > 0 && uses >= maxUses {
		httpx.Err(w, http.StatusGone, "Link has reached its use limit")
		return
	}

	var one int
	err = db.SysPool.QueryRow(ctx,
		`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL`,
		chatID, user.ID).Scan(&one)
	if err == nil {
		httpx.JSON(w, 200, map[string]any{"chatId": chatID, "alreadyMember": true})
		return
	}
	if !db.NoRows(err) {
		log.Printf("[chats join] %v", err)
		httpx.Err(w, 500, "Failed to join via link")
		return
	}

	if approveMembers {
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO chat_join_requests (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			chatID, user.ID); err != nil {
			log.Printf("[chats join] %v", err)
			httpx.Err(w, 500, "Failed to join via link")
			return
		}
		emitx.ChatEvent(chatID, "join_requested", map[string]any{"userId": user.ID})
		httpx.JSON(w, 200, map[string]any{"chatId": chatID, "pending": true})
		return
	}

	var rChatID *string
	var status *string
	err = db.Pool.QueryRow(ctx,
		`SELECT chat_id, status FROM vc_redeem_invite($1, $2)`, code, user.ID).Scan(&rChatID, &status)
	if err != nil && !db.NoRows(err) {
		log.Printf("[chats join] %v", err)
		httpx.Err(w, 500, "Failed to join via link")
		return
	}
	if db.NoRows(err) || status == nil || *status != "ok" {
		msg, code := "Invalid link", http.StatusGone
		if status != nil {
			switch *status {
			case "invalid":
				msg = "Invalid or revoked link"
			case "expired":
				msg = "Link has expired"
			case "used":
				msg = "Link has reached its use limit"
			case "full":
				// The link is fine; the group has no seats. 410 Gone would tell
				// the user to stop trying, which is wrong — a seat may free up.
				msg, code = "This group is full", http.StatusConflict
			}
		}
		httpx.Err(w, code, msg)
		return
	}
	emitx.ChatEvent(*rChatID, "members_added", map[string]any{"added": []string{user.ID}, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"chatId": *rChatID})
}

// ─── Join requests (approve-members groups) ────────────────────────────

func chatsJoinRequestsGet(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to load join requests")
	if mem == nil {
		return
	}
	if !mem.isAdmin() {
		httpx.Err(w, 403, "Admin only")
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT jr.user_id, jr.created_at, u.name, u.first_name_cipher, u.last_name_cipher, u.email_cipher, u.photo_url
		   FROM chat_join_requests jr JOIN users u ON u.id = jr.user_id
		  WHERE jr.chat_id = $1 ORDER BY jr.created_at`, r.PathValue("id"))
	if err != nil {
		log.Printf("[join-requests GET] %v", err)
		httpx.Err(w, 500, "Failed to load join requests")
		return
	}
	defer rows.Close()
	type jr struct {
		UserID      string       `json:"userId"`
		Name        *string      `json:"name"`
		PhotoURL    *string      `json:"photoURL"`
		RequestedAt httpx.JSTime `json:"requestedAt"`
	}
	out := []jr{}
	for rows.Next() {
		var userID string
		var createdAt time.Time
		var name, fnc, lnc, ec, photoURL *string
		if err := rows.Scan(&userID, &createdAt, &name, &fnc, &lnc, &ec, &photoURL); err != nil {
			log.Printf("[join-requests GET] %v", err)
			httpx.Err(w, 500, "Failed to load join requests")
			return
		}
		ident := vault.IdentityFromRow(fnc, lnc, ec, nil, nil, nil, name, nil, nil, nil, nil)
		out = append(out, jr{UserID: userID, Name: ident.Name, PhotoURL: photoURL, RequestedAt: httpx.JSTime(createdAt)})
	}
	httpx.JSON(w, 200, out)
}

func chatsJoinRequestApprove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	chatID := r.PathValue("id")
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to approve request")
	if mem == nil {
		return
	}
	if !mem.isAdmin() {
		httpx.Err(w, 403, "Admin only")
		return
	}
	target := r.PathValue("userId")
	var one int
	err := db.Pool.QueryRow(ctx,
		`SELECT 1 FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2`,
		chatID, target).Scan(&one)
	if db.NoRows(err) {
		httpx.Err(w, 404, "Request not found")
		return
	}
	if err != nil {
		log.Printf("[join-requests approve] %v", err)
		httpx.Err(w, 500, "Failed to approve request")
		return
	}
	// Admin context → RLS allows the membership insert.
	if err := chatsExecU(ctx, user.ID,
		`INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')
		 ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
		chatID, target); err != nil {
		log.Printf("[join-requests approve] %v", err)
		httpx.Err(w, 500, "Failed to approve request")
		return
	}
	realtime.InvalidateChatMembers(ctx, chatID) // P2.2: fresh roster before any fan-out
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2`, chatID, target); err != nil {
		log.Printf("[join-requests approve] %v", err)
		httpx.Err(w, 500, "Failed to approve request")
		return
	}
	emitx.ChatEvent(chatID, "members_added", map[string]any{"added": []string{target}, "by": user.ID})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func chatsJoinRequestReject(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mem := chatsRequireMem(w, r, 403, "Not a member", "Failed to reject request")
	if mem == nil {
		return
	}
	if !mem.isAdmin() {
		httpx.Err(w, 403, "Admin only")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM chat_join_requests WHERE chat_id = $1 AND user_id = $2`,
		r.PathValue("id"), r.PathValue("userId")); err != nil {
		log.Printf("[join-requests reject] %v", err)
		httpx.Err(w, 500, "Failed to reject request")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ─── GET /chats/search — zero-knowledge: chat/member-name hits only ────

var chatsLikeEscaper = strings.NewReplacer("%", `\%`, "_", `\_`)

func chatsSearch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		httpx.JSON(w, 200, map[string]any{"chats": []any{}, "messages": []any{}})
		return
	}
	if len([]rune(q)) > 200 {
		httpx.Err(w, 400, "query too long")
		return
	}
	limitStr := r.URL.Query().Get("limit")
	if limitStr == "" {
		limitStr = "20"
	}
	limit, ok := httpx.ParseIntPrefix(limitStr)
	if !ok {
		// Node: Math.min(NaN, 100) → LIMIT NaN → query error → 500.
		httpx.Err(w, 500, "Search failed")
		return
	}
	if limit > 100 {
		limit = 100
	}
	like := "%" + chatsLikeEscaper.Replace(q) + "%"

	type hit struct {
		ID            string        `json:"id"`
		Type          string        `json:"type"`
		Name          *string       `json:"name"`
		PhotoURL      *string       `json:"photoURL"`
		LastMessageAt *httpx.JSTime `json:"lastMessageAt"`
	}
	out := []hit{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT DISTINCT c.id, c.type, c.name, c.photo_url, c.last_message_at
		   FROM chats c
		   JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
		   LEFT JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id <> $1 AND cm2.left_at IS NULL
		   LEFT JOIN users u ON u.id = cm2.user_id
		  WHERE (c.name ILIKE $2 OR u.name ILIKE $2 OR u.email ILIKE $2)
		  ORDER BY c.last_message_at DESC NULLS LAST
		  LIMIT $3`,
		[]any{user.ID, like, limit}, func(rows pgx.Rows) error {
			var h hit
			var lma *time.Time
			if e := rows.Scan(&h.ID, &h.Type, &h.Name, &h.PhotoURL, &lma); e != nil {
				return e
			}
			h.LastMessageAt = httpx.JST(lma)
			out = append(out, h)
			return nil
		})
	if err != nil {
		log.Printf("[chats search] %v", err)
		httpx.Err(w, 500, "Search failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"chats": out, "messages": []any{}})
}

// ─── GET /chats/common/{userId} — groups in common ─────────────────────

func chatsCommon(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	type g struct {
		ID       string  `json:"id"`
		Name     *string `json:"name"`
		PhotoURL *string `json:"photoURL"`
	}
	out := []g{}
	err := chatsQueryU(ctx, user.ID,
		`SELECT c.id, c.name, c.photo_url
		   FROM chats c
		   JOIN chat_members a ON a.chat_id = c.id AND a.user_id = $1 AND a.left_at IS NULL
		   JOIN chat_members b ON b.chat_id = c.id AND b.user_id = $2 AND b.left_at IS NULL
		  WHERE c.type = 'group'
		  ORDER BY c.last_message_at DESC NULLS LAST
		  LIMIT 50`,
		[]any{user.ID, r.PathValue("userId")}, func(rows pgx.Rows) error {
			var row g
			if e := rows.Scan(&row.ID, &row.Name, &row.PhotoURL); e != nil {
				return e
			}
			out = append(out, row)
			return nil
		})
	if err != nil {
		log.Printf("[chats common] %v", err)
		httpx.Err(w, 500, "Failed")
		return
	}
	httpx.JSON(w, 200, map[string]any{"groups": out})
}
