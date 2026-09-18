package realtime

import (
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// ccwire_typing_parity_test.go — typing_start/typing_stop arrives in TWO forms
// and the server must treat them as one operation.
//
//	typed:  body 81 TypingState {chat_id, typing}   -> serveBody -> s.typing
//	legacy: body 100 AppEvent  {"typing_start", …}  -> s.appEvent -> events map
//
// The client sends only the legacy form today (no ServerHello capability says
// the server serves typed app-domain bodies inbound, so it cannot negotiate the
// typed one). These tests pin the property that makes the switch safe when that
// signal arrives: both forms decode to the same operation, take the same gate,
// and read the actor from the session rather than the payload.
//
// WHAT THESE TESTS DELIBERATELY DO NOT DO: run the allow path to completion.
// Both forms end in FanOutToChat, which reads the member roster from Redis and
// Postgres, and this package's tests have neither — TestCCWireTypingUsesTheChat
// MemberGate says the same thing for the same reason. Everything up to the
// fan-out is shared, decodable and asserted here; the fan-out itself is one
// call with identical arguments on both paths.

func typedTypingFrame(t *testing.T, chatID string, typing bool, senderUID string) []byte {
	t.Helper()
	b := ccwire.AppendStringField(nil, 1, chatID)
	b = ccwire.AppendBoolField(b, 2, typing)
	if senderUID != "" {
		b = ccwire.AppendStringField(b, 3, senderUID)
	}
	return frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassEphemeral,
		Stream:       ccwireStreamEphemeral,
		BodyField:    ccwire.BodyTypingState,
		Body:         b,
	})
}

// Both forms are stopped by the SAME membership gate, and neither reaches the
// fan-out. This is the security-relevant half of "accepts both forms
// identically": a non-member cannot inject typing by chat id through either
// door.
func TestCCWireTypingBothFormsTakeTheSameMembershipGate(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	denied := func() map[string]cachedPerm {
		return map[string]cachedPerm{"c1": {ok: false, gen: permGenerationOf("c1"), at: time.Now()}}
	}
	for _, typing := range []bool{true, false} {
		event := "typing_stop"
		if typing {
			event = "typing_start"
		}

		typed, tf := newSession("u1", denied())
		typed.hello = true
		if !typed.handle(typedTypingFrame(t, "c1", typing, "")) {
			t.Fatalf("%s typed: a refusal must not end the session", event)
		}
		if got := errorCodeOf(t, tf.last(t)); got != errNotPermitted {
			t.Fatalf("%s typed: expected NOT_PERMITTED, got %d", event, got)
		}

		legacy, lf := newSession("u1", denied())
		enableTestEvents(legacy)
		if !legacy.handle(appEventFrame(event, map[string]any{"chatId": "c1"})) {
			t.Fatalf("%s app_event: a refusal must not end the session", event)
		}
		// The legacy form answers nothing at all — it is fire-and-forget on both
		// transports, and the Socket.IO handler it shares does not reply either.
		// The DECISION is identical; only the (absent) answer differs, and the
		// client treats neither as an acknowledgement.
		if len(lf.out) != 0 {
			t.Fatalf("%s app_event: expected silence, got %d frames", event, len(lf.out))
		}
	}
}

// A typed body naming no chat is refused before any gate: there is nothing to
// authorize and nothing to route to. The legacy form drops it the same way.
func TestCCWireTypingBothFormsRefuseAnEmptyChatID(t *testing.T) {
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	allowed := func() map[string]cachedPerm {
		return map[string]cachedPerm{"c1": {ok: true, gen: permGenerationOf("c1"), at: time.Now()}}
	}

	typed, tf := newSession("u1", allowed())
	typed.hello = true
	if !typed.handle(typedTypingFrame(t, "", true, "")) {
		t.Fatal("typed: a refusal must not end the session")
	}
	if got := errorCodeOf(t, tf.last(t)); got != errPayloadInvalid {
		t.Fatalf("typed: expected PAYLOAD_INVALID, got %d", got)
	}

	legacy, lf := newSession("u1", allowed())
	enableTestEvents(legacy)
	if !legacy.handle(appEventFrame("typing_start", map[string]any{})) {
		t.Fatal("app_event: a refusal must not end the session")
	}
	if len(lf.out) != 0 {
		t.Fatalf("app_event: an unroutable typing event produced %d frames", len(lf.out))
	}
}

// THE ACTOR IS NEVER THE PAYLOAD'S, IN EITHER FORM.
//
// TypingState.sender_uid (3) is SERVER->CLIENT only. A client that fills it in
// must not be able to make someone else appear to be typing — and, because
// delivery.go's senderOfEvent reads the same field to decide whose hide_typing
// ghost-mode applies, must not be able to pick another account's privacy
// setting either. DecodeTyping simply does not return it; this pins that.
func TestCCWireTypingInboundIgnoresSenderUID(t *testing.T) {
	b := ccwire.AppendStringField(nil, 1, "c1")
	b = ccwire.AppendBoolField(b, 2, true)
	b = ccwire.AppendStringField(b, 3, "victim")
	chatID, typing, err := ccwire.DecodeTyping(b, ccwire.DefaultLimits())
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if chatID != "c1" || !typing {
		t.Fatalf("decoded %q/%v", chatID, typing)
	}

	// And the refusal path proves the same thing end to end: a forged sender_uid
	// buys nothing, because the gate is applied to the SESSION's uid.
	s, f := newSession("u1", map[string]cachedPerm{
		"c1": {ok: false, gen: permGenerationOf("c1"), at: time.Now()},
	})
	s.hello = true
	if !s.handle(typedTypingFrame(t, "c1", true, "victim")) {
		t.Fatal("a refusal must not end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", got)
	}
}

// The server's OUTBOUND typed body and its INBOUND decoder are the same shape,
// so a client that learns to read body 81 can also send it. This is the
// round-trip the client's typed emit will depend on once a capability exists to
// negotiate it.
func TestCCWireTypingOutboundBodyRoundTripsThroughTheInboundDecoder(t *testing.T) {
	for _, event := range []string{"typing_start", "typing_stop"} {
		msg, raw := ccwireEventBuild("c1", event, map[string]any{"uid": "typer", "chatId": "c1"})
		if len(raw) == 0 {
			t.Fatalf("%s: no frame built", event)
		}
		if msg.BodyField != ccwire.BodyTypingState {
			t.Fatalf("%s: body %d, want TypingState", event, msg.BodyField)
		}
		if msg.TrafficClass != ccwire.TrafficClassEphemeral {
			t.Fatalf("%s: traffic class %d, want EPHEMERAL", event, msg.TrafficClass)
		}
		// EPHEMERAL is unsequenced by design (ccwire_seq.go `sequenced`), which
		// is what lets a client drop a typing frame without any cursor moving.
		if sequenced(msg.TrafficClass) {
			t.Fatalf("%s: typing must not carry a sequence number", event)
		}
		chatID, typing, err := ccwire.DecodeTyping(msg.Body, ccwire.DefaultLimits())
		if err != nil {
			t.Fatalf("%s: decode: %v", event, err)
		}
		if chatID != "c1" || typing != (event == "typing_start") {
			t.Fatalf("%s: round trip gave %q/%v", event, chatID, typing)
		}
		// sender_uid survives the encode — it is the half the client READS.
		tf := pbFields(t, msg.Body)
		if pbStr(t, tf, 3) != "typer" {
			t.Fatalf("%s: sender_uid lost on the outbound body", event)
		}
	}
}
