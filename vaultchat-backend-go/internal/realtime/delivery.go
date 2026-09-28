package realtime

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/redisx"
)

// ── fanOutToChat (server.js) ──────────────────────────────────────────
// Fan a chat-scoped event to every connected socket of every chat member.
// senderID (when set) suppresses recipients who blocked the sender; ghost-mode
// columns suppress typing/read signals per-recipient. Filter-free events also
// hit the chat:<id> room directly (open-chat sockets); filtered events route
// only via per-user rooms so the skips apply.
var eventToGhostCol = map[string]string{
	"typing_start": "hide_typing",
	"typing_stop":  "hide_typing",
	"message_read": "hide_read",
}

func senderOfEvent(event string, data any) string {
	m, _ := data.(map[string]any)
	if m == nil {
		return ""
	}
	switch event {
	case "typing_start", "typing_stop":
		s, _ := m["uid"].(string)
		return s
	case "message_read":
		s, _ := m["userId"].(string)
		return s
	}
	return ""
}

// ── Chat-membership cache (P2.2) ─────────────────────────────────────
// Every fan-out used to run `SELECT vc_chat_member_ids($1)` — one DB query
// per message/typing/receipt event, the single hottest read on the server.
// Membership changes are rare; cache it in Redis for 30s and DEL on every
// mutation (InvalidateChatMembers, called from the routes that add/remove
// members). Redis-down ⇒ straight to the DB (fail-open, same as before).
const memberCacheTTL = 30 * time.Second

func chatMemberIDs(ctx context.Context, chatID string) ([]string, error) {
	key := "vc:members:" + chatID
	if c := redisx.Client; c != nil {
		if cached, err := c.SMembers(ctx, key).Result(); err == nil && len(cached) > 0 {
			// "\x00empty" marks a cached empty membership (SETs can't be empty).
			if len(cached) == 1 && cached[0] == "\x00empty" {
				return nil, nil
			}
			return cached, nil
		}
	}
	rows, err := db.SysPool.Query(ctx, `SELECT * FROM vc_chat_member_ids($1)`, chatID)
	if err != nil {
		return nil, err
	}
	var memberIDs []string
	for rows.Next() {
		var id *string
		if rows.Scan(&id) == nil && id != nil && *id != "" {
			memberIDs = append(memberIDs, *id)
		}
	}
	rows.Close()
	if c := redisx.Client; c != nil {
		vals := make([]any, 0, len(memberIDs)+1)
		for _, m := range memberIDs {
			vals = append(vals, m)
		}
		if len(vals) == 0 {
			vals = append(vals, "\x00empty")
		}
		pipe := c.Pipeline()
		pipe.Del(ctx, key) // never merge with a stale set
		pipe.SAdd(ctx, key, vals...)
		pipe.Expire(ctx, key, memberCacheTTL)
		_, _ = pipe.Exec(ctx)
	}
	return memberIDs, nil
}

// InvalidateChatMembers drops the cached member list — call after any
// chat_members mutation so fan-out never uses a stale roster for >0ms.
// (The 30s TTL is only the backstop for missed call sites.)
func InvalidateChatMembers(ctx context.Context, chatID string) {
	if c := redisx.Client; c != nil {
		c.Del(ctx, "vc:members:"+chatID)
	}
	// AUDIT F02: dropping the roster stops fan-out REACHING a removed member,
	// but their live socket was still holding its own "yes, a member" decision
	// and could keep publishing into the chat. Same call site, both caches.
	BumpChatPermissions(chatID)
}

// FanOutToChat is the exact port of server.js fanOutToChat.
func (h *Hub) FanOutToChat(ctx context.Context, chatID, event string, payload any, senderID string) {
	ctx, cancel := realtimeContext(ctx)
	defer cancel()
	if ctx.Err() != nil {
		return
	}
	ghostCol := eventToGhostCol[event]
	effectiveSender := senderID
	if effectiveSender == "" {
		effectiveSender = senderOfEvent(event, payload)
	}
	// NOTE: this used to take a Socket.IO shortcut when unfiltered — one
	// room emit instead of N per-user emits. CC-Wire has no room broadcast
	// that bypasses per-recipient authorization, and the loop below already
	// reaches every member, so the shortcut left with Socket.IO.
	_ = senderID != "" || ghostCol != ""

	// Members of this chat (Redis-cached, 30s TTL — P2.2).
	memberIDs, err := chatMemberIDs(ctx, chatID)
	if err != nil {
		log.Printf("[fanOutToChat] %v", err)
		return
	}

	// Viewers who blocked the sender — drop those.
	blockerSet := map[string]bool{}
	if senderID != "" && len(memberIDs) > 0 {
		blk, err := db.SysPool.Query(ctx,
			`SELECT blocker_id FROM user_blocks
			  WHERE blocked_id = $1 AND blocker_id = ANY($2::uuid[])`, senderID, memberIDs)
		if err != nil {
			log.Printf("[fanOutToChat blocks] %v", err)
		} else {
			for blk.Next() {
				var b string
				if blk.Scan(&b) == nil {
					blockerSet[b] = true
				}
			}
			blk.Close()
		}
	}

	// Ghost-mode targets for this signal.
	ghostedSet := map[string]bool{}
	if ghostCol != "" && effectiveSender != "" {
		ghostedSet = h.loadGhostTargets(effectiveSender, ghostCol, ctx)
	}

	for _, uid := range memberIDs {
		if ctx.Err() != nil {
			return
		}
		if blockerSet[uid] || ghostedSet[uid] {
			continue
		}
		// chatID is carried into the leaf so a CC-Wire recipient can be handed a
		// Receipt body, which requires it. The Socket.IO emit is identical.
		h.emitToUidInContext(ctx, chatID, uid, event, payload)
	}
}

