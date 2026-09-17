package realtime

import (
	"context"
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
	join    func(Room) bool
	leave   func(Room)
	emit    func(string, any)
	to      func(Room, string, any)
}

func (p *eventPeer) On(event string, fn func(...any)) { p.on(event, fn) }
func (p *eventPeer) Context() context.Context {
	if p.context != nil {
		return p.context()
	}
	return bg
}
func (p *eventPeer) Join(room Room) bool          { return p.join(room) }
func (p *eventPeer) Leave(room Room)              { p.leave(room) }
func (p *eventPeer) Emit(event string, value any) { p.emit(event, value) }

type peerRoom struct {
	p    *eventPeer
	room Room
}

func (p *eventPeer) To(room Room) peerRoom      { return peerRoom{p, room} }
func (r peerRoom) Emit(event string, value any) { r.p.to(r.room, event, value) }

// The Socket.IO peer constructor and its four *socket.Socket wrappers were
// here. eventPeer itself stays — it is the transport-agnostic seam, and every
// *Peer handler is now reached through ccwireSession.eventPeer() below.

func (s *ccwireSession) eventPeer() *eventPeer {
	return &eventPeer{
		data:    s.d,
		context: s.ctxOrBG,
		on:      func(e string, fn func(...any)) { s.events[e] = fn },
		join:    func(r Room) bool { return s.joinEventRoom(string(r)) },
		leave:   func(r Room) { s.subMu.Lock(); delete(s.subs, string(r)); s.subMu.Unlock() },
		emit: func(e string, v any) {
			if s.ctxOrBG().Err() != nil {
				return
			}
			s.deliver(appEventBuild(e, v))
		},
		to: func(r Room, e string, v any) {
			s.hub.emitRooms([]string{string(r)}, s.sessionID, e, v, s.ctxOrBG())
		},
	}
}

const ccwireMaxSubscriptions = 256

func (s *ccwireSession) joinEventRoom(room string) bool {
	// THE REFUSAL IS SENT OUTSIDE closeMu, and that is not a tidy-up.
	//
	// sendError writes to the socket, and the write path takes the session's
	// position lock. Delivery takes that lock in the other order — it holds
	// pos.mu across enqueue(), which reads s.closed under closeMu — so sending
	// while holding closeMu closes a cycle:
	//
	//   deliver()        pos.mu  -> closeMu
	//   joinEventRoom()  closeMu -> pos.mu
	//
	// One Subscribe past the limit, concurrent with a fan-out to the same
	// session, wedges both goroutines permanently. closeOnce() also needs
	// closeMu, so the socket is never closed, drain() never exits, and the
	// session leaks with pos.mu held forever.
	//
	// closeMu is only ever a snapshot of s.closed here — the session can close
	// the instant after it is released either way — so nothing is lost by
	// taking it, reading, and letting go.
	s.closeMu.Lock()
	closed := s.closed
	s.closeMu.Unlock()
	if closed || s.ctxOrBG().Err() != nil {
		return false
	}

	s.subMu.Lock()
	_, exists := s.subs[room]
	refused := len(room) > 256 || (!exists && len(s.subs) >= ccwireMaxSubscriptions)
	if !refused {
		s.subs[room] = struct{}{}
	}
	s.subMu.Unlock()

	if refused {
		s.sendError("", errRateLimited, "subscription limit")
		return false
	}
	return true
}
