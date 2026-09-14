package realtime

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// These tests drive the session directly, like ccwire_test.go, because the
// package has no database by design. What they CAN prove without one is the
// part that matters: which handler a CC-Wire frame is routed into, what the
// server puts in the request when it gets there, and that the fan-out leaf
// Socket.IO already uses is what reaches a CC-Wire client.
//
// What they cannot prove here is what happens INSIDE chatsMessagePost — the
// rate limit, the membership query, the ON CONFLICT dedup. Those are tested in
// internal/routes against the real handler, and the point of routing through it
// rather than around it is that they do not need a second set of tests.

// ── a stand-in for the chat write routes ────────────────────────────────

type capturedCall struct {
	method string
	path   string
	body   map[string]any
}

// fakeRoutes installs a mux with the SAME patterns internal/routes registers,
// so the path a session builds has to match the real one to be served at all.
func fakeRoutes(t *testing.T, calls *[]capturedCall, reply func(capturedCall) (int, map[string]any)) {
	t.Helper()
	h := func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		c := capturedCall{r.Method, r.URL.Path, b}
		*calls = append(*calls, c)
		status, out := reply(c)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(out)
	}
	m := http.NewServeMux()
	m.HandleFunc("POST /chats/{id}/messages", h)
	m.HandleFunc("POST /chats/{id}/delivered", h)
	m.HandleFunc("POST /chats/{id}/read", h)
	SetCCWireRoutes(m)
	t.Cleanup(func() { SetCCWireRoutes(nil) })
}

// ── a minimal protobuf reader, for assertions only ──────────────────────

type pbVal struct {
	wire uint8
	num  uint64
	buf  []byte
}

func pbFields(t *testing.T, b []byte) map[uint32][]pbVal {
	t.Helper()
	out := map[uint32][]pbVal{}
	varint := func() uint64 {
		var v uint64
		var shift uint
		for len(b) > 0 {
			c := b[0]
			b = b[1:]
			v |= uint64(c&0x7f) << shift
			if c&0x80 == 0 {
				break
			}
			shift += 7
		}
		return v
	}
	for len(b) > 0 {
		tag := varint()
		field, wire := uint32(tag>>3), uint8(tag&7)
		switch wire {
		case 0:
			out[field] = append(out[field], pbVal{wire: 0, num: varint()})
		case 2:
			n := int(varint())
			if n > len(b) {
				t.Fatalf("truncated length-delimited field %d", field)
			}
			out[field] = append(out[field], pbVal{wire: 2, buf: b[:n]})
			b = b[n:]
		default:
			t.Fatalf("unexpected wire type %d on field %d", wire, field)
		}
	}
	return out
}

func pbStr(t *testing.T, m map[uint32][]pbVal, field uint32) string {
	t.Helper()
	if len(m[field]) == 0 {
		return ""
	}
	return string(m[field][0].buf)
}

func pbSub(t *testing.T, m map[uint32][]pbVal, field uint32) map[uint32][]pbVal {
	t.Helper()
	if len(m[field]) == 0 {
		t.Fatalf("field %d absent", field)
	}
	return pbFields(t, m[field][0].buf)
}

// submitBody builds a SubmitMessage the way a client would.
func submitBody(chatID, clientMsgID, sealed string, extraEnvelope []byte) []byte {
	env := ccwire.AppendStringField(nil, 1, chatID)
	env = ccwire.AppendStringField(env, 3, clientMsgID)
	env = append(env, extraEnvelope...)
	b := ccwire.AppendBytesField(nil, 1, env)
	return ccwire.AppendBytesField(b, 2, []byte(sealed))
}

func submit(t *testing.T, s *ccwireSession, body []byte) bool {
	t.Helper()
	return s.handle(frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassMessaging,
		BodyField:    ccwire.BodySubmitMessage,
		Body:         body,
	}))
}

// ── SubmitMessage routes into the REST send path ────────────────────────

