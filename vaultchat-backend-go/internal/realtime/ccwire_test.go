package realtime

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"vaultchat/backend-go/internal/ccwire"
)

// ── the property that protects everyone who is not opted in ─────────────

// With CCWIRE_WS unset, nothing is registered. Not "registered and refusing" —
// NOT REGISTERED, so the mux answers exactly as it did before this file existed
// and no CC-Wire code can run at all.
func TestCCWireIsOffByDefault(t *testing.T) {
	t.Setenv("CCWIRE_WS", "")
	if CCWireEnabled() {
		t.Fatal("CCWIRE_WS unset must read as off")
	}

	mux := http.NewServeMux()
	RegisterCCWire(mux, &Hub{})

	// ServeMux reports the pattern that would handle a request; a miss falls
	// through to the built-in NotFoundHandler with an empty pattern.
	if _, pattern := mux.Handler(httptest.NewRequest(http.MethodGet, CCWirePath, nil)); pattern != "" {
		t.Fatalf("route registered with the flag off: pattern %q", pattern)
	}

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, CCWirePath, nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 with the flag off, got %d", rec.Code)
	}
}

// The mirror: with the flag on it IS registered. Without this, the test above
// would keep passing if RegisterCCWire were gutted entirely.
func TestCCWireRegistersWhenEnabled(t *testing.T) {
	t.Setenv("CCWIRE_WS", "1")
	mux := http.NewServeMux()
	RegisterCCWire(mux, &Hub{})
	if _, pattern := mux.Handler(httptest.NewRequest(http.MethodGet, CCWirePath, nil)); pattern != CCWirePath {
		t.Fatalf("flag on but route missing: pattern %q", pattern)
	}
}

// Some value other than "1" is not a half-on state.
func TestCCWireFlagIsExact(t *testing.T) {
	for _, v := range []string{"", "0", "true", "yes", "2"} {
		t.Setenv("CCWIRE_WS", v)
		if CCWireEnabled() {
			t.Fatalf("CCWIRE_WS=%q must not enable the listener", v)
		}
	}
}

// Registering with the flag on must not disturb an already-mounted /socket.io/.
// The live transport keeping its handler is the whole constraint.
func TestCCWireDoesNotDisturbSocketIO(t *testing.T) {
	t.Setenv("CCWIRE_WS", "1")
	mux := http.NewServeMux()
	live := http.NewServeMux() // stands in for hub.Handler()
	mux.Handle("/socket.io/", live)

	RegisterCCWire(mux, &Hub{})

	h, pattern := mux.Handler(httptest.NewRequest(http.MethodGet, "/socket.io/?EIO=4", nil))
	if pattern != "/socket.io/" {
		t.Fatalf("Socket.IO route changed: pattern %q", pattern)
	}
	if h != http.Handler(live) {
		t.Fatal("Socket.IO handler was replaced")
	}
}

// ── authentication ──────────────────────────────────────────────────────

// The endpoint is wrapped in httpx.RequireAuth, so an unauthenticated upgrade
// is refused before the WebSocket handshake — there is no moment at which an
// anonymous socket exists.
func TestCCWireRefusesUnauthenticatedUpgrade(t *testing.T) {
	t.Setenv("CCWIRE_WS", "1")
	mux := http.NewServeMux()
	RegisterCCWire(mux, &Hub{})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + CCWirePath
	for _, hdr := range []http.Header{
		nil,
		{"Authorization": {"Bearer not-a-jwt"}},
		{"Authorization": {"Basic hunter2"}},
	} {
		c, resp, err := websocket.DefaultDialer.Dial(url, hdr)
		if err == nil {
			c.Close()
			t.Fatalf("upgrade succeeded without a valid token (headers %v)", hdr)
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %v", resp)
		}
	}
}

// ── the wire, end to end, without a database ────────────────────────────
//
// The session is driven directly rather than through the HTTP route, because
// the authorization gates hit the database and this package's tests have none
// by design (see join_authz_test.go). The cached path returns before touching
// it, so a pre-seeded decision is what makes a membership test runnable here —
// and it is the same cache join_chat consults.

