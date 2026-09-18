package realtime

import (
	"bytes"
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// typed_app_bodies is Capabilities field 9: "this peer ACCEPTS typed app-domain
// bodies inbound". serveBody routes 50/51/52/64/81/82/84 (and 48) with no
// feature flag, so the claim is honest unconditionally. It is NOT field 8
// inverted — both may be set at once.
func TestServerHelloAdvertisesTypedAppBodies(t *testing.T) {
	s, _ := newSession("u1", map[string]cachedPerm{})

	// Byte check: field 9, varint, true == tag 72 (9<<3) then 0x01.
	if !bytes.Contains(s.capabilities(), []byte{72, 0x01}) {
		t.Fatalf("capabilities blob lacks field 9 varint true (72 0x01): % x", s.capabilities())
	}

	// app_events_v1 (8) is independent and unchanged: absent unless negotiated,
	// present alongside 9 when it is.
	if f := pbFields(t, s.capabilities()); len(f[8]) != 0 {
		t.Fatalf("field 8 advertised without negotiation: %v", f[8])
	}
	s.appEvents = true
	f := pbFields(t, s.capabilities())
	if len(f[8]) != 1 || f[8][0].num != 1 {
		t.Fatalf("field 8 regressed once negotiated: %v", f[8])
	}
	if len(f[9]) != 1 || f[9][0].num != 1 {
		t.Fatalf("field 9 not set: %v", f[9])
	}

	// And it really ships inside ServerHello.capabilities (field 3).
	if len(pbFields(t, pbFields(t, s.serverHello())[3][0].buf)[9]) != 1 {
		t.Fatal("ServerHello.capabilities does not carry field 9")
	}
}

// The hand-written pbr-based readers (helloAppEvents, helloWantsResumption) are
// the OTHER Go codec for capabilities. Neither models field 9 — they must at
// least skip it cleanly rather than bail out.
func TestHandWrittenCapabilityReadersTolerateField9(t *testing.T) {
	s, _ := newSession("u1", map[string]cachedPerm{})
	s.appEvents = true
	caps := s.capabilities()
	caps = ccwire.AppendBoolField(caps, 2, true) // resumption, so both readers have something to find
	hello := ccwire.AppendBytesField(nil, 3, caps)

	if !helloAppEvents(hello, s.lim) {
		t.Fatal("helloAppEvents failed on a capabilities blob containing field 9")
	}
	if !helloWantsResumption(hello, s.lim) {
		t.Fatal("helloWantsResumption failed on a capabilities blob containing field 9")
	}
}
