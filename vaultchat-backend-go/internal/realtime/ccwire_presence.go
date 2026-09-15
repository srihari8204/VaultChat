// CC-Wire presence — viewer_state (82) and geo_relay (84), the two EPHEMERAL
// presence bodies a client may SEND.
//
// WHAT THE PROTO ACTUALLY SAYS, body by body (proto/ccwire/v1/envelope.proto):
//
//	presence_update (80) — PresenceUpdate{user_id, online, last_seen_ms}.
//	  Every field is server-authored: a client telling the server that some
//	  user is online is not a request, it is an assertion the server already
//	  owns (presence.go onUserOnline/onUserOffline, driven by socket tracking).
//	  It is also NOT in the EPHEMERAL allow-list, so it cannot even ride the
//	  traffic class. OUTBOUND ONLY — deliberately left unserved here, so it
//	  falls through to UNKNOWN_OPERATION.
//
//	viewer_state (82) — ViewerState{chat_id, activity, leaving, resync}. All
//	  four are client intent. INBOUND, and on the EPHEMERAL allow-list. This is
//	  the CC-Wire spelling of the Socket.IO `chat_view` event.
//
//	viewer_list (83) — ViewerList{chat_id, repeated Viewer}. The roster is the
//	  server's; `Viewer.user_id` is another user's identity, which a client
//	  cannot supply. REPLY SHAPE — same argument cursor_batch (65) is left
//	  unserved. It is EMITTED from here, never accepted, and only ever to the
//	  session that asked, which by then has passed the chat's membership gate.
//	  Not on the EPHEMERAL allow-list either, so it rides SYNC like CursorBatch.
//
//	geo_relay (84) — GeoRelay{scope_kind, scope_id, subject_id, sealed, ended,
//	  until_ms, sender_uid}. `sender_uid` is "server-stamped on delivery", the
//	  rest is client intent. INBOUND, on the EPHEMERAL allow-list.
//
// NOTHING HERE WRITES TO POSTGRES. Viewer presence lives in the Redis hash
// delivery.go owns (cv:h:<chat>) and nowhere else; a geo relay is forwarded and
// forgotten. The only database reads are the ghost-mode lookups presence.go
// already does, and the membership gate's own cache miss.
//
// THE SERVER STAYS BLIND TO COORDINATES. GeoRelay.sealed is opaque bytes: it is
// re-emitted base64'd into the `blob` field the Socket.IO live-location relay
// already carries, and it is never parsed, never ranged-checked, never logged.
// envelope.proto is explicit that CC-Wire has no plaintext lat/lng path at all.
package realtime

import (
	"encoding/base64"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/metrics"
)

// ── activity, both directions ───────────────────────────────────────────
//
// The Redis hash stores the Socket.IO activity STRING; the proto carries the
// ViewerActivity enum. One table, read both ways, so the two transports cannot
// drift into different vocabularies.

var viewerActivityWire = map[uint32]string{
	1: "reading",
	2: "typing",
	3: "uploading",
}

// viewerActivityEnum is the inverse. An activity string this build does not
// know surfaces as VIEWER_ACTIVITY_UNSPECIFIED (0) rather than being dropped —
// the same rule the codec applies to unknown enum numbers.
func viewerActivityEnum(s string) uint64 {
	for n, name := range viewerActivityWire {
		if name == s {
			return uint64(n)
		}
	}
	return 0
}

