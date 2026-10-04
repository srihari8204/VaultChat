package realtime

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/metrics"
	"vaultchat/backend-go/internal/redisx"
	"vaultchat/backend-go/internal/workx"
)

// ── shared payload helpers ────────────────────────────────────────────
//
// ONE BOUNDS GATE, NOT THIRTY.
//
// Every handler in this file starts with argMap, so argMap is where the trust
// boundary is. It used to be `args[0].(map[string]any)` and nothing else: an
// untyped map of whatever the client sent, with no schema, no type checks and
// no lengths. The only ceiling anywhere was the 2 MB socket frame in server.go,
// and roughly fifteen of these events are RELAYS — the server copies the map
// and forwards it verbatim into another user's event handlers. So "2 MB" was
// also the size of the JSON one account could inject into another's client.
//
// What this can and cannot check:
//
//	SHAPE, yes. Field count, key length, value types, string lengths, array
//	counts, nesting depth, and a whole-payload budget.
//
//	CONTENT, no — and deliberately not. The relayed bodies are E2EE envelopes
//	(SDP sealed per peer, call media keys, VaultBeam chunk bitmaps, rekey
//	material). This process has no key for any of them and must not grow one.
//
//	FIELD NAMES, no allowlist. A per-event schema would be the stricter thing,
//	but the relays forward fields this file has never enumerated and a deployed
//	client that still sends one must keep working. Bounded-but-unnamed is the
//	line that holds without a forced client update.
//
// A violation DROPS the event and logs. It never disconnects: the brief says a
// bug in one client must not kick that user offline, and a drop is also the
// behaviour every other refusal in this file already has.
const (
	maxEventFields = 32        // fields in one object; real payloads use <10
	maxKeyLen      = 64        // "longitude" is 9
	maxStringLen   = 192 << 10 // one sealed field: SDP, chunk bitmap, envelope
	maxPayloadLen  = 256 << 10 // whole event — 8x under the 2 MB frame
	maxArrayLen    = 1024      // e.g. a reaction list
	maxDepth       = 6         // trip "plain" and reaction objects are 2-3
)

// bounded walks one decoded JSON value, charging every element against a single
// shared budget so a payload cannot be large by being deep, wide, or long — only
// by being all three under the cap. Returns false at the first violation.
func bounded(v any, depth int, budget *int) bool {
	if depth > maxDepth || *budget <= 0 {
		return false
	}
	switch t := v.(type) {
	case nil, bool, float64, int, int64, json.Number:
		*budget -= 8
	case string:
		if len(t) > maxStringLen {
			return false
		}
		*budget -= len(t) + 8
	case []byte: // socket.io binary placeholder; bounded like a string
		if len(t) > maxStringLen {
			return false
		}
		*budget -= len(t) + 8
	case []any:
		if len(t) > maxArrayLen {
			return false
		}
		for _, e := range t {
			if !bounded(e, depth+1, budget) {
				return false
			}
		}
	case map[string]any:
		if len(t) > maxEventFields {
			return false
		}
		for k, e := range t {
			if len(k) > maxKeyLen {
				return false
			}
			*budget -= len(k) + 8
			if !bounded(e, depth+1, budget) {
				return false
			}
		}
	default:
		// Not a value the JSON decoder produces. Refusing beats relaying a type
		// this server cannot reason about into someone else's client.
		return false
	}
	return *budget > 0
}

// argMap returns the event payload, or nil if it is absent, not an object, or
// out of bounds. Every caller already drops on a missing field, so nil is the
// drop — no handler needs its own check.
func argMap(event string, args []any) map[string]any {
	if len(args) == 0 {
		return nil
	}
	m, ok := args[0].(map[string]any)
	if !ok {
		return nil
	}
	budget := maxPayloadLen
	if !bounded(m, 0, &budget) {
		// Logged, not silent: this fires on a hostile client or on a real one
		// that has outgrown a limit, and those need telling apart.
		log.Printf("[socket] dropped %s: payload out of bounds (%d fields)", event, len(m))
		metrics.Inc("socket_payload_rejected")
		return nil
	}
	return m
}

