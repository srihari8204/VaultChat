package realtime

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/metrics"
)

// The feature is opt-in on both peers until deployment parity is verified.
func appEventsEnabled() bool { return os.Getenv("CCWIRE_APP_EVENTS") == "1" }

// JSON escaping can use six bytes per decoded byte; bounded() remains the
// decoded-object authority. Only negotiated app-event sessions get this
// logical-message ceiling; physical frames and reassembly budget stay bounded.
const maxAppEventPayload = 6 * maxPayloadLen
const appEventLogicalLimit = 2 << 20

var appEventSequence atomic.Uint64

func helloAppEvents(body []byte, lim ccwire.Limits) bool {
	// ClientHello.capabilities is field 3.
	r := pbr{b: body}
	for r.p < len(r.b) {
		t, ok := r.tag()
		if !ok {
			return false
		}
		if t>>3 == 3 && t&7 == 2 {
			b, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return false
			}
			c := pbr{b: b}
			var fragments, events bool
			for c.p < len(c.b) {
				t, ok := c.tag()
				if !ok {
					return false
				}
				if (t>>3 == 8 || t>>3 == 1) && t&7 == 0 {
					v, ok := c.varint()
					if !ok {
						return false
					}
					if t>>3 == 8 {
						events = v == 1
					} else {
						fragments = v == 1
					}
					continue
				}
				if !c.skip(uint8(t&7), lim) {
					return false
				}
			}
			return events && fragments
		} else if !r.skip(uint8(t&7), lim) {
			return false
		}
	}
	return false
}

func appEventFrame(event string, payload any) []byte {
	frames := appEventFrames(event, payload)
	if len(frames) != 1 {
		return nil
	}
	return frames[0]
}

// appEventFrames is the SHARED encode: one set of bytes fanned out to every
// session. appEventBuild also hands back the Messages behind those bytes, which
// is what a resuming session needs in order to stamp its own per-session
// sequence numbers — see (*ccwireSession).deliver.
func appEventFrames(event string, payload any) [][]byte {
	_, frames := appEventBuild(event, payload)
	return frames
}

func appEventBuild(event string, payload any) ([]ccwire.Message, [][]byte) {
	if event == "" || len(event) > 64 {
		return nil, nil
	}
	data, err := json.Marshal(payload)
	if err != nil || len(data) > maxAppEventPayload {
		return nil, nil
	}
	body := ccwire.AppendStringField(nil, 1, event)
	body = ccwire.AppendBytesField(body, 2, data)
	lim := ccwire.DefaultLimits()
	lim.MaxMessageBodyBytes = appEventLogicalLimit
	msg := ccwire.Message{TrafficClass: ccwire.TrafficClassControl, Stream: ccwireStreamControl, BodyField: ccwire.BodyAppEvent, Body: body}
	message, err := ccwire.EncodeMessage(msg, lim, appEventLogicalLimit)
	if err != nil {
		return nil, nil
	}
	if len(message) <= lim.MaxFrameBytes {
		raw, err := ccwire.Encode(message, ccwire.Options{MaxBytes: lim.MaxFrameBytes})
		if err != nil {
			return nil, nil
		}
		return []ccwire.Message{msg}, [][]byte{raw}
	}
	// Existing Fragment contract carries the complete logical Frame protobuf,
	// not the five-byte physical header. Chunks never exceed max_opaque_bytes.
	id := nodeID + ":event:" + strconv.FormatUint(appEventSequence.Add(1), 10)
	total := (len(message) + lim.MaxOpaqueBytes - 1) / lim.MaxOpaqueBytes
	if total > int(lim.MaxFragmentsPerMessage) {
		return nil, nil
	}
	msgs := make([]ccwire.Message, 0, total)
	frames := make([][]byte, 0, total)
	for i := 0; i < total; i++ {
		end := (i + 1) * lim.MaxOpaqueBytes
		if end > len(message) {
			end = len(message)
		}
		fragment := ccwire.AppendStringField(nil, 1, id)
		fragment = ccwire.AppendVarintField(fragment, 2, uint64(i))
		fragment = ccwire.AppendVarintField(fragment, 3, uint64(total))
		fragment = ccwire.AppendVarintField(fragment, 4, uint64(len(message)))
		fragment = ccwire.AppendBytesField(fragment, 5, message[i*lim.MaxOpaqueBytes:end])
		fragment = ccwire.AppendBoolField(fragment, 6, i == total-1)
		fm := ccwire.Message{TrafficClass: ccwire.TrafficClassControl, Stream: ccwireStreamControl, BodyField: ccwire.BodyFragment, Body: fragment}
		raw := ccwireFrame(fm)
		if raw == nil {
			return nil, nil
		}
		msgs = append(msgs, fm)
		frames = append(frames, raw)
	}
	return msgs, frames
}