// ── inbound: ViewerState (82) ───────────────────────────────────────────
//
// onChatView (handlers.go) is the Socket.IO half. This is the same sequence
// against the same authority: h.chatMemberAllowed at the same cache generation
// as typing_state and join_chat, then cvTouch / cvRemove / cvList — the ONE
// viewer roster, in delivery.go, keyed in Redis. There is no second store here
// and no second gate.
//
// THE PRESENCE LEAK THIS CLOSES, and the check it is closed with: cvList
// returns the uid of everyone viewing the chat, and cvTouch announces the
// caller to them. Both are reached only after chatMemberAllowed(s.d, chatID)
// says this session is a current, non-left member of that chat — the exact
// property chatview_authz_test.go pins for the Socket.IO handler. Revocation
// revokes it: BumpChatPermissions invalidates the cached decision, so a removed
// member's next viewer_state re-queries and is refused.
func (s *ccwireSession) viewerState(m ccwire.Message) bool {
	decoded, err := ccwire.DecodeBody(ccwire.BodyViewerState, m.Body, s.lim, 1)
	if err != nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "viewer_state")
	}
	v, ok := decoded.(ccwire.ViewerState)
	if !ok {
		return s.sendError(m.RequestID, errPayloadInvalid, "viewer_state")
	}
	if v.ChatID == "" {
		return s.sendError(m.RequestID, errPayloadInvalid, "chat_id required")
	}
	if !s.hub.chatMemberAllowed(s.d, v.ChatID, s.ctxOrBG()) {
		metrics.Inc("ccwire_viewer_state_refused")
		return s.sendError(m.RequestID, errNotPermitted, "not permitted")
	}

	h, uid := s.hub, s.d.uid

	if v.Leaving {
		h.cvRemove(v.ChatID, uid, s.ctxOrBG())
		// onChatView emits viewer_left into the Socket.IO room, which no CC-Wire
		// session is in. Fanning to the remaining viewers by uid reaches both
		// transports and reuses the roster that was just updated, rather than
		// inventing a second audience.
		for _, w := range h.cvList(v.ChatID, s.ctxOrBG()) {
			if w.UserID != uid {
				h.emitToUidContext(s.ctxOrBG(), w.UserID, "viewer_left", map[string]any{"chatId": v.ChatID, "userId": uid})
			}
		}
		metrics.Inc("ccwire_viewer_state")
		return true // EPHEMERAL: fire-and-forget, no Ack — as typing_state is.
	}

	isNew, changed, act := h.cvTouch(v.ChatID, uid, viewerActivityWire[v.Activity], s.ctxOrBG())
	if !isNew && !changed && !v.Resync {
		metrics.Inc("ccwire_viewer_state")
		return true // plain heartbeat
	}

	viewers := h.cvList(v.ChatID, s.ctxOrBG())
	if (isNew || changed) && len(viewers) > 0 {
		event := "viewer_activity"
		if isNew {
			event = "viewer_joined"
		}
		hideFrom := h.loadGhostTargets(uid, "hide_online", s.ctxOrBG())
		for _, w := range viewers {
			if w.UserID == uid || hideFrom[w.UserID] {
				continue
			}
			h.emitToUidContext(s.ctxOrBG(), w.UserID, event, map[string]any{"chatId": v.ChatID, "userId": uid, "activity": act})
		}
	}

	if isNew || v.Resync {
		s.sendViewerList(v.ChatID, uid, viewers)
	}
	metrics.Inc("ccwire_viewer_state")
	return true
}

// ── outbound: ViewerList (83) ───────────────────────────────────────────
//
// Sent to ONE session, the one that just passed the chat's membership gate in
// viewerState. It is never broadcast and never accepted inbound, so the only
// way to obtain a chat's roster over this transport is to be a member of it.
// hide_online is honoured the same way onChatView honours it: loadGhostOwners
// names the users who have hidden from the caller, and they are omitted.
func (s *ccwireSession) sendViewerList(chatID, uid string, viewers []cvViewer) {
	hiddenFromMe := map[string]bool{}
	if len(viewers) > 0 {
		hiddenFromMe = s.hub.loadGhostOwners(uid, "hide_online", s.ctxOrBG())
	}
	b := ccwire.AppendStringField(nil, 1, chatID)
	for _, w := range viewers {
		if w.UserID == uid || hiddenFromMe[w.UserID] {
			continue
		}
		e := ccwire.AppendStringField(nil, 1, w.UserID)
		e = ccwire.AppendVarintField(e, 2, viewerActivityEnum(w.Activity))
		b = ccwire.AppendBytesField(b, 2, e)
	}
	// SYNC, not EPHEMERAL: viewer_list is not on envelope.proto's EPHEMERAL
	// allow-list, so EncodeMessage would (correctly) refuse it there. Same
	// class and stream as the other reply-shaped body, CursorBatch.
	s.send(ccwire.Message{
		TrafficClass: ccwire.TrafficClassSync,
		Stream:       ccwireStreamSync,
		BodyField:    ccwire.BodyViewerList,
		Body:         b,
	})
}