// The whole authorization argument rests on this: a CC-Wire submit is not
// persisted by this package, it is POSTed to the one handler that owns the
// rate limit, chatsRequireMem, the block check, the group policies and the
// client_id dedup. If the request ever stopped arriving there, every one of
// those gates would be silently gone — so this asserts the destination itself.
func TestCCWireSubmitRunsTheRESTSendPath(t *testing.T) {
	var calls []capturedCall
	fakeRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{"id": "9001"}
	})

	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)
	if !submit(t, s, submitBody("c1", "cli-7", "\x00vc1:{}", nil)) {
		t.Fatal("a valid submit must not end the session")
	}

	if len(calls) != 1 {
		t.Fatalf("expected exactly one loopback call, got %d", len(calls))
	}
	c := calls[0]
	if c.method != http.MethodPost || c.path != "/chats/c1/messages" {
		t.Fatalf("submit went somewhere other than the send route: %s %s", c.method, c.path)
	}
	if c.body["content"] != "\x00vc1:{}" {
		t.Fatalf("sealed body was not forwarded verbatim: %q", c.body["content"])
	}
	// The idempotency key must survive the translation — the REST path's
	// ON CONFLICT (chat_id, sender_id, client_id) is what a retry over either
	// transport relies on, and dropping the key would disable it silently.
	if c.body["clientId"] != "cli-7" {
		t.Fatalf("client_msg_id was not forwarded as clientId: %v", c.body["clientId"])
	}

	m := f.last(t)
	if m.BodyField != ccwire.BodyAck {
		t.Fatalf("expected Ack, got body %d", m.BodyField)
	}
	if got := pbStr(t, pbFields(t, m.Body), 1); got != "9001" {
		t.Fatalf("Ack did not carry the server-assigned id: %q", got)
	}
}

// NO CLIENT FIELD REACHES THE REQUEST AS AN IDENTITY.
//
// SubmitMessage has no sender field at all (envelope.proto: "unrepresentable
// beats unchecked"), so the attack shape is an UNKNOWN field smuggled into the
// envelope in the hope it is copied through. The decoder skips unknown fields
// and the request is built from a fixed set of keys, so nothing sender-shaped
// can appear — this asserts the request's whole key set rather than the absence
// of one spelling, because the next spelling would pass a narrower test.
func TestCCWireSubmitCannotCarryAnIdentity(t *testing.T) {
	var calls []capturedCall
	fakeRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{"id": "1"}
	})

	// Fields 99 and 100 of the envelope: "senderUid" and "userId" by any other
	// name. Neither is a field the schema has, so both must be skipped.
	extra := ccwire.AppendStringField(nil, 99, "victim-uid")
	extra = ccwire.AppendStringField(extra, 100, "victim-uid")

	s, _ := newSession("attacker", map[string]cachedPerm{})
	hello(t, s)
	if !submit(t, s, submitBody("c1", "", "sealed", extra)) {
		t.Fatal("session ended unexpectedly")
	}
	if len(calls) != 1 {
		t.Fatalf("expected one call, got %d", len(calls))
	}
	allowed := map[string]bool{"type": true, "content": true, "clientId": true, "meta": true}
	for k, v := range calls[0].body {
		if !allowed[k] {
			t.Fatalf("an unexpected key reached the send request: %q = %v", k, v)
		}
	}
	// The sender is whoever httpx.UserFrom says, which is set by RequireAuth at
	// the upgrade and cannot be reached from here — there is no key to set.
}

// A retry of the same client_msg_id must not become a second message. The dedup
// itself is the database's (ON CONFLICT); what this transport owes it is the
// key, unchanged, on every attempt — and the same Ack back, so the client sees
// one message rather than two ids for one send.
func TestCCWireSubmitIsIdempotentOnClientMsgID(t *testing.T) {
	var calls []capturedCall
	byClient := map[string]string{}
	next := 100
	fakeRoutes(t, &calls, func(c capturedCall) (int, map[string]any) {
		// Stands in for ON CONFLICT (chat_id, sender_id, client_id) DO NOTHING
		// plus the retry SELECT: the same key returns the ORIGINAL row.
		key, _ := c.body["clientId"].(string)
		if id, ok := byClient[key]; ok {
			return 200, map[string]any{"id": id}
		}
		next++
		id := string(rune('0'+next/100)) + "00"
		byClient[key] = id
		return 200, map[string]any{"id": id}
	})

	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)

	ids := make([]string, 2)
	for i := range ids {
		if !submit(t, s, submitBody("c1", "same-key", "sealed", nil)) {
			t.Fatalf("attempt %d ended the session", i)
		}
		m := f.last(t)
		if m.BodyField != ccwire.BodyAck {
			t.Fatalf("attempt %d: expected Ack, got body %d", i, m.BodyField)
		}
		ids[i] = pbStr(t, pbFields(t, m.Body), 1)
	}
	if ids[0] == "" || ids[0] != ids[1] {
		t.Fatalf("a retry produced a different message: %q then %q", ids[0], ids[1])
	}
	if calls[0].body["clientId"] != "same-key" || calls[1].body["clientId"] != "same-key" {
		t.Fatal("the idempotency key was not forwarded on both attempts")
	}
}

