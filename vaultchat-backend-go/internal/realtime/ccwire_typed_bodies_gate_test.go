package realtime

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// THE SAFETY PROPERTY BEHIND Capabilities field 9 (typed_app_bodies).
//
// helloTypedAppBodies / s.typedAppBodies gate ONE thing: sending a typed body
// to a session that negotiated app_events and would otherwise expect
// app_event (100). It must never be used to gate the delivery path that has
// always been typed — ccwireDeliverLocal's else-branch (`if s.appEvents { …
// } else { s.deliverOne(…) }`, ccwire_messages.go), which serves every session
// that did NOT ask for app_events.
//
// That branch predates field 9. Every shipped client that omits field 9 still
// lands there, so adding `&& s.typedAppBodies` to it would silently stop
// messages, edits, deletes, typing and receipts for all of them — no error, no
// log, just a dead chat screen.
//
// This test is the tripwire: it drives the real fan-out entry point with
// typedAppBodies FALSE and asserts the typed bodies still arrive. Retro-gate
// that branch and this fails.
func TestShippedTypedDeliveryIsNotGatedOnCapabilityField9(t *testing.T) {
	cases := []struct {
		event   string
		payload map[string]any
		body    uint32
	}{
		{"new_message", map[string]any{"chatId": "c1", "id": "m1", "senderId": "u2"}, ccwire.BodyDeliverMessage},
		{"message_edited", map[string]any{"id": "m1", "content": "sealed"}, ccwire.BodyEditMessage},
		{"message_deleted", map[string]any{"id": "m1"}, ccwire.BodyDeleteMessage},
		{"typing_start", map[string]any{"chatId": "c1", "uid": "u2"}, ccwire.BodyTypingState},
		{"message_read", map[string]any{"lastReadMessageId": "m1", "userId": "u2"}, ccwire.BodyReceipt},
	}

	// Both halves of the flag, because neither value may change this path:
	// false is the shipped client, true is a new client that also happens to
	// advertise field 9.
	for _, typed := range []bool{false, true} {
		h := &Hub{}
		s, f := registered(t, h, "u1")
		s.appEvents = false // did not negotiate app_events: the typed branch
		s.typedAppBodies = typed

		for i, c := range cases {
			h.ccwireDeliverLocal("c1", "u1", c.event, c.payload)
			if len(f.out) != i+1 {
				t.Fatalf("typedAppBodies=%v: %s delivered %d frames, want %d — the shipped typed path was gated",
					typed, c.event, len(f.out)-i, 1)
			}
			if got := f.last(t).BodyField; got != c.body {
				t.Fatalf("typedAppBodies=%v: %s arrived as body %d, want typed body %d",
					typed, c.event, got, c.body)
			}
		}
	}
}

// The companion half, stated as a fact about the session struct rather than a
// behaviour: negotiation sets typedAppBodies independently of appEvents, so a
// future typed-emit caller can read `s.typedAppBodies` on an app_events
// session without inferring it from anything else. helloTypedAppBodies's own
// fail-closed cases live in ccwire_typed_bodies_reader_test.go.
func TestHelloNegotiatesTypedAppBodiesIndependentlyOfAppEvents(t *testing.T) {
	// app_events_v1 (8) absent, typed_app_bodies (9) set: the combination that
	// proves the two are read from separate fields.
	hello := capsInHello([]byte{8, 1, 72, 1})
	lim := ccwire.DefaultLimits()

	if !helloTypedAppBodies(hello, lim) {
		t.Fatal("field 9 not read without field 8")
	}
	if helloAppEvents(hello, lim) {
		t.Fatal("field 9 leaked into the app_events decision")
	}
}
