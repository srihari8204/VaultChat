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

// ── EditMessage / DeleteMessage ─────────────────────────────────────────

// editRoutes is fakeRoutes plus the two per-message routes. It is separate so
// the existing tests keep asserting exactly the send/receipt surface they were
// written for.
func editRoutes(t *testing.T, calls *[]capturedCall, reply func(capturedCall) (int, map[string]any)) {
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
	// The SAME patterns internal/routes registers on the CC-Wire mux, so a path
	// this session builds has to match the real one to be served at all.
	m.HandleFunc("POST /chats/{id}/messages", h)
	m.HandleFunc("PATCH /chats/{id}/messages/{msgId}", h)
	m.HandleFunc("DELETE /chats/{id}/messages/{msgId}", h)
	SetCCWireRoutes(m)
	t.Cleanup(func() { SetCCWireRoutes(nil) })
}

// editBody builds an EditMessage the way a client would: the target message id
// lives in Envelope.message_id (field 2), which on an edit is not a
// server-assigned value but the thing being named.
func editBody(chatID, msgID, sealed string, extraEnvelope []byte) []byte {
	env := ccwire.AppendStringField(nil, 1, chatID)
	env = ccwire.AppendStringField(env, 2, msgID)
	env = append(env, extraEnvelope...)
	b := ccwire.AppendBytesField(nil, 1, env)
	b = ccwire.AppendBytesField(b, 2, []byte(sealed))
	return ccwire.AppendVarintField(b, 3, 7) // edit_seq: skipped by the server
}

func deleteBody(chatID, msgID string, forEveryone bool) []byte {
	b := ccwire.AppendStringField(nil, 1, chatID)
	b = ccwire.AppendStringField(b, 2, msgID)
	return ccwire.AppendBoolField(b, 3, forEveryone)
}

func sendBody(t *testing.T, s *ccwireSession, field uint32, body []byte) bool {
	t.Helper()
	return s.handle(frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassMessaging,
		BodyField:    field,
		Body:         body,
	}))
}

// THE DESTINATION IS THE ARGUMENT. An edit is not persisted by this package; it
// is PATCHed to chatsMessagePatch, whose WHERE clause carries sender ownership,
// deleted_at IS NULL and the 15-minute window, behind chatsRequireMem, ending in
// the message_edited fan-out. If the request stopped arriving there, every one
// of those would be silently gone.
func TestCCWireEditRunsTheRESTEditPath(t *testing.T) {
	var calls []capturedCall
	editRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{"id": "9001"}
	})

	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)
	if !sendBody(t, s, ccwire.BodyEditMessage, editBody("c1", "9001", "\x00vc1:{new}", nil)) {
		t.Fatal("a valid edit must not end the session")
	}

	if len(calls) != 1 {
		t.Fatalf("expected exactly one loopback call, got %d", len(calls))
	}
	c := calls[0]
	if c.method != http.MethodPatch || c.path != "/chats/c1/messages/9001" {
		t.Fatalf("edit went somewhere other than the edit route: %s %s", c.method, c.path)
	}
	if c.body["content"] != "\x00vc1:{new}" {
		t.Fatalf("sealed body was not forwarded verbatim: %q", c.body["content"])
	}
	// The request carries the new ciphertext and nothing else — in particular
	// nothing that could name a sender or widen what the handler updates.
	if len(c.body) != 1 {
		t.Fatalf("the edit request carried more than the content: %v", c.body)
	}
	m := f.last(t)
	if m.BodyField != ccwire.BodyAck {
		t.Fatalf("expected Ack, got body %d", m.BodyField)
	}
	if got := pbStr(t, pbFields(t, m.Body), 1); got != "9001" {
		t.Fatalf("Ack did not carry the edited message id: %q", got)
	}
}