type fakeConn struct {
	out [][]byte
}

func newSession(uid string, seed map[string]cachedPerm) (*ccwireSession, *fakeConn) {
	f := &fakeConn{}
	return &ccwireSession{
		hub:  &Hub{},
		lim:  ccwire.DefaultLimits(),
		d:    &sockData{uid: uid, chatMemberOk: seed, runOk: map[string]cachedPerm{}},
		subs: map[string]struct{}{},
		w:    f.write,
	}, f
}

func (f *fakeConn) write(b []byte) error { f.out = append(f.out, b); return nil }

// last decodes the most recent frame written by the session.
func (f *fakeConn) last(t *testing.T) ccwire.Message {
	t.Helper()
	if len(f.out) == 0 {
		t.Fatal("session wrote nothing")
	}
	fr, err := ccwire.Decode(f.out[len(f.out)-1], ccwire.Options{Strict: true})
	if err != nil {
		t.Fatalf("session emitted an unframeable message: %v", err)
	}
	m, err := ccwire.DecodeMessage(fr.Payload, ccwire.DefaultLimits(), 0, 0)
	if err != nil {
		t.Fatalf("session emitted an undecodable frame: %v", err)
	}
	return m
}

// errorCodeOf reads Error.code (field 1) out of an Error body.
func errorCodeOf(t *testing.T, m ccwire.Message) uint32 {
	t.Helper()
	if m.BodyField != ccwire.BodyError {
		t.Fatalf("expected an Error body, got field %d", m.BodyField)
	}
	if len(m.Body) < 2 || m.Body[0] != 0x08 {
		t.Fatalf("Error body does not start with field 1 varint: %x", m.Body)
	}
	return uint32(m.Body[1])
}

// frame builds a wire message the way a client would.
func frame(t *testing.T, m ccwire.Message) []byte {
	t.Helper()
	payload, err := ccwire.EncodeMessage(m, ccwire.DefaultLimits(), 0)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := ccwire.Encode(payload, ccwire.Options{})
	if err != nil {
		t.Fatalf("frame: %v", err)
	}
	return out
}

func hello(t *testing.T, s *ccwireSession) {
	t.Helper()
	if !s.handle(frame(t, ccwire.Message{
		TrafficClass: ccwire.TrafficClassControl,
		BodyField:    ccwire.BodyClientHello,
	})) {
		t.Fatal("ClientHello was refused")
	}
}

func TestCCWireHandshakeThenPing(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)
	if m := f.last(t); m.BodyField != ccwire.BodyServerHello {
		t.Fatalf("expected ServerHello, got body %d", m.BodyField)
	}

	if !s.handle(frame(t, ccwire.Message{
		RequestID:    "req-1",
		TrafficClass: ccwire.TrafficClassControl,
		BodyField:    ccwire.BodyPing,
		Body:         []byte{0x0a, 0x02, 0xaa, 0xbb}, // nonce
	})) {
		t.Fatal("Ping was refused")
	}
	m := f.last(t)
	if m.BodyField != ccwire.BodyPong {
		t.Fatalf("expected Pong, got body %d", m.BodyField)
	}
	if m.RequestID != "req-1" {
		t.Fatalf("Pong lost the correlation id: %q", m.RequestID)
	}
	if string(m.Body) != string([]byte{0x0a, 0x02, 0xaa, 0xbb}) {
		t.Fatalf("Pong did not echo the nonce verbatim: %x", m.Body)
	}
}

// Nothing is served before the handshake — and it is ANSWERED, never silently
// dropped.
func TestCCWireRequiresClientHelloFirst(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{})
	if s.handle(frame(t, ccwire.Message{
		TrafficClass: ccwire.TrafficClassControl,
		BodyField:    ccwire.BodySubscribe,
		Body:         ccwire.EncodeScope(ccwire.ScopeKindChat, "c1"),
	})) {
		t.Fatal("a pre-handshake Subscribe must end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errProtocolViolation {
		t.Fatalf("expected PROTOCOL_VIOLATION, got %d", got)
	}
}

// ── THE authorization property ──────────────────────────────────────────

