package realtime

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// EVERY body is accounted for: served, or answered. Never silently dropped.
//
// The other CC-Wire tests each pin one operation. Nothing pinned the SET, so
// the failure this file exists to catch is a body that is neither served nor
// refused - the client waits forever for a reply that is never coming, which is
// the silent-drop bug errors.proto was written to end.
//
// It is driven off ccwire.BodyFields, the schema's own list, so adding a body
// to the contract without deciding what this server does with it fails here
// rather than at a customer.

// bodyDisposition is the DECISION for each body, not a description of current
// behaviour. Changing an entry is a deliberate contract change.
type bodyDisposition int

const (
	// servedInbound: a client may send it and this server acts on it.
	servedInbound bodyDisposition = iota
	// outboundOnly: this server SENDS it; a client that sends one is confused,
	// and must be told so rather than ignored.
	outboundOnly
	// notServed: in the contract, deliberately not implemented here. Must be
	// answered UNKNOWN_OPERATION. The reason is recorded per entry below.
	notServed
)

var ccwireDisposition = map[uint32]struct {
	name string
	d    bodyDisposition
	why  string
}{
	// ── handshake and control ──────────────────────────────────────────────
	ccwire.BodyClientHello: {"client_hello", servedInbound, ""},
	ccwire.BodyServerHello: {"server_hello", outboundOnly, "the server's half of the handshake"},
	ccwire.BodyReAuth: {"reauth", notServed,
		"re-auth in place would refresh credentials mid-session. Capabilities." +
			"reauth_in_place is NOT advertised, so no conforming client sends one; " +
			"serving it would mean accepting a new identity on a session whose " +
			"authorization caches (chatMemberOk/runOk) were populated for the old one."},
	ccwire.BodyPing:   {"ping", servedInbound, ""},
	ccwire.BodyPong:   {"pong", outboundOnly, "answer to our ping"},
	ccwire.BodyGoAway: {"go_away", outboundOnly, "we send it on shutdown; see sendGoAway"},
	ccwire.BodyAck:    {"ack", outboundOnly, "our acknowledgement"},
	ccwire.BodyError:  {"error", outboundOnly, "our refusal"},

	// ── scope ──────────────────────────────────────────────────────────────
	ccwire.BodySubscribe:   {"subscribe", servedInbound, ""},
	ccwire.BodyUnsubscribe: {"unsubscribe", servedInbound, ""},

	// ── messaging ──────────────────────────────────────────────────────────
	ccwire.BodySubmitMessage:  {"submit_message", servedInbound, ""},
	ccwire.BodyDeliverMessage: {"deliver_message", outboundOnly, "fan-out to recipients"},
	ccwire.BodyEditMessage:    {"edit_message", servedInbound, ""},
	ccwire.BodyDeleteMessage:  {"delete_message", servedInbound, ""},
	ccwire.BodyReceipt:        {"receipt", servedInbound, ""},

	// ── sync ───────────────────────────────────────────────────────────────
	ccwire.BodyCursorSync: {"cursor_sync", servedInbound, ""},
	ccwire.BodyCursorBatch: {"cursor_batch", outboundOnly,
		"cursor.proto gives it `more` and a server-authored `continuation`; a " +
			"client cannot author either, so it is the REPLY to cursor_sync"},

	// ── presence and ephemeral ─────────────────────────────────────────────
	ccwire.BodyTypingState: {"typing_state", servedInbound, ""},
	ccwire.BodyPresenceUpdate: {"presence_update", outboundOnly,
		"every field is server-authored (user_id, online, last_seen_ms) and " +
			"presence.go owns that fact. Accepting one inbound would let a client " +
			"assert ANOTHER user's online state. Not on the EPHEMERAL allow-list."},
	ccwire.BodyViewerState: {"viewer_state", servedInbound, ""},
	ccwire.BodyViewerList: {"viewer_list", outboundOnly,
		"reply shape carrying other users' identities, which a client cannot " +
			"supply - the same argument as cursor_batch. Sent to one requesting " +
			"member session only, never broadcast, ghost-mode owners removed."},
	ccwire.BodyGeoRelay: {"geo_relay", servedInbound, ""},

	// ── framing ────────────────────────────────────────────────────────────
	ccwire.BodyFragment: {"fragment", servedInbound, ""},
	ccwire.BodyAppEvent: {"app_event", servedInbound, ""},

	// ── media ──────────────────────────────────────────────────────────────
	ccwire.BodyAttachmentControl: {"attachment_control", notServed,
		"media deliberately stays on REST, where chatsValidateAttachmentRef gates " +
			"every attachment reference. Serving it here would be a second, weaker " +
			"path to the same objects - see the refusal in ccwire_messages.go that " +
			"already rejects attachmentId/gifUrl smuggled through a text send."},
	ccwire.BodyDeviceEvent: {"device_event", notServed,
		"device add/remove is an identity change. It belongs to the authenticated " +
			"REST surface that owns the device registry, not to a transport frame. " +
			"(Naming that table here trips the guard in internal/routes that keeps it " +
			"unreferenced until the device claim lands.)"},
	ccwire.BodyCryptoControl: {"crypto_control", notServed,
		"key material and prekey exchange stay on the REST surface. The transport " +
			"is deliberately blind to crypto state."},
	ccwire.BodyCallSignal: {"call_signal", notServed,
		"calls signal over the app_event webrtc_* relay (handlers.go " +
			"registerSignalHandlersPeer), not over this body. The asymmetry noted here " +
			"before is gone: a ScopeKindCall Subscribe now needs app_events, which is " +
			"exactly what the relay needs, so nothing can subscribe to a call room it " +
			"cannot signal on. Serving 49 would be a second signalling path."},
}

