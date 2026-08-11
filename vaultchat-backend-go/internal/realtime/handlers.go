package realtime

import (
	"os"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/zishang520/socket.io/v2/socket"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/workx"
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

	// Group trips (Groups & Circles, G5) — the same zero-knowledge relay as live
	// location, reusing its cached membership check.
	//
	// These were missing on BOTH socket owners: the client has emitted
	// trip_update since G5 shipped and nothing listened, so every ping went
	// nowhere and no member ever saw another member's ETA. Socket.IO drops
	// unknown events silently, which is why it looked like it worked.
	//
	// blob is sealed with the trip key the starter published in an E2EE message,
	// so what passes through here is opaque: no destination, no ETA, no route.
	s.On("trip_update", func(args ...any) {
		m := argMap(args)
		chatID := mstr(m, "chatId")
		blob := mstr(m, "blob")
		if chatID == "" || blob == "" {
			return
		}
		if !h.liveLocAllowed(d, chatID) {
			return
		}
		s.To(socket.Room("chat:"+chatID)).Emit("trip_update", map[string]any{
			"userId": d.uid, "tripId": m["tripId"], "blob": blob,
		})
	})
	s.On("trip_end", func(args ...any) {
		m := argMap(args)
		chatID := mstr(m, "chatId")
		if chatID == "" {
			return
		}
		if !h.liveLocAllowed(d, chatID) {
			return
		}
		s.To(socket.Room("chat:"+chatID)).Emit("trip_end", map[string]any{
			"userId": d.uid, "tripId": m["tripId"],
		})
	})

	// Run positions (Spaces & Operations, S2.8). Kept in its own function
	// because, unlike trips, a run fans out to a per-run room rather than to the
	// chat — see registerRunRelay for why.
	h.registerRunRelay(s, d)

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

	// NOTE: the in-call extras (`call_emoji`, `call_chat`) used to be handled
	// here as chat-room broadcasts that re-emitted a CLIENT-supplied `from` —
	// the same spoofing shape the legacy message_edited/message_deleted relays
	// were removed for (see server.js). They are now registered on the
	// authenticated per-peer relay in registerSignalHandlers, which requires a
	// `to`, stamps `from`/`fromUid` from the socket's own uid, and passes the
	// payload through verbatim so the body can be an E2EE envelope rather than
	// plaintext. No client had ever sent or received either event.
}

// ── run position relay (Spaces & Operations, S2.8) ────────────────────
//
// A run's live position is the driver device's sealed ping, tagged with the run
// id. Same zero-knowledge relay as live location and trips: the blob is sealed
// with the space's live-location key and this server forwards bytes it cannot
// read.
//
// WHY A RUN GETS ITS OWN ROOM, WHEN TRIPS BROADCAST TO THE CHAT
//
// A trip belongs to everyone in the group. A run does not: a guardian may
// follow the bus their child is on and no other, which is the same rule the
// runs_select policy and vc_run_visible enforce for the REST API. Fanning a run
// out to "chat:<id>" would hand every parent in a school every bus.
//
// So entitlement is checked once, at SUBSCRIBE, and the room membership is the
// permission — rather than re-checking on every ping, which at one ping per
// second per bus would be a database call per bus per second. A member who
// loses visibility keeps receiving until they disconnect; that window is
// acceptable for a vehicle position and is the reason this is not the model for
// anything finer-grained.
//
// NOTE ON THE KEY. The sealing key is the space's, so it is known to every
// member. The confidentiality boundary here is therefore DELIVERY, not
// cryptography: a member who is not in the run's room never receives the
// ciphertext. Said plainly rather than implied.
func (h *Hub) registerRunRelay(s *socket.Socket, d *sockData) {
	s.On("run_subscribe", func(args ...any) {
		m := argMap(args)
		chatID, runID := mstr(m, "chatId"), mstr(m, "runId")
		if chatID == "" || runID == "" || !h.liveLocAllowed(d, chatID) {
			return
		}
		if !h.runAllowed(d, runID, false) {
			return
		}
		s.Join(socket.Room("run:" + runID))
	})

	s.On("run_unsubscribe", func(args ...any) {
		if runID := mstr(argMap(args), "runId"); runID != "" {
			s.Leave(socket.Room("run:" + runID))
		}
	})

	s.On("run_update", func(args ...any) {
		m := argMap(args)
		chatID, runID, blob := mstr(m, "chatId"), mstr(m, "runId"), mstr(m, "blob")
		if chatID == "" || runID == "" || blob == "" || !h.liveLocAllowed(d, chatID) {
			return
		}
		// Only the assigned driver may claim to be the vehicle. Without this a
		// member could publish a position for a bus they are nowhere near, and
		// every parent watching would believe it.
		if !h.runAllowed(d, runID, true) {
			return
		}
		s.To(socket.Room("run:"+runID)).Emit("run_update", map[string]any{
			"userId": d.uid, "runId": runID, "blob": blob,
		})
	})

	s.On("run_end", func(args ...any) {
		m := argMap(args)
		runID := mstr(m, "runId")
		if runID == "" || !h.runAllowed(d, runID, true) {
			return
		}
		s.To(socket.Room("run:"+runID)).Emit("run_end", map[string]any{
			"userId": d.uid, "runId": runID,
		})
	})
}