// ── Live Chat Viewers (feature #58) — ephemeral, Redis-only (server.js) ──
const cvTTLms = 30000

func cvRedis() *redis.Client {
	if redisx.Client == nil {
		return nil
	}
	return redisx.Client
}

func (h *Hub) cvTouch(chatID, uid, activity string, parents ...context.Context) (isNew, changed bool, act string) {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	c := cvRedis()
	if c == nil {
		if activity == "" {
			activity = "reading"
		}
		return false, false, activity
	}
	now := time.Now().UnixMilli()
	prev, _ := c.HGet(ctx, "cv:h:"+chatID, uid).Result()
	prevAct := ""
	if prev != "" {
		var pj struct {
			Activity string `json:"activity"`
		}
		if json.Unmarshal([]byte(prev), &pj) == nil {
			prevAct = pj.Activity
		}
	}
	a := activity
	if a == "" {
		a = prevAct
	}
	if a == "" {
		a = "reading"
	}
	val, _ := json.Marshal(map[string]any{"activity": a, "ts": now})
	c.HSet(ctx, "cv:h:"+chatID, uid, string(val))
	c.ZAdd(ctx, "cv:exp", redis.Z{Score: float64(now), Member: chatID + "|" + uid})
	c.PExpire(ctx, "cv:h:"+chatID, time.Duration(cvTTLms*3)*time.Millisecond)
	return prev == "", prev != "" && activity != "" && activity != prevAct, a
}

func (h *Hub) cvRemove(chatID, uid string, parents ...context.Context) {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	c := cvRedis()
	if c == nil {
		return
	}
	c.HDel(ctx, "cv:h:"+chatID, uid)
	c.ZRem(ctx, "cv:exp", chatID+"|"+uid)
}

type cvViewer struct {
	UserID   string `json:"userId"`
	Activity string `json:"activity"`
}

func (h *Hub) cvList(chatID string, parents ...context.Context) []cvViewer {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	c := cvRedis()
	if c == nil {
		return []cvViewer{}
	}
	m, _ := c.HGetAll(ctx, "cv:h:"+chatID).Result()
	out := make([]cvViewer, 0, len(m))
	for uid, val := range m {
		activity := "reading"
		var pj struct {
			Activity string `json:"activity"`
		}
		if json.Unmarshal([]byte(val), &pj) == nil && pj.Activity != "" {
			activity = pj.Activity
		}
		out = append(out, cvViewer{UserID: uid, Activity: activity})
	}
	return out
}

// startViewerSweep drops viewers whose heartbeat is >30s stale and broadcasts
// viewer_left (covers crashes/drops with no LEFT). server.js 10s interval.
func (h *Hub) startViewerSweep() {
	go func() {
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for range t.C {
			c := cvRedis()
			if c == nil {
				continue
			}
			// Cluster (P2.1): the sweep reads shared Redis keys, so let ONE
			// node per tick do it — otherwise every replica emits its own
			// duplicate viewer_left for the same expiry.
			if ClusterEnabled() {
				if ok, err := c.SetNX(bg, "vc:cvsweep:lock", nodeID, 9*time.Second).Result(); err != nil || !ok {
					continue
				}
			}
			cutoff := time.Now().UnixMilli() - cvTTLms
			expired, err := c.ZRangeByScore(bg, "cv:exp", &redis.ZRangeBy{
				Min: "0", Max: strconv.FormatInt(cutoff, 10),
			}).Result()
			if err != nil {
				continue
			}
			for _, member := range expired {
				i := strings.IndexByte(member, '|')
				if i < 0 {
					c.ZRem(bg, "cv:exp", member)
					continue
				}
				chatID, uid := member[:i], member[i+1:]
				c.HDel(bg, "cv:h:"+chatID, uid)
				c.ZRem(bg, "cv:exp", member)
				h.emitRooms([]string{"chat:" + chatID}, "", "viewer_left",
					map[string]any{"chatId": chatID, "userId": uid})
			}
		}
	}()
}

// ── Call wake-up push (server.js call_incoming → sendPushToTokens) ──────
// Expo Push transport, ported from push.js: batch 100, 3 attempts on 5xx,
// prune DeviceNotRegistered tokens. Only fired when the callee has NO live
// socket (killed/doze). channelId 'calls' + category 'incoming_call' render
// the Notifee full-screen call.
var expoHTTP = &http.Client{Timeout: 15 * time.Second}

