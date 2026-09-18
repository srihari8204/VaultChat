// CC-Wire v1 — the realtime listener, off by default.
//
// HISTORY, because the shape of this file still shows it: CC-Wire was added as
// a SECOND listener running beside Socket.IO, which is why it registers its own
// route on its own mux entry behind its own flag. Socket.IO is now gone — from
// this server, from the mobile client, and from the lockfile (asserted by
// lib/socketioRemoval.selftest.ts). What remains is the flag: with CCWIRE_WS
// unset RegisterCCWire returns before touching the mux, so a deployment that
// does not opt in is byte-for-byte the deployment it was before (asserted by
// TestCCWireIsOffByDefault).
//
// # WHY IT LIVES IN package realtime RATHER THAN package routes
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
	"runtime/debug"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/metrics"
)

// CCWirePath is the endpoint. The prefix was chosen to be disjoint from
// /socket.io/ back when both were mounted; nothing is mounted there now.
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
	log.Printf("[ccwire] CCWIRE_WS=1 — CC-Wire listener mounted at %s", CCWirePath)
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
	h.ccwireRun(r, c)
}

// Both carriers enter the same authenticated protocol and fan-out session.
func (h *Hub) ccwireRun(r *http.Request, c ccwireConnection) {
	u := httpx.UserFrom(r)

	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()
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
		ctx:    ctx,
		cancel: cancel,
	}
	s.w = s.writeWS
	s.sessionID = newSessionID()
	if s.sessionID == "" {
		// The RNG failed. Every consumer of sessionID guards against "", so the
		// session is inert for MATCHING — but it is not inert overall: it would
		// complete the handshake, answer pings, accept submissions, and simply
		// never be registered for fan-out. A client that receives nothing for
		// the life of a connection that looks healthy, with no error and no
		// GoAway, is the worst shape this can fail in. Refuse instead.
		// The socket is already upgraded, so there is no status code left to
		// send; closing it is the refusal. The client reconnects and gets a
		// working session, which is what it would have to do anyway.
		metrics.Inc("ccwire_refused_no_session_id")
		log.Printf("[ccwire] refusing a connection: no session id (RNG unavailable)")
		_ = c.Close()
		return
	}

	// Registered for fan-out AFTER the session is fully built and unregistered
	// before the socket closes, so emitToUidIn never holds a half-live session.
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
			s.queueMu.Lock()
			s.queuedBytes -= len(raw)
			s.queueMu.Unlock()
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
	if s.cancel != nil {
		s.cancel()
	}
	close(s.done)
	if s.conn != nil {
		_ = s.conn.Close()
	}
}

type ccwireConnection interface {
	Close() error
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
	ReadMessage() (int, []byte, error)
	WriteMessage(int, []byte) error
}

