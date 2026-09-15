package realtime

import (
	"context"
	"github.com/zishang520/socket.io/v2/socket"
	"time"
)

const realtimeCommandTimeout = 30 * time.Second

func realtimeContext(parents ...context.Context) (context.Context, context.CancelFunc) {
	parent := context.Context(bg)
	if len(parents) > 0 && parents[0] != nil {
		parent = parents[0]
	}
	return context.WithTimeout(parent, realtimeCommandTimeout)
}

// eventPeer is the transport boundary of the existing authorized handlers.
// Both adapters register the same callbacks; neither fabricates a socket identity.
type eventPeer struct {
	data    *sockData
	context func() context.Context
	on      func(string, func(...any))
	join    func(socket.Room) bool
	leave   func(socket.Room)
	emit    func(string, any)
	to      func(socket.Room, string, any)
}

func (p *eventPeer) On(event string, fn func(...any)) { p.on(event, fn) }
func (p *eventPeer) Context() context.Context {
	if p.context != nil {
		return p.context()
	}
	return bg
}
func (p *eventPeer) Join(room socket.Room) bool   { return p.join(room) }
func (p *eventPeer) Leave(room socket.Room)       { p.leave(room) }
func (p *eventPeer) Emit(event string, value any) { p.emit(event, value) }

type peerRoom struct {
	p    *eventPeer
	room socket.Room
}

func (p *eventPeer) To(room socket.Room) peerRoom { return peerRoom{p, room} }
func (r peerRoom) Emit(event string, value any)   { r.p.to(r.room, event, value) }

func (h *Hub) socketPeer(s *socket.Socket) *eventPeer {
	return &eventPeer{
		data:  sd(s),
		on:    func(e string, fn func(...any)) { s.On(e, fn) },
		join:  func(r socket.Room) bool { s.Join(r); return true },
		leave: func(r socket.Room) { s.Leave(r) },
		emit:  func(e string, v any) { s.Emit(e, v) },
		to: func(r socket.Room, e string, v any) {
			s.To(r).Emit(e, v)
			h.ccwireRooms([]string{string(r)}, "", e, v)
		},
	}
}

func (h *Hub) registerChatHandlers(s *socket.Socket)   { h.registerChatHandlersPeer(h.socketPeer(s)) }
func (h *Hub) registerSignalHandlers(s *socket.Socket) { h.registerSignalHandlersPeer(h.socketPeer(s)) }
func (h *Hub) registerRunRelay(s *socket.Socket, d *sockData) {
	h.registerRunRelayPeer(h.socketPeer(s), d)
}
func (h *Hub) onChatView(s *socket.Socket, m map[string]any) { h.onChatViewPeer(h.socketPeer(s), m) }

func (s *ccwireSession) eventPeer() *eventPeer {
	return &eventPeer{
		data:    s.d,
		context: s.ctxOrBG,
		on:      func(e string, fn func(...any)) { s.events[e] = fn },
		join:    func(r socket.Room) bool { return s.joinEventRoom(string(r)) },
		leave:   func(r socket.Room) { s.subMu.Lock(); delete(s.subs, string(r)); s.subMu.Unlock() },
		emit: func(e string, v any) {
			if s.ctxOrBG().Err() != nil {
				return
			}
			for _, raw := range appEventFrames(e, v) {
				s.enqueue(raw)
			}
		},
		to: func(r socket.Room, e string, v any) {
			s.hub.emitRooms([]string{string(r)}, s.sessionID, e, v, s.ctxOrBG())
		},
	}
}

const ccwireMaxSubscriptions = 256

func (s *ccwireSession) joinEventRoom(room string) bool {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.closed || s.ctxOrBG().Err() != nil {
		return false
	}
	s.subMu.Lock()
	_, exists := s.subs[room]
	if len(room) > 256 || (!exists && len(s.subs) >= ccwireMaxSubscriptions) {
		s.subMu.Unlock()
		s.sendError("", errRateLimited, "subscription limit")
		return false
	}
	s.subs[room] = struct{}{}
	s.subMu.Unlock()
	return true
}