// A delete goes to the delete-for-everyone route, and ONLY when the client
// actually asked for that. for_everyone = false has no handler on this server
// (there is no delete-for-me on either transport), so it is answered rather
// than quietly upgraded into an irreversible delete the user did not request.
func TestCCWireDeleteRunsTheRESTDeletePath(t *testing.T) {
	var calls []capturedCall
	editRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{"id": "9001", "deletedAt": "2026-09-14T12:00:00.000Z"}
	})

	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)
	if !sendBody(t, s, ccwire.BodyDeleteMessage, deleteBody("c1", "9001", true)) {
		t.Fatal("a valid delete must not end the session")
	}
	if len(calls) != 1 {
		t.Fatalf("expected exactly one loopback call, got %d", len(calls))
	}
	if calls[0].method != http.MethodDelete || calls[0].path != "/chats/c1/messages/9001" {
		t.Fatalf("delete went somewhere else: %s %s", calls[0].method, calls[0].path)
	}
	if got := pbStr(t, pbFields(t, f.last(t).Body), 1); got != "9001" {
		t.Fatalf("Ack did not carry the deleted message id: %q", got)
	}

	// for_everyone = false: refused, and no database path reached.
	calls = nil
	if !sendBody(t, s, ccwire.BodyDeleteMessage, deleteBody("c1", "9001", false)) {
		t.Fatal("a refusal must not end the session")
	}
	if len(calls) != 0 {
		t.Fatalf("delete-for-me reached a handler: %v", calls)
	}
	if got := errorCodeOf(t, f.last(t)); got != errUnknownOperation {
		t.Fatalf("expected UNKNOWN_OPERATION for delete-for-me, got %d", got)
	}
}

// A NON-OWNER'S EDIT IS REFUSED, and by the handler rather than by anything
// here. chatsMessagePatch's UPDATE matches on sender_id = the authenticated
// user, so someone else's message simply updates no row and returns 404 — which
// this transport must surface as a refusal and must not paper over. 403 and 404
// collapse to NOT_PERMITTED (errors.proto: no existence oracle for message ids).
func TestCCWireEditAndDeleteSurfaceTheOwnershipRefusal(t *testing.T) {
	for _, field := range []uint32{ccwire.BodyEditMessage, ccwire.BodyDeleteMessage} {
		for _, status := range []int{http.StatusNotFound, http.StatusForbidden} {
			var calls []capturedCall
			st := status
			editRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
				// What the real handler answers for "not yours, not there, or the
				// window expired" — one answer to three questions.
				return st, map[string]any{"error": "Message not found, not yours, or edit window expired"}
			})
			body := editBody("c1", "9001", "sealed", nil)
			if field == ccwire.BodyDeleteMessage {
				body = deleteBody("c1", "9001", true)
			}
			s, f := newSession("not-the-owner", map[string]cachedPerm{})
			hello(t, s)
			if !sendBody(t, s, field, body) {
				t.Fatalf("body %d status %d: a refusal must not end the session", field, st)
			}
			m := f.last(t)
			if got := errorCodeOf(t, m); got != errNotPermitted {
				t.Fatalf("body %d status %d: expected NOT_PERMITTED, got %d", field, st, got)
			}
			if pbStr(t, pbFields(t, m.Body), 3) == "Message not found, not yours, or edit window expired" {
				t.Fatalf("body %d: the handler's error text was echoed to the peer", field)
			}
		}
	}
}

