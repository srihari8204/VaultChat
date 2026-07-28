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
	"github.com/zishang520/socket.io/v2/socket"

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

// FanOutToChat is the exact port of server.js fanOutToChat.
func (h *Hub) FanOutToChat(ctx context.Context, chatID, event string, payload any, senderID string) {
	ghostCol := eventToGhostCol[event]
	effectiveSender := senderID
	if effectiveSender == "" {
		effectiveSender = senderOfEvent(event, payload)
	}
	filtered := senderID != "" || ghostCol != ""

	if !filtered {
		h.io.To(socket.Room("chat:"+chatID)).Emit(event, payload)
	}

	// Members of this chat.
	rows, err := db.Pool.Query(ctx, `SELECT * FROM vc_chat_member_ids($1)`, chatID)
	if err != nil {
		log.Printf("[fanOutToChat] %v", err)
		return
	}
	var memberIDs []string
	for rows.Next() {
		var id *string
		if rows.Scan(&id) == nil && id != nil && *id != "" {
			memberIDs = append(memberIDs, *id)
		}
	}
	rows.Close()

	// Viewers who blocked the sender — drop those.
	blockerSet := map[string]bool{}
	if senderID != "" && len(memberIDs) > 0 {
		blk, err := db.Pool.Query(ctx,
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
		ghostedSet = h.loadGhostTargets(effectiveSender, ghostCol)
	}

	for _, uid := range memberIDs {
		if blockerSet[uid] || ghostedSet[uid] {
			continue
		}
		h.EmitToUid(uid, event, payload)
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

func (h *Hub) cvTouch(chatID, uid, activity string) (isNew, changed bool, act string) {
	c := cvRedis()
	if c == nil {
		if activity == "" {
			activity = "reading"
		}
		return false, false, activity
	}
	now := time.Now().UnixMilli()
	prev, _ := c.HGet(bg, "cv:h:"+chatID, uid).Result()
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
	c.HSet(bg, "cv:h:"+chatID, uid, string(val))
	c.ZAdd(bg, "cv:exp", redis.Z{Score: float64(now), Member: chatID + "|" + uid})
	c.PExpire(bg, "cv:h:"+chatID, time.Duration(cvTTLms*3)*time.Millisecond)
	return prev == "", prev != "" && activity != "" && activity != prevAct, a
}

func (h *Hub) cvRemove(chatID, uid string) {
	c := cvRedis()
	if c == nil {
		return
	}
	c.HDel(bg, "cv:h:"+chatID, uid)
	c.ZRem(bg, "cv:exp", chatID+"|"+uid)
}

type cvViewer struct {
	UserID   string `json:"userId"`
	Activity string `json:"activity"`
}

func (h *Hub) cvList(chatID string) []cvViewer {
	c := cvRedis()
	if c == nil {
		return []cvViewer{}
	}
	m, _ := c.HGetAll(bg, "cv:h:"+chatID).Result()
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
				h.io.To(socket.Room("chat:"+chatID)).Emit("viewer_left",
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
	rows, err := db.Pool.Query(ctx,
		`SELECT push_token FROM devices WHERE user_id = $1 AND push_token IS NOT NULL`, calleeID)
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
		"priority": "high", "channelId": "calls", "categoryId": "incoming_call",
		"_displayInForeground": true,
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
		_, _ = db.Pool.Exec(ctx, `DELETE FROM devices WHERE push_token = ANY($1::text[])`, dead)
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