func mstr(m map[string]any, k string) string { s, _ := m[k].(string); return s }

// latLng type- and range-checks the legacy plaintext location fields. The E2E
// blob path is preferred and untouched by this — there is nothing to check in
// ciphertext.
func latLng(m map[string]any) (lat, lng float64, ok bool) {
	lat, okA := m["latitude"].(float64)
	lng, okB := m["longitude"].(float64)
	if !okA || !okB || lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		return 0, 0, false
	}
	return lat, lng, true
}

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
func (h *Hub) registerChatHandlersPeer(s *eventPeer) {
	d := s.data

	// AUTHORIZE THE ROOM, do not take the client's word for it.
	//
	// This used to join whatever chatId arrived. Room membership was therefore
	// SELF-ASSERTED: any authenticated socket could join chat:<id> and receive
	// that chat's fan-out — FanOutToChat emits unfiltered events straight to the
	// room, and this file sends live_location_update, trip_update, trip_end,
	// reaction_updated and message_delivered there too.
	//
	// Guessing a chat UUID is not the threat. A REMOVED MEMBER is: they already
	// know the id, and nothing here re-checked whether they still belong, so a
	// stale client could keep listening to a chat it had been removed from.
	//
	// chatMemberAllowed is the same cached `chat_members … left_at IS NULL`
	// check the live-location and trip handlers already gate on — reused rather
	// than reinvented, so there is one definition of "is a member".
	s.On("join_chat", func(args ...any) {
		id := mstr(argMap("join_chat", args), "chatId")
		if id == "" {
			return
		}
		if !h.chatMemberAllowed(d, id, s.Context()) {
			// Logged, not silent: a refusal here means a client believes it
			// belongs to a chat the database disagrees about, and that is worth
			// seeing rather than guessing at.
			log.Printf("[join_chat] refused uid=%s chat=%s (not a current member)", d.uid, id)
			metrics.Inc("socket_join_chat_refused")
			return
		}
		if !s.Join(Room("chat:" + id)) {
			return
		}
	})
	s.On("leave_chat", func(args ...any) {
		if id := mstr(argMap("leave_chat", args), "chatId"); id != "" {
			s.Leave(Room("chat:" + id))
		}
	})

	// Same rule as join_chat: the room is authorised, not self-asserted. Only
	// the channel's admin or a current subscriber may listen, so someone who
	// left (POST /channels/{id}/leave) cannot rejoin the live feed.
	s.On("channel_join", func(args ...any) {
		if id := mstr(argMap("channel_join", args), "channelId"); id != "" {
			if !h.channelAllowed(d, id, s.Context()) {
				log.Printf("[channel_join] refused uid=%s channel=%s (not a subscriber)", d.uid, id)
				metrics.Inc("socket_channel_join_refused")
				return
			}
			if !s.Join(Room("channel:" + id)) {
				return
			}
		}
	})
	s.On("channel_leave", func(args ...any) {
		if id := mstr(argMap("channel_leave", args), "channelId"); id != "" {
			s.Leave(Room("channel:" + id))
		}
	})

	// Live location — zero-knowledge relay into the chat room (excl. self),
	// gated on a per-socket cached membership check (server.js).
	s.On("live_location_update", func(args ...any) {
		m := argMap("live_location_update", args)
		chatID := mstr(m, "chatId")
		if chatID == "" {
			return
		}
		if !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		out := map[string]any{"userId": d.uid, "until": m["until"]}
		if blob := mstr(m, "blob"); blob != "" {
			out["blob"] = blob // E2E path (preferred)
		} else if lat, lng, ok := latLng(m); ok {
			// Legacy plaintext path. The coordinates are now TYPE- and
			// RANGE-checked: they used to be forwarded as whatever `any` arrived,
			// so a string or an object landed straight in the peer's map pin.
			out["latitude"] = lat
			out["longitude"] = lng
			out["address"] = mstr(m, "address")
		}
		s.To(Room("chat:"+chatID)).Emit("live_location_update", out)
	})
	s.On("live_location_stop", func(args ...any) {
		if chatID := mstr(argMap("live_location_stop", args), "chatId"); chatID != "" {
			s.To(Room("chat:"+chatID)).Emit("live_location_stop", map[string]any{"userId": d.uid})
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
	// TWO PAYLOAD SHAPES, ONE RELAY:
	//   blob  — legacy trips, sealed with the trip key the starter published in
	//           an E2EE message; opaque here (no destination, ETA or route).
	//   plain — server-backed trips (migration 113). Space activities are exempt
	//           from E2EE by owner directive, and a plain ping carries only
	//           DERIVED numbers (remaining metres, an ETA, an arrived flag) —
	//           never a position, so it discloses nothing presence does not.
	// Membership is enforced identically for both; a ping with neither field is
	// dropped rather than fanned out empty.
	s.On("trip_update", func(args ...any) {
		m := argMap("trip_update", args)
		chatID := mstr(m, "chatId")
		blob := mstr(m, "blob")
		plain, hasPlain := m["plain"]
		if chatID == "" || (blob == "" && !hasPlain) {
			return
		}
		if !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		out := map[string]any{"userId": d.uid, "tripId": m["tripId"]}
		if blob != "" {
			out["blob"] = blob
		}
		if hasPlain {
			out["plain"] = plain
		}
		s.To(Room("chat:"+chatID)).Emit("trip_update", out)
	})
	s.On("trip_end", func(args ...any) {
		m := argMap("trip_end", args)
		chatID := mstr(m, "chatId")
		if chatID == "" {
			return
		}
		if !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		s.To(Room("chat:"+chatID)).Emit("trip_end", map[string]any{
			"userId": d.uid, "tripId": m["tripId"],
		})
	})

	// Run positions (Spaces & Operations, S2.8). Kept in its own function
	// because, unlike trips, a run fans out to a per-run room rather than to the
	// chat — see registerRunRelay for why.
	h.registerRunRelayPeer(s, d)

	// Family Space Emergency Connect — the kill-safe leg (F7.1). Mirrors
	// server.js: relay into the circle room, then wake only the members the
	// relay did NOT reach, exactly like call_incoming. The payload is
	// CONTENT-FREE — the alert text lives in the E2EE audit message, which this
	// server cannot read.
	//
	// Membership gate is chatMemberAllowed, the same one live location and trips
	// use: a Circle IS a chat, so it is the identical question.
	s.On("family_emergency", func(args ...any) {
		chatID := mstr(argMap("family_emergency", args), "chatId")
		if chatID == "" || !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		s.To(Room("chat:"+chatID)).Emit("family_emergency",
			map[string]any{"chatId": chatID, "userId": d.uid})

		uid := d.uid
		// bg, not s.Context(): the wake-up push outlives this handler and must
		// not be cancelled when the socket's request context ends.
		workx.Submit(func() { h.familyEmergencyWake(bg, chatID, uid) }) // bounded, not raw-spawned
	})
	// Typing — routed via fanOutToChat so it reaches every member's user-room
	// and honours hide_typing ghost-mode.
	//
	// THE uid IS THE SOCKET'S, NOT THE PAYLOAD'S.
	//
	// It used to be m["uid"] — a client-declared identity, fanned out verbatim
	// to every member of the chat on a channel the app treats as trusted. Any
	// account could therefore make any other account appear to be typing in any
	// chat it could name. Worse than the cosmetic version of that bug:
	// delivery.go's senderOfEvent reads the SAME field to decide whose
	// hide_typing ghost-mode applies, so a spoofed uid also picked the victim's
	// privacy settings for them.
	//
	// d.uid comes from the verified JWT in the handshake middleware and cannot
	// be influenced by the payload. The client still SENDS uid (lib/socket.ts
	// emitTypingStart) and that stays on the wire untouched — it is simply no
	// longer read, so no deployed client changes.
	//
	// Membership is now required too, for the same reason join_chat is: FanOutToChat
	// reaches every member's user-room directly, bypassing the chat room, so
	// without this a non-member could inject typing into any chat by id.
	typing := func(event string) func(...any) {
		return func(args ...any) {
			chatID := mstr(argMap(event, args), "chatId")
			if chatID == "" || !h.chatMemberAllowed(d, chatID, s.Context()) {
				return
			}
			h.FanOutToChat(s.Context(), chatID, event, map[string]any{"uid": d.uid, "chatId": chatID}, "")
		}
	}
	s.On("typing_start", typing("typing_start"))
	s.On("typing_stop", typing("typing_stop"))

	s.On("chat_view", func(args ...any) { h.onChatViewPeer(s, argMap("chat_view", args)) })

	// Delivered tick + reactions — relays into the chat room (excl. self).
	//
	// Both were "never gated", and `s.To(room)` broadcasts to a room whether or
	// not this socket is IN it — so join_chat's membership check never covered
	// these. Any authenticated account could push a message_delivered tick, or
	// an arbitrary `reactions` object, into any chat it could name. Same cached
	// check as every other publish path here.
	s.On("new_message", func(args ...any) {
		m := argMap("new_message", args)
		chatID := mstr(m, "chatId")
		if chatID == "" || !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		s.To(Room("chat:"+chatID)).Emit("message_delivered", map[string]any{"messageId": m["messageId"]})
	})

	s.On("reaction_updated", func(args ...any) {
		m := argMap("reaction_updated", args)
		chatID := mstr(m, "chatId")
		if chatID == "" || !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		s.To(Room("chat:"+chatID)).Emit("reaction_updated",
			map[string]any{"messageId": m["messageId"], "reactions": m["reactions"]})
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
// # WHY A RUN GETS ITS OWN ROOM, WHEN TRIPS BROADCAST TO THE CHAT
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
func (h *Hub) registerRunRelayPeer(s *eventPeer, d *sockData) {
	s.On("run_subscribe", func(args ...any) {
		m := argMap("run_subscribe", args)
		chatID, runID := mstr(m, "chatId"), mstr(m, "runId")
		if chatID == "" || runID == "" || !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		if !h.runAllowed(d, runID, false, s.Context()) {
			return
		}
		if !s.Join(Room("run:" + runID)) {
			return
		}
	})

	s.On("run_unsubscribe", func(args ...any) {
		if runID := mstr(argMap("run_unsubscribe", args), "runId"); runID != "" {
			s.Leave(Room("run:" + runID))
		}
	})

	s.On("run_update", func(args ...any) {
		m := argMap("run_update", args)
		chatID, runID, blob := mstr(m, "chatId"), mstr(m, "runId"), mstr(m, "blob")
		if chatID == "" || runID == "" || blob == "" || !h.chatMemberAllowed(d, chatID, s.Context()) {
			return
		}
		// Only the assigned driver may claim to be the vehicle. Without this a
		// member could publish a position for a bus they are nowhere near, and
		// every parent watching would believe it.
		if !h.runAllowed(d, runID, true, s.Context()) {
			return
		}
		s.To(Room("run:"+runID)).Emit("run_update", map[string]any{
			"userId": d.uid, "runId": runID, "blob": blob,
		})
	})

	s.On("run_end", func(args ...any) {
		m := argMap("run_end", args)
		runID := mstr(m, "runId")
		if runID == "" || !h.runAllowed(d, runID, true, s.Context()) {
			return
		}
		s.To(Room("run:"+runID)).Emit("run_end", map[string]any{
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
func (h *Hub) runAllowed(d *sockData, runID string, drive bool, parents ...context.Context) bool {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return false
	}
	key := "view:" + runID
	if drive {
		key = "drive:" + runID
	}
	// Run entitlement follows the same generation as the run's space chat: being
	// dropped from a run is the same class of change as being dropped from a
	// group, and had the same lifetime bug (audit F02).
	gen := permGenerationOf(runID)
	d.mu.Lock()
	entry, cached := d.runOk[key]
	d.mu.Unlock()
	if cached && entry.fresh(gen) {
		return entry.ok
	}
	ok := false
	_ = db.WithUser(ctx, d.uid, func(tx pgx.Tx) error {
		var one bool
		q := `SELECT vc_run_visible($1)`
		if drive {
			q = `SELECT EXISTS (SELECT 1 FROM runs WHERE id = $1 AND driver_id = current_setting('app.current_user_id', true)::uuid AND status = 'started')`
		}
		if tx.QueryRow(ctx, q, runID).Scan(&one) == nil {
			ok = one
		}
		return nil
	})
	d.mu.Lock()
	d.runOk[key] = cachedPerm{ok: ok, gen: gen, at: time.Now()}
	d.mu.Unlock()
	return ok
}

// channelAllowed is THE broadcast-channel room check, shared by channel_join,
// the CC-Wire SCOPE_KIND_CHANNEL subscribe and the per-delivery recheck
// (canReceiveRooms): the channel's admin or a row in channel_subscribers.
// Cached per socket like chat membership, under the key "channel:<id>" with
// its own generation, which BumpChannelPermissions (called by the REST leave
// and join) invalidates. Fails closed with no database.
func (h *Hub) channelAllowed(d *sockData, channelID string, parents ...context.Context) bool {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return false
	}
	key := "channel:" + channelID
	gen := permGenerationOf(key)
	d.mu.Lock()
	entry, cached := d.chatMemberOk[key]
	d.mu.Unlock()
	if cached && entry.fresh(gen) {
		return entry.ok
	}
	if db.Pool == nil {
		return false
	}
	ok := false
	if err := db.Pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM channels c
		                 WHERE c.id::text = $1
		                   AND (c.admin_id::text = $2
		                        OR EXISTS (SELECT 1 FROM channel_subscribers cs
		                                    WHERE cs.channel_id = c.id AND cs.user_id::text = $2)))`,
		channelID, d.uid).Scan(&ok); err != nil {
		return false // not cached: a transient error must not stick for permTTL
	}
	d.mu.Lock()
	if d.chatMemberOk == nil {
		d.chatMemberOk = map[string]cachedPerm{}
	}
	d.chatMemberOk[key] = cachedPerm{ok: ok, gen: gen, at: time.Now()}
	d.mu.Unlock()
	return ok
}

// BumpChannelPermissions drops every socket's cached channel-room decision for
// this channel, so a leave takes effect on the next delivery instead of after
// permTTL. Per-process, like BumpChatPermissions (permTTL bounds other replicas).
func BumpChannelPermissions(channelID string) { BumpChatPermissions("channel:" + channelID) }

// chatMemberAllowed caches the chat-membership check per socket per chat (RLS,
// server.js db.queryAs). One query per chat for the socket's lifetime.
func (h *Hub) chatMemberAllowed(d *sockData, chatID string, parents ...context.Context) bool {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return false
	}
	gen := permGenerationOf(chatID)
	d.mu.Lock()
	entry, cached := d.chatMemberOk[chatID]
	d.mu.Unlock()
	// Only a decision made at the current generation, recently, may be reused —
	// otherwise a member removed mid-connection keeps publishing (audit F02).
	if cached && entry.fresh(gen) {
		return entry.ok
	}
	ok := false
	_ = db.WithUser(ctx, d.uid, func(tx pgx.Tx) error {
		var one int
		if tx.QueryRow(ctx,
			`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND left_at IS NULL LIMIT 1`,
			chatID, d.uid).Scan(&one) == nil {
			ok = true
		}
		return nil
	})
	d.mu.Lock()
	d.chatMemberOk[chatID] = cachedPerm{ok: ok, gen: gen, at: time.Now()}
	d.mu.Unlock()
	return ok
}

// peerAllowed reports whether this socket may address a per-peer relay to `to`.
//
// The rule is the one broadcastPresence already applies: the two accounts share
// at least one live chat. Reusing it rather than inventing a second notion of
// "may reach" means the relay surface can never be wider than the presence
// surface — if you are not allowed to know they are online, you cannot ring
// them, rekey with them or open a VaultBeam to them.
//
// ponytail: TTL-only caching, no generation. Chat generations are keyed by chat
// id and this decision is keyed by peer, so a bump cannot find it; permTTL (30s)
// is the bound instead. Losing the last shared chat with someone therefore
// leaves a ≤30s window in which signalling still reaches them — the same
// backstop the other caches rely on in cluster mode. Key it by chat and bump it
// if that window ever matters.
func (h *Hub) peerAllowed(d *sockData, to string, parents ...context.Context) bool {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return false
	}
	if d == nil || to == "" {
		return false
	}
	if to == d.uid {
		return true // own other devices — always addressable
	}
	d.mu.Lock()
	if d.peerOk == nil {
		d.peerOk = map[string]cachedPerm{}
	}
	entry, cached := d.peerOk[to]
	d.mu.Unlock()
	if cached && entry.fresh(0) {
		return entry.ok
	}
	ok := false
	_ = db.WithUser(ctx, d.uid, func(tx pgx.Tx) error {
		var one int
		if tx.QueryRow(ctx,
			`SELECT 1 FROM chat_members mine
			   JOIN chat_members theirs ON theirs.chat_id = mine.chat_id
			  WHERE mine.user_id = $1 AND mine.left_at IS NULL
			    AND theirs.user_id = $2 AND theirs.left_at IS NULL
			  LIMIT 1`, d.uid, to).Scan(&one) == nil {
			ok = true
		}
		return nil
	})
	d.mu.Lock()
	d.peerOk[to] = cachedPerm{ok: ok, gen: 0, at: time.Now()}
	d.mu.Unlock()
	if !ok {
		log.Printf("[relay] refused uid=%s → %s (no shared chat)", d.uid, to)
		metrics.Inc("socket_relay_refused")
	}
	return ok
}

// onChatView — ephemeral live-viewer presence (feature #58, server.js chat_view).
//
// Gated like every other chat publisher in this file: cvList returns the uids
// of everyone viewing, and a join announces the caller into the chat's room, so
// an ungated call read and wrote presence for any chat id a client could name.
func (h *Hub) onChatViewPeer(s *eventPeer, m map[string]any) {
	chatID := mstr(m, "chatId")
	if chatID == "" {
		return
	}
	d := s.data
	if !h.chatMemberAllowed(d, chatID, s.Context()) {
		return
	}
	uid := d.uid
	status := mstr(m, "status")
	activity := mstr(m, "activity")
	resync := truthy(m["resync"])

	if status == "LEFT" {
		h.cvRemove(chatID, uid, s.Context())
		h.emitRooms([]string{"chat:" + chatID}, "", "viewer_left", map[string]any{"chatId": chatID, "userId": uid}, s.Context())
		return
	}

	isNew, changed, act := h.cvTouch(chatID, uid, activity, s.Context())
	if !isNew && !changed && !resync {
		return // plain heartbeat
	}
	hideFrom := h.loadGhostTargets(uid, "hide_online", s.Context())
	viewers := h.cvList(chatID, s.Context())

	if isNew {
		for _, v := range viewers {
			if v.UserID == uid || hideFrom[v.UserID] {
				continue
			}
			h.emitToUidContext(s.Context(), v.UserID, "viewer_joined", map[string]any{"chatId": chatID, "userId": uid, "activity": act})
		}
	} else if changed {
		for _, v := range viewers {
			if v.UserID == uid || hideFrom[v.UserID] {
				continue
			}
			h.emitToUidContext(s.Context(), v.UserID, "viewer_activity", map[string]any{"chatId": chatID, "userId": uid, "activity": act})
		}
	}

	if isNew || resync {
		hiddenFromMe := h.loadGhostOwners(uid, "hide_online", s.Context())
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
func (h *Hub) registerSignalHandlersPeer(s *eventPeer) {
	d := s.data

	// relayToPeer: forward to a specific peer uid, stamping the authenticated
	// sender as from/fromUid (critical for webrtc_end hangup matching).
	//
	// AUTHORISE THE RECIPIENT, not just the sender.
	//
	// `from` was already trustworthy — it is stamped from the socket, not read
	// from the payload — but `to` was any uid on the platform. Fifteen events
	// route through here, so a stranger could push a call offer, a rekey, a
	// VaultBeam invite or an in-call chat envelope straight into any account's
	// handlers, unsolicited, with nothing but a uid.
	//
	// peerAllowed is the rule presence already uses ("shares a live chat"), so
	// this adds no new notion of who may reach whom: if you cannot see that
	// they are online, you cannot signal them. Every real caller qualifies —
	// calls, rekeys and beams all start from a chat the two parties are in.
	relay := func(event string) func(...any) {
		return func(args ...any) {
			m := argMap(event, args)
			to := mstr(m, "to")
			if to == "" || !h.peerAllowed(d, to, s.Context()) {
				return
			}
			out := copyMap(m)
			out["from"] = d.uid
			out["fromUid"] = d.uid
			h.emitToUidContext(s.Context(), to, event, out)
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
		m := argMap("call_incoming", args)
		to := mstr(m, "to")
		// Same entitlement as every other per-peer relay: ringing a stranger is
		// the one of these that also lights up their screen.
		if to == "" || !h.peerAllowed(d, to, s.Context()) {
			return
		}
		// Ringing is the one socket event that costs the RECIPIENT something:
		// below it fires a high-priority FCM push that wakes a dozing device
		// and can bypass Do Not Disturb. Nothing limited it. POST /calls has a
		// limiter (call_sessions.go) but the client does not go through that
		// path, so in practice ringing was unmetered.
		//
		// The budget is set by legitimate behaviour, not by what feels polite:
		// ringAndOffer re-emits every 3 s up to 9 times per call (lib/call/
		// signal.ts), so one call is ~10 events, and ringGroup emits once per
		// member. 120/min therefore absorbs a full re-ring of a large group
		// plus redials, and still stops an automated flood.
		//
		// Keyed on the CALLER's uid — an account is what gets banned, and a
		// per-IP key would punish everyone behind one carrier NAT. Consume
		// fails OPEN, so a Redis outage degrades to today's behaviour rather
		// than silencing every call on the platform.
		if rl := redisx.Consume(s.Context(), "call:ring:"+d.uid, callRingLimit, callRingWindowSec); !rl.Allowed {
			metrics.Inc("call_ring_rate_limited")
			return
		}
		out := copyMap(m)
		out["from"] = d.uid
		out["fromUid"] = d.uid
		h.emitToUidContext(s.Context(), to, "call_incoming", out)

		// NO PUSH FROM HERE — /call/initiate already owns the ring.
		//
		// This block was a SECOND, independent ring mechanism. The caller's
		// engine calls nativeCall.ringPeer (engine.ts:1176) on every outgoing
		// call, which POSTs /call/initiate, and routes/calls.go pushes an FCM
		// with type="incoming_call", the caller's id and their photo. The native
		// VaultCallMessagingService handles exactly that type and posts the
		// full-screen ring.
		//
		// This one pushed type="call" with no callerId and no photo, which the
		// native service does not handle at all — so it was rendered by the JS
		// notifee layer instead. That is why one call produced TWO notifications
		// and why only one of them had an avatar: two server paths, two
		// renderers, one call. Measured on device during a live ring as
		// id=50193 channel=vaultchat_incoming_calls next to a notifee entry on
		// channel=calls.
		//
		// Deleting this leaves one ring, with the richer payload, rendered by
		// the one component that can also ring a killed app. The socket relay
		// above is untouched: an app that IS running still gets call_incoming
		// and shows its in-app screen.
	})

	// Group calls (mesh) — a call room per chat. In cluster mode the roster
	// lives in Redis (cluster.go) because FetchSockets on the local adapter
	// only sees THIS node's sockets; the room join/leave still happens so the
	// Redis adapter carries the in-room emits across nodes (P2.1).
	s.On("join_call", func(args ...any) {
		chatID := mstr(argMap("join_call", args), "chatId")
		if chatID == "" {
			return
		}
		// MEMBERSHIP, not merely authentication.
		//
		// This checked nothing but "is chatId non-empty", so any signed-in
		// account could join the call room of any chat it could name: it
		// received call_roster (the uid list of everyone on a private call),
		// was announced to every participant as call_peer_joined, and then got
		// every in-room event for the rest of the call.
		//
		// chatMemberAllowed is the same cached chat_members check this file
		// already applies to live location and trips — strictly less sensitive
		// data than the membership of a call in progress.
		//
		// Silent return, like every other refusal here: Socket.IO drops
		// unknown/ignored events without a reply, and telling a prober whether
		// a chat id exists is itself the leak.
		//
		// Only the group path reaches this. A 1:1 call never emits join_call —
		// its signalling is addressed per-uid — so this cannot refuse one.
		//
		// ponytail: chatMemberAllowed caches the NEGATIVE too, for the socket's
		// lifetime. Someone refused before being added to the chat stays
		// refused until they reconnect. Narrow (it needs a join attempt made
		// before joining the group) and self-healing, and it is the behaviour
		// the three existing relays already have. Give the call path its own
		// positive-only cache if that window ever shows up in call_join_denied.
		if !h.chatMemberAllowed(d, chatID, s.Context()) {
			metrics.Inc("call_join_denied")
			return
		}
		room := Room("call:" + chatID)
		var existing []string
		if ClusterEnabled() {
			existing = clusterCallRoster(chatID, d.uid, s.Context())
		} else {
			existing = h.callRoster(room, d.uid, s.Context())
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
		if !s.Join(room) {
			return
		}
		if ClusterEnabled() {
			clusterCallJoin(chatID, d.uid, s.Context())
		}
		s.Emit("call_roster", map[string]any{"chatId": chatID, "peers": existing})
		s.To(room).Emit("call_peer_joined", map[string]any{"chatId": chatID, "uid": d.uid})
	})
	s.On("leave_call", func(args ...any) {
		chatID := mstr(argMap("leave_call", args), "chatId")
		if chatID == "" {
			return
		}
		room := Room("call:" + chatID)
		s.To(room).Emit("call_peer_left", map[string]any{"chatId": chatID, "uid": d.uid})
		s.Leave(room)
		if ClusterEnabled() {
			clusterCallLeave(chatID, d.uid, s.Context())
		}
	})
}

// How many call_incoming events one account may emit per window. See the
// handler for why the number is this large: it must never interrupt a real
// re-ring, only automation.
const (
	callRingLimit     = 120
	callRingWindowSec = 60
)

// ONE WAKE-UP PUSH PER CALL, not one per ring.
//
// ringAndOffer re-emits call_incoming every 3s for up to 9 repeats, and the
// push below fired on EVERY one of them that found no live socket. The callee
// got a stream of notifications for a single call — measured on device as three
// FCM deliveries 3s apart (19:23:53 / :56 / :59) — where every other messenger
// shows exactly one.
//
// The push only has to WAKE the device; once awake the socket delivers the
// re-rings, and the notification the native service posts uses a fixed id, so
// the ring persists without being re-sent. Re-pushing adds noise, not
// reachability.
//
// The window outlasts a full ring cycle (9 x 3s = 27s) so no repeat inside one
// call gets through, while a genuine redial afterwards still rings. Keyed by
// caller+callee+chat so a second caller is never suppressed. Consume fails OPEN,
// so a Redis outage degrades to the old chatty behaviour rather than silencing
// calls.
const callPushDedupeSec = 40

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
func (h *Hub) callRoster(room Room, me string, parents ...context.Context) []string {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	for _, uid := range h.ccwireCallRoster(string(room), me) {
		if !seen[uid] {
			seen[uid] = true
			out = append(out, uid)
		}
	}
	return out
}