// IDENTITY COMES FROM THE SESSION, AND THERE IS NO PAYLOAD FIELD THAT COMPETES.
//
// EditMessage's envelope has no sender field (envelope.proto: "unrepresentable
// beats unchecked"), so the attack shape is an unknown field smuggled in hoping
// it is copied through. This asserts the WHOLE key set of the outgoing request
// rather than the absence of one spelling — the next spelling would pass a
// narrower test — and the sender the handler uses is httpx.UserFrom on the
// session's own context, which nothing on this path can set.
func TestCCWireEditCannotCarryAnIdentity(t *testing.T) {
	var calls []capturedCall
	editRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{"id": "9001"}
	})
	// Envelope fields 99/100: "senderUid" and "userId" by any other name.
	extra := ccwire.AppendStringField(nil, 99, "victim-uid")
	extra = ccwire.AppendStringField(extra, 100, "victim-uid")

	s, _ := newSession("attacker", map[string]cachedPerm{})
	hello(t, s)
	if !sendBody(t, s, ccwire.BodyEditMessage, editBody("c1", "9001", "sealed", extra)) {
		t.Fatal("session ended unexpectedly")
	}
	if len(calls) != 1 {
		t.Fatalf("expected one call, got %d", len(calls))
	}
	for k, v := range calls[0].body {
		if k != "content" {
			t.Fatalf("an unexpected key reached the edit request: %q = %v", k, v)
		}
	}
	if calls[0].body["content"] == "victim-uid" {
		t.Fatal("a smuggled envelope field became the edit content")
	}
}

// A RETRIED EDIT IS NOT A SECOND EDIT. The REST edit is an UPDATE guarded by
// (id, chat_id, sender_id, not deleted, inside the window), so replaying it
// rewrites one row to the same content — there is no ON CONFLICT to honour and
// no key for this transport to forward. What IS required of the transport is
// that it produce exactly one request per frame and the same Ack each time, so
// the client never sees two identities for one edit.
func TestCCWireEditRetryIsIdempotent(t *testing.T) {
	var calls []capturedCall
	// Stands in for the UPDATE: the row is rewritten, its id never changes, and
	// the number of stored revisions is one no matter how many times it runs.
	stored := map[string]string{"9001": "old"}
	editRoutes(t, &calls, func(c capturedCall) (int, map[string]any) {
		content, _ := c.body["content"].(string)
		stored["9001"] = content
		return 200, map[string]any{"id": "9001"}
	})

	s, f := newSession("u1", map[string]cachedPerm{})
	hello(t, s)
	ids := make([]string, 2)
	for i := range ids {
		if !sendBody(t, s, ccwire.BodyEditMessage, editBody("c1", "9001", "\x00vc1:{new}", nil)) {
			t.Fatalf("attempt %d ended the session", i)
		}
		m := f.last(t)
		if m.BodyField != ccwire.BodyAck {
			t.Fatalf("attempt %d: expected Ack, got body %d", i, m.BodyField)
		}
		ids[i] = pbStr(t, pbFields(t, m.Body), 1)
	}
	if ids[0] == "" || ids[0] != ids[1] {
		t.Fatalf("a retried edit produced a different message: %q then %q", ids[0], ids[1])
	}
	if len(calls) != 2 {
		t.Fatalf("expected one request per frame, got %d", len(calls))
	}
	if len(stored) != 1 || stored["9001"] != "\x00vc1:{new}" {
		t.Fatalf("a retry produced more than one edited state: %v", stored)
	}
}