// The REST refusals a client must be able to tell apart, and the ones it must
// not. 403 and 404 collapse to NOT_PERMITTED on purpose (errors.proto: the
// error channel must not be an existence oracle for chat ids).
func TestCCWireSubmitRefusalsMapToErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   uint32
	}{
		{http.StatusForbidden, errNotPermitted},      // not a member, blocked, admins-only
		{http.StatusNotFound, errNotPermitted},       // indistinguishable, deliberately
		{http.StatusTooManyRequests, errRateLimited}, // the send limit, or slow mode
		{http.StatusBadRequest, errPayloadInvalid},
		{http.StatusInternalServerError, errInternal},
	} {
		var calls []capturedCall
		status := tc.status
		fakeRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
			return status, map[string]any{"error": "a message only the REST client should see"}
		})
		s, f := newSession("u1", map[string]cachedPerm{})
		hello(t, s)
		if !submit(t, s, submitBody("c1", "", "sealed", nil)) {
			t.Fatalf("status %d must not end the session", tc.status)
		}
		m := f.last(t)
		if got := errorCodeOf(t, m); got != tc.want {
			t.Fatalf("status %d: expected error code %d, got %d", tc.status, tc.want, got)
		}
		// The REST error string is never echoed: errors.proto forbids reflecting
		// client-influenced text back through the error channel.
		if pbStr(t, pbFields(t, m.Body), 3) == "a message only the REST client should see" {
			t.Fatalf("status %d: the handler's error text was echoed to the peer", tc.status)
		}
	}
}

// The message TYPE is not on this wire (envelope.proto has no `type`; it lives
// inside the sealed wrapper). So the PublicMeta fields that only make sense for
// another type are refused rather than smuggled through on a text send, where
// they would skip the media/card/poll validation that runs per type.
func TestCCWireSubmitRefusesTypeCoupledMeta(t *testing.T) {
	for field, name := range map[uint32]string{
		1: "attachment_id", 7: "group_id", 8: "gif_url", 13: "game", 14: "room",
	} {
		var calls []capturedCall
		fakeRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
			return 200, map[string]any{"id": "1"}
		})
		meta := ccwire.AppendStringField(nil, field, "x")
		env := ccwire.AppendBytesField(nil, 7, meta)

		s, f := newSession("u1", map[string]cachedPerm{})
		hello(t, s)
		if !submit(t, s, submitBody("c1", "", "sealed", env)) {
			t.Fatalf("%s: session ended unexpectedly", name)
		}
		if len(calls) != 0 {
			t.Fatalf("%s: an untyped send reached the database path", name)
		}
		if got := errorCodeOf(t, f.last(t)); got != errUnknownOperation {
			t.Fatalf("%s: expected UNKNOWN_OPERATION, got %d", name, got)
		}
	}
}

// ── Receipt ─────────────────────────────────────────────────────────────

// A receipt goes to the caller's OWN pointer route. delivery.proto's whole
// reason for stamping user_id server-side is that the ungated
// new_message → message_delivered relay let anyone assert a receipt for anyone;
// here a client-supplied user_id is not refused, it is unreadable — the request
// carries only the pointer, and the handler scopes it to the session's user.
func TestCCWireReceiptCannotAssertAnotherUser(t *testing.T) {
	for _, tc := range []struct {
		kind  uint32
		path  string
		field string
	}{
		{ccwire.ReceiptKindDelivered, "/chats/c1/delivered", "lastDeliveredMessageId"},
		{ccwire.ReceiptKindRead, "/chats/c1/read", "lastReadMessageId"},
	} {
		var calls []capturedCall
		fakeRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
			return 200, map[string]any{"ok": true}
		})

		body := ccwire.AppendStringField(nil, 1, "c1")
		body = ccwire.AppendStringField(body, 2, "41")
		body = ccwire.AppendStringField(body, 2, "307") // highest wins
		body = ccwire.AppendStringField(body, 2, "88")
		body = ccwire.AppendVarintField(body, 3, uint64(tc.kind))
		body = ccwire.AppendStringField(body, 4, "someone-else") // server-stamped; ignored

		s, _ := newSession("u1", map[string]cachedPerm{})
		hello(t, s)
		if !s.handle(frame(t, ccwire.Message{
			RequestID:    "r",
			TrafficClass: ccwire.TrafficClassSync,
			BodyField:    ccwire.BodyReceipt,
			Body:         body,
		})) {
			t.Fatalf("kind %d ended the session", tc.kind)
		}
		if len(calls) != 1 {
			t.Fatalf("kind %d: expected one call, got %d", tc.kind, len(calls))
		}
		if calls[0].path != tc.path {
			t.Fatalf("kind %d went to %s, want %s", tc.kind, calls[0].path, tc.path)
		}
		if calls[0].body[tc.field] != "307" {
			t.Fatalf("kind %d: pointer is %v, want the highest id 307", tc.kind, calls[0].body[tc.field])
		}
		if len(calls[0].body) != 1 {
			t.Fatalf("kind %d: the request carried more than the pointer: %v", tc.kind, calls[0].body)
		}
	}
}