type ccwireSession struct {
	sessionID string
	appEvents bool
	// typedAppBodies: the CLIENT said it decodes typed app-domain bodies
	// (Capabilities field 9). Inbound typed bodies are served unconditionally
	// either way; this is only about what the server may SEND.
	//
	// Scope is narrower than it looks — see ccwire_typed_bodies.go. Sessions
	// that did NOT negotiate app_events already receive typed bodies through
	// deliverOne and must keep doing so ungated. This flag is for sending a
	// typed body to a session that DID negotiate app_events, where the client
	// expects app_event (100) and would silently drop anything else.
	typedAppBodies bool
	events      map[string]func(...any)
	subMu       sync.RWMutex
	queueMu     sync.Mutex
	queuedBytes int
	hub         *Hub
	conn        ccwireConnection
	d           *sockData
	lim         ccwire.Limits
	hello       bool
	subs        map[string]struct{}
	// frag is THIS session's fragment reassembler (ccwire_fragment.go).
	// Per-session on purpose: a shared one would let any client evict or
	// observe another's partial sets. Created lazily, so a peer that never
	// fragments costs nothing.
	frag *fragmentReassembler

	// lastCursorAt throttles catch-up. ccwire_messages.go routes sends through
	// the REST handler specifically so CC-Wire inherits its rate limit -
	// chatsDelta has none, and each cursor_sync additionally costs an owner
	// lookup over up to 256 ids under an RLS transaction plus a MAX(id) read. One
	// authenticated socket looping the frame was unbounded work. Single goroutine
	// per session (run()), so no mutex.
	lastCursorAt time.Time
	// wantsResume records that the client negotiated Capabilities.resumption.
	// Gates both the token handed out in ServerHello and the capability echoed
	// back, so the two can never disagree.
	wantsResume bool
	// resumeToken is minted at ServerHello and handed to the client there, so
	// the client is already holding it when the connection dies — which is the
	// only order that works, because most disconnects give no warning. It
	// resolves to nothing until the session parks under it.
	resumeToken string
	// resumed records whether THIS connection resumed a parked session. It is
	// the value ServerHello.resumed reports, and it is false unless every check
	// in tryResume passed — a partial resume is not a resume.
	resumed bool
	// generation is this connection's epoch for the logical session. A frame
	// arriving on an older generation must not advance state: see
	// parkedSession.supersedes.
	generation uint64
	// cursors is what the server has SENT on each stream, stream → seq. The
	// authority against which a client's claimed resume_from is checked.
	cursors map[uint32]uint64
	// acked is what the client has CONFIRMED receiving, from Ping.progress.
	// Always <= cursors: a claim past what we sent is discarded, not recorded.
	acked map[uint32]uint64
	// replay retains recent outbound frames so a resumed session can be handed
	// what it missed (ccwire_replay.go). Nil unless this session negotiated
	// resumption, so the cost is paid only where it can be used.
	replay *replayWindow
	// pos guards cursors, acked, replay and the sequence counters together —
	// they are one fact, written from the fan-out goroutines and read from the
	// reader goroutine. See ccwire_seq.go.
	pos position
	// pendingReplay is what a successful resume owes the client: already-encoded
	// frames, written after ServerHello and before registration lets new traffic
	// in, so replay cannot interleave with what comes next.
	pendingReplay []retainedFrame

	// deviceID comes from ClientHello's existing protobuf field. It is an
	// authenticated session attribute used only to identify a sync install; it
	// does not grant device trust or change authorization.
	deviceID string
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
	ctx    context.Context
	cancel context.CancelFunc
	// Accessed only by the ordered command worker and its synchronous handlers.
	commandCtx context.Context

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
	// One ordered command worker keeps database work off the heartbeat reader.
	// Eight frame slots bound pending input to at most 2 MiB at negotiated limits.
	commands := make(chan []byte, 8)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		// A panic in here is NOT recovered by net/http. This is our goroutine,
		// not a request goroutine, and the handlers it runs are the same
		// production write paths the HTTP mux serves -- chatsMessagePost,
		// chatsMessagePatch, chatsMessageDelete, chatsDelivered, chatsRead,
		// chatsDelta (internal/routes/chats.go:112-128). Without this, one nil
		// map or slice index in any of them takes the WHOLE PROCESS down, for
		// every connected client, not just the one that sent the frame.
		//
		// Recovering ends this session instead of resuming the loop: after a
		// panic part-way through a handler the session state is whatever the
		// panic left behind, and serving more commands from it is a worse
		// failure than making that one client reconnect.
		//
		// Registered AFTER close(finished) so it runs BEFORE it -- run()'s
		// `defer func(){ s.closeOnce(); <-finished }()` blocks on that channel,
		// so finished must not close until recovery has done its work.
		defer func() {
			if r := recover(); r != nil {
				// Two calls rather than one with an embedded newline: the
				// stack is the whole point of this log line, and a format
				// string that wraps is the kind of thing a later edit
				// silently truncates.
				log.Printf("[ccwire] PANIC in command worker, closing session: %v", r)
				log.Printf("[ccwire] stack: %s", debug.Stack())
				s.closeOnce()
			}
		}()
		for {
			select {
			case <-s.done:
				return
			case raw := <-commands:
				select {
				case <-s.done:
					return
				default:
				}
				ctx, cancel := realtimeContext(s.ctx)
				s.commandCtx = ctx
				alive := s.handle(raw)
				s.commandCtx = nil
				cancel()
				if !alive {
					s.closeOnce()
					return
				}
			}
		}
	}()
	defer func() { s.closeOnce(); <-finished }()
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
		if !s.hello {
			if !s.handle(raw) {
				return
			}
			continue
		}
		// Parse before choosing the fast path; malformed frames cannot bypass validation.
		fr, e := ccwire.Decode(raw, ccwire.Options{MaxBytes: s.lim.MaxFrameBytes, Strict: true})
		if e != nil {
			s.refuse("", errPayloadInvalid, "frame")
			return
		}
		m, e := ccwire.DecodeMessage(fr.Payload, s.lim, 0, 0)
		if e != nil {
			s.refuse("", errPayloadInvalid, "frame")
			return
		}
		if m.BodyField == ccwire.BodyPing {
			if !s.handle(raw) {
				return
			}
			continue
		}
		select {
		case commands <- raw:
		case <-s.done:
			return
		default:
			s.refuse(m.RequestID, errRateLimited, "command queue full")
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
	errServerDraining     uint32 = 14
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
		hello, ok := ccwireParseClientHello(m.Body, s.lim)
		if !ok {
			s.refuse(m.RequestID, errPayloadInvalid, "ClientHello")
			return false
		}
		s.deviceID = hello.deviceID
		// Resume is attempted ONLY when the client offered a token. Every
		// failure path inside tryResume leaves s.resumed false, which makes the
		// ServerHello say resumed=false and the client full-resync — exactly
		// what it does today. That is the whole safety argument: this can only
		// improve on the current behaviour, never fall below it.
		//
		// Gated on exactly what the mint below is gated on. The two used to
		// disagree: resume ran on any hello carrying a token, while the token
		// and window were only issued to a client that had negotiated the
		// capability. A client that presented a token without negotiating
		// resumption therefore got resumed=true and a replayed tail, in a
		// ServerHello whose capabilities said resumption was not negotiated —
		// and held a window for the life of the connection that it could never
		// park, paying a per-frame re-encode for nothing.
		wantsResume := resumptionEnabled() && helloWantsResumption(m.Body, s.lim)
		if wantsResume && hello.resumeToken != "" {
			s.tryResume(hello)
		}
		// Mint the NEXT token only for a client that negotiated resumption.
		// A client that did not ask is never handed a credential it will not
		// use, and never sees behaviour different from today.
		if wantsResume {
			s.wantsResume = true
			if tok, ok := newResumeToken(); ok {
				s.resumeToken = tok
				// Same gate, same moment: a window without a token can never be
				// resumed from, and a token without a window can only ever
				// answer resumed=false. A resume already adopted the parked one
				// — replacing it here would discard the tail we just promised.
				if s.replay == nil {
					s.replay = newReplayWindow()
				}
			} else if s.resumed {
				// The RNG failed AFTER a successful resume. Left alone, this
				// ServerHello would say resumed=true while its capabilities
				// omit resumption — telling the client it resumed on a feature
				// the same message says was not negotiated. The adopted window
				// would also be retained for the connection's whole life and
				// could never be parked, because park() refuses without a
				// token: memory and a per-frame re-encode bought for nothing.
				//
				// Unwinding to a fresh session costs one resync, which is the
				// fallback every other uncertain branch here takes.
				metrics.Inc("ccwire_resume_unwound_no_token")
				s.resumed = false
				s.pendingReplay = nil
				s.replay = nil
			}
		}
		s.hello = true
		s.appEvents = appEventsEnabled() && (!ClusterEnabled() || s.hub.cwBusClose != nil) && helloAppEvents(m.Body, s.lim)
		// No env gate, unlike appEvents: this records what the CLIENT can
		// decode, which no server flag can change.
		s.typedAppBodies = helloTypedAppBodies(m.Body, s.lim)
		if s.appEvents {
			s.lim.MaxMessageBodyBytes = appEventLogicalLimit
			s.events = map[string]func(...any){}
			peer := s.eventPeer()
			s.hub.registerChatHandlersPeer(peer)
			s.hub.registerSignalHandlersPeer(peer)
		}
		// The credential inside ClientHello is NOT read: this connection was
		// already authenticated by httpx.RequireAuth at the upgrade, which is
		// the same handshake-time-only model the Socket.IO middleware uses.
		sent := s.send(ccwire.Message{
			RequestID:    m.RequestID,
			TrafficClass: ccwire.TrafficClassControl,
			Stream:       1,
			BodyField:    ccwire.BodyServerHello,
			Body:         s.serverHello(),
		})
		// Registration follows the SEND, not the parse: a session the client
		// never received a ServerHello for must not be registered as live.
		// (`ok` here is the hello-parse result, which is always true by this
		// point — using it would have silently registered on a failed send.)
		// Replay BEFORE registration. Registration is what lets new traffic
		// reach this session; writing the missed tail first is what makes
		// "in ascending sequence within each stream, before any new traffic"
		// true by construction rather than by timing.
		if sent {
			sent = s.flushReplay()
		}
		if sent && s.sessionID != "" {
			s.hub.ccwireRegister(s)
			if s.appEvents {
				s.hub.trackIdentity(s.d.uid, s.sessionID)
			}
		}
		return sent
	}

	switch m.BodyField {
	case ccwire.BodyClientHello:
		s.refuse(m.RequestID, errProtocolViolation, "duplicate ClientHello")
		return false

	case ccwire.BodyPing:
		// Ping.progress (2) carries the client's acknowledged position. Read it
		// so a resume after an ungraceful drop starts from where the client
		// actually got to, not from the last thing the server happened to send.
		//
		// Read-only, and it CANNOT move a cursor forward: noteAcked clamps
		// every claim to what this session actually sent. A client that lies
		// about its progress gets its claim discarded, not honoured.
		s.noteProgress(m.Body)

		// Pong still mirrors Ping field-for-field, so the body is echoed
		// verbatim rather than re-encoded. Bytes not re-serialised are bytes
		// that cannot be corrupted on the way back.
		return s.send(ccwire.Message{
			RequestID:    m.RequestID,
			TrafficClass: ccwire.TrafficClassControl,
			Stream:       1,
			BodyField:    ccwire.BodyPong,
			Body:         m.Body,
		})

	case ccwire.BodySubscribe, ccwire.BodyUnsubscribe:
		return s.scope(m)

	case ccwire.BodyFragment:
		if s.frag == nil {
			s.frag = newFragmentReassembler(s.lim)
		}
		// serveFragment re-dispatches a COMPLETED payload back through serveBody.
		// That covers the MESSAGING bodies only. Ping is answered by handle()
		// inline and Subscribe/Unsubscribe are routed by handle() to s.scope, so
		// none of the three is reachable through a fragment - they fit in one
		// frame by construction, so fragmenting one is a client bug and is
		// answered UNKNOWN_OPERATION. No authorization is skipped either way:
		// s.scope IS the gate, and it simply is not reached.
		if handled, alive := serveFragment(s, s.frag, m); handled {
			return alive
		}
		metrics.Inc("ccwire_unknown_operation")
		return s.sendError(m.RequestID, errUnknownOperation, "operation not served")

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

// ccwireClientHelloDevice reads only ClientHello.device_id (field 5). Unknown
// fields remain opaque, and the bounded protobuf reader rejects malformed data.
func ccwireClientHelloDevice(body []byte, lim ccwire.Limits) (string, bool) {
	h, ok := ccwireParseClientHello(body, lim)
	if !ok {
		return "", false
	}
	return h.deviceID, true
}

// clientHello is the subset of ClientHello this server reads.
//
// credential (6) is deliberately absent: the connection was already
// authenticated by httpx.RequireAuth at the upgrade, and reading a second copy
// of a secret that nobody verifies would buy nothing.
type clientHello struct {
	deviceID    string
	resumeToken string
	// resumeFrom is the client's claimed progress, stream → last_delivered_seq.
	// A CLAIM: validated in acceptCursors against what the server actually sent,
	// never trusted as given.
	resumeFrom map[uint32]uint64
}

// maxResumeFromEntries bounds resume_from. envelope.proto says "<= 8 entries"
// and there are only five streams, so anything beyond this is malformed or
// hostile; either way it is refused rather than allocated for.
const maxResumeFromEntries = 8

// ccwireParseClientHello reads the fields this server acts on.
//
// One parser for the whole message rather than one per field: a second pass
// over the same bytes is a second chance to disagree with the first about what
// they say.
func ccwireParseClientHello(body []byte, lim ccwire.Limits) (clientHello, bool) {
	var h clientHello
	resumeFromSeen := 0
	r := pbr{b: body}
	for r.p < len(r.b) {
		tag, ok := r.tag()
		if !ok || tag>>3 == 0 {
			return clientHello{}, false
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		switch {
		case field == 5 && wire == 2: // device_id
			b, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return clientHello{}, false
			}
			h.deviceID = string(b)

		case field == 7 && wire == 2: // resume_token
			b, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return clientHello{}, false
			}
			h.resumeToken = string(b)

		case field == 8 && wire == 2: // resume_from, repeated StreamCursor
			b, ok := r.span(lim.MaxStringFieldBytes)
			if !ok {
				return clientHello{}, false
			}
			// Count ENTRIES, not distinct streams.
			//
			// This counted len(h.resumeFrom), a map — so N repetitions of the
			// same stream collapsed to one key and the bound never tripped. A
			// hello packed with field-8 entries for stream 2 made the server
			// span() and parse every one of them while the count stayed at 1.
			// Bounded by MaxFrameBytes, so a constant factor per connection
			// rather than something unbounded, but the check did not do what
			// its comment said.
			resumeFromSeen++
			if resumeFromSeen > maxResumeFromEntries {
				// Past the declared bound. Refuse rather than keep allocating
				// for a peer that is already outside the contract.
				return clientHello{}, false
			}
			stream, seq, ok := parseStreamCursor(b, lim)
			if !ok {
				return clientHello{}, false
			}
			if h.resumeFrom == nil {
				h.resumeFrom = map[uint32]uint64{}
			}
			if _, dup := h.resumeFrom[stream]; dup {
				// A second cursor for a stream the client already named. Which
				// one is the truth? Refusing is the only answer that does not
				// involve picking one, and a conforming client never sends it.
				return clientHello{}, false
			}
			h.resumeFrom[stream] = seq

		default:
			if !r.skip(wire, lim) {
				return clientHello{}, false
			}
		}
	}
	return h, true
}

