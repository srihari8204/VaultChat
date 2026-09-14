// CC-Wire v1 — a SECOND, PARALLEL realtime listener, off by default.
//
// The live transport is Socket.IO v4 over WebSocket and everything else in this
// package serves it. This file adds nothing to that path: it registers its own
// route, on its own mux entry, only when CCWIRE_WS=1 is set. With the flag
// unset RegisterCCWire returns before touching the mux, so a deployment that
// does not opt in is byte-for-byte the deployment it was before (asserted by
// TestCCWireIsOffByDefault).
//
// WHY IT LIVES IN package realtime RATHER THAN package routes
//
// Because of the one thing a second transport must never do: grow its own
// notion of who may reach what. chatMemberAllowed, peerAllowed and runAllowed
// are unexported methods on *Hub over an unexported *sockData. A handler in
// another package could not call them, and would therefore have had to
// reimplement them — which is precisely how a parallel transport becomes an
// authorization bypass. Being in this package means a CC-Wire Subscribe to a
// chat runs THE SAME cached `chat_members … left_at IS NULL` check, at the same
// generation, through the same cache, as join_chat.
//
// AUTHENTICATION is httpx.RequireAuth, unmodified — the same Bearer/VerifyAccess
// path every other route uses, applied BEFORE the WebSocket upgrade. There is
// no unauthenticated socket at any point: a request without a valid access
// token gets a 401 and never reaches the upgrader.
package realtime

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/zishang520/socket.io/v2/socket"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/metrics"
)

// CCWirePath is the endpoint. Deliberately disjoint from /socket.io/ so the two
// transports cannot collide on a mux prefix.
const CCWirePath = "/ccwire/v1"

// ccwireIdleTimeout bounds a silent connection. The client drives liveness with
// Ping (Limits.heartbeat_interval_ms is 10 s), so several missed heartbeats is
// the right shape of bound; it is refreshed on every frame received.
const ccwireIdleTimeout = 60 * time.Second

// CCWireEnabled reports whether the parallel CC-Wire listener is switched on.
// Same flag convention as REDIS_ADAPTER: absent means off, and off means the
// route does not exist.
func CCWireEnabled() bool { return os.Getenv("CCWIRE_WS") == "1" }

// RegisterCCWire mounts the CC-Wire endpoint — and ONLY if the flag is set.
//
// The check is here, not at the call site, so there is exactly one place that
// decides whether this listener exists. Nothing is registered, no goroutine is
// started and no state is allocated when it is off.
func RegisterCCWire(mux *http.ServeMux, h *Hub) {
	if !CCWireEnabled() || mux == nil || h == nil {
		return
	}
	mux.Handle(CCWirePath, http.HandlerFunc(httpx.RequireAuth(h.ccwireServe)))
	log.Printf("[ccwire] CCWIRE_WS=1 — parallel CC-Wire listener mounted at %s (Socket.IO unaffected)", CCWirePath)
}

// The default CheckOrigin is deliberately left in place: it permits a request
// with no Origin header (every native client) and refuses a cross-origin
// browser upgrade, which is the stricter of the two available defaults.
var ccwireUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

func (h *Hub) ccwireServe(w http.ResponseWriter, r *http.Request) {
	u := httpx.UserFrom(r)
	if u.ID == "" {
		// Unreachable behind RequireAuth; kept because "unreachable" is how an
		// unauthenticated realtime endpoint gets shipped.
		httpx.Err(w, http.StatusUnauthorized, "auth_required")
		return
	}

	c, err := ccwireUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade has already written the response
	}
	defer c.Close()

	// One WebSocket message is one CC-Wire frame. The read limit is the same
	// 2 MiB ceiling as opts.SetMaxHttpBufferSize on the Socket.IO server and
	// ccwire.MaxFrameBytes; the negotiated per-frame bound (256 KiB) is checked
	// inside, so an oversized frame is refused rather than dropping the socket.
	c.SetReadLimit(int64(ccwire.HeaderBytes + ccwire.MaxFrameBytes))

	s := &ccwireSession{
		hub:  h,
		conn: c,
		lim:  ccwire.DefaultLimits(),
		// The same sockData the Socket.IO handlers carry, with the same caches,
		// so the authorization gates below behave identically for both
		// transports — including the generation bump from BumpChatPermissions.
		d: &sockData{
			uid:          u.ID,
			email:        u.Email,
			chatMemberOk: map[string]cachedPerm{},
			runOk:        map[string]cachedPerm{},
		},
		subs: map[string]struct{}{},
		out:  make(chan []byte, ccwireOutQueue),
		done: make(chan struct{}),
		// The AUTHENTICATED context, values and all, detached from the request's
		// cancellation so the loopback in ccwire_messages.go can run for the life
		// of the session. httpx's context key is unexported, so carrying the real
		// context is also the only way to reach httpx.UserFrom — a session cannot
		// fabricate an identity it was not given.
		ctx: context.WithoutCancel(r.Context()),
	}
	s.w = s.writeWS

	// Registered for fan-out AFTER the session is fully built and unregistered
	// before the socket closes, so emitToUidIn never holds a half-live session.
	h.ccwireRegister(s)
	defer h.ccwireUnregister(s)
	go s.drain()
	defer s.closeOnce()

	metrics.Inc("ccwire_connect")
	defer metrics.Inc("ccwire_disconnect")
	s.run()
}

