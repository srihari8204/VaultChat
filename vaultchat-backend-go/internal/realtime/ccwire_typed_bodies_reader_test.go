package realtime

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// helloTypedAppBodies is the INBOUND half of Capabilities field 9. The server
// already advertises field 9; without this reader a client's bit was invisible,
// so "gate typed emit on what the peer decodes" was unenforceable in the
// server->client direction.
//
// Every case here is about failing CLOSED: false means "keep sending
// app_event", which is the only direction that cannot break an existing client.

// capsInHello wraps a capabilities blob in a ClientHello: field 3, wire 2.
func capsInHello(caps []byte) []byte {
	b := ccwire.AppendVarintField(nil, 1, 1) // protocol_major, as a real hello has
	b = append(b, byte(3<<3|2), byte(len(caps)))
	return append(b, caps...)
}

func TestHelloTypedAppBodiesReadsField9(t *testing.T) {
	lim := ccwire.DefaultLimits()

	// The exact blob the TS client sends: fragmentation(1) resumption(2)
	// app_events_v1(8) typed_app_bodies(9). Tag 9<<3 = 72.
	full := []byte{8, 1, 16, 1, 64, 1, 72, 1}
	if !helloTypedAppBodies(capsInHello(full), lim) {
		t.Fatal("field 9 set but not read")
	}

	// A client that predates the field. This is the case that matters most:
	// absence must never be mistaken for support.
	old := []byte{8, 1, 16, 1, 64, 1}
	if helloTypedAppBodies(capsInHello(old), lim) {
		t.Fatal("a hello without field 9 must not enable typed emit")
	}

	// Explicitly false is not true.
	if helloTypedAppBodies(capsInHello([]byte{72, 0}), lim) {
		t.Fatal("typed_app_bodies = 0 must be false")
	}

	// No capabilities sub-message at all.
	if helloTypedAppBodies(ccwire.AppendVarintField(nil, 1, 1), lim) {
		t.Fatal("a hello with no capabilities must not enable typed emit")
	}

	// Field 9 present but AFTER an unknown field, so the skip path has to work.
	withUnknown := []byte{8, 1, 120, 1, 72, 1} // field 15 varint, then field 9
	if !helloTypedAppBodies(capsInHello(withUnknown), lim) {
		t.Fatal("field 9 after an unknown field must still be read")
	}
}

func TestHelloTypedAppBodiesFailsClosedOnGarbage(t *testing.T) {
	lim := ccwire.DefaultLimits()
	cases := map[string][]byte{
		"empty":                    {},
		"truncated tag":            {0x80},
		"caps length overruns":     {8, 1, byte(3<<3 | 2), 0x7f, 1, 2, 3},
		"truncated varint in caps": append(capsInHello([]byte{72}), 0),
		"caps is not a submessage": {byte(3<<3 | 0), 1},
	}
	for name, b := range cases {
		if helloTypedAppBodies(b, lim) {
			t.Fatalf("%s: malformed input returned true; it must fail closed", name)
		}
	}
}

// The other two hand-written readers must SKIP field 9 rather than choke on it.
// A client sending the new bit must not lose resumption or app events.
func TestExistingReadersTolerateField9(t *testing.T) {
	lim := ccwire.DefaultLimits()
	// fragmentation + resumption + app_events_v1 + typed_app_bodies
	hello := capsInHello([]byte{8, 1, 16, 1, 64, 1, 72, 1})

	if !helloAppEvents(hello, lim) {
		t.Fatal("helloAppEvents regressed when field 9 is present")
	}
	if !helloWantsResumption(hello, lim) {
		t.Fatal("helloWantsResumption regressed when field 9 is present")
	}
}

// A repeated scalar is legal protobuf and the LAST one wins — the rule every
// conformant decoder applies, helloAppEvents next door included.
//
// It matters here in one direction only. Reading a retracted `true` as consent
// makes the server send a typed body to a session that negotiated app_events
// and will silently drop anything else: no error, no log, a message that simply
// does not arrive. Reading a retracted `false` as a no costs nothing — the
// server keeps sending app_event, which every such client already handles.
//
// A hello like this is not exotic. Concatenating two capability blobs, or a
// proxy appending a correction rather than rewriting the field, both produce it.
func TestHelloTypedAppBodiesLastOccurrenceWins(t *testing.T) {
	lim := ccwire.DefaultLimits()

	// true then false — the dangerous direction. Must read as FALSE.
	if helloTypedAppBodies(capsInHello([]byte{72, 1, 72, 0}), lim) {
		t.Error("typed_app_bodies=true then false read as true: the client's LAST " +
			"word was no, and the server would send frames it silently drops")
	}

	// false then true — must read as TRUE, so the fix is last-wins and not
	// simply "any false anywhere".
	if !helloTypedAppBodies(capsInHello([]byte{72, 0, 72, 1}), lim) {
		t.Error("typed_app_bodies=false then true read as false: last occurrence wins")
	}
}
