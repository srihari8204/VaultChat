// ccwire_presence_test.go — the four presence bodies, against the package's
// existing socket-free seams (newSession/fakeConn/frame/pbFields).
//
// The inbound handlers are driven directly rather than through handle(),
// because the serveBody switch that routes 82 and 84 to them is ccwire.go's to
// write. Every frame is still round-tripped through EncodeMessage/DecodeMessage
// first, so the bodies under test are bytes off the wire, not structs.
package realtime

import (
	"encoding/base64"
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/db"
)

func permAt(id string, ok bool) cachedPerm {
	return cachedPerm{ok: ok, gen: permGenerationOf(id), at: time.Now()}
}

// wire encodes and re-decodes a message, so a handler is handed exactly what
// the transport would hand it — including the EPHEMERAL invariant, which
// EncodeMessage enforces on the way out.
func wire(t *testing.T, m ccwire.Message) ccwire.Message {
	t.Helper()
	payload, err := ccwire.EncodeMessage(m, ccwire.DefaultLimits(), 0)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, err := ccwire.DecodeMessage(payload, ccwire.DefaultLimits(), 0, 0)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got
}

func viewerStateBody(chatID string, activity uint64, leaving, resync bool) []byte {
	b := ccwire.AppendStringField(nil, 1, chatID)
	b = ccwire.AppendVarintField(b, 2, activity)
	b = ccwire.AppendBoolField(b, 3, leaving)
	return ccwire.AppendBoolField(b, 4, resync)
}

func viewerStateMsg(t *testing.T, body []byte) ccwire.Message {
	t.Helper()
	return wire(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassEphemeral,
		Stream:       ccwireStreamEphemeral,
		BodyField:    ccwire.BodyViewerState,
		Body:         body,
	})
}

func geoRelayMsg(t *testing.T, body []byte) ccwire.Message {
	t.Helper()
	return wire(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassEphemeral,
		Stream:       ccwireStreamEphemeral,
		BodyField:    ccwire.BodyGeoRelay,
		Body:         body,
	})
}

// ── viewer_state: authorization ─────────────────────────────────────────

// The gate is the same one join_chat, typing_state and onChatView use, at the
// same cache generation. Without it, cvList hands back the uid of everyone
// viewing any chat a client can name, and cvTouch announces the caller to them.
func TestCCWireViewerStateUsesTheChatMemberGate(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{"c-denied": permAt("c-denied", false)})

	if !s.viewerState(viewerStateMsg(t, viewerStateBody("c-denied", 1, false, true))) {
		t.Fatal("a refusal must not end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", got)
	}
	// Nothing else went out: no roster, not even an empty one.
	if len(f.out) != 1 {
		t.Fatalf("a refused viewer_state wrote %d frames", len(f.out))
	}
}

// Revocation revokes it. BumpChatPermissions invalidates the held decision, so
// the next viewer_state cannot reuse the answer from before the removal.
func TestCCWireViewerStateDecisionIsInvalidatedOnRevocation(t *testing.T) {
	const chat = "c-bumped"
	s, _ := newSession("u1", map[string]cachedPerm{chat: permAt(chat, true)})
	if !s.hub.chatMemberAllowed(s.d, chat) {
		t.Fatal("precondition: the seeded decision should be usable")
	}
	BumpChatPermissions(chat)
	if s.d.chatMemberOk[chat].fresh(permGenerationOf(chat)) {
		t.Fatal("a removed member kept a usable viewer_state decision")
	}
}

// ── viewer_state: malformed bodies ──────────────────────────────────────

func TestCCWireViewerStateRefusesMalformedBodies(t *testing.T) {
	cases := []struct {
		name string
		body []byte
	}{
		{"empty", nil},
		{"no chat_id", viewerStateBody("", 1, false, false)},
		// A length-delimited field whose length runs past the body.
		{"truncated string", []byte{0x0a, 0x7f, 'a'}},
		// field 0 is not representable in protobuf.
		{"field zero", []byte{0x00, 0x01}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, f := newSession("u1", map[string]cachedPerm{"c1": permAt("c1", true)})
			// Built without EncodeMessage for the malformed shapes: the point is
			// a body the codec accepted as opaque bytes but that does not decode.
			m := ccwire.Message{RequestID: "r", TrafficClass: ccwire.TrafficClassEphemeral,
				BodyField: ccwire.BodyViewerState, Body: c.body}
			if !s.viewerState(m) {
				t.Fatal("a malformed body must not end the session")
			}
			if got := errorCodeOf(t, f.last(t)); got != errPayloadInvalid {
				t.Fatalf("expected PAYLOAD_INVALID, got %d", got)
			}
		})
	}
}