// ── TypingState ─────────────────────────────────────────────────────────

// The same gate typing_start has on Socket.IO, for the same reason: FanOutToChat
// reaches every member's user-room directly, bypassing the chat room, so without
// a membership check a non-member injects typing into any chat by id.
//
// Only the REFUSAL is asserted here — the allow path calls FanOutToChat, which
// reads the member roster from Redis/Postgres and this package's tests have
// neither. The gate is the security-relevant half.
func TestCCWireTypingUsesTheChatMemberGate(t *testing.T) {
	s, f := newSession("u1", map[string]cachedPerm{
		"c-denied": {ok: false, gen: permGenerationOf("c-denied"), at: time.Now()},
	})
	hello(t, s)

	body := ccwire.AppendStringField(nil, 1, "c-denied")
	body = ccwire.AppendBoolField(body, 2, true)
	if !s.handle(frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassEphemeral,
		BodyField:    ccwire.BodyTypingState,
		Body:         body,
	})) {
		t.Fatal("a refusal must not end the session")
	}
	if got := errorCodeOf(t, f.last(t)); got != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", got)
	}
}

// ── the shared fan-out reaches CC-Wire ──────────────────────────────────

// registered builds a session attached to hub h and registered for fan-out,
// with no write queue — so a delivery lands in the fake connection synchronously.
func registered(t *testing.T, h *Hub, uid string) (*ccwireSession, *fakeConn) {
	t.Helper()
	f := &fakeConn{}
	s := &ccwireSession{
		hub: h, lim: ccwire.DefaultLimits(), hello: true,
		d:    &sockData{uid: uid, chatMemberOk: map[string]cachedPerm{}, runOk: map[string]cachedPerm{}},
		subs: map[string]struct{}{},
		w:    f.write,
	}
	h.ccwireRegister(s)
	t.Cleanup(func() { h.ccwireUnregister(s) })
	return s, f
}

// THE CROSS-TRANSPORT PROPERTY.
//
// EmitToUid is the per-user emit every Socket.IO delivery already goes through —
// FanOutToChat calls it once per surviving member after the roster, block-list
// and ghost-mode filtering. A message sent by ANY transport (the REST send path
// a Socket.IO client uses, and now a CC-Wire SubmitMessage, which POSTs to that
// same handler) fans out through it. So a CC-Wire session reached from here is a
// CC-Wire session reached by a Socket.IO sender, over one roster, with one set
// of filters — there is no second fan-out to diverge from this one.
//
// It also asserts the identity stamp: sender_uid is read off the PERSISTED row
// the handler returned, which the INSERT wrote from the authenticated session.
func TestCCWireReceivesTheSocketIOFanOut(t *testing.T) {
	h := &Hub{}
	_, f := registered(t, h, "recipient")

	h.EmitToUid("recipient", "new_message", map[string]any{
		"id": "5150", "chatId": "c1", "senderId": "the-real-sender",
		"content": "\x00vc1:{sealed}", "createdAt": "2026-09-14T12:00:00.000Z",
		"meta": map[string]any{"silent": true, "mentionUserIds": []any{"u9"}},
	})

	m := f.last(t)
	if m.BodyField != ccwire.BodyDeliverMessage {
		t.Fatalf("expected DeliverMessage, got body %d", m.BodyField)
	}
	if m.TrafficClass != ccwire.TrafficClassMessaging {
		t.Fatalf("DeliverMessage on traffic class %d", m.TrafficClass)
	}
	fields := pbFields(t, m.Body)
	if got := pbStr(t, fields, 3); got != "the-real-sender" {
		t.Fatalf("sender_uid is %q, not the persisted sender", got)
	}
	if got := pbStr(t, fields, 2); got != "\x00vc1:{sealed}" {
		t.Fatalf("sealed body was not carried verbatim: %q", got)
	}
	env := pbSub(t, fields, 1)
	if pbStr(t, env, 1) != "c1" || pbStr(t, env, 2) != "5150" {
		t.Fatalf("envelope routing is wrong: chat %q message %q", pbStr(t, env, 1), pbStr(t, env, 2))
	}
	if len(env[5]) == 0 || env[5][0].num != 2 {
		t.Fatal("meta.silent did not become MESSAGE_CLASS_SILENT")
	}
	meta := pbSub(t, env, 7)
	if len(meta[6]) == 0 || meta[6][0].num != 1 {
		t.Fatal("public_meta.silent was dropped")
	}
	if pbStr(t, meta, 11) != "u9" {
		t.Fatal("public_meta.mention_user_ids was dropped")
	}
}