// A CC-Wire Subscribe to a chat passes the SAME membership check as join_chat.
// The seeded cache is the one chatMemberAllowed reads, so a `false` decision
// here is the removed-member case — the exact scenario audit F02 covers for
// Socket.IO, now proven for the second transport too.
func TestCCWireSubscribeUsesTheJoinChatGate(t *testing.T) {
	at := func(id string, ok bool) cachedPerm {
		return cachedPerm{ok: ok, gen: permGenerationOf(id), at: time.Now()}
	}

	t.Run("a non-member is refused", func(t *testing.T) {
		s, f := newSession("u1", map[string]cachedPerm{"c-denied": at("c-denied", false)})
		hello(t, s)
		if !s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassControl,
			BodyField:    ccwire.BodySubscribe,
			Body:         ccwire.EncodeScope(ccwire.ScopeKindChat, "c-denied"),
		})) {
			t.Fatal("a refusal must not kill the session — the client may still resync")
		}
		if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
			t.Fatalf("expected NOT_PERMITTED, got %d", got)
		}
		if _, ok := s.subs["chat:c-denied"]; ok {
			t.Fatal("a refused subscribe must not be recorded")
		}
	})

	t.Run("a member is admitted", func(t *testing.T) {
		s, f := newSession("u1", map[string]cachedPerm{"c-ok": at("c-ok", true)})
		hello(t, s)
		if !s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassControl,
			BodyField:    ccwire.BodySubscribe,
			Body:         ccwire.EncodeScope(ccwire.ScopeKindChat, "c-ok"),
		})) {
			t.Fatal("a member's subscribe was refused")
		}
		if m := f.last(t); m.BodyField != ccwire.BodyAck {
			t.Fatalf("expected Ack, got body %d", m.BodyField)
		}
		if _, ok := s.subs["chat:c-ok"]; !ok {
			t.Fatal("an accepted subscribe was not recorded")
		}
	})

	// A membership change must invalidate a CC-Wire session's held decision the
	// same way it invalidates a Socket.IO one. The bump makes the cached entry
	// unusable, so the next check re-queries the database rather than reusing
	// the answer from before the removal.
	t.Run("a permission bump invalidates the held decision", func(t *testing.T) {
		const chat = "c-bumped"
		s, _ := newSession("u1", map[string]cachedPerm{chat: at(chat, true)})
		if !s.hub.chatMemberAllowed(s.d, chat) {
			t.Fatal("precondition: the seeded decision should be usable")
		}
		BumpChatPermissions(chat)
		if s.d.chatMemberOk[chat].fresh(permGenerationOf(chat)) {
			t.Fatal("a removed member's CC-Wire session kept a usable decision")
		}
	})
}

// The scopes a session may never name. SCOPE_KIND_ADMIN is the admin key's, and
// the admin key is a Socket.IO handshake concept not accepted here at all;
// UNSPECIFIED and anything from a newer peer are refused, never assumed.
func TestCCWireRefusesUnnameableScopes(t *testing.T) {
	for _, kind := range []uint32{ccwire.ScopeKindUnspecified, ccwire.ScopeKindAdmin, 99} {
		s, f := newSession("u1", map[string]cachedPerm{})
		hello(t, s)
		if !s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassControl,
			BodyField:    ccwire.BodySubscribe,
			Body:         ccwire.EncodeScope(kind, "anything"),
		})) {
			t.Fatalf("scope %d: session ended unexpectedly", kind)
		}
		if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
			t.Fatalf("scope %d: expected NOT_PERMITTED, got %d", kind, got)
		}
	}
}

// ── the EPHEMERAL invariant, over the actual transport ──────────────────

