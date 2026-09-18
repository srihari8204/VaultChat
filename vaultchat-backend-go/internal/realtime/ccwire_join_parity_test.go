package realtime

import (
	"encoding/hex"
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// ccwire_join_parity_test.go — join_chat arrives in TWO forms and the server
// must treat them as ONE operation.
//
//	typed:  body 32 Subscribe {kind: SCOPE_KIND_CHAT, id}  -> handle -> s.scope
//	legacy: body 100 AppEvent {"join_chat", {"chatId":…}}   -> s.appEvent -> events map
//
// The typed form needs NO server change and no server-side capability gate:
// handle() has routed 32/33 to s.scope since CC-Wire shipped, which is what
// capabilities() field 9 (typed_app_bodies) already advertises — the comment
// there names "32/33 via handle→s.scope" explicitly. The gate that matters is
// on the CLIENT: lib/ccwire/eventsSocket.ts emits body 32 only when the
// ServerHello advertised bit 9, and the byte-identical app_event otherwise.
// These tests pin the property that makes that switch safe: both forms take
// the same gate, land on the same room key, and neither is reachable by a
// non-member.

func typedJoinFrame(t *testing.T, chatID string) []byte {
	t.Helper()
	return frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       ccwireStreamControl,
		BodyField:    ccwire.BodySubscribe,
		Body:         ccwire.EncodeScope(ccwire.ScopeKindChat, chatID),
	})
}

func seededPerm(chatID string, ok bool) map[string]cachedPerm {
	return map[string]cachedPerm{chatID: {ok: ok, gen: permGenerationOf(chatID), at: time.Now()}}
}

// A member joins the SAME room through either door. "chat:c1" is the key the
// fan-out matches on (ccwireRoomsLocal reads s.subs), so this is the whole of
// what join_chat does.
func TestCCWireJoinBothFormsReachTheSameRoom(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")

	typed, tf := newSession("u1", seededPerm("c1", true))
	typed.hello = true
	if !typed.handle(typedJoinFrame(t, "c1")) {
		t.Fatal("typed: a member's Subscribe was refused")
	}
	if m := tf.last(t); m.BodyField != ccwire.BodyAck {
		t.Fatalf("typed: expected Ack, got body %d", m.BodyField)
	}
	if _, ok := typed.subs["chat:c1"]; !ok {
		t.Fatal("typed: Subscribe did not join chat:c1")
	}

	legacy, lf := newSession("u1", seededPerm("c1", true))
	enableTestEvents(legacy)
	if !legacy.handle(appEventFrame("join_chat", map[string]any{"chatId": "c1"})) {
		t.Fatal("app_event: join_chat ended the session")
	}
	if _, ok := legacy.subs["chat:c1"]; !ok {
		t.Fatal("app_event: join_chat did not join chat:c1")
	}
	// The legacy form answers NOTHING, exactly as it does today and exactly as
	// Socket.IO does. That silence is the shipped contract and must not change:
	// a client that never negotiated bit 9 sees byte-for-byte what it saw
	// before this migration.
	if len(lf.out) != 0 {
		t.Fatalf("app_event: expected silence, got %d frames", len(lf.out))
	}
}

// The security half: a removed member cannot join by chat id through EITHER
// door. Both read the same seeded cache, which is chatMemberAllowed's.
func TestCCWireJoinBothFormsTakeTheSameMembershipGate(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")

	typed, tf := newSession("u1", seededPerm("c1", false))
	typed.hello = true
	if !typed.handle(typedJoinFrame(t, "c1")) {
		t.Fatal("typed: a refusal must not end the session")
	}
	if got := errorCodeOf(t, tf.last(t)); got != errNotPermitted {
		t.Fatalf("typed: expected NOT_PERMITTED, got %d", got)
	}
	if _, ok := typed.subs["chat:c1"]; ok {
		t.Fatal("typed: a refused join was recorded anyway")
	}

	legacy, lf := newSession("u1", seededPerm("c1", false))
	enableTestEvents(legacy)
	if !legacy.handle(appEventFrame("join_chat", map[string]any{"chatId": "c1"})) {
		t.Fatal("app_event: a refusal must not end the session")
	}
	if _, ok := legacy.subs["chat:c1"]; ok {
		t.Fatal("app_event: a refused join was recorded anyway")
	}
	if len(lf.out) != 0 {
		t.Fatalf("app_event: expected silence, got %d frames", len(lf.out))
	}
}

// The typed form does NOT depend on app_events being negotiated, and the
// legacy form does. Neither statement may quietly become the other: a client
// that negotiated app_events keeps its join_chat handler, and a client that
// did not can still Subscribe.
func TestCCWireJoinTypedFormNeedsNoAppEvents(t *testing.T) {
	s, f := newSession("u1", seededPerm("c1", true))
	s.hello = true // appEvents stays false: no events map, no join_chat handler
	if !s.handle(typedJoinFrame(t, "c1")) {
		t.Fatal("Subscribe was refused on a session without app_events")
	}
	if m := f.last(t); m.BodyField != ccwire.BodyAck {
		t.Fatalf("expected Ack, got body %d", m.BodyField)
	}
	if _, ok := s.subs["chat:c1"]; !ok {
		t.Fatal("Subscribe did not join chat:c1 without app_events")
	}
}

// CROSS-LANGUAGE BYTE PIN. The TS side asserts these same hex strings
// (lib/ccwire/joinEmit.selftest.ts, SCOPE_BODY_PIN / JOIN_FRAME_PIN). Semantic
// agreement alone would let the two sides drift onto different field numbers
// and both still pass; the bytes are what make them one contract.
//
// Body:  08 01            field 1 varint, SCOPE_KIND_CHAT = 1
//        12 02 6331       field 2, 2 bytes, "c1"
// Frame: 0a 01 72         request_id "r"
//        10 01            traffic_class CONTROL
//        18 01            stream CONTROL
//        82 02 06 …       field 32 (32*8+2 = 258), wire 2, 6 bytes, then the body
// seq and depends_on are proto3 defaults and are not written: a join carries no
// position and must not appear to.
const ccwireJoinScopeGoldenWire = "080112026331"
const ccwireJoinFrameGoldenWire = "0a017210011801820206" + ccwireJoinScopeGoldenWire

func TestCCWireJoinWireBytePin(t *testing.T) {
	body := ccwire.EncodeScope(ccwire.ScopeKindChat, "c1")
	if got := hex.EncodeToString(body); got != ccwireJoinScopeGoldenWire {
		t.Errorf("Subscribe body = %s\n                 want %s", got, ccwireJoinScopeGoldenWire)
	}
	msg, err := ccwire.EncodeMessage(ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       ccwireStreamControl,
		BodyField:    ccwire.BodySubscribe,
		Body:         body,
	}, ccwire.DefaultLimits(), 0)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if got := hex.EncodeToString(msg); got != ccwireJoinFrameGoldenWire {
		t.Errorf("Subscribe frame = %s\n                  want %s", got, ccwireJoinFrameGoldenWire)
	}

	// And the pinned bytes decode back to the operation, so the pin is a
	// contract rather than a checksum of whatever this build happens to emit.
	raw, err := hex.DecodeString(ccwireJoinScopeGoldenWire)
	if err != nil {
		t.Fatalf("unhex: %v", err)
	}
	kind, id, err := ccwire.DecodeScope(raw, ccwire.DefaultLimits())
	if err != nil || kind != ccwire.ScopeKindChat || id != "c1" {
		t.Fatalf("DecodeScope(pin) = (%d, %q, %v), want (1, \"c1\", nil)", kind, id, err)
	}
}