// A user with no CC-Wire session is untouched, and an event with no CC-Wire
// body is not invented — both are how the Socket.IO path stays what it was.
func TestCCWireFanOutIgnoresWhatItHasNoBodyFor(t *testing.T) {
	h := &Hub{}
	_, f := registered(t, h, "recipient")

	h.EmitToUid("someone-else", "new_message", map[string]any{"id": "1", "senderId": "s"})
	h.EmitToUid("recipient", "viewer_joined", map[string]any{"chatId": "c1"})
	h.EmitToUid("recipient", "reaction_updated", map[string]any{"messageId": "1"})

	if len(f.out) != 0 {
		t.Fatalf("%d frame(s) written for events CC-Wire does not carry", len(f.out))
	}
}

// Receipts and typing fan out too, and both carry the SERVER's idea of who did
// it — the uid the Socket.IO handler stamped from its own session, never a
// payload field a client chose.
func TestCCWireFanOutCarriesReceiptsAndTyping(t *testing.T) {
	h := &Hub{}
	_, f := registered(t, h, "recipient")

	h.emitToUidIn("c1", "recipient", "message_read", map[string]any{
		"userId": "reader", "lastReadMessageId": "77",
	})
	m := f.last(t)
	if m.BodyField != ccwire.BodyReceipt {
		t.Fatalf("expected Receipt, got body %d", m.BodyField)
	}
	rf := pbFields(t, m.Body)
	if pbStr(t, rf, 1) != "c1" || pbStr(t, rf, 2) != "77" || pbStr(t, rf, 4) != "reader" {
		t.Fatalf("receipt fields wrong: %v", rf)
	}
	if len(rf[3]) == 0 || uint32(rf[3][0].num) != ccwire.ReceiptKindRead {
		t.Fatal("receipt kind is not READ")
	}

	h.emitToUidIn("c1", "recipient", "typing_start", map[string]any{"uid": "typer", "chatId": "c1"})
	m = f.last(t)
	if m.BodyField != ccwire.BodyTypingState {
		t.Fatalf("expected TypingState, got body %d", m.BodyField)
	}
	if m.TrafficClass != ccwire.TrafficClassEphemeral {
		t.Fatalf("typing must ride EPHEMERAL, got traffic class %d", m.TrafficClass)
	}
	tf := pbFields(t, m.Body)
	if pbStr(t, tf, 1) != "c1" || pbStr(t, tf, 3) != "typer" {
		t.Fatalf("typing fields wrong: %v", tf)
	}
	if len(tf[2]) == 0 || tf[2][0].num != 1 {
		t.Fatal("typing_start did not set typing=true")
	}
}

// The hook added to the SHARED path must be inert when nobody is on CC-Wire —
// which, with the flag off, is always. A bare Hub has no session map at all.
func TestCCWireFanOutHookIsInertWithNoSessions(t *testing.T) {
	t.Setenv("CCWIRE_WS", "")
	h := &Hub{}
	h.EmitToUid("nobody", "new_message", map[string]any{"id": "1", "senderId": "s"})
	h.emitToUidIn("c1", "nobody", "message_read", map[string]any{"userId": "x", "lastReadMessageId": "1"})
	if h.cwSessions != nil {
		t.Fatal("the fan-out hook allocated session state for a user with no CC-Wire session")
	}
}