// ── inbound: GeoRelay (84) ──────────────────────────────────────────────
//
// The CC-Wire spelling of live_location_update / live_location_stop and
// trip_update / trip_end (handlers.go), and it is gated by exactly the check
// those four share: h.chatMemberAllowed. subject_id picks trip over plain live
// location, `ended` picks the terminal event.
//
// CHAT SCOPE ONLY. subscribeAllowed maps every ScopeKind to an existing gate,
// but SCOPE_KIND_CHANNEL is ungated there by design and a run has its own
// per-run room and relay (registerRunRelay). Live location has only ever been
// chat-scoped on the other transport, so anything else is refused rather than
// silently given a weaker gate than the feature has today.
//
// `sealed` is forwarded as opaque bytes. It is base64'd because the existing
// payload field carries a string; nothing reads into it, and until_ms is the
// only number that crosses, which the client chose and which discloses no
// position.
func (s *ccwireSession) geoRelay(m ccwire.Message) bool {
	decoded, err := ccwire.DecodeBody(ccwire.BodyGeoRelay, m.Body, s.lim, 1)
	if err != nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "geo_relay")
	}
	g, ok := decoded.(ccwire.GeoRelay)
	if !ok {
		return s.sendError(m.RequestID, errPayloadInvalid, "geo_relay")
	}
	if g.ScopeKind != ccwire.ScopeKindChat {
		metrics.Inc("ccwire_geo_relay_refused")
		return s.sendError(m.RequestID, errNotPermitted, "not permitted")
	}
	if g.ScopeID == "" {
		return s.sendError(m.RequestID, errPayloadInvalid, "scope_id required")
	}
	if !g.Ended && len(g.Sealed) == 0 {
		// The "dropped rather than fanned out empty" rule trip_update already
		// has: a live ping with no payload is nothing to relay.
		return s.sendError(m.RequestID, errPayloadInvalid, "sealed required")
	}
	if !s.hub.chatMemberAllowed(s.d, g.ScopeID, s.ctxOrBG()) {
		metrics.Inc("ccwire_geo_relay_refused")
		return s.sendError(m.RequestID, errNotPermitted, "not permitted")
	}

	event, out := geoRelayEvent(s.d.uid, g)

	// The same room the Socket.IO relay emits into. Guarded because the
	// package's socket-free tests build a bare &Hub{} (emitToUidIn guards the
	// same way, for the same reason).
	s.hub.emitRooms([]string{"chat:" + g.ScopeID}, s.sessionID, event, out, s.ctxOrBG())
	metrics.Inc("ccwire_geo_relay")
	return true // EPHEMERAL: fire-and-forget, no Ack.
}

// geoRelayEvent maps one GeoRelay onto the Socket.IO event and payload the
// other transport already publishes. Pure, so the one property that matters —
// that the payload carries the SESSION's uid and nothing but opaque bytes — is
// checkable without a socket.
//
// `sealed` goes out base64'd under `blob`, the field live_location_update and
// trip_update already carry a sealed string in. There is no latitude,
// longitude or address key here and there must never be one: envelope.proto
// removed the plaintext path from CC-Wire on purpose.
func geoRelayEvent(uid string, g ccwire.GeoRelay) (string, map[string]any) {
	out := map[string]any{"userId": uid}
	event := "live_location_update"
	switch {
	case g.SubjectID != "" && g.Ended:
		event, out["tripId"] = "trip_end", g.SubjectID
	case g.SubjectID != "":
		event, out["tripId"] = "trip_update", g.SubjectID
	case g.Ended:
		event = "live_location_stop"
	}
	if !g.Ended {
		out["blob"] = base64.StdEncoding.EncodeToString(g.Sealed)
		if g.UntilMS != 0 {
			out["until"] = g.UntilMS
		}
	}
	return event, out
}