// drain writes queued fan-out frames. One writer goroutine plus the reader
// goroutine means two writers on one gorilla connection, which is not allowed —
// hence the mutex in write().
func (s *ccwireSession) drain() {
	for {
		select {
		case raw := <-s.out:
			if s.write(raw) != nil {
				s.closeOnce()
				return
			}
		case <-s.done:
			return
		}
	}
}

// closeOnce ends the session from any goroutine. Closing the connection is what
// unblocks the reader in run(), which then tears everything down.
func (s *ccwireSession) closeOnce() {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.done)
	if s.conn != nil {
		_ = s.conn.Close()
	}
}

type ccwireSession struct {
	hub   *Hub
	conn  *websocket.Conn
	d     *sockData
	lim   ccwire.Limits
	hello bool
	subs  map[string]struct{}
	// w writes one already-framed message. Indirected so the protocol above it
	// — the handshake, the authorization gates, the EPHEMERAL invariant — can
	// be driven in a test without a socket, the same way this package's other
	// tests run with neither sockets nor a database.
	w func([]byte) error
	// wmu serialises w. Replies are written by the reader goroutine and fan-out
	// frames by drain(), and a gorilla connection permits exactly one writer.
	wmu sync.Mutex

	// ctx is the authenticated request context (see ccwireServe), used by the
	// loopback into the REST handlers. nil in tests that drive handle() directly.
	ctx context.Context

	// out is the fan-out queue; nil in tests, which write inline. done/closed
	// end the session from any goroutine exactly once.
	out     chan []byte
	done    chan struct{}
	closeMu sync.Mutex
	closed  bool
}

// write is the one serialised path to the socket.
func (s *ccwireSession) write(b []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return s.w(b)
}

func (s *ccwireSession) writeWS(b []byte) error {
	_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.conn.WriteMessage(websocket.BinaryMessage, b)
}

func (s *ccwireSession) run() {
	for {
		_ = s.conn.SetReadDeadline(time.Now().Add(ccwireIdleTimeout))
		typ, raw, err := s.conn.ReadMessage()
		if err != nil {
			return
		}
		if typ != websocket.BinaryMessage {
			// CC-Wire is binary. A text message is not a lenient encoding of
			// it, it is a different protocol.
			s.refuse("", errProtocolViolation, "binary frames only")
			return
		}
		if !s.handle(raw) {
			return
		}
	}
}

// errorCode values from proto/ccwire/v1/errors.proto.
const (
	errUnsupportedVersion uint32 = 1
	errAuthRequired       uint32 = 2
	errNotPermitted       uint32 = 5
	errRateLimited        uint32 = 6
	errFrameTooLarge      uint32 = 7
	errPayloadInvalid     uint32 = 8
	errUnknownOperation   uint32 = 10
	errProtocolViolation  uint32 = 11
	errInternal           uint32 = 15
)