// ── viewer_list: outbound only ──────────────────────────────────────────

// A member asking to resync gets the roster back, as a ViewerList on SYNC.
// With no Redis in this package's tests the roster is empty, which is the
// correct answer and still proves the shape, the class and the chat id.
func TestCCWireViewerStateResyncRepliesWithAViewerList(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{"c-ok": permAt("c-ok", true)})

	if !s.viewerState(viewerStateMsg(t, viewerStateBody("c-ok", 2, false, true))) {
		t.Fatal("a member's viewer_state was refused")
	}
	m := f.last(t)
	if m.BodyField != ccwire.BodyViewerList {
		t.Fatalf("expected ViewerList, got body %d", m.BodyField)
	}
	if m.TrafficClass != ccwire.TrafficClassSync {
		t.Fatalf("viewer_list is not on the EPHEMERAL allow-list; got class %d", m.TrafficClass)
	}
	if got := pbStr(t, pbFields(t, m.Body), 1); got != "c-ok" {
		t.Fatalf("viewer_list chat_id wrong: %q", got)
	}
}

// A plain heartbeat is not a roster request: no frame at all.
func TestCCWireViewerStateHeartbeatAnswersNothing(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{"c-ok": permAt("c-ok", true)})
	if !s.viewerState(viewerStateMsg(t, viewerStateBody("c-ok", 1, false, false))) {
		t.Fatal("a heartbeat was refused")
	}
	if len(f.out) != 0 {
		t.Fatalf("EPHEMERAL viewer_state must not be acked; wrote %d frames", len(f.out))
	}
}

// 83 and 80 are server-authored shapes. They are not accepted inbound, and the
// answer is UNKNOWN_OPERATION rather than a silent drop.
func TestCCWireDoesNotAcceptViewerListOrPresenceUpdateInbound(t *testing.T) {
	for _, body := range []uint32{ccwire.BodyViewerList, ccwire.BodyPresenceUpdate} {
		s, f := newSession("u1", map[string]cachedPerm{})
		hello(t, s)
		if !s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassSync,
			BodyField:    body,
			Body:         ccwire.AppendStringField(nil, 1, "c1"),
		})) {
			t.Fatalf("body %d: an unserved operation must not kill the session", body)
		}
		if got := errorCodeOf(t, f.last(t)); got != errUnknownOperation {
			t.Fatalf("body %d: expected UNKNOWN_OPERATION, got %d", body, got)
		}
	}
}

// ── the EPHEMERAL invariant, for all four ───────────────────────────────

// envelope.proto: an EPHEMERAL frame may carry ONLY typing_state, viewer_state
// or geo_relay. presence_update and viewer_list are refused in that class at
// BOTH ends — which is the other half of why neither is served inbound here.
func TestCCWirePresenceBodiesObeyTheEphemeralInvariant(t *testing.T) {
	for _, body := range []uint32{ccwire.BodyViewerState, ccwire.BodyGeoRelay} {
		if _, err := ccwire.EncodeMessage(ccwire.Message{
			TrafficClass: ccwire.TrafficClassEphemeral, BodyField: body,
		}, ccwire.DefaultLimits(), 0); err != nil {
			t.Fatalf("body %d must be legal on EPHEMERAL: %v", body, err)
		}
	}
	for _, body := range []uint32{ccwire.BodyPresenceUpdate, ccwire.BodyViewerList} {
		if _, err := ccwire.EncodeMessage(ccwire.Message{
			TrafficClass: ccwire.TrafficClassEphemeral, BodyField: body,
		}, ccwire.DefaultLimits(), 0); err != ccwire.ErrProtocolViolation {
			t.Fatalf("body %d on EPHEMERAL must be a protocol violation, got %v", body, err)
		}
	}

	// And over the transport: a hand-built EPHEMERAL presence_update ends the
	// session with PROTOCOL_VIOLATION, never "handled leniently".
	// 1005 = traffic_class EPHEMERAL; 8205 00 = field 80 wire 2, empty.
	raw, err := ccwire.Encode([]byte{0x10, 0x05, 0x82, 0x05, 0x00}, ccwire.Options{})
	if err != nil {
		t.Fatalf("frame: %v", err)
	}
	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)
	if s.handle(raw) {
		t.Fatal("an EPHEMERAL presence_update must end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errProtocolViolation {
		t.Fatalf("expected PROTOCOL_VIOLATION, got %d", got)
	}
}