// parseStreamCursor reads one StreamCursor{stream=1, last_delivered_seq=2}.
func parseStreamCursor(b []byte, lim ccwire.Limits) (stream uint32, seq uint64, ok bool) {
	r := pbr{b: b}
	for r.p < len(r.b) {
		tag, good := r.tag()
		if !good || tag>>3 == 0 {
			return 0, 0, false
		}
		field, wire := uint32(tag>>3), uint8(tag&7)
		switch {
		case field == 1 && wire == 0:
			v, good := r.varint()
			if !good {
				return 0, 0, false
			}
			stream = uint32(v)
		case field == 2 && wire == 0:
			v, good := r.varint()
			if !good {
				return 0, 0, false
			}
			seq = v
		default:
			if !r.skip(wire, lim) {
				return 0, 0, false
			}
		}
	}
	return stream, seq, true
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
		s.subMu.Lock()
		_, was := s.subs[key]
		delete(s.subs, key)
		s.subMu.Unlock()
		if was && kind == ccwire.ScopeKindCall {
			// The two side effects leave_call has (handlers.go) and that
			// leaveAppRooms already performs for every call room on disconnect.
			// Without them a typed leave was invisible: every peer kept
			// rendering a tile for someone who is gone, and in cluster mode the
			// Redis roster kept counting a seat nobody holds — which is also a
			// seat the mesh cap keeps refusing to the next joiner.
			//
			// Guarded on `was` so an Unsubscribe for a room this session never
			// joined cannot announce a departure on its behalf.
			p := s.eventPeer()
			p.To(Room(key)).Emit("call_peer_left", map[string]any{"chatId": id, "uid": s.d.uid})
			if ClusterEnabled() {
				clusterCallLeave(id, s.d.uid, s.ctxOrBG())
			}
		}
		return s.sendAck(m)
	}

	allowed, full, roster := s.subscribeAllowed(kind, id)
	if !allowed {
		if full {
			// The mesh cap is not an authorization failure and the client can do
			// something about it: it shows "call is full". The untyped handler
			// has always said so; a typed subscriber heard only NOT_PERMITTED,
			// which is indistinguishable from "you are not in this chat".
			p := s.eventPeer()
			p.Emit("call_full", map[string]any{
				"chatId": id, "max": meshMaxParticipants(), "reason": "mesh_capacity",
			})
		}
		// Coarse on purpose (errors.proto): "not a member", "no such chat" and
		// "not entitled" are one answer, so the error channel is an existence
		// oracle for nothing.
		log.Printf("[ccwire] subscribe refused uid=%s scope=%s", s.d.uid, key)
		metrics.Inc("ccwire_subscribe_refused")
		return s.sendError(m.RequestID, errNotPermitted, "not permitted")
	}
	if !s.joinEventRoom(key) {
		return true
	}
	metrics.Inc("ccwire_subscribe")
	if kind == ccwire.ScopeKindCall {
		// The rest of join_call (handlers.go), through the SAME eventPeer emits
		// it uses, so the frames are the ones that handler produces.
		//
		// NOT in joinEventRoom: that is shared with the untyped door
		// (event_peer.go join -> handlers.go s.Join), so a roster emitted there
		// would reach every legacy joiner TWICE.
		//
		// `roster` was read by the gate, before this session was in the room —
		// re-reading it here would be a second Redis round trip for the same
		// answer.
		p := s.eventPeer()
		if ClusterEnabled() {
			clusterCallJoin(id, s.d.uid, s.ctxOrBG())
		}
		p.Emit("call_roster", map[string]any{"chatId": id, "peers": roster})
		p.To(Room(key)).Emit("call_peer_joined", map[string]any{"chatId": id, "uid": s.d.uid})
	}
	return s.sendAck(m)
}

