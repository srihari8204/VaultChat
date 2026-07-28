package realtime

import (
	"github.com/jackc/pgx/v5"
	"github.com/zishang520/socket.io/v2/socket"

	"vaultchat/backend-go/internal/db"
)

// ── shared payload helpers ────────────────────────────────────────────
func argMap(args []any) map[string]any {
	if len(args) == 0 {
		return nil
	}
	m, _ := args[0].(map[string]any)
	return m
}

func mstr(m map[string]any, k string) string { s, _ := m[k].(string); return s }

func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m)+2)
	for k, v := range m {
		out[k] = v
	}
	return out
}

// truthy mirrors JS truthiness for the fields we branch on (resync, blob).
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	default:
		return true
	}
}

// ── Chat real-time handlers (server.js io.on('connection') chat block) ──
func (h *Hub) registerChatHandlers(s *socket.Socket) {
	d := sd(s)

	s.On("join_chat", func(args ...any) {
		if id := mstr(argMap(args), "chatId"); id != "" {
			s.Join(socket.Room("chat:" + id))
		}
	})
	s.On("leave_chat", func(args ...any) {
		if id := mstr(argMap(args), "chatId"); id != "" {
			s.Leave(socket.Room("chat:" + id))
		}
	})

	s.On("channel_join", func(args ...any) {
		if id := mstr(argMap(args), "channelId"); id != "" {
			s.Join(socket.Room("channel:" + id))
		}
	})
	s.On("channel_leave", func(args ...any) {
		if id := mstr(argMap(args), "channelId"); id != "" {
			s.Leave(socket.Room("channel:" + id))
		}
	})

	// Live location — zero-knowledge relay into the chat room (excl. self),
	// gated on a per-socket cached membership check (server.js).
	s.On("live_location_update", func(args ...any) {
		m := argMap(args)
		chatID := mstr(m, "chatId")
		if chatID == "" {
			return
		}
		if !h.liveLocAllowed(d, chatID) {
			return
		}
		out := map[string]any{"userId": d.uid, "until": m["until"]}
		if blob := mstr(m, "blob"); blob != "" {
			out["blob"] = blob // E2E path (preferred)
		} else if lat, has := m["latitude"]; has && lat != nil {
			out["latitude"] = lat // legacy plaintext
			out["longitude"] = m["longitude"]
			out["address"] = m["address"]
		}
		s.To(socket.Room("chat:"+chatID)).Emit("live_location_update", out)
	})
	s.On("live_location_stop", func(args ...any) {
		if chatID := mstr(argMap(args), "chatId"); chatID != "" {
			s.To(socket.Room("chat:"+chatID)).Emit("live_location_stop", map[string]any{"userId": d.uid})
		}
	})

	// Typing — routed via fanOutToChat so it reaches every member's user-room
	// and honours hide_typing ghost-mode. uid comes from the CLIENT payload.
	s.On("typing_start", func(args ...any) {
		m := argMap(args)
		if chatID := mstr(m, "chatId"); chatID != "" {
			h.FanOutToChat(bg, chatID, "typing_start", map[string]any{"uid": m["uid"], "chatId": chatID}, "")
		}
	})
	s.On("typing_stop", func(args ...any) {
		m := argMap(args)
		if chatID := mstr(m, "chatId"); chatID != "" {
			h.FanOutToChat(bg, chatID, "typing_stop", map[string]any{"uid": m["uid"], "chatId": chatID}, "")
		}
	})

	s.On("chat_view", func(args ...any) { h.onChatView(s, argMap(args)) })

	// Delivered tick — relay to the chat room (excl. self). Never gated.
	s.On("new_message", func(args ...any) {
		m := argMap(args)
		if chatID := mstr(m, "chatId"); chatID != "" {
			s.To(socket.Room("chat:"+chatID)).Emit("message_delivered", map[string]any{"messageId": m["messageId"]})
		}
	})

	s.On("reaction_updated", func(args ...any) {
		m := argMap(args)
		if chatID := mstr(m, "chatId"); chatID != "" {
			s.To(socket.Room("chat:"+chatID)).Emit("reaction_updated",
				map[string]any{"messageId": m["messageId"], "reactions": m["reactions"]})
		}
	})

	// In-call extras — relay into the chat room (excl. self).
	s.On("call_emoji", func(args ...any) {
		m := argMap(args)
		if chatID := mstr(m, "chatId"); chatID != "" {
			s.To(socket.Room("chat:"+chatID)).Emit("call_emoji", map[string]any{"emoji": m["emoji"], "from": m["from"]})
		}
	})
	s.On("call_chat", func(args ...any) {
		m := argMap(args)
		if chatID := mstr(m, "chatId"); chatID != "" {
			s.To(socket.Room("chat:"+chatID)).Emit("call_chat", map[string]any{"text": m["text"], "from": m["from"]})
		}
	})
}