// handle processes one WebSocket message. It returns false when the session
// must end.
func (s *ccwireSession) handle(raw []byte) bool {
	// Layer 1: length-prefixed framing (internal/ccwire/frame.go, unmodified).
	// Strict, because one WebSocket message is exactly one frame — a trailing
	// byte is a framing disagreement, not a second frame.
	fr, err := ccwire.Decode(raw, ccwire.Options{MaxBytes: s.lim.MaxFrameBytes, Strict: true})
	if err != nil {
		s.refuse("", framingErrorCode(err), "framing")
		return false
	}

	// Layer 2: the routing header. Bodies stay opaque; the EPHEMERAL invariant
	// and every bound from capabilities.proto are enforced in here.
	m, err := ccwire.DecodeMessage(fr.Payload, s.lim, 0, 0)
	if err != nil {
		var ce ccwire.CodecError
		code := errPayloadInvalid
		if errors.As(err, &ce) {
			code = ce.ErrorCode()
		}
		metrics.Inc("ccwire_frame_refused")
		s.refuse("", code, "decode")
		return false
	}

	if m.BodyField == 0 {
		s.refuse(m.RequestID, errProtocolViolation, "no body")
		return false
	}

	// The handshake is mandatory and must come first. Everything before it is a
	// protocol violation rather than a silent drop — the silent drop is the bug
	// ERROR_CODE_UNKNOWN_OPERATION exists to fix.
	if !s.hello {
		if m.BodyField != ccwire.BodyClientHello {
			s.refuse(m.RequestID, errProtocolViolation, "ClientHello first")
			return false
		}
		s.hello = true
		// The credential inside ClientHello is NOT read: this connection was
		// already authenticated by httpx.RequireAuth at the upgrade, which is
		// the same handshake-time-only model the Socket.IO middleware uses.
		return s.send(ccwire.Message{
			RequestID:    m.RequestID,
			TrafficClass: ccwire.TrafficClassControl,
			Stream:       1,
			BodyField:    ccwire.BodyServerHello,
			Body:         s.serverHello(),
		})
	}

	switch m.BodyField {
	case ccwire.BodyClientHello:
		s.refuse(m.RequestID, errProtocolViolation, "duplicate ClientHello")
		return false

	case ccwire.BodyPing:
		// Pong mirrors Ping field-for-field (nonce = 1, progress = 2), so the
		// body is echoed verbatim rather than re-encoded. Bytes not parsed are
		// bytes that cannot be corrupted.
		return s.send(ccwire.Message{
			RequestID:    m.RequestID,
			TrafficClass: ccwire.TrafficClassControl,
			Stream:       1,
			BodyField:    ccwire.BodyPong,
			Body:         m.Body,
		})

	case ccwire.BodySubscribe, ccwire.BodyUnsubscribe:
		return s.scope(m)

	default:
		// The messaging bodies (ccwire_messages.go). They route through the SAME
		// REST handlers and the SAME fan-out as Socket.IO rather than growing a
		// second path, which is why they live in their own file and not here.
		if handled, alive := s.serveBody(m); handled {
			return alive
		}
		// A body this build routes but does not yet serve. Answered, never
		// dropped: a silent drop is how trips shipped broken for a release.
		metrics.Inc("ccwire_unknown_operation")
		return s.sendError(m.RequestID, errUnknownOperation, "operation not served")
	}
}

// scope handles Subscribe / Unsubscribe — THE authorization path.
func (s *ccwireSession) scope(m ccwire.Message) bool {
	kind, id, err := ccwire.DecodeScope(m.Body, s.lim)
	if err != nil {
		s.refuse(m.RequestID, errPayloadInvalid, "scope")
		return false
	}
	if id == "" {
		return s.sendError(m.RequestID, errPayloadInvalid, "scope id required")
	}
	key := scopeRoom(kind, id)
	if key == "" {
		return s.sendError(m.RequestID, errNotPermitted, "scope refused")
	}

	if m.BodyField == ccwire.BodyUnsubscribe {
		// Leaving is always permitted, exactly as leave_chat is.
		delete(s.subs, key)
		return s.sendAck(m)
	}

	if !s.subscribeAllowed(kind, id) {
		// Coarse on purpose (errors.proto): "not a member", "no such chat" and
		// "not entitled" are one answer, so the error channel is an existence
		// oracle for nothing.
		log.Printf("[ccwire] subscribe refused uid=%s scope=%s", s.d.uid, key)
		metrics.Inc("ccwire_subscribe_refused")
		return s.sendError(m.RequestID, errNotPermitted, "not permitted")
	}
	s.subs[key] = struct{}{}
	metrics.Inc("ccwire_subscribe")
	return s.sendAck(m)
}

