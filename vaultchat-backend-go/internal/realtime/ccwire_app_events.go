package realtime

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/zishang520/socket.io/v2/socket"
	"vaultchat/backend-go/internal/ccwire"
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
		t, ok := r.varint()
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
				t, ok := c.varint()
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

func appEventFrames(event string, payload any) [][]byte {
	if event == "" || len(event) > 64 {
		return nil
	}
	data, err := json.Marshal(payload)
	if err != nil || len(data) > maxAppEventPayload {
		return nil
	}
	body := ccwire.AppendStringField(nil, 1, event)
	body = ccwire.AppendBytesField(body, 2, data)
	lim := ccwire.DefaultLimits()
	lim.MaxMessageBodyBytes = appEventLogicalLimit
	message, err := ccwire.EncodeMessage(ccwire.Message{TrafficClass: ccwire.TrafficClassControl, Stream: ccwireStreamControl, BodyField: ccwire.BodyAppEvent, Body: body}, lim, appEventLogicalLimit)
	if err != nil {
		return nil
	}
	if len(message) <= lim.MaxFrameBytes {
		raw, err := ccwire.Encode(message, ccwire.Options{MaxBytes: lim.MaxFrameBytes})
		if err != nil {
			return nil
		}
		return [][]byte{raw}
	}
	// Existing Fragment contract carries the complete logical Frame protobuf,
	// not the five-byte physical header. Chunks never exceed max_opaque_bytes.
	id := nodeID + ":event:" + strconv.FormatUint(appEventSequence.Add(1), 10)
	total := (len(message) + lim.MaxOpaqueBytes - 1) / lim.MaxOpaqueBytes
	if total > int(lim.MaxFragmentsPerMessage) {
		return nil
	}
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
		raw := ccwireFrame(ccwire.Message{TrafficClass: ccwire.TrafficClassControl, Stream: ccwireStreamControl, BodyField: ccwire.BodyFragment, Body: fragment})
		if raw == nil {
			return nil
		}
		frames = append(frames, raw)
	}
	return frames
}

func (s *ccwireSession) appEvent(m ccwire.Message) bool {
	if !s.appEvents {
		return s.sendError(m.RequestID, errUnknownOperation, "app events not negotiated")
	}
	r := pbr{b: m.Body}
	var name string
	var payload []byte
	for r.p < len(r.b) {
		t, ok := r.varint()
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
	if h.io != nil {
		rs := make([]socket.Room, len(rooms))
		for i, r := range rooms {
			rs[i] = socket.Room(r)
		}
		h.io.To(rs...).Emit(event, payload)
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
	frames := appEventFrames(event, payload)
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
	for _, s := range targets {
		if ctx.Err() != nil {
			return
		}
		if s.canReceiveRooms(rooms, ctx) {
			for _, raw := range frames {
				s.enqueue(raw)
			}
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
			return true // same public-channel policy as the shared join handler
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