// subscribeAllowed is the whole point of this file: every scope resolves to a
// gate that ALREADY EXISTS and is already used by the Socket.IO handlers. No
// new notion of "may reach" is introduced here, because a second transport that
// invents one is a second transport that bypasses the first's.
//
// The two extra results belong to the CALL arm alone and are the zero value for
// every other kind. `full` separates the mesh-cap refusal from the membership
// refusal — the only thing the caller needs beyond yes/no, because join_call
// answers a cap refusal with call_full and a typed subscriber must hear the
// same. `roster` is the list the cap was measured against, handed back so the
// join emit does not read it a second time (in cluster mode that is a second
// Redis round trip for an answer already in hand).
func (s *ccwireSession) subscribeAllowed(kind uint32, id string) (allowed bool, full bool, roster []string) {
	switch kind {
	case ccwire.ScopeKindChat:
		// The same check join_chat makes (handlers.go), same cache, same
		// generation — so BumpChatPermissions invalidates a CC-Wire session's
		// decision exactly as it does a Socket.IO one.
		return s.hub.chatMemberAllowed(s.d, id, s.ctxOrBG()), false, nil

	case ccwire.ScopeKindCall:
		// envelope.proto: "chat membership + mesh cap" — which is join_call's
		// rule (handlers.go:802 and the meshMaxParticipants check below it),
		// read off the same roster, in the same order.
		if !s.appEvents {
			// A session that did not negotiate app_events cannot take part in a
			// call at all: emitRooms and ccwireCallRoster both skip it, so it
			// would hear no call_roster, no call_peer_joined and no webrtc_*,
			// and no peer would ever see it — a seat held by a ghost. The
			// untyped door is shut to it too (join_call is only registered for
			// app_event sessions), so refusing here keeps ONE answer, not two.
			return false, false, nil
		}
		if !s.hub.chatMemberAllowed(s.d, id, s.ctxOrBG()) {
			return false, false, nil
		}
		// The roster is whatever join_call counts — h.callRoster now delegates
		// entirely to ccwireCallRoster (handlers.go), so both doors measure the
		// same set of live app_event sessions. An earlier comment here claimed
		// it "counts Socket.IO sockets only"; that transport is gone and the
		// claim was the reverse of the truth.
		if ClusterEnabled() {
			roster = clusterCallRoster(id, s.d.uid, s.ctxOrBG())
		} else {
			roster = s.hub.callRoster(Room("call:"+id), s.d.uid, s.ctxOrBG())
		}
		if len(roster)+1 > meshMaxParticipants() {
			metrics.Inc("ccwire_call_mesh_full")
			return false, true, nil
		}
		return true, false, roster

	case ccwire.ScopeKindRun:
		// runAllowed(drive=false) is the view entitlement, matching the run
		// relay's read side (handlers.go registerRunRelay).
		return s.hub.runAllowed(s.d, id, false, s.ctxOrBG()), false, nil

	case ccwire.ScopeKindChannel:
		// UNGATED, and recorded as such in envelope.proto. channel_join has no
		// check today; adding one HERE would be a second, divergent policy.
		// When channels grow a membership gate it belongs in one function both
		// transports call.
		return true, false, nil

	case ccwire.ScopeKindAdmin:
		// The admin key is a Socket.IO handshake concept and is not accepted on
		// this endpoint at all, so no session can ever satisfy this scope.
		return false, false, nil

	default:
		// SCOPE_KIND_UNSPECIFIED, or a kind from a newer peer. An unknown scope
		// is refused, never assumed.
		return false, false, nil
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
	// resume_token (6) — the credential for the NEXT connection, handed over
	// now because there is no later opportunity: a dropped connection cannot
	// deliver anything. It is inert until this session parks under it.
	//
	// Only offered when the capability is negotiated, so a client that did not
	// ask for resume is never handed a credential it will not use.
	if s.resumeToken != "" {
		b = ccwire.AppendStringField(b, 6, s.resumeToken)
	}
	b = ccwire.AppendVarintField(b, 7, uint64(time.Now().UnixMilli()))
	if s.resumed {
		// resumed (8). False is a proto3 default and stays unwritten, which is
		// also the honest answer: the client must full-resync.
		b = ccwire.AppendBoolField(b, 8, true)
	}
	return b
}

// capabilities is the intersection this build can actually honour. Anything not
// implemented is ABSENT rather than advertised — a capability claimed and not
// delivered is worse than one never offered.
func (s *ccwireSession) capabilities() []byte {
	// Negotiation is by INTERSECTION (capabilities.proto): a capability absent
	// from either side is inactive. So the rule cuts both ways, and only one
	// half was being observed. Claiming something unimplemented is the obvious
	// error; NOT claiming something implemented is the quieter one - a
	// conforming client is told fragmentation is off and will never fragment,
	// while the reassembler (8 slots, 2 MiB) stays reachable by anyone who
	// ignores the handshake. The two below are served and tested; advertise them.
	var b []byte
	b = ccwire.AppendBoolField(b, 1, true) // fragmentation     — serveFragment, this file
	b = ccwire.AppendBoolField(b, 3, true) // batch_cursor_sync — ccwire_cursor.go
	b = ccwire.AppendBoolField(b, 7, true) // structured_errors
	b = ccwire.AppendBoolField(b, 9, true) // typed_app_bodies — serveBody serves 48/50/51/52/64/81/82/84 unconditionally (32/33 via handle→s.scope); NOT field 8 inverted, both may be set
	if s.appEvents {
		b = ccwire.AppendBoolField(b, 8, true)
	}
	// resumption (2) is advertised only when BOTH the deployment enabled it
	// (CCWIRE_RESUME=1) and this client asked for it. The capability set is an
	// INTERSECTION, so echoing it unconditionally would promise resume to
	// clients that never negotiated it — and advertising it while the feature
	// was off would promise it to everyone.
	if s.wantsResume && s.resumeToken != "" {
		b = ccwire.AppendBoolField(b, 2, true)
	}
	// Still ABSENT on purpose: datagrams (4) - not applicable over WebSocket;
	// reauth_in_place (5) and causal_epochs (6) - unimplemented.
	return b
}

func encodeLimits(l ccwire.Limits) []byte {
	var b []byte
	b = ccwire.AppendVarintField(b, 1, uint64(l.MaxFrameBytes))
	b = ccwire.AppendVarintField(b, 2, uint64(l.MaxOpaqueBytes))
	b = ccwire.AppendVarintField(b, 3, uint64(l.MaxMessageBodyBytes))
	b = ccwire.AppendVarintField(b, 4, uint64(l.MaxFragmentsPerMessage))
	b = ccwire.AppendVarintField(b, 5, ReassemblyLifetimeMS)      // enforced by ccwire_fragment.go
	b = ccwire.AppendVarintField(b, 6, MaxReassemblyBytes)        // enforced by ccwire_fragment.go
	b = ccwire.AppendVarintField(b, 7, MaxConcurrentReassemblies) // enforced by ccwire_fragment.go
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

// sendGoAway tells the peer this server is going away on purpose.
//
// BodyGoAway (21) has existed in the codec tables since the contract was
// written and lib/ccwire/client.ts has always handled it - it calls
// down("transport", "go_away"), which is its RECONNECT path. Go never sent
// one, so a deploy or a SIGTERM reached the client as an abrupt socket close,
// which is indistinguishable from a network failure and is handled with the
// backoff reserved for one. Saying "go away" instead lets the client reconnect
// immediately, to another replica, without waiting out a penalty it did not
// earn.
//
// drain_deadline_ms is the honest remainder of the shutdown budget, not a
// constant: a client that is told 10s and then cut off at 2s learns to ignore
// the field.
func (s *ccwireSession) sendGoAway(reason uint32, drainMS uint32) bool {
	var b []byte
	b = ccwire.AppendVarintField(b, 1, uint64(reason))
	b = ccwire.AppendVarintField(b, 3, uint64(drainMS))
	// Field 2 (last_accepted) and field 4 (resume_token) are deliberately
	// omitted. Both are promises: last_accepted says "everything up to here is
	// durable" and resume_token says "hand this back and I will restore your
	// state".
	//
	// This comment used to say there was no resumption support at all. With
	// CCWIRE_RESUME=1 there is, so the reason has to be restated rather than
	// left to rot into a false claim: a client that negotiated resumption is
	// ALREADY holding a token from its ServerHello, and this frame is sent
	// while the process is going down. Parked state dies with it, so the token
	// the client holds will not resolve, the next ServerHello answers
	// resumed=false, and the client resyncs. Offering a fresh token here would
	// be promising to restore state that this process will not be alive to
	// restore.
	return s.send(ccwire.Message{
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       1,
		BodyField:    ccwire.BodyGoAway,
		Body:         b,
	})
}

// ccwireShutdown tells every live CC-Wire session to go away, then ends them.
//
// Called from Hub.Shutdown. Socket.IO clients already got DisconnectSockets;
// CC-Wire sessions had nothing equivalent and were simply dropped when the
// process exited.
//
// Best-effort by construction: a peer that is already gone, or whose write
// blocks, must not hold up the shutdown budget for everyone else, so a failed
// send is ignored and the session is closed regardless.
func (h *Hub) ccwireShutdown(drain time.Duration) {
	if h == nil {
		return
	}
	h.cwmu.Lock()
	var all []*ccwireSession
	for _, byUser := range h.cwSessions {
		for s := range byUser {
			all = append(all, s)
		}
	}
	h.cwmu.Unlock()

	// The grace we will ACTUALLY honour, which is what gets advertised. An
	// earlier version advertised the caller's whole budget and then closed in
	// the next statement - the precise behaviour sendGoAway's own comment
	// condemns, and a client told 10s and cut off at 0 learns to ignore the
	// field. It is capped well under the caller's budget because Hub.Shutdown
	// still has to close the Socket.IO server inside the same deadline.
	grace := drain / 4
	if grace > 2*time.Second {
		grace = 2 * time.Second
	}
	if grace < 0 {
		grace = 0
	}

	// CONCURRENTLY. write() takes the session's write mutex and writeWS sets a
	// 10s deadline, and drain() may already hold that mutex on a stalled
	// fan-out write - so one wedged peer used to cost up to 20s BEFORE the next
	// session was even reached. Serially, that is the whole SIGTERM budget for
	// a handful of dead sockets.
	var wg sync.WaitGroup
	for _, s := range all {
		wg.Add(1)
		go func(s *ccwireSession) {
			defer wg.Done()
			// SERVER_DRAINING, not INTERNAL. errors.proto has both, and the
			// difference is the whole message: draining says "this is a planned
			// shutdown, come back", internal says "something broke". A client
			// that cannot tell them apart treats every rolling deploy as a
			// fault — and the ones that back off harder on faults take longest
			// to come back exactly when the fleet is trying to.
			_ = s.sendGoAway(errServerDraining, uint32(grace.Milliseconds()))
		}(s)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(grace):
		// A peer that has not taken the frame in the grace it was promised does
		// not get to extend it. Its goroutine is left to finish against its own
		// write deadline; closing the socket below is what unblocks it.
	}
	for _, s := range all {
		s.closeOnce()
	}
}

// sendError writes a structured Error. `detail` is SERVER-AUTHORED and never
// echoes client input — echoing would reintroduce the relay injection surface
// inside the error channel itself (errors.proto).
func (s *ccwireSession) sendError(requestID string, code uint32, detail string) bool {
	class := uint32(2) // ERROR_CLASS_FATAL
	switch code {
	// PAYLOAD_INVALID is a bad FRAME, not a bad session, and the two sides used
	// to disagree about that: sendError's callers return true, so the server
	// keeps serving, while the client read class FATAL and tore the transport
	// down for good (client.ts down('protocol') -> fatal -> transport.ts refuses
	// to re-dial for the life of the process). One stale cursor presented for
	// the wrong chat - the exact case ccwire_cursor.go exists to catch - cost
	// the client CC-Wire until the app was restarted.
	//
	// A violation that really must end the session goes through refuse(), which
	// closes it deliberately rather than relying on the class to do it.
	case errNotPermitted, errUnknownOperation, errRateLimited, errInternal,
		errPayloadInvalid:
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
	if c, ok := s.conn.(*websocket.Conn); ok {
		_ = c.WriteControl(websocket.CloseMessage,
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
	if s.write(out) != nil {
		return false
	}
	// Under one lock, because a cursor that has moved past a frame the window
	// has not retained yet is a window with a hole nobody recorded.
	//
	// Frames sent HERE are control-plane replies and carry no seq, so both
	// calls are no-ops in practice. They stay because the invariant is "a frame
	// with a seq is retained", and an invariant enforced at only one of its two
	// call sites is one refactor away from being false.
	s.pos.mu.Lock()
	s.noteSentLocked(m)
	s.replay.retain(m, out, time.Now())
	s.pos.mu.Unlock()
	return true
}

// noteSent records what this session has now SENT on each stream.
//
// This is the authority a resuming client's claimed progress is checked
// against: without it, s.cursors stays empty, a parked session carries no
// position, and acceptCursors compares a claim against nothing. The cursor half
// of resume would look implemented and do nothing — which is worse than it not
// existing, because the metrics would say it worked.
//
// Placed AFTER a successful write on purpose. A frame that failed to go out was
// not sent, and recording it would tell the next connection to skip a frame the
// peer never saw.
func (s *ccwireSession) noteSent(m ccwire.Message) {
	s.pos.mu.Lock()
	defer s.pos.mu.Unlock()
	s.noteSentLocked(m)
}

func (s *ccwireSession) noteSentLocked(m ccwire.Message) {
	if m.Seq == 0 {
		// Unsequenced control traffic (ServerHello, Pong, Error) carries no
		// position and must not move one.
		return
	}
	if s.cursors == nil {
		s.cursors = map[uint32]uint64{}
	}
	// Monotonic only. Streams are per-stream FIFO, so a lower seq here means a
	// bug upstream; taking it would move the cursor BACKWARDS and re-deliver.
	if m.Seq > s.cursors[m.Stream] {
		s.cursors[m.Stream] = m.Seq
	}
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