func (s *ccwireSession) appEvent(m ccwire.Message) bool {
	if !s.appEvents {
		return s.sendError(m.RequestID, errUnknownOperation, "app events not negotiated")
	}
	r := pbr{b: m.Body}
	var name string
	var payload []byte
	for r.p < len(r.b) {
		t, ok := r.tag()
		if !ok {
			return s.sendError(m.RequestID, errPayloadInvalid, "event")
		}
		if t == 10 || t == 18 {
			limit := maxAppEventPayload
			if t == 10 {
				limit = 64
			}
			b, ok := r.span(limit)
			if !ok {
				return s.sendError(m.RequestID, errPayloadInvalid, "event")
			}
			if t == 10 {
				name = string(b)
			} else {
				payload = b
			}
		} else if !r.skip(uint8(t&7), s.lim) {
			return s.sendError(m.RequestID, errPayloadInvalid, "event")
		}
	}
	fn := s.events[name]
	if name == "" {
		return s.sendError(m.RequestID, errPayloadInvalid, "event required")
	}
	if fn == nil {
		return s.sendError(m.RequestID, errUnknownOperation, "event not served")
	}
	var value map[string]any
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	if json.Unmarshal(payload, &value) != nil || value == nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "event payload")
	}
	budget := maxPayloadLen
	if !bounded(value, 0, &budget) {
		return s.sendError(m.RequestID, errPayloadInvalid, "event payload")
	}
	fn(value)
	// These legacy events have no semantic acknowledgement. A transport Ack
	// must never be interpreted as durable delivery or successful authorization.
	return true
}

func (h *Hub) emitRooms(rooms []string, exclude, event string, payload any, parents ...context.Context) {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return
	}
	h.ccwireRooms(rooms, exclude, event, payload, ctx)
}

func (h *Hub) ccwireRooms(rooms []string, exclude, event string, payload any, parents ...context.Context) {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return
	}
	h.ccwireRoomsLocal(rooms, exclude, event, payload, ctx)
	h.publishCCWire("", "", rooms, exclude, event, payload, ctx)
}