// A CryptoControl on an EPHEMERAL frame is refused by the endpoint, with
// ERROR_CODE_PROTOCOL_VIOLATION — never "handled leniently" (envelope.proto).
func TestCCWireEnforcesTheEphemeralInvariant(t *testing.T) {
	// Built by hand: EncodeMessage refuses to produce this, which is itself the
	// encode half of the invariant.
	if _, err := ccwire.EncodeMessage(ccwire.Message{
		TrafficClass: ccwire.TrafficClassEphemeral,
		BodyField:    ccwire.BodyCryptoControl,
	}, ccwire.DefaultLimits(), 0); err != ccwire.ErrProtocolViolation {
		t.Fatalf("encode must refuse an EPHEMERAL CryptoControl, got %v", err)
	}

	// 1005 = traffic_class EPHEMERAL; 9206 00 = field 98 wire 2, empty.
	payload := []byte{0x10, 0x05, 0x92, 0x06, 0x00}
	raw, err := ccwire.Encode(payload, ccwire.Options{})
	if err != nil {
		t.Fatalf("frame: %v", err)
	}

	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)
	if s.handle(raw) {
		t.Fatal("an EPHEMERAL CryptoControl must end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errProtocolViolation {
		t.Fatalf("expected PROTOCOL_VIOLATION, got %d", got)
	}

	// The legal counterpart, so the refusal above is the invariant and not a
	// blanket refusal of EPHEMERAL.
	s2, f2 := newSession("u1", map[string]cachedPerm{})
	hello(t, s2)
	if !s2.handle(frame(t, ccwire.Message{
		TrafficClass: ccwire.TrafficClassEphemeral,
		BodyField:    ccwire.BodyTypingState,
	})) {
		t.Fatal("EPHEMERAL typing_state is legal and must not end the session")
	}
	// typing_state IS served now (ccwire_messages.go), so an EMPTY one is
	// refused for the reason an empty one deserves — no chat_id — rather than as
	// an unserved operation. Either way the session survives, which is what this
	// half of the test is for: the refusal above is the EPHEMERAL invariant and
	// not a blanket refusal of the traffic class.
	if got := errorCodeOf(t, f2.last(t)); got != errPayloadInvalid {
		t.Fatalf("expected PAYLOAD_INVALID for an empty typing_state, got %d", got)
	}
}

// A frame over the negotiated size is refused BEFORE anything is parsed, and
// reported as FRAME_TOO_LARGE rather than as a decode failure.
func TestCCWireRefusesOversizedFrames(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)

	big := make([]byte, ccwire.DefaultLimits().MaxFrameBytes+1)
	raw, err := ccwire.Encode(big, ccwire.Options{}) // hard max, so framing allows it
	if err != nil {
		t.Fatalf("frame: %v", err)
	}
	if s.handle(raw) {
		t.Fatal("an oversized frame must end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errFrameTooLarge {
		t.Fatalf("expected FRAME_TOO_LARGE, got %d", got)
	}
}

// A body this build routes but does not serve is ANSWERED with
// UNKNOWN_OPERATION — "the fix for the silent-drop bug that shipped trips
// broken" (errors.proto).
func TestCCWireAnswersUnservedOperations(t *testing.T) {
	// submit_message, receipt, typing_state, edit_message and delete_message have
	// moved OFF this list — they are served now (ccwire_messages_test.go).
	//
	// fragment (112) moved off too: ccwire_fragment.go reassembles it, and a
	// malformed one is now answered FRAGMENT_INVALID (9) rather than
	// UNKNOWN_OPERATION. That is a deliberate behaviour change, not a weakened
	// assertion — ccwire_fragment_test.go covers the body end to end, including
	// that every refusal carries code 9.
	//
	// cursor_sync (64) is served as well (ccwire_cursor.go). cursor_batch (65)
	// stays OFF the served list on purpose: cursor.proto gives it `more` and a
	// server-authored `continuation`, which makes it the REPLY shape, not an
	// inbound request.
	//
	// Everything still on it is answered rather than dropped.
	for _, body := range []uint32{
		ccwire.BodyCryptoControl, ccwire.BodyCallSignal,
	} {
		s, f := newSession("u1", map[string]cachedPerm{})
		hello(t, s)
		if !s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassMessaging,
			BodyField:    body,
		})) {
			t.Fatalf("body %d: an unserved operation must not kill the session", body)
		}
		if got := errorCodeOf(t, f.last(t)); got != errUnknownOperation {
			t.Fatalf("body %d: expected UNKNOWN_OPERATION, got %d", body, got)
		}
	}
}
