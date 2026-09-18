package realtime

import (
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// ccwire_call_parity_test.go — join_call, like join_chat, arrives in TWO forms:
//
//	typed:  body 32 Subscribe {kind: SCOPE_KIND_CALL, id}  -> handle -> s.scope
//	legacy: body 100 AppEvent {"join_call", {"chatId":…}}   -> s.appEvent -> events map
//
// Unlike join_chat the typed door was a STUB: it took the gate, joined the
// room and acked, and did none of the four things join_call does — no roster
// to the joiner, no call_peer_joined to the room, no cluster roster write, and
// a mesh-cap refusal that looked exactly like "you are not a member". A client
// that took that door got a silent call: it was in the room, and nobody in the
// room knew, including itself. These tests pin the four, in both directions.

func typedCallFrame(t *testing.T, chatID string, leave bool) []byte {
	t.Helper()
	body := ccwire.BodySubscribe
	if leave {
		body = ccwire.BodyUnsubscribe
	}
	return frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       ccwireStreamControl,
		BodyField:    body,
		Body:         ccwire.EncodeScope(ccwire.ScopeKindCall, chatID),
	})
}

// eventsWritten decodes every app_event (100) frame this session has written,
// in order. The call contract is entirely app_event frames, so this is what
// "did the join do its job" means.
func eventsWritten(t *testing.T, f *fakeConn) []struct {
	Name    string
	Payload map[string]any
} {
	t.Helper()
	var out []struct {
		Name    string
		Payload map[string]any
	}
	for _, raw := range f.out {
		fr, err := ccwire.Decode(raw, ccwire.Options{Strict: true})
		if err != nil {
			t.Fatalf("unframeable: %v", err)
		}
		m, err := ccwire.DecodeMessage(fr.Payload, ccwire.DefaultLimits(), 0, 0)
		if err != nil {
			t.Fatalf("undecodable: %v", err)
		}
		if m.BodyField != ccwire.BodyAppEvent {
			continue
		}
		r := pbr{b: m.Body}
		var name string
		var payload map[string]any
		for r.p < len(r.b) {
			tag, ok := r.tag()
			if !ok {
				t.Fatal("bad app_event body")
			}
			b, ok := r.span(maxPayloadLen)
			if !ok {
				t.Fatal("bad app_event field")
			}
			if tag == 10 {
				name = string(b)
			} else if tag == 18 {
				if err := json.Unmarshal(b, &payload); err != nil {
					t.Fatalf("app_event payload: %v", err)
				}
			}
		}
		out = append(out, struct {
			Name    string
			Payload map[string]any
		}{name, payload})
	}
	return out
}

func countEvent(events []struct {
	Name    string
	Payload map[string]any
}, name string) int {
	n := 0
	for _, e := range events {
		if e.Name == name {
			n++
		}
	}
	return n
}

func firstEvent(t *testing.T, events []struct {
	Name    string
	Payload map[string]any
}, name string) map[string]any {
	t.Helper()
	for _, e := range events {
		if e.Name == name {
			return e.Payload
		}
	}
	t.Fatalf("no %s among %d events: %v", name, len(events), events)
	return nil
}

// callSession returns a registered app_event session that is a member of chatID.
func callSession(t *testing.T, h *Hub, uid, chatID string) (*ccwireSession, *fakeConn) {
	t.Helper()
	s, f := newSession(uid, map[string]cachedPerm{chatID: {ok: true, gen: permGenerationOf(chatID), at: time.Now()}})
	s.hub = h
	s.sessionID = "cw:" + uid
	enableTestEvents(s)
	h.ccwireRegister(s)
	return s, f
}

// The whole of join_call, through the typed door: the joiner learns who is
// already there, the room learns about the joiner, and the Ack still answers
// the Subscribe.
func TestCCWireTypedCallJoinDeliversRosterAndAnnouncesTheJoiner(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	t.Setenv("REDIS_ADAPTER", "")
	h := &Hub{}

	peer, pf := callSession(t, h, "u2", "c1")
	peer.subs["call:c1"] = struct{}{}

	joiner, jf := callSession(t, h, "u1", "c1")
	if !joiner.handle(typedCallFrame(t, "c1", false)) {
		t.Fatal("typed: a member's call Subscribe was refused")
	}
	if _, ok := joiner.subs["call:c1"]; !ok {
		t.Fatal("typed: Subscribe did not join call:c1")
	}
	if m := jf.last(t); m.BodyField != ccwire.BodyAck {
		t.Fatalf("typed: expected Ack last, got body %d", m.BodyField)
	}

	got := eventsWritten(t, jf)
	if n := countEvent(got, "call_roster"); n != 1 {
		t.Fatalf("typed join delivered %d call_roster events, want exactly 1 — without it the "+
			"joiner never learns who is already in the call and connects to nobody", n)
	}
	roster := firstEvent(t, got, "call_roster")
	if roster["chatId"] != "c1" {
		t.Fatalf("call_roster chatId = %v", roster["chatId"])
	}
	peers, _ := roster["peers"].([]any)
	if len(peers) != 1 || peers[0] != "u2" {
		t.Fatalf("call_roster peers = %v, want [u2]", roster["peers"])
	}

	// The joiner must NOT receive its own announcement (exclude = sessionID),
	// and the room must.
	if n := countEvent(got, "call_peer_joined"); n != 0 {
		t.Fatalf("joiner received %d of its own call_peer_joined", n)
	}
	announced := firstEvent(t, eventsWritten(t, pf), "call_peer_joined")
	if announced["uid"] != "u1" || announced["chatId"] != "c1" {
		t.Fatalf("call_peer_joined = %v, want {chatId:c1, uid:u1}", announced)
	}
	if n := countEvent(eventsWritten(t, pf), "call_roster"); n != 0 {
		t.Fatal("the roster is the JOINER's; a peer already in the room must not be re-rostered")
	}
}