// A MALFORMED ID IS REFUSED BEFORE IT IS INTERPOLATED INTO A PATH.
//
// Two real defects, one check, and the panic case is asserted explicitly
// because it is the one that does not merely misbehave: httptest.NewRequest
// builds a request line and hands it to http.ReadRequest, so a space in an id
// PANICS inside the session goroutine, from a client-controlled string.
// "x/read?" is the other half — without the check it reparses into a DIFFERENT
// route, which makes the payload the router.
func TestCCWireMalformedIDsAreRefusedNotInterpolated(t *testing.T) {
	bad := []string{"c 1", "x/read?", "c1/../c2", "c1?x=1", "c1/messages", "", "c1#f", "c1%2f"}

	for _, id := range bad {
		var calls []capturedCall
		editRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
			return 200, map[string]any{"id": "1"}
		})
		s, f := newSession("u1", map[string]cachedPerm{})
		hello(t, s)

		// chat_id on every body that interpolates one, plus message_id.
		frames := []struct {
			field uint32
			body  []byte
		}{
			{ccwire.BodySubmitMessage, submitBody(id, "", "sealed", nil)},
			{ccwire.BodyEditMessage, editBody(id, "9001", "sealed", nil)},
			{ccwire.BodyEditMessage, editBody("c1", id, "sealed", nil)},
			{ccwire.BodyDeleteMessage, deleteBody(id, "9001", true)},
			{ccwire.BodyDeleteMessage, deleteBody("c1", id, true)},
		}
		for i, fr := range frames {
			// A panic here fails the test rather than taking the process with it,
			// which is the behaviour being fixed.
			if !sendBody(t, s, fr.field, fr.body) {
				t.Fatalf("id %q frame %d: a refusal must not end the session", id, i)
			}
			if got := errorCodeOf(t, f.last(t)); got != errPayloadInvalid {
				t.Fatalf("id %q frame %d: expected PAYLOAD_INVALID, got %d", id, i, got)
			}
		}
		if len(calls) != 0 {
			t.Fatalf("id %q reached a handler: %v", id, calls)
		}
	}

	// The mirror: an id of a shape this server actually issues is not refused,
	// or the check above would pass by rejecting everything.
	for _, id := range []string{"9001", "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "abc_DEF-123"} {
		var calls []capturedCall
		editRoutes(t, &calls, func(capturedCall) (int, map[string]any) {
			return 200, map[string]any{"id": "1"}
		})
		s, _ := newSession("u1", map[string]cachedPerm{})
		hello(t, s)
		if !sendBody(t, s, ccwire.BodyEditMessage, editBody(id, "9001", "sealed", nil)) {
			t.Fatalf("id %q ended the session", id)
		}
		if len(calls) != 1 {
			t.Fatalf("id %q was refused but is a real id shape", id)
		}
	}
}

// The outbound half. An edit or delete made by ANY transport ends in
// emitx.ChatEvent → FanOutToChat → emitToUidIn — the same leaf new_message
// uses, after the same roster, block-list and ghost-mode filtering — so a
// CC-Wire session reached here is reached by a Socket.IO editor too, over one
// audience decision. Without this a CC-Wire client could send an edit and never
// receive one.
func TestCCWireFanOutCarriesEditsAndDeletes(t *testing.T) {
	h := &Hub{}
	_, f := registered(t, h, "recipient")

	h.emitToUidIn("c1", "recipient", "message_edited", map[string]any{
		"id": "9001", "content": "\x00vc1:{new}", "editedAt": "2026-09-14T12:00:00.000Z",
	})
	m := f.last(t)
	if m.BodyField != ccwire.BodyEditMessage {
		t.Fatalf("expected EditMessage, got body %d", m.BodyField)
	}
	ef := pbFields(t, m.Body)
	if got := pbStr(t, ef, 2); got != "\x00vc1:{new}" {
		t.Fatalf("edited sealed body not carried verbatim: %q", got)
	}
	env := pbSub(t, ef, 1)
	if pbStr(t, env, 1) != "c1" || pbStr(t, env, 2) != "9001" {
		t.Fatalf("edit routing wrong: chat %q message %q", pbStr(t, env, 1), pbStr(t, env, 2))
	}

	h.emitToUidIn("c1", "recipient", "message_deleted", map[string]any{
		"id": "9001", "deletedAt": "2026-09-14T12:00:00.000Z",
	})
	m = f.last(t)
	if m.BodyField != ccwire.BodyDeleteMessage {
		t.Fatalf("expected DeleteMessage, got body %d", m.BodyField)
	}
	df := pbFields(t, m.Body)
	if pbStr(t, df, 1) != "c1" || pbStr(t, df, 2) != "9001" {
		t.Fatalf("delete routing wrong: %v", df)
	}
	if len(df[3]) == 0 || df[3][0].num != 1 {
		t.Fatal("the tombstone did not say for_everyone")
	}
}