// Bodies whose disposition this build decides dynamically are listed here so the
// table above stays a decision rather than a mirror of the code.
func TestEveryBodyInTheSchemaHasADisposition(t *testing.T) {
	for _, f := range ccwire.BodyFields {
		if _, ok := ccwireDisposition[f]; !ok {
			t.Fatalf("body field %d is in ccwire.BodyFields but nothing in this table "+
				"says what this server does with it. A body with no decision is the "+
				"silent-drop bug: a client sends it and waits forever.", f)
		}
	}
	if len(ccwireDisposition) != len(ccwire.BodyFields) {
		t.Fatalf("the disposition table has %d entries for %d schema bodies - an entry "+
			"names a body that is no longer in the contract",
			len(ccwireDisposition), len(ccwire.BodyFields))
	}
}

// Anything not served inbound must be ANSWERED, never dropped. An empty body is
// used deliberately: a served operation refuses it on its own terms (some code
// other than UNKNOWN_OPERATION), an unserved one is refused by the dispatch.
func TestUnservedAndOutboundBodiesAreAnswered(t *testing.T) {
	for _, f := range ccwire.BodyFields {
		e := ccwireDisposition[f]
		if e.d == servedInbound {
			continue
		}
		s, fc := newSession("u1", map[string]cachedPerm{})
		hello(t, s)

		alive := s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassMessaging,
			BodyField:    f,
		}))
		if !alive {
			t.Fatalf("%s (%d): an unserved operation must not kill the session", e.name, f)
		}
		if len(fc.out) == 0 {
			t.Fatalf("%s (%d): SILENTLY DROPPED - no reply at all. The client waits "+
				"forever. Reason this body is not served: %s", e.name, f, e.why)
		}
		if got := errorCodeOf(t, fc.last(t)); got != errUnknownOperation {
			t.Fatalf("%s (%d): expected UNKNOWN_OPERATION, got %d - this body is being "+
				"served, but the table says it should not be. Reason: %s",
				e.name, f, got, e.why)
		}
	}
}

// The complement: everything the table calls servedInbound must NOT answer
// UNKNOWN_OPERATION, or the table is lying about what this build does.
func TestServedBodiesAreNotAnsweredUnknown(t *testing.T) {
	for _, f := range ccwire.BodyFields {
		e := ccwireDisposition[f]
		if e.d != servedInbound || f == ccwire.BodyClientHello {
			continue // client_hello is consumed by the handshake, before this path
		}
		s, fc := newSession("u1", map[string]cachedPerm{})
		hello(t, s)

		if f == ccwire.BodyAppEvent {
			s.appEvents = true
		}
		if !s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassMessaging,
			BodyField:    f,
		})) {
			t.Fatalf("%s (%d): a malformed body must not kill the session", e.name, f)
		}
		if len(fc.out) == 0 {
			continue // answering with nothing is acceptable for some ephemerals
		}
		// A served body need not answer with an Error at all - ping answers with a
		// pong. Only an Error body can carry UNKNOWN_OPERATION, so anything else
		// already proves the handler was reached.
		if last := fc.last(t); last.BodyField != ccwire.BodyError {
			continue
		}
		if got := errorCodeOf(t, fc.last(t)); got == errUnknownOperation {
			t.Fatalf("%s (%d) is listed as served but the dispatch answers "+
				"UNKNOWN_OPERATION - the handler is unreachable", e.name, f)
		}
	}
}

// Advertised capabilities must match IMPLEMENTED ones, in both directions.
//
// capabilities.proto negotiates by INTERSECTION: a bit absent from either side
// is inactive. Both failure modes matter, and only one was being watched.
// Claiming something unimplemented breaks a client that believes it. NOT
// claiming something implemented is quieter and was the live defect: a
// conforming client was told fragmentation was off and would never fragment,
// while the reassembler stayed reachable to anything that ignored the
// handshake - so the feature was dead weight and an attack surface at once.
func TestAdvertisedCapabilitiesMatchTheImplementation(t *testing.T) {
	s, _ := newSession("u1", map[string]cachedPerm{})
	got := map[uint32]bool{}
	for f, vals := range pbFields(t, s.capabilities()) {
		got[f] = len(vals) > 0 && vals[0].num == 1
	}

	// field -> (should be advertised, why)
	want := map[uint32]struct {
		on  bool
		why string
	}{
		1: {true, "fragmentation: serveFragment is dispatched from handle()"},
		2: {false, "resumption: no resume state is kept — sendGoAway deliberately omits resume_token"},
		3: {true, "batch_cursor_sync: cursorSync replies with a CursorBatch"},
		4: {false, "datagrams: not applicable over WebSocket"},
		5: {false, "reauth_in_place: reauth is unserved (see the disposition table)"},
		6: {false, "causal_epochs: unimplemented"},
		7: {true, "structured_errors: sendError emits a typed Error body"},
	}
	for field, w := range want {
		if got[field] != w.on {
			verb := "is NOT advertised but IS implemented"
			if !w.on {
				verb = "IS advertised but is NOT implemented"
			}
			t.Fatalf("capability field %d %s — %s", field, verb, w.why)
		}
	}

	// The two that are advertised as served must genuinely be in the dispatch,
	// or this test is only checking itself.
	if d := ccwireDisposition[ccwire.BodyFragment]; d.d != servedInbound {
		t.Fatal("fragmentation is advertised but body 112 is not served inbound")
	}
	if d := ccwireDisposition[ccwire.BodyCursorSync]; d.d != servedInbound {
		t.Fatal("batch_cursor_sync is advertised but body 64 is not served inbound")
	}
}