// ── geo_relay: authorization ────────────────────────────────────────────

func geoBody(kind uint32, scopeID, subjectID string, sealed []byte, ended bool, until int64) []byte {
	b := ccwire.AppendVarintField(nil, 1, uint64(kind))
	b = ccwire.AppendStringField(b, 2, scopeID)
	b = ccwire.AppendStringField(b, 3, subjectID)
	b = ccwire.AppendBytesField(b, 4, sealed)
	b = ccwire.AppendBoolField(b, 5, ended)
	return ccwire.AppendVarintField(b, 6, uint64(until))
}

// The gate live_location_update and trip_update already have.
func TestCCWireGeoRelayUsesTheChatMemberGate(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{"c-denied": permAt("c-denied", false)})
	if !s.geoRelay(geoRelayMsg(t, geoBody(ccwire.ScopeKindChat, "c-denied", "", []byte("sealed"), false, 0))) {
		t.Fatal("a refusal must not end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", got)
	}
}

// Every non-chat scope is refused, and refused BEFORE the membership cache is
// consulted — live location is chat-scoped on the other transport and a second
// transport must not widen it.
func TestCCWireGeoRelayRefusesNonChatScopes(t *testing.T) {
	for _, kind := range []uint32{
		ccwire.ScopeKindUnspecified, ccwire.ScopeKindChannel,
		ccwire.ScopeKindCall, ccwire.ScopeKindRun, ccwire.ScopeKindAdmin, 99,
	} {
		// Seeded ALLOW: if the handler consulted membership for these scopes it
		// would pass, so a refusal here can only come from the scope check.
		s, f := newSession("u1", map[string]cachedPerm{"c1": permAt("c1", true)})
		if !s.geoRelay(geoRelayMsg(t, geoBody(kind, "c1", "", []byte("sealed"), false, 0))) {
			t.Fatalf("scope %d: session ended unexpectedly", kind)
		}
		if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
			t.Fatalf("scope %d: expected NOT_PERMITTED, got %d", kind, got)
		}
	}
}

func TestCCWireGeoRelayRefusesMalformedBodies(t *testing.T) {
	cases := []struct {
		name string
		body []byte
		code uint32
	}{
		{"no scope_id", geoBody(ccwire.ScopeKindChat, "", "", []byte("s"), false, 0), errPayloadInvalid},
		{"live ping with no sealed", geoBody(ccwire.ScopeKindChat, "c1", "", nil, false, 0), errPayloadInvalid},
		{"truncated bytes field", []byte{0x22, 0x7f, 'a'}, errPayloadInvalid},
		// scope_kind defaults to UNSPECIFIED on an empty body, which is refused
		// as a scope rather than decoded into a chat.
		{"empty", nil, errNotPermitted},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, f := newSession("u1", map[string]cachedPerm{"c1": permAt("c1", true)})
			m := ccwire.Message{RequestID: "r", TrafficClass: ccwire.TrafficClassEphemeral,
				BodyField: ccwire.BodyGeoRelay, Body: c.body}
			if !s.geoRelay(m) {
				t.Fatal("a malformed body must not end the session")
			}
			if got := errorCodeOf(t, f.last(t)); got != c.code {
				t.Fatalf("expected %d, got %d", c.code, got)
			}
		})
	}
}

// A member's relay is fire-and-forget: forwarded, not acked, not errored.
func TestCCWireGeoRelayIsFireAndForget(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{"c-ok": permAt("c-ok", true)})
	if !s.geoRelay(geoRelayMsg(t, geoBody(ccwire.ScopeKindChat, "c-ok", "", []byte("sealed"), false, 99))) {
		t.Fatal("a member's geo_relay was refused")
	}
	if len(f.out) != 0 {
		t.Fatalf("EPHEMERAL geo_relay must not be answered; wrote %d frames", len(f.out))
	}
}

// ── geo_relay: the server stays blind ───────────────────────────────────