// THE DOUBLE-EMIT GUARD. The roster lives in the CALL arm of s.scope, never in
// joinEventRoom — which is shared with the legacy door (event_peer.go join ->
// handlers.go s.Join). Put it there and every legacy joiner gets two.
func TestCCWireLegacyCallJoinEmitsExactlyOneRoster(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	t.Setenv("REDIS_ADAPTER", "")
	h := &Hub{}

	peer, _ := callSession(t, h, "u2", "c1")
	peer.subs["call:c1"] = struct{}{}

	legacy, lf := callSession(t, h, "u1", "c1")
	if !legacy.handle(appEventFrame("join_call", map[string]any{"chatId": "c1"})) {
		t.Fatal("app_event: join_call ended the session")
	}
	got := eventsWritten(t, lf)
	if n := countEvent(got, "call_roster"); n != 1 {
		t.Fatalf("the legacy join emitted %d call_roster events, want exactly 1 — a second one "+
			"means the typed path's emit leaked into shared code (joinEventRoom)", n)
	}
	// And it still answers nothing else: no Ack, no Error.
	for _, raw := range lf.out {
		fr, _ := ccwire.Decode(raw, ccwire.Options{Strict: true})
		m, _ := ccwire.DecodeMessage(fr.Payload, ccwire.DefaultLimits(), 0, 0)
		if m.BodyField != ccwire.BodyAppEvent {
			t.Fatalf("legacy join_call answered with body %d; silence + events is the shipped contract", m.BodyField)
		}
	}
}

// Unsubscribe is the other half. leaveAppRooms already does this on disconnect;
// an explicit typed leave did not, so peers kept a tile for someone gone.
func TestCCWireTypedCallLeaveAnnouncesTheDeparture(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	t.Setenv("REDIS_ADAPTER", "")
	h := &Hub{}

	peer, pf := callSession(t, h, "u2", "c1")
	peer.subs["call:c1"] = struct{}{}
	leaver, lf := callSession(t, h, "u1", "c1")
	leaver.subs["call:c1"] = struct{}{}

	if !leaver.handle(typedCallFrame(t, "c1", true)) {
		t.Fatal("typed: Unsubscribe ended the session")
	}
	if _, ok := leaver.subs["call:c1"]; ok {
		t.Fatal("typed: Unsubscribe did not leave call:c1")
	}
	if m := lf.last(t); m.BodyField != ccwire.BodyAck {
		t.Fatalf("typed: expected Ack, got body %d", m.BodyField)
	}
	left := firstEvent(t, eventsWritten(t, pf), "call_peer_left")
	if left["uid"] != "u1" || left["chatId"] != "c1" {
		t.Fatalf("call_peer_left = %v, want {chatId:c1, uid:u1}", left)
	}

	// A second Unsubscribe for a room this session is not in must not announce
	// a departure that already happened.
	before := len(pf.out)
	leaver.handle(typedCallFrame(t, "c1", true))
	if len(pf.out) != before {
		t.Fatal("an Unsubscribe for a room never joined announced a departure")
	}
}

// A mesh-cap refusal is NOT an authorization failure and the client can act on
// it. Answering only NOT_PERMITTED made "the call is full" indistinguishable
// from "you are not in this chat".
func TestCCWireTypedCallRefusedByMeshCapSaysCallFull(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	t.Setenv("REDIS_ADAPTER", "")
	t.Setenv("MESH_MAX_PARTICIPANTS", "2")
	h := &Hub{}
	for _, uid := range []string{"u2", "u3"} {
		p, _ := callSession(t, h, uid, "c1")
		p.subs["call:c1"] = struct{}{}
	}

	joiner, jf := callSession(t, h, "u1", "c1")
	if !joiner.handle(typedCallFrame(t, "c1", false)) {
		t.Fatal("a refusal must not end the session")
	}
	if _, ok := joiner.subs["call:c1"]; ok {
		t.Fatal("a call refused for capacity was joined anyway")
	}
	full := firstEvent(t, eventsWritten(t, jf), "call_full")
	if full["chatId"] != "c1" || full["reason"] != "mesh_capacity" || full["max"] != float64(2) {
		t.Fatalf("call_full = %v, want {chatId:c1, max:2, reason:mesh_capacity}", full)
	}
	if got := errorCodeOf(t, jf.last(t)); got != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED alongside call_full, got %d", got)
	}
}