// runAllowed caches run entitlement per socket per run.
//
// drive=false asks "may this socket WATCH the run" and defers to vc_run_visible,
// the same SECURITY DEFINER function the REST policies use — one rule, three
// callers. drive=true asks "is this socket the run's driver", which is a plain
// column read and deliberately not the same question: ops may watch every run
// and must still not be able to publish a position for one.
func (h *Hub) runAllowed(d *sockData, runID string, drive bool) bool {
	key := "view:" + runID
	if drive {
		key = "drive:" + runID
	}
	d.mu.Lock()
	ok, cached := d.runOk[key]
	d.mu.Unlock()
	if cached {
		return ok
	}
	ok = false
	_ = db.WithUser(bg, d.uid, func(tx pgx.Tx) error {
		var one bool
		q := `SELECT vc_run_visible($1)`
		if drive {
			q = `SELECT EXISTS (SELECT 1 FROM runs WHERE id = $1 AND driver_id = current_setting('app.current_user_id', true)::uuid AND status = 'started')`
		}
		if tx.QueryRow(bg, q, runID).Scan(&one) == nil {
			ok = one
		}
		return nil
	})
	d.mu.Lock()
	d.runOk[key] = ok
	d.mu.Unlock()
	return ok
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
	// The call's shared media key, sealed with the recipient's per-peer call
	// cipher. Relayed like every other call signal: the server stamps the sender
	// and forwards an opaque blob it cannot read — which is precisely what lets
	// a group call stay end-to-end encrypted while an SFU the client does not
	// have to trust forwards the media.
	s.On("call_media_key", relay("call_media_key"))
	s.On("screen_share_start", relay("screen_share_start"))
	s.On("screen_share_stop", relay("screen_share_stop"))
	// In-call chat + reactions. Addressed like any other call signal so the
	// sender is authenticated and the body stays an opaque E2EE envelope.
	s.On("call_chat", relay("call_chat"))
	s.On("call_emoji", relay("call_emoji"))
	s.On("vaultbeam_offer", relay("vaultbeam_offer"))
	s.On("vaultbeam_answer", relay("vaultbeam_answer"))
	s.On("vaultbeam_ice", relay("vaultbeam_ice"))
	s.On("vaultbeam_end", relay("vaultbeam_end"))
	s.On("vaultbeam_pull", relay("vaultbeam_pull"))
	s.On("vaultbeam_ready", relay("vaultbeam_ready"))
	s.On("vaultbeam_tier", relay("vaultbeam_tier"))
	// have — recipient: sealed verified-chunk bitmap, so the sender can skip
	// what the peer already holds. Opaque routing; the mask never touches
	// this process in cleartext.
	s.On("vaultbeam_have", relay("vaultbeam_have"))

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
		workx.Submit(func() { h.sendCallWakePush(bg, to, title, body, data) }) // P2.2: bounded, not raw-spawned
	})

	// Group calls (mesh) — a call room per chat. In cluster mode the roster
	// lives in Redis (cluster.go) because FetchSockets on the local adapter
	// only sees THIS node's sockets; the room join/leave still happens so the
	// Redis adapter carries the in-room emits across nodes (P2.1).
	s.On("join_call", func(args ...any) {
		chatID := mstr(argMap(args), "chatId")
		if chatID == "" {
			return
		}
		room := socket.Room("call:" + chatID)
		var existing []string
		if ClusterEnabled() {
			existing = clusterCallRoster(chatID, d.uid)
		} else {
			existing = h.callRoster(room, d.uid)
		}
		// P6.1: enforce the mesh cap SERVER-side. This is a full mesh — each
		// participant holds N-1 RTCPeerConnections and uploads N-1 encoded
		// streams, so cost grows quadratically across the call and linearly
		// per phone. Past ~5-6 the uplink/CPU on mid-tier mobile collapses and
		// the call degrades for EVERYONE already in it, not just the joiner.
		// Refusing the join is strictly better than admitting them and melting
		// the room. The client shows a "call is full" notice (call_full).
		// Raising this is an SFU decision, not a config decision — see
		// SCALEOUT.md; MESH_MAX_PARTICIPANTS exists to lower it, or to raise
		// it deliberately once an SFU terminates the media instead of peers.
		if max := meshMaxParticipants(); len(existing)+1 > max {
			// The single most actionable call metric: every increment is a real
			// person refused entry to a call in progress. A rising rate is the
			// evidence that the mesh cap is costing users something, and the
			// argument for the SFU — or for raising MESH_MAX_PARTICIPANTS.
			metrics.Inc("call_mesh_full")
			s.Emit("call_full", map[string]any{
				"chatId": chatID, "max": max, "reason": "mesh_capacity",
			})
			return
		}
		if ClusterEnabled() {
			clusterCallJoin(chatID, d.uid)
		}
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
		if ClusterEnabled() {
			clusterCallLeave(chatID, d.uid)
		}
	})
}

// meshMaxParticipants is the hard ceiling on a full-mesh group call,
// including the joiner. Default 5: at 5 participants each phone already runs
// 4 peer connections and 4 outbound encodes. MESH_MAX_PARTICIPANTS overrides
// it; values <2 are ignored (a call needs at least two people).
func meshMaxParticipants() int {
	if v, err := strconv.Atoi(os.Getenv("MESH_MAX_PARTICIPANTS")); err == nil && v >= 2 {
		return v
	}
	return 5
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