// liveLocAllowed caches the chat-membership check per socket per chat (RLS,
// server.js db.queryAs). One query per chat for the socket's lifetime.
func (h *Hub) liveLocAllowed(d *sockData, chatID string) bool {
	d.mu.Lock()
	ok, cached := d.liveLocOk[chatID]
	d.mu.Unlock()
	if cached {
		return ok
	}
	ok = false
	_ = db.WithUser(bg, d.uid, func(tx pgx.Tx) error {
		var one int
		if tx.QueryRow(bg,
			`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
			chatID, d.uid).Scan(&one) == nil {
			ok = true
		}
		return nil
	})
	d.mu.Lock()
	d.liveLocOk[chatID] = ok
	d.mu.Unlock()
	return ok
}

// onChatView — ephemeral live-viewer presence (feature #58, server.js chat_view).
func (h *Hub) onChatView(s *socket.Socket, m map[string]any) {
	chatID := mstr(m, "chatId")
	if chatID == "" {
		return
	}
	uid := sd(s).uid
	status := mstr(m, "status")
	activity := mstr(m, "activity")
	resync := truthy(m["resync"])

	if status == "LEFT" {
		h.cvRemove(chatID, uid)
		h.io.To(socket.Room("chat:"+chatID)).Emit("viewer_left", map[string]any{"chatId": chatID, "userId": uid})
		return
	}

	isNew, changed, act := h.cvTouch(chatID, uid, activity)
	if !isNew && !changed && !resync {
		return // plain heartbeat
	}
	hideFrom := h.loadGhostTargets(uid, "hide_online")
	viewers := h.cvList(chatID)

	if isNew {
		for _, v := range viewers {
			if v.UserID == uid || hideFrom[v.UserID] {
				continue
			}
			h.EmitToUid(v.UserID, "viewer_joined", map[string]any{"chatId": chatID, "userId": uid, "activity": act})
		}
	} else if changed {
		for _, v := range viewers {
			if v.UserID == uid || hideFrom[v.UserID] {
				continue
			}
			h.EmitToUid(v.UserID, "viewer_activity", map[string]any{"chatId": chatID, "userId": uid, "activity": act})
		}
	}

	if isNew || resync {
		hiddenFromMe := h.loadGhostOwners(uid, "hide_online")
		list := []cvViewer{}
		for _, v := range viewers {
			if v.UserID != uid && !hiddenFromMe[v.UserID] {
				list = append(list, v)
			}
		}
		s.Emit("viewer_list", map[string]any{"chatId": chatID, "viewers": list})
	}
}

// ── WebRTC / VaultBeam / call signaling (server.js relayToPeer block) ──
func (h *Hub) registerSignalHandlers(s *socket.Socket) {
	d := sd(s)

	// relayToPeer: forward to a specific peer uid, stamping the authenticated
	// sender as from/fromUid (critical for webrtc_end hangup matching).
	relay := func(event string) func(...any) {
		return func(args ...any) {
			m := argMap(args)
			to := mstr(m, "to")
			if to == "" {
				return
			}
			out := copyMap(m)
			out["from"] = d.uid
			out["fromUid"] = d.uid
			h.EmitToUid(to, event, out)
		}
	}
	s.On("webrtc_offer", relay("webrtc_offer"))
	s.On("webrtc_answer", relay("webrtc_answer"))
	s.On("webrtc_ice", relay("webrtc_ice"))
	s.On("webrtc_end", relay("webrtc_end"))
	s.On("e2ee_rekey", relay("e2ee_rekey"))
	s.On("screen_share_start", relay("screen_share_start"))
	s.On("screen_share_stop", relay("screen_share_stop"))
	s.On("vaultbeam_offer", relay("vaultbeam_offer"))
	s.On("vaultbeam_answer", relay("vaultbeam_answer"))
	s.On("vaultbeam_ice", relay("vaultbeam_ice"))
	s.On("vaultbeam_end", relay("vaultbeam_end"))
	s.On("vaultbeam_pull", relay("vaultbeam_pull"))
	s.On("vaultbeam_ready", relay("vaultbeam_ready"))
	s.On("vaultbeam_tier", relay("vaultbeam_tier"))

	// call_incoming — relay over socket AND fire a high-priority wake-up push
	// when the callee has NO live socket (killed/doze).
	s.On("call_incoming", func(args ...any) {
		m := argMap(args)
		to := mstr(m, "to")
		if to == "" {
			return
		}
		out := copyMap(m)
		out["from"] = d.uid
		out["fromUid"] = d.uid
		h.EmitToUid(to, "call_incoming", out)

		if h.hasLiveSocket(to) {
			return // app running → in-app/Notifee already rings; avoid double
		}
		title := mstr(m, "callerName")
		if title == "" {
			title = "Incoming call"
		}
		body, callType := "📞 Voice call", "audio"
		if mstr(m, "type") == "video" {
			body, callType = "📹 Video call", "video"
		}
		data := map[string]any{
			"type":       "call",
			"chatId":     mstr(m, "chatId"),
			"fromUid":    d.uid,
			"callerName": mstr(m, "callerName"),
			"callType":   callType,
		}
		go h.sendCallWakePush(bg, to, title, body, data)
	})

	// Group calls (mesh) — a call room per chat.
	s.On("join_call", func(args ...any) {
		chatID := mstr(argMap(args), "chatId")
		if chatID == "" {
			return
		}
		room := socket.Room("call:" + chatID)
		existing := h.callRoster(room, d.uid)
		s.Join(room)
		s.Emit("call_roster", map[string]any{"chatId": chatID, "peers": existing})
		s.To(room).Emit("call_peer_joined", map[string]any{"chatId": chatID, "uid": d.uid})
	})
	s.On("leave_call", func(args ...any) {
		chatID := mstr(argMap(args), "chatId")
		if chatID == "" {
			return
		}
		room := socket.Room("call:" + chatID)
		s.To(room).Emit("call_peer_left", map[string]any{"chatId": chatID, "uid": d.uid})
		s.Leave(room)
	})
}

// callRoster returns the distinct uids already in a call room (excl. me).
// FetchSockets runs its callback synchronously for the in-memory adapter; the
// channel makes the read safe regardless.
func (h *Hub) callRoster(room socket.Room, me string) []string {
	seen := map[string]bool{}
	out := []string{}
	done := make(chan struct{})
	h.io.In(room).FetchSockets()(func(socks []*socket.RemoteSocket, _ error) {
		for _, rs := range socks {
			if d, ok := rs.Data().(*sockData); ok && d.uid != "" && d.uid != me && !seen[d.uid] {
				seen[d.uid] = true
				out = append(out, d.uid)
			}
		}
		close(done)
	})
	<-done
	return out
}