// subscribeAllowed is the whole point of this file: every scope resolves to a
// gate that ALREADY EXISTS and is already used by the Socket.IO handlers. No
// new notion of "may reach" is introduced here, because a second transport that
// invents one is a second transport that bypasses the first's.
func (s *ccwireSession) subscribeAllowed(kind uint32, id string) bool {
	switch kind {
	case ccwire.ScopeKindChat:
		// The same check join_chat makes (handlers.go), same cache, same
		// generation — so BumpChatPermissions invalidates a CC-Wire session's
		// decision exactly as it does a Socket.IO one.
		return s.hub.chatMemberAllowed(s.d, id)

	case ccwire.ScopeKindCall:
		// envelope.proto: "chat membership + mesh cap" — which is call_join's
		// rule (handlers.go:773 and the meshMaxParticipants check below it).
		if !s.hub.chatMemberAllowed(s.d, id) {
			return false
		}
		// ponytail: the roster counts Socket.IO sockets only, so this cap sees
		// existing callers but not other CC-Wire subscribers. Harmless while
		// no media is fanned out over this transport; when it is, call
		// membership needs one roster both transports write to.
		if max := meshMaxParticipants(); len(s.hub.callRoster(socket.Room("call:"+id), s.d.uid))+1 > max {
			metrics.Inc("ccwire_call_mesh_full")
			return false
		}
		return true

	case ccwire.ScopeKindRun:
		// runAllowed(drive=false) is the view entitlement, matching the run
		// relay's read side (handlers.go registerRunRelay).
		return s.hub.runAllowed(s.d, id, false)

	case ccwire.ScopeKindChannel:
		// UNGATED, and recorded as such in envelope.proto. channel_join has no
		// check today; adding one HERE would be a second, divergent policy.
		// When channels grow a membership gate it belongs in one function both
		// transports call.
		return true

	case ccwire.ScopeKindAdmin:
		// The admin key is a Socket.IO handshake concept and is not accepted on
		// this endpoint at all, so no session can ever satisfy this scope.
		return false

	default:
		// SCOPE_KIND_UNSPECIFIED, or a kind from a newer peer. An unknown scope
		// is refused, never assumed.
		return false
	}
}

// scopeRoom is the room name a scope maps to, and "" for one no session may
// name. It mirrors the room strings the Socket.IO side already uses.
func scopeRoom(kind uint32, id string) string {
	switch kind {
	case ccwire.ScopeKindChat:
		return "chat:" + id
	case ccwire.ScopeKindChannel:
		return "channel:" + id
	case ccwire.ScopeKindCall:
		return "call:" + id
	case ccwire.ScopeKindRun:
		return "run:" + id
	default:
		// Includes SCOPE_KIND_ADMIN: there is no per-user scope and no admin
		// scope on this transport, so neither gets a name.
		return ""
	}
}

// ── replies ─────────────────────────────────────────────────────────────

func (s *ccwireSession) serverHello() []byte {
	var b []byte
	b = ccwire.AppendVarintField(b, 1, 1) // protocol_major
	// protocol_minor is 0 — a proto3 default, therefore not written.
	b = ccwire.AppendBytesField(b, 3, s.capabilities()) // INTERSECTION, never union
	b = ccwire.AppendBytesField(b, 4, encodeLimits(s.lim))
	b = ccwire.AppendStringField(b, 5, s.d.uid) // session_id
	// resume_token (6) stays empty: resumption is not implemented, and an
	// unusable token is worse than none.
	b = ccwire.AppendVarintField(b, 7, uint64(time.Now().UnixMilli()))
	// resumed (8) is false — a proto3 default, and honest: the client must
	// full-resync.
	return b
}

// capabilities is the intersection this build can actually honour. Anything not
// implemented is ABSENT rather than advertised — a capability claimed and not
// delivered is worse than one never offered.
func (s *ccwireSession) capabilities() []byte {
	var b []byte
	b = ccwire.AppendBoolField(b, 7, true) // structured_errors
	return b
}