// The relayed payload carries the SESSION's uid, the sealed blob verbatim
// (base64 of the exact bytes, round-trippable) and no coordinate of any kind.
func TestGeoRelayEventIsOpaqueAndServerStamped(t *testing.T) {
	sealed := []byte{0x00, 0xff, 0x10, 'l', 'a', 't'}

	for _, c := range []struct {
		name    string
		g       ccwire.GeoRelay
		event   string
		hasBlob bool
	}{
		{"live", ccwire.GeoRelay{ScopeID: "c1", Sealed: sealed, UntilMS: 42}, "live_location_update", true},
		{"live stop", ccwire.GeoRelay{ScopeID: "c1", Ended: true}, "live_location_stop", false},
		{"trip", ccwire.GeoRelay{ScopeID: "c1", SubjectID: "t1", Sealed: sealed}, "trip_update", true},
		{"trip end", ccwire.GeoRelay{ScopeID: "c1", SubjectID: "t1", Ended: true}, "trip_end", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			// sender_uid is set on the INBOUND body: it must be ignored, because
			// the proto marks it server-stamped on delivery.
			g := c.g
			g.SenderUID = "someone-else"
			event, out := geoRelayEvent("u1", g)

			if event != c.event {
				t.Fatalf("event %q, want %q", event, c.event)
			}
			if out["userId"] != "u1" {
				t.Fatalf("userId is %v, not the session's", out["userId"])
			}
			for _, k := range []string{"latitude", "longitude", "address", "lat", "lng"} {
				if _, ok := out[k]; ok {
					t.Fatalf("the relay payload leaked a plaintext %q", k)
				}
			}
			blob, ok := out["blob"].(string)
			if ok != c.hasBlob {
				t.Fatalf("blob present=%v, want %v", ok, c.hasBlob)
			}
			if c.hasBlob {
				back, err := base64.StdEncoding.DecodeString(blob)
				if err != nil || string(back) != string(sealed) {
					t.Fatalf("sealed bytes did not survive verbatim: %x (%v)", back, err)
				}
			}
			if c.g.SubjectID != "" && out["tripId"] != c.g.SubjectID {
				t.Fatalf("tripId is %v", out["tripId"])
			}
		})
	}
}

// ── ephemeral means not durable ─────────────────────────────────────────

// Neither body may reach Postgres. This package's tests run with no pool at
// all, so any persistence attempt would nil-dereference: the precondition below
// turns "did not persist" into something the run actually proves rather than
// something the reader takes on trust.
func TestPresenceBodiesNeverPersist(t *testing.T) {
	if db.SysPool != nil {
		t.Skip("a pool is configured; this assertion only holds in the DB-free package tests")
	}
	s, f := newSession("u1", map[string]cachedPerm{"c-ok": permAt("c-ok", true)})

	if !s.viewerState(viewerStateMsg(t, viewerStateBody("c-ok", 1, false, false))) {
		t.Fatal("viewer_state heartbeat failed")
	}
	if !s.viewerState(viewerStateMsg(t, viewerStateBody("c-ok", 1, false, true))) {
		t.Fatal("viewer_state resync failed")
	}
	if !s.viewerState(viewerStateMsg(t, viewerStateBody("c-ok", 0, true, false))) {
		t.Fatal("viewer_state leave failed")
	}
	if !s.geoRelay(geoRelayMsg(t, geoBody(ccwire.ScopeKindChat, "c-ok", "", []byte("x"), false, 0))) {
		t.Fatal("geo_relay failed")
	}
	if !s.geoRelay(geoRelayMsg(t, geoBody(ccwire.ScopeKindChat, "c-ok", "t1", nil, true, 0))) {
		t.Fatal("geo_relay end failed")
	}

	// The only frame any of that may produce is the resync's ViewerList.
	if len(f.out) != 1 {
		t.Fatalf("expected exactly one reply (the resync roster), got %d", len(f.out))
	}
	if m := f.last(t); m.BodyField != ccwire.BodyViewerList {
		t.Fatalf("expected ViewerList, got body %d", m.BodyField)
	}
}

// The activity vocabulary is shared with the Socket.IO roster, so it must round
// trip: a string the Redis hash holds encodes to the enum a peer reads, and an
// unknown one degrades to UNSPECIFIED rather than being invented.
func TestViewerActivityRoundTrips(t *testing.T) {
	for n, name := range viewerActivityWire {
		if got := viewerActivityEnum(name); got != uint64(n) {
			t.Fatalf("%q encoded as %d, want %d", name, got, n)
		}
	}
	if got := viewerActivityEnum("teleporting"); got != 0 {
		t.Fatalf("an unknown activity must surface as UNSPECIFIED, got %d", got)
	}
	if _, ok := viewerActivityWire[99]; ok {
		t.Fatal("an unknown enum number must not map to an activity string")
	}
}