// Both doors take the SAME gate, and the typed one emits nothing to a
// non-member — the roster of a call in progress is the thing being protected.
func TestCCWireTypedCallTakesTheMembershipGate(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	t.Setenv("REDIS_ADAPTER", "")
	h := &Hub{}
	peer, _ := callSession(t, h, "u2", "c1")
	peer.subs["call:c1"] = struct{}{}

	s, f := newSession("stranger", map[string]cachedPerm{"c1": {ok: false, gen: permGenerationOf("c1"), at: time.Now()}})
	s.hub = h
	s.sessionID = "cw:stranger"
	enableTestEvents(s)
	h.ccwireRegister(s)

	if !s.handle(typedCallFrame(t, "c1", false)) {
		t.Fatal("a refusal must not end the session")
	}
	if _, ok := s.subs["call:c1"]; ok {
		t.Fatal("a non-member joined the call room")
	}
	if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", got)
	}
	if len(eventsWritten(t, f)) != 0 {
		t.Fatalf("a refused non-member received call events: %v", eventsWritten(t, f))
	}
}

// A session that negotiated typed bodies but NOT app_events cannot take part in
// a call at all — emitRooms and ccwireCallRoster both skip it — so it must not
// hold a seat. The legacy door is equally shut (join_call is only registered
// for app_event sessions), which is the point: one answer, not two.
func TestCCWireTypedCallNeedsAppEvents(t *testing.T) {
	t.Setenv("REDIS_ADAPTER", "")
	s, f := newSession("u1", map[string]cachedPerm{"c1": {ok: true, gen: permGenerationOf("c1"), at: time.Now()}})
	s.hello = true // appEvents stays false
	if !s.handle(typedCallFrame(t, "c1", false)) {
		t.Fatal("a refusal must not end the session")
	}
	if _, ok := s.subs["call:c1"]; ok {
		t.Fatal("a session that cannot hear a call joined one")
	}
	if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", got)
	}
}

// CROSS-LANGUAGE BYTE PIN, the join_chat pin one ScopeKind along. The TS side
// asserts these same hex strings (lib/ccwire/joinEmit.selftest.ts,
// CALL_SCOPE_BODY_PIN / CALL_FRAME_PIN).
//
// Body:  08 03            field 1 varint, SCOPE_KIND_CALL = 3
//        12 02 6331       field 2, 2 bytes, "c1"
const ccwireCallScopeGoldenWire = "080312026331"
const ccwireCallFrameGoldenWire = "0a017210011801820206" + ccwireCallScopeGoldenWire

func TestCCWireCallWireBytePin(t *testing.T) {
	body := ccwire.EncodeScope(ccwire.ScopeKindCall, "c1")
	if got := hexOf(body); got != ccwireCallScopeGoldenWire {
		t.Errorf("Subscribe(CALL) body = %s\n                       want %s", got, ccwireCallScopeGoldenWire)
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
	if got := hexOf(msg); got != ccwireCallFrameGoldenWire {
		t.Errorf("Subscribe(CALL) frame = %s\n                        want %s", got, ccwireCallFrameGoldenWire)
	}
	raw, err := hex.DecodeString(ccwireCallScopeGoldenWire)
	if err != nil {
		t.Fatalf("unhex: %v", err)
	}
	kind, id, err := ccwire.DecodeScope(raw, ccwire.DefaultLimits())
	if err != nil || kind != ccwire.ScopeKindCall || id != "c1" {
		t.Fatalf("DecodeScope(pin) = (%d, %q, %v), want (3, \"c1\", nil)", kind, id, err)
	}
}

func hexOf(b []byte) string { return hex.EncodeToString(b) }

// EXECUTED with Redis (VC_TEST_REDIS), skipped without: the typed door writes
// and clears the CLUSTER roster, which is the only roster other nodes can see.
func TestCCWireTypedCallMaintainsTheClusterRoster(t *testing.T) {
	c := testRedis(t)
	prefix := scopeKeys(t)
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	t.Setenv("REDIS_ADAPTER", "1")
	key := prefix + "call:c1"
	t.Cleanup(func() { c.Del(bg, key) })

	h := &Hub{}
	joiner, _ := callSession(t, h, "u1", "c1")
	if !joiner.handle(typedCallFrame(t, "c1", false)) {
		t.Fatal("typed: a member's call Subscribe was refused")
	}
	if in, _ := c.SIsMember(bg, key, "u1").Result(); !in {
		t.Fatal("typed join did not write the cluster roster — other nodes cannot see this caller")
	}
	if !joiner.handle(typedCallFrame(t, "c1", true)) {
		t.Fatal("typed: Unsubscribe ended the session")
	}
	if in, _ := c.SIsMember(bg, key, "u1").Result(); in {
		t.Fatal("typed leave left a seat in the cluster roster nobody holds")
	}
}