func encodeLimits(l ccwire.Limits) []byte {
	var b []byte
	b = ccwire.AppendVarintField(b, 1, uint64(l.MaxFrameBytes))
	b = ccwire.AppendVarintField(b, 2, uint64(l.MaxOpaqueBytes))
	b = ccwire.AppendVarintField(b, 3, uint64(l.MaxMessageBodyBytes))
	b = ccwire.AppendVarintField(b, 4, uint64(l.MaxFragmentsPerMessage))
	b = ccwire.AppendVarintField(b, 5, 30000) // reassembly_lifetime_ms
	b = ccwire.AppendVarintField(b, 6, 2097152)
	b = ccwire.AppendVarintField(b, 7, 8)
	b = ccwire.AppendVarintField(b, 8, uint64(l.MaxNestingDepth))
	b = ccwire.AppendVarintField(b, 9, uint64(l.MaxRepeatedElements))
	b = ccwire.AppendVarintField(b, 10, uint64(l.MaxStringFieldBytes))
	b = ccwire.AppendVarintField(b, 11, 256)
	b = ccwire.AppendVarintField(b, 12, 64)
	b = ccwire.AppendVarintField(b, 13, 10000) // heartbeat_interval_ms
	b = ccwire.AppendVarintField(b, 14, 5000)  // heartbeat_timeout_ms
	return b
}

func (s *ccwireSession) sendAck(m ccwire.Message) bool {
	var b []byte
	// message_id (1) is empty: a subscription has none.
	b = ccwire.AppendVarintField(b, 2, m.Seq)
	b = ccwire.AppendVarintField(b, 3, uint64(time.Now().UnixMilli()))
	return s.send(ccwire.Message{
		RequestID:    m.RequestID,
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       1,
		BodyField:    ccwire.BodyAck,
		Body:         b,
	})
}

// sendError writes a structured Error. `detail` is SERVER-AUTHORED and never
// echoes client input — echoing would reintroduce the relay injection surface
// inside the error channel itself (errors.proto).
func (s *ccwireSession) sendError(requestID string, code uint32, detail string) bool {
	class := uint32(2) // ERROR_CLASS_FATAL
	switch code {
	case errNotPermitted, errUnknownOperation, errRateLimited, errInternal:
		class = 1 // ERROR_CLASS_RETRYABLE — the session survives
	case errAuthRequired:
		class = 3 // ERROR_CLASS_AUTH
	}
	var b []byte
	b = ccwire.AppendVarintField(b, 1, uint64(code))
	b = ccwire.AppendVarintField(b, 2, uint64(class))
	b = ccwire.AppendStringField(b, 3, detail)
	b = ccwire.AppendStringField(b, 5, requestID)
	return s.send(ccwire.Message{
		RequestID:    requestID,
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       1,
		BodyField:    ccwire.BodyError,
		Body:         b,
	})
}

// refuse sends an Error and ends the session. Used where continuing would mean
// reading a stream we have lost sync with.
func (s *ccwireSession) refuse(requestID string, code uint32, detail string) {
	_ = s.sendError(requestID, code, detail)
	if s.conn != nil {
		_ = s.conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, ""),
			time.Now().Add(time.Second))
	}
}

func (s *ccwireSession) send(m ccwire.Message) bool {
	// Encoded through the same codec, so the EPHEMERAL invariant is enforced on
	// the way OUT too: a bug that produces an illegal frame fails on the
	// machine that has the stack trace, not on the peer that only has bytes.
	payload, err := ccwire.EncodeMessage(m, s.lim, 0)
	if err != nil {
		log.Printf("[ccwire] refusing to emit an invalid frame: %v", err)
		return false
	}
	out, err := ccwire.Encode(payload, ccwire.Options{MaxBytes: s.lim.MaxFrameBytes})
	if err != nil {
		log.Printf("[ccwire] refusing to emit an oversized frame: %v", err)
		return false
	}
	return s.write(out) == nil
}

// ── error mapping ───────────────────────────────────────────────────────

// framingErrorCode maps a frame.go rejection onto errors.proto. An unknown
// framing version is UNSUPPORTED_VERSION, not "invalid payload": the peer
// speaks something else and should be told so.
func framingErrorCode(err error) uint32 {
	switch {
	case errors.Is(err, ccwire.ErrBadVersion):
		return errUnsupportedVersion
	case errors.Is(err, ccwire.ErrLengthOverMax), errors.Is(err, ccwire.ErrLengthOverflow):
		return errFrameTooLarge
	default:
		return errPayloadInvalid
	}
}