func (h *Hub) ccwireRoomsLocal(rooms []string, exclude, event string, payload any, parents ...context.Context) {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return
	}
	msgs, frames := appEventBuild(event, payload)
	if len(frames) == 0 {
		return
	}
	h.cwmu.Lock()
	var targets []*ccwireSession
	for _, sessions := range h.cwSessions {
		for s := range sessions {
			if !s.appEvents || (exclude != "" && s.sessionID == exclude) {
				continue
			}
			s.subMu.RLock()
			matched := len(rooms) == 0
			for _, r := range rooms {
				if _, ok := s.subs[r]; ok {
					matched = true
					break
				}
			}
			s.subMu.RUnlock()
			if matched {
				targets = append(targets, s)
			}
		}
	}
	h.cwmu.Unlock()
	// NO ctx.Err() ABORT IN THIS LOOP.
	//
	// It used to return here, which made a fan-out that ran out of time deliver
	// to the sessions early in the slice and silently skip the rest: no error,
	// no hole in anyone's window, no metric. canReceiveRooms can reach the DB
	// on a cache miss, once per target, so a call room with a few dozen
	// participants on a cold permission cache exhausts the budget mid-loop —
	// and the participants that never got call_peer_left keep rendering a tile
	// for someone who left, for the rest of the call.
	//
	// The per-session authorization check below is a different thing and stays:
	// skipping ONE session because it may not receive is correct. Abandoning
	// the others because the clock ran out is not.
	// Removing the loop's abort was NOT enough on its own, and that is worth
	// stating because it looked like it was. canReceiveRooms derives its own
	// context from this one and returns false the moment the parent is expired
	// — before it checks anything — so every target after the deadline was
	// still skipped, silently, exactly as before. The only observable change
	// was a metric.
	//
	// So when the budget is gone, authorization continues on a FRESH one rather
	// than failing closed for everyone remaining. The security check is still
	// performed against the database; what changes is that blowing a deadline
	// no longer decides who receives a message. One extra budget per fan-out,
	// taken at most once, is the cost.
	var fresh context.Context
	var cancelFresh context.CancelFunc
	defer func() {
		if cancelFresh != nil {
			cancelFresh()
		}
	}()

	for _, s := range targets {
		use := ctx
		if use.Err() != nil {
			if fresh == nil {
				fresh, cancelFresh = realtimeContext()
				metrics.Inc("ccwire_fanout_deadline_exceeded")
			}
			use = fresh
		}
		if s.canReceiveRooms(rooms, use) {
			s.deliver(msgs, frames)
		}
	}
}

// Recheck cached entitlement outside the Hub lock. A saved subscription is
// not permission after membership changes invalidate the shared cache.
func (s *ccwireSession) canReceiveRooms(rooms []string, parents ...context.Context) bool {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return false
	}
	if len(rooms) == 0 {
		return true
	}
	for _, room := range rooms {
		s.subMu.RLock()
		_, joined := s.subs[room]
		s.subMu.RUnlock()
		if !joined {
			continue
		}
		kind, id, ok := strings.Cut(room, ":")
		if !ok {
			continue
		}
		switch kind {
		case "chat", "call":
			if s.hub.chatMemberAllowed(s.d, id, ctx) {
				return true
			}
		case "run":
			if s.hub.runAllowed(s.d, id, false, ctx) {
				return true
			}
		case "channel":
			// Re-checked per delivery like chats: a subscriber who left stops
			// receiving even if their session is still in the room.
			if s.hub.channelAllowed(s.d, id, ctx) {
				return true
			}
		}
	}
	return false
}

func (h *Hub) ccwireCallRoster(room string, me string) []string {
	h.cwmu.Lock()
	defer h.cwmu.Unlock()
	var ids []string
	for uid, sessions := range h.cwSessions {
		if uid == me {
			continue
		}
		for s := range sessions {
			s.subMu.RLock()
			_, ok := s.subs[room]
			s.subMu.RUnlock()
			if ok && s.appEvents {
				ids = append(ids, uid)
				break
			}
		}
	}
	return ids
}

func (s *ccwireSession) leaveAppRooms() {
	ctx, cancel := context.WithTimeout(bg, 5*time.Second)
	defer cancel()
	s.subMu.Lock()
	rooms := s.subs
	s.subs = map[string]struct{}{}
	s.subMu.Unlock()
	for room := range rooms {
		if ctx.Err() != nil {
			return
		}
		if strings.HasPrefix(room, "call:") {
			chatID := strings.TrimPrefix(room, "call:")
			s.hub.emitRooms([]string{room}, s.sessionID, "call_peer_left", map[string]any{"chatId": chatID, "uid": s.d.uid}, ctx)
			if ClusterEnabled() {
				clusterCallLeave(chatID, s.d.uid, ctx)
			}
		}
	}
}