func (h *Hub) sendCallWakePush(ctx context.Context, calleeID, title, body string, data map[string]any) {
	h.sendWakePush(ctx, calleeID, title, body, "calls", "incoming_call", data)
}

// sendWakePush is the same transport with the Android channel (and optional
// iOS/Android category) left to the caller, so a non-call wake — Family Space
// Emergency Connect — can route to its own channel instead of ringing like a
// call. Pass an empty categoryID to omit it.
func (h *Hub) sendWakePush(ctx context.Context, userID, title, body, channelID, categoryID string, data map[string]any) {
	rows, err := db.SysPool.Query(ctx,
		`SELECT push_token FROM devices WHERE user_id = $1 AND push_token IS NOT NULL`, userID)
	if err != nil {
		return
	}
	var tokens []string
	for rows.Next() {
		var t *string
		if rows.Scan(&t) == nil && t != nil && strings.HasPrefix(*t, "Expo") {
			tokens = append(tokens, *t)
		}
	}
	rows.Close()
	if len(tokens) == 0 {
		return
	}

	base := map[string]any{
		"sound": "default", "title": title, "body": body, "data": data,
		"priority": "high", "channelId": channelID,
		"_displayInForeground": true,
	}
	if categoryID != "" {
		base["categoryId"] = categoryID
	}
	var dead []string
	for i := 0; i < len(tokens); i += 100 {
		end := i + 100
		if end > len(tokens) {
			end = len(tokens)
		}
		slice := tokens[i:end]
		chunk := make([]map[string]any, len(slice))
		for j, tk := range slice {
			msg := map[string]any{"to": tk}
			for k, v := range base {
				msg[k] = v
			}
			chunk[j] = msg
		}
		tickets := expoPostBatch(chunk)
		for j, t := range tickets {
			if j >= len(slice) {
				break
			}
			if t.Status == "error" && t.Details.Error == "DeviceNotRegistered" {
				dead = append(dead, slice[j])
			}
		}
	}
	if len(dead) > 0 {
		_, _ = db.SysPool.Exec(ctx, `DELETE FROM devices WHERE push_token = ANY($1::text[])`, dead)
	}
}

// familyEmergencyWake pushes the Emergency Connect alert to every circle member
// the socket relay did NOT already reach.
//
// "Did not reach" means: not present in the circle's socket room. That room is
// exactly where the client joins AND registers its family_emergency listener
// (lib/family/presence.ts subscribeCircle), so room membership is the only gate
// that matches the relay.
//
// Gating on hasLiveSocket() instead was WRONG: a socket joins `user:<uid>` on
// connect but `chat:<id>` only while the Family screen is open, so a guardian
// with the app running on any other screen — the commonest state — was missed
// by the relay AND skipped by the push, receiving nothing at all.
//
// Failure direction is deliberate: if the roster is incomplete (e.g. a
// multi-node deployment where FetchSockets sees only this node), the member is
// treated as uncovered and gets a push. A duplicate alert is a far better
// failure than a silent one.
func (h *Hub) familyEmergencyWake(ctx context.Context, chatID, senderID string) {
	rows, err := db.SysPool.Query(ctx,
		`SELECT user_id FROM chat_members WHERE chat_id = $1 AND left_at IS NULL AND user_id <> $2`,
		chatID, senderID)
	if err != nil {
		return
	}
	var members []string
	for rows.Next() {
		var uid string
		if rows.Scan(&uid) == nil && uid != "" {
			members = append(members, uid)
		}
	}
	rows.Close()

	// callRoster is generic over any socket room despite its name — it returns
	// the distinct uids present, excluding the caller.
	covered := map[string]bool{}
	for _, uid := range h.callRoster(Room("chat:"+chatID), senderID) {
		covered[uid] = true
	}

	data := map[string]any{"type": "family-emergency", "circleId": chatID}
	for _, uid := range members {
		if covered[uid] {
			continue // already alerted by the socket relay
		}
		// channelId must match FAMILY_CRITICAL_CHANNEL_ID in lib/family/notify.ts.
		h.sendWakePush(ctx, uid, "Family Space", "Emergency alert - open VaultChat",
			"family-critical", "", data)
	}
}

type expoTicket struct {
	Status  string `json:"status"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

func expoPostBatch(chunk []map[string]any) []expoTicket {
	body, _ := json.Marshal(chunk)
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequest("POST", "https://exp.host/--/api/v2/push/send", bytes.NewReader(body))
		if err != nil {
			return nil
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		resp, err := expoHTTP.Do(req)
		if err == nil {
			if resp.StatusCode >= 500 {
				resp.Body.Close() // transient → retry
			} else if resp.StatusCode >= 400 {
				resp.Body.Close()
				return nil // 4xx not retryable
			} else {
				var out struct {
					Data []expoTicket `json:"data"`
				}
				json.NewDecoder(resp.Body).Decode(&out)
				resp.Body.Close()
				return out.Data
			}
		}
		if attempt < 3 {
			time.Sleep(time.Duration(300*attempt) * time.Millisecond)
		}
	}
	return nil
}
