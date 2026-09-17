// CC-Wire message delivery — the half of ccwire.go that used to answer
// ERROR_CODE_UNKNOWN_OPERATION.
//
// ONE ROSTER, ONE FAN-OUT, ONE SET OF GATES. Read that as three separate
// promises, because each is kept by a different mechanism:
//
//	INBOUND (CC-Wire → everyone). A SubmitMessage is not persisted here. It is
//	turned into the REST request the client would otherwise have sent and run
//	through chatsMessagePost ITSELF — the same handler, the same function, not a
//	copy of it. That is how it inherits the send rate limit, chatsRequireMem,
//	the block check, the group send/media/slow-mode policies, the announcement
//	permission, the ON CONFLICT (chat_id, sender_id, client_id) idempotency and,
//	at the end, emitx.ChatNewMessage. A gate cannot be skipped by a transport
//	that never had the option of not calling it.
//
//	OUTBOUND (everyone → CC-Wire). Delivery hangs off emitToUidIn, the leaf of
//	FanOutToChat. The audience is decided ONCE, by the Redis-cached member
//	roster minus blockers minus ghost-mode targets, and CC-Wire sessions are
//	reached because that decision already named their uid. There is no second
//	roster to disagree with the first.
//
//	IDENTITY. sender_uid on a DeliverMessage is read back off the persisted row
//	(messages.sender_id, written from the authenticated session), never off the
//	submitting payload — which is why SubmitMessage has no such field to read.
//	Receipt.user_id and TypingState.sender_uid are stamped the same way.
//
// Everything here is still behind CCWIRE_WS=1: nothing registers a session, so
// ccwireDeliver finds an empty map and returns, and SetCCWireRoutes is only
// called when the flag is on.
package realtime

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"time"
	"unicode/utf8"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/metrics"
)

// ── the loopback into the REST handlers ─────────────────────────────────

// ccwireRoutes holds the chat write handlers, UNWRAPPED (no RequireAuth: this
// session was authenticated at the upgrade and carries the resulting context).
// It is a *http.ServeMux rather than three func vars so path parsing, method
// matching and r.PathValue("id") are the mux's job here exactly as they are for
// a real request — one fewer thing to get subtly different.
var ccwireRoutes *http.ServeMux

// SetCCWireRoutes is called by internal/routes, which owns the handlers and
// already imports this package (the other direction would be a cycle).
func SetCCWireRoutes(m *http.ServeMux) { ccwireRoutes = m }

// ccwireCtxKey marks a request context as belonging to the CC-Wire loopback.
// Unexported, so nothing outside this package — and in particular no client,
// through any header or payload — can set or clear it.
type ccwireCtxKey struct{}

// IsCCWire reports whether r arrived over the in-process CC-Wire loopback.
// Handlers on the public mux see false for every real client request.
func IsCCWire(r *http.Request) bool {
	if r == nil {
		return false
	}
	on, _ := r.Context().Value(ccwireCtxKey{}).(bool)
	return on
}

// call runs one loopback request and returns the status and decoded JSON body.
//
// The AUTHENTICATED CONTEXT is the session's, carried from the upgrade request,
// so httpx.UserFrom inside the handler returns the same user RequireAuth
// verified — and there is no way for this to pass an identity of its own
// choosing, because httpx's context key is unexported.
func (s *ccwireSession) call(method, path string, body map[string]any) (int, map[string]any) {
	return s.callContext(s.ctxOrBG(), method, path, body)
}

func (s *ccwireSession) callContext(ctx context.Context, method, path string, body map[string]any) (int, map[string]any) {
	if ccwireRoutes == nil {
		return http.StatusServiceUnavailable, nil
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return http.StatusBadRequest, nil
	}
	// The REST path's own timeout shape: a send that outlives this has failed
	// regardless, and an unbounded one would pin a DB connection per stuck frame.
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Marks the request as arriving over CC-Wire. The install identifier from
	// ClientHello is forwarded separately; it is not proof of device ownership.
	//
	// A CONTEXT VALUE, not a header. GET /chats/delta is also on the PUBLIC mux,
	// so a header is something a client can set (or clear) itself; the key here
	// is unexported, exactly as httpx does for the authenticated user, so only
	// this loopback can stamp it. Read it with IsCCWire.
	ctx = context.WithValue(ctx, ccwireCtxKey{}, true)

	req := httptest.NewRequest(method, path, bytes.NewReader(buf)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	if s.deviceID != "" {
		req.Header.Set("X-Device-Id", s.deviceID)
	}
	rec := httptest.NewRecorder()
	ccwireRoutes.ServeHTTP(rec, req)

	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// ccwireSafeID is the gate on every id that is INTERPOLATED INTO A LOOPBACK
// PATH, and it is applied before the path string is built, not after.
//
// Two concrete defects, one check. `httptest.NewRequest` builds a request line
// and hands it to `http.ReadRequest`, so an id containing a space does not
// produce a bad request — it PANICS, inside the session goroutine, from a
// client-controlled string. And an id containing `?` or `/` reparses: a
// chat_id of `x/read?` turns a `/chats/{id}/messages` path into a different
// route entirely, which is a routing decision made by the payload.
//
// The charset is what this server's ids actually are — a UUID for a chat, a
// decimal BIGINT for a message — expressed as a charset rather than a format,
// so it stays true if an id shape changes and false for everything that makes
// a path mean something else.
func ccwireSafeID(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// statusToErrorCode maps an HTTP refusal onto errors.proto. NOT_PERMITTED is
// deliberately coarse for both 403 and 404 (errors.proto): "not a member", "no
// such chat" and "not entitled" must be one answer, or the error channel is an
// existence oracle.
func statusToErrorCode(status int) uint32 {
	switch {
	case status == http.StatusTooManyRequests:
		return errRateLimited
	case status == http.StatusForbidden, status == http.StatusNotFound:
		return errNotPermitted
	case status == http.StatusRequestEntityTooLarge:
		return errFrameTooLarge
	case status >= 400 && status < 500:
		return errPayloadInvalid
	default:
		return errInternal
	}
}

// ── inbound: SubmitMessage ──────────────────────────────────────────────

func (s *ccwireSession) submit(m ccwire.Message) bool {
	sub, err := ccwire.DecodeSubmit(m.Body, s.lim)
	if err != nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "submit")
	}
	if !ccwireSafeID(sub.ChatID) || len(sub.Sealed) == 0 {
		return s.sendError(m.RequestID, errPayloadInvalid, "chat_id and sealed required")
	}
	// messages.content is a text column and the REST body is JSON, neither of
	// which can carry arbitrary bytes. The sealed body is the '\0vc1:' wrapper,
	// which is text — so this refuses a malformed client rather than silently
	// mangling ciphertext on its way to the database.
	if !utf8.Valid(sub.Sealed) {
		return s.sendError(m.RequestID, errPayloadInvalid, "sealed must be UTF-8")
	}
	// THE MESSAGE TYPE IS NOT ON THIS WIRE.
	//
	// envelope.proto has no `type`: it lives inside the sealed wrapper, which
	// this server does not open. So CC-Wire can only submit a `text` message,
	// and the PublicMeta fields that exist solely to describe another type are
	// refused rather than smuggled through on a text send — attachmentId and
	// gifUrl would skip chatsValidateAttachmentRef (it runs only for media
	// types), groupId would skip chatsValidateGroupRef, game/room would skip the
	// game-invite validation, optionCount/allowMultiple would land on a message
	// the poll vote handler will never read.
	//
	// Refusing is the only honest answer while the type is unrepresentable. Media
	// and cards stay on REST, where they are fully gated. This lifts the moment
	// SubmitMessage carries a type the server can validate against.
	if sub.Meta.AttachmentID != "" || sub.Meta.GifURL != "" || sub.Meta.GroupID != "" ||
		sub.Meta.Game != "" || sub.Meta.Room != "" || sub.Meta.OptionCount != 0 || sub.Meta.AllowMultiple {
		metrics.Inc("ccwire_submit_untyped_meta")
		return s.sendError(m.RequestID, errUnknownOperation, "only text messages are carried by CC-Wire")
	}

	body := map[string]any{"type": "text", "content": string(sub.Sealed)}
	// client_msg_id → clientId, verbatim. This is the idempotency key the REST
	// path already honours through ON CONFLICT (chat_id, sender_id, client_id):
	// a retry over EITHER transport returns the original row instead of a
	// second message. Nothing here re-implements that — it just has to not drop
	// the key.
	if sub.ClientMsgID != "" {
		body["clientId"] = sub.ClientMsgID
	}
	if meta := ccwireSubmitMeta(sub); len(meta) > 0 {
		body["meta"] = meta
	}

	// The gates live in here: rate limit, membership, blocks, group policies,
	// announcement permission, idempotency — and the fan-out at the end.
	status, resp := s.call(http.MethodPost, "/chats/"+sub.ChatID+"/messages", body)
	if status != http.StatusOK {
		metrics.Inc("ccwire_submit_refused")
		// The REST error STRING is not echoed: errors.proto forbids reflecting
		// client-influenced text back into the error channel.
		return s.sendError(m.RequestID, statusToErrorCode(status), "submit refused")
	}
	metrics.Inc("ccwire_submit")

	id, _ := resp["id"].(string)
	return s.sendAckID(m, id) // the server-assigned message_id
}

// ccwireSubmitMeta is the PublicMeta a text send may legitimately carry,
// under the EXACT key spellings jobs.MetaPublicKeys uses — the REST handler
// reads these, and a different spelling would silently disable the gate rather
// than fail.
func ccwireSubmitMeta(sub ccwire.Submit) map[string]any {
	meta := map[string]any{}
	if sub.Meta.ViewOnce {
		meta["viewOnce"] = true
	}
	if sub.Meta.Announcement {
		// chatsMessagePost enforces PermSendAnnouncement and validates
		// meta.audience against the sender's own subtree. Passing these through
		// is what makes that gate apply to CC-Wire too; dropping them would have
		// been the quieter bug (an announcement silently demoted to a message).
		meta["announcement"] = true
	}
	if sub.Meta.Audience != "" {
		meta["audience"] = sub.Meta.Audience
	}
	if sub.Meta.Silent {
		meta["silent"] = true
	}
	if sub.Meta.Encrypted {
		meta["encrypted"] = true
	}
	if len(sub.Meta.MentionUserIDs) > 0 {
		ids := make([]any, len(sub.Meta.MentionUserIDs))
		for i, u := range sub.Meta.MentionUserIDs {
			ids[i] = u
		}
		meta["mentionUserIds"] = ids
	}
	return meta
}

// ── inbound: EditMessage ────────────────────────────────────────────────

// edit runs chatsMessagePatch — the handler that owns the edit rule — rather
// than restating it. That rule is one WHERE clause:
//
//	WHERE id = $ AND chat_id = $ AND sender_id = $ AND deleted_at IS NULL
//	  AND created_at > NOW() - INTERVAL '15 minutes'
//
// sender_id is the AUTHENTICATED user (httpx.UserFrom, from the session context
// this loopback carries), so a non-owner's edit matches no row and comes back
// 404 — the ownership check is the update itself, not a check beside it that a
// second transport could forget. chatsRequireMem runs first, the retention
// invariant (an edit never extends body_expires_at) holds because the deadline
// is derived from the immutable created_at, and the message_edited fan-out at
// the end is what reaches every open client on both transports.
//
// IDEMPOTENCY needs nothing here: this is an UPDATE, not an INSERT. Replaying
// the same edit rewrites the same row to the same content — there is no second
// edit to produce, which is why EditMessage has no client_msg_id to forward.
func (s *ccwireSession) edit(m ccwire.Message) bool {
	ed, err := ccwire.DecodeEdit(m.Body, s.lim)
	if err != nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "edit")
	}
	if !ccwireSafeID(ed.ChatID) || !ccwireSafeID(ed.MessageID) || len(ed.Sealed) == 0 {
		return s.sendError(m.RequestID, errPayloadInvalid, "chat_id, message_id and sealed required")
	}
	// Same reason as submit: messages.content is a text column reached through a
	// JSON body, so non-UTF-8 ciphertext is refused rather than mangled.
	if !utf8.Valid(ed.Sealed) {
		return s.sendError(m.RequestID, errPayloadInvalid, "sealed must be UTF-8")
	}

	status, resp := s.call(http.MethodPatch,
		"/chats/"+ed.ChatID+"/messages/"+ed.MessageID,
		map[string]any{"content": string(ed.Sealed)})
	if status != http.StatusOK {
		metrics.Inc("ccwire_edit_refused")
		// 404 here is "not yours, not there, or the window closed" — one answer
		// to three questions, collapsed to NOT_PERMITTED by statusToErrorCode
		// so the error channel stays no kind of oracle.
		return s.sendError(m.RequestID, statusToErrorCode(status), "edit refused")
	}
	metrics.Inc("ccwire_edit")

	id, _ := resp["id"].(string)
	return s.sendAckID(m, id)
}

// ── inbound: DeleteMessage ──────────────────────────────────────────────

// del runs chatsMessageDelete: the same sender-owned, not-already-deleted,
// inside-the-60-hour-window WHERE clause, the same tombstone, the same
// best-effort body reclaim and the same message_deleted fan-out.
//
// for_everyone = false is REFUSED, not quietly upgraded. There is no
// delete-for-me on this server — no per-user hide, on either transport — so the
// only thing a transport could do with that flag is silently perform the
// IRREVERSIBLE action the user did not ask for. Answered with
// UNKNOWN_OPERATION, the same way RECEIPT_KIND_PLAYED is.
func (s *ccwireSession) del(m ccwire.Message) bool {
	d, err := ccwire.DecodeDelete(m.Body, s.lim)
	if err != nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "delete")
	}
	if !ccwireSafeID(d.ChatID) || !ccwireSafeID(d.MessageID) {
		return s.sendError(m.RequestID, errPayloadInvalid, "chat_id and message_id required")
	}
	if !d.ForEveryone {
		metrics.Inc("ccwire_delete_for_me_refused")
		return s.sendError(m.RequestID, errUnknownOperation, "delete for me is not served")
	}

	status, resp := s.call(http.MethodDelete,
		"/chats/"+d.ChatID+"/messages/"+d.MessageID, nil)
	if status != http.StatusOK {
		metrics.Inc("ccwire_delete_refused")
		return s.sendError(m.RequestID, statusToErrorCode(status), "delete refused")
	}
	metrics.Inc("ccwire_delete")

	// A replayed delete is refused (deleted_at IS NULL no longer holds) rather
	// than acked twice, which is the handler's answer on REST too. Nothing is
	// deleted a second time either way.
	id, _ := resp["id"].(string)
	return s.sendAckID(m, id)
}

// sendAckID is sendAck plus the message_id the handler returned.
func (s *ccwireSession) sendAckID(m ccwire.Message, id string) bool {
	var b []byte
	b = ccwire.AppendStringField(b, 1, id)
	b = ccwire.AppendVarintField(b, 2, m.Seq)
	b = ccwire.AppendVarintField(b, 3, uint64(time.Now().UnixMilli()))
	return s.send(ccwire.Message{
		RequestID:    m.RequestID,
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       ccwireStreamControl,
		BodyField:    ccwire.BodyAck,
		Body:         b,
	})
}

// ── inbound: Receipt ────────────────────────────────────────────────────

// receipt advances this user's OWN delivery/read pointer, through the same two
// REST handlers the client uses. Both are self-scoped (`WHERE chat_id = $1 AND
// user_id = $2`, under RLS as the session's user), so a receipt on another
// account's behalf is not refused so much as unexpressible — which is the fix
// delivery.proto names for the ungated new_message → message_delivered relay.
func (s *ccwireSession) receipt(m ccwire.Message) bool {
	rc, err := ccwire.DecodeReceipt(m.Body, s.lim)
	if err != nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "receipt")
	}
	if !ccwireSafeID(rc.ChatID) || len(rc.MessageIDs) == 0 {
		return s.sendError(m.RequestID, errPayloadInvalid, "chat_id and message_ids required")
	}
	// The product's pointers are high-water marks, not sets, so the highest id
	// in the batch is the whole batch. Ids are BIGINTs rendered as decimal
	// strings (chatsPublicMsg.ID); anything else is refused by chatsParseInt
	// downstream, and an empty result is refused here.
	high := ""
	for _, id := range rc.MessageIDs {
		if len(id) > len(high) || (len(id) == len(high) && id > high) {
			high = id
		}
	}

	var path, field string
	switch rc.Kind {
	case ccwire.ReceiptKindDelivered:
		path, field = "/chats/"+rc.ChatID+"/delivered", "lastDeliveredMessageId"
	case ccwire.ReceiptKindRead:
		// READ also runs the read-receipt reciprocity rule and the Vanish-Mode
		// sweep inside chatsRead. Both are reasons not to write this by hand.
		path, field = "/chats/"+rc.ChatID+"/read", "lastReadMessageId"
	default:
		// RECEIPT_KIND_PLAYED has no server-side pointer on either transport
		// today; answered rather than dropped.
		return s.sendError(m.RequestID, errUnknownOperation, "receipt kind not served")
	}

	status, _ := s.call(http.MethodPost, path, map[string]any{field: high})
	if status != http.StatusOK {
		return s.sendError(m.RequestID, statusToErrorCode(status), "receipt refused")
	}
	metrics.Inc("ccwire_receipt")
	return s.sendAck(m)
}

// ── inbound: TypingState ────────────────────────────────────────────────

// typing is the Socket.IO typing handler, reached from the other transport.
// Same gate (chatMemberAllowed — FanOutToChat reaches every member's user-room
// directly, so without it a non-member injects typing by chat id), same
// fan-out, and the same reason the uid is the session's: delivery.go's
// senderOfEvent reads it to pick whose hide_typing ghost-mode applies, so a
// payload-supplied uid would let a caller choose someone else's privacy setting.
func (s *ccwireSession) typing(m ccwire.Message) bool {
	chatID, isTyping, err := ccwire.DecodeTyping(m.Body, s.lim)
	if err != nil {
		return s.sendError(m.RequestID, errPayloadInvalid, "typing")
	}
	if chatID == "" {
		return s.sendError(m.RequestID, errPayloadInvalid, "chat_id required")
	}
	if !s.hub.chatMemberAllowed(s.d, chatID, s.ctxOrBG()) {
		metrics.Inc("ccwire_typing_refused")
		return s.sendError(m.RequestID, errNotPermitted, "not permitted")
	}
	event := "typing_stop"
	if isTyping {
		event = "typing_start"
	}
	s.hub.FanOutToChat(s.ctxOrBG(), chatID, event, map[string]any{"uid": s.d.uid, "chatId": chatID}, "")
	// EPHEMERAL is fire-and-forget: no Ack, matching the Socket.IO handler,
	// which also answers nothing.
	return true
}

// ── outbound: the fan-out leaf ──────────────────────────────────────────

const (
	ccwireStreamControl   uint32 = 1
	ccwireStreamMessaging uint32 = 2
	ccwireStreamEphemeral uint32 = 5
)

func (h *Hub) ccwireRegister(s *ccwireSession) {
	var superseded []*ccwireSession

	h.cwmu.Lock()
	if h.cwSessions == nil {
		h.cwSessions = map[string]map[*ccwireSession]struct{}{}
	}
	if h.cwSessions[s.d.uid] == nil {
		h.cwSessions[s.d.uid] = map[*ccwireSession]struct{}{}
	}
	// A RESUMED session supersedes the connection it took over from.
	//
	// The race this closes: connection A is alive but unreachable, B resumes at
	// a higher generation, and A's queued frames arrive afterwards describing a
	// world that has moved on. Without this, A keeps advancing cursors,
	// presence and receipts for a session it no longer owns.
	//
	// Matched on sessionID, not uid: a user's OTHER devices are separate
	// logical sessions and must not be disturbed — "one user, one connection"
	// is exactly the assumption multi-device routing cannot make.
	if s.resumed && s.sessionID != "" {
		for other := range h.cwSessions[s.d.uid] {
			if other != s && other.sessionID == s.sessionID && other.generation < s.generation {
				superseded = append(superseded, other)
			}
		}
	}
	h.cwSessions[s.d.uid][s] = struct{}{}
	h.cwmu.Unlock()

	// Closed OUTSIDE the lock: closeOnce may take other locks, and holding the
	// hub mutex across it is how a deadlock gets introduced quietly.
	for _, old := range superseded {
		metrics.Inc("ccwire_generation_superseded")
		old.closeOnce()
	}
}

func (h *Hub) ccwireUnregister(s *ccwireSession) {
	// Park BEFORE tearing down, so the next connection can pick this session up
	// instead of forcing a full application resync. Failure to park is silent
	// and harmless: the client reconnects fresh, which is today's behaviour.
	//
	// Nothing about the teardown below is skipped or deferred because of this —
	// the session still leaves its rooms and stops being tracked. Parking
	// copies identity and position out; it does not keep the session alive.
	s.parkForResume()

	if s.appEvents {
		s.leaveAppRooms()
		if s.sessionID != "" {
			h.untrackIdentity(s.d.uid, s.sessionID)
		}
	}
	h.cwmu.Lock()
	defer h.cwmu.Unlock()
	set := h.cwSessions[s.d.uid]
	delete(set, s)
	if len(set) == 0 {
		delete(h.cwSessions, s.d.uid)
	}
}

// ccwireDeliver translates one already-authorised fan-out event for this uid's
// CC-Wire sessions. It is called from emitToUidIn on EVERY Socket.IO emit, so
// the no-sessions path must cost one uncontended lock and nothing else — which
// is what it costs with the flag off, since no session can exist.
func (h *Hub) ccwireDeliver(chatID, uid, event string, payload any, parents ...context.Context) {
	ctx, cancel := realtimeContext(parents...)
	defer cancel()
	if ctx.Err() != nil {
		return
	}
	h.ccwireDeliverLocal(chatID, uid, event, payload)
	h.publishCCWire(uid, chatID, nil, "", event, payload, ctx)
}

func (h *Hub) ccwireDeliverLocal(chatID, uid, event string, payload any) {
	if h == nil {
		return
	}
	// Recorded BEFORE the live-session check, because the case that matters is
	// exactly the one with no live sessions: the user's only connection is
	// parked mid-tunnel, this frame reaches nobody, and nothing else in the
	// system would ever know it happened. See resumeStore.noteTraffic.
	h.resume.noteTraffic(uid)

	h.cwmu.Lock()
	var targets []*ccwireSession
	for s := range h.cwSessions[uid] {
		targets = append(targets, s)
	}
	h.cwmu.Unlock()
	if len(targets) == 0 {
		return
	}
	// Encoded ONCE and shared, as before. deliver() hands those bytes straight
	// to every session that has no replay window, and re-encodes with a
	// per-session seq only for the ones that can use it.
	msg, raw := ccwireEventBuild(chatID, event, payload)
	var appMsgs []ccwire.Message
	var appFrames [][]byte
	built := false
	for _, s := range targets {
		if s.appEvents {
			if !built {
				appMsgs, appFrames = appEventBuild(event, payload)
				built = true
			}
			s.deliver(appMsgs, appFrames)
		} else {
			s.deliverOne(msg, raw)
		}
	}
}

// ccwireEventFrame builds the wire bytes for one fan-out event, or nil for an
// event CC-Wire has no body for. Built ONCE per (uid, event) and shared across
// that user's sessions.
func ccwireEventFrame(chatID, event string, payload any) []byte {
	_, raw := ccwireEventBuild(chatID, event, payload)
	return raw
}

func ccwireEventBuild(chatID, event string, payload any) (ccwire.Message, []byte) {
	var msg ccwire.Message
	switch event {
	case "new_message":
		m := ccwireJSONMap(payload)
		if m == nil {
			return msg, nil
		}
		msg = ccwire.Message{
			TrafficClass: ccwire.TrafficClassMessaging,
			Stream:       ccwireStreamMessaging,
			BodyField:    ccwire.BodyDeliverMessage,
			Body:         ccwireDeliverBody(m),
		}

	// The other half of edit and delete. Both handlers end in
	// emitx.ChatEvent → FanOutToChat → emitToUidIn, the SAME leaf new_message
	// uses, so the audience is the one roster minus blockers minus ghost-mode —
	// decided once, for both transports. Without these two cases a CC-Wire
	// client would send an edit successfully and never see anyone else's, which
	// is the silent half-failure this transport exists to stop.
	case "message_edited":
		m := ccwireJSONMap(payload)
		if m == nil {
			return msg, nil
		}
		id, _ := m["id"].(string)
		if id == "" {
			return msg, nil
		}
		env := ccwire.AppendStringField(nil, 1, chatID)
		env = ccwire.AppendStringField(env, 2, id)
		b := ccwire.AppendBytesField(nil, 1, env)
		// content is a *string on the spine row and is nil when the body lives
		// out of band; an absent sealed is the honest encoding of that, not "".
		if c, ok := m["content"].(string); ok && c != "" {
			b = ccwire.AppendBytesField(b, 2, []byte(c))
		}
		// edit_seq (3) is not written: the server keeps no per-message edit
		// counter, and a fabricated one is worse than an absent one.
		msg = ccwire.Message{
			TrafficClass: ccwire.TrafficClassMessaging,
			Stream:       ccwireStreamMessaging,
			BodyField:    ccwire.BodyEditMessage,
			Body:         b,
		}

	case "message_deleted":
		m := ccwireJSONMap(payload)
		if m == nil {
			return msg, nil
		}
		id, _ := m["id"].(string)
		if id == "" {
			return msg, nil
		}
		b := ccwire.AppendStringField(nil, 1, chatID)
		b = ccwire.AppendStringField(b, 2, id)
		// for_everyone is true by construction: chatsMessageDelete is the
		// delete-for-everyone handler and there is no other kind to emit.
		b = ccwire.AppendBoolField(b, 3, true)
		msg = ccwire.Message{
			TrafficClass: ccwire.TrafficClassMessaging,
			Stream:       ccwireStreamMessaging,
			BodyField:    ccwire.BodyDeleteMessage,
			Body:         b,
		}

	case "typing_start", "typing_stop":
		m := ccwireJSONMap(payload)
		if m == nil {
			return msg, nil
		}
		id, _ := m["chatId"].(string)
		if id == "" {
			id = chatID
		}
		var b []byte
		b = ccwire.AppendStringField(b, 1, id)
		b = ccwire.AppendBoolField(b, 2, event == "typing_start")
		// sender_uid, SERVER→CLIENT only. It is the uid the Socket.IO handler
		// stamped from its own session, carried through untouched.
		uid, _ := m["uid"].(string)
		b = ccwire.AppendStringField(b, 3, uid)
		msg = ccwire.Message{
			TrafficClass: ccwire.TrafficClassEphemeral,
			Stream:       ccwireStreamEphemeral,
			BodyField:    ccwire.BodyTypingState,
			Body:         b,
		}

	case "message_delivered", "message_read":
		m := ccwireJSONMap(payload)
		if m == nil {
			return msg, nil
		}
		kind, idField := ccwire.ReceiptKindDelivered, "lastDeliveredMessageId"
		if event == "message_read" {
			kind, idField = ccwire.ReceiptKindRead, "lastReadMessageId"
		}
		id, _ := m[idField].(string)
		if id == "" {
			return msg, nil
		}
		var b []byte
		b = ccwire.AppendStringField(b, 1, chatID)
		b = ccwire.AppendStringField(b, 2, id) // repeated: the high-water mark
		b = ccwire.AppendVarintField(b, 3, uint64(kind))
		userID, _ := m["userId"].(string)
		b = ccwire.AppendStringField(b, 4, userID)
		b = ccwire.AppendVarintField(b, 5, uint64(time.Now().UnixMilli()))
		msg = ccwire.Message{
			TrafficClass: ccwire.TrafficClassSync,
			Stream:       ccwireStreamMessaging,
			BodyField:    ccwire.BodyReceipt,
			Body:         b,
		}

	default:
		return msg, nil
	}
	return msg, ccwireFrame(msg)
}

// ccwireDeliverBody encodes a DeliverMessage from the persisted public message
// the REST path fans out. Every value here came back OUT of the database.
func ccwireDeliverBody(m map[string]any) []byte {
	str := func(k string) string { s, _ := m[k].(string); return s }

	var env []byte
	env = ccwire.AppendStringField(env, 1, str("chatId"))
	env = ccwire.AppendStringField(env, 2, str("id"))
	// client_msg_id (3) is absent: publicMessage does not carry client_id, and
	// inventing one would break the client's own dedup.
	if ts, err := time.Parse(time.RFC3339, str("createdAt")); err == nil {
		env = ccwire.AppendVarintField(env, 4, uint64(ts.UnixMilli()))
	}
	meta, _ := m["meta"].(map[string]any)
	class := uint64(1) // MESSAGE_CLASS_NORMAL
	if truthy(meta["silent"]) {
		class = 2 // MESSAGE_CLASS_SILENT
	}
	env = ccwire.AppendVarintField(env, 5, class)
	if pm := ccwirePublicMeta(meta); len(pm) > 0 {
		env = ccwire.AppendBytesField(env, 7, pm)
	}

	var b []byte
	b = ccwire.AppendBytesField(b, 1, env)
	if c, ok := m["content"].(string); ok && c != "" {
		b = ccwire.AppendBytesField(b, 2, []byte(c)) // sealed, verbatim
	}
	// THE identity field. senderId is messages.sender_id, which the INSERT
	// wrote from the authenticated session — never from any payload.
	b = ccwire.AppendStringField(b, 3, str("senderId"))
	// sender_device_id (4) is empty: this server does not track one per message.
	return b
}

// ccwirePublicMeta encodes the allow-listed meta, and ONLY that. The key
// spellings are jobs.MetaPublicKeys; a key not listed there is message content
// and must never reach this encoder.
func ccwirePublicMeta(meta map[string]any) []byte {
	if meta == nil {
		return nil
	}
	str := func(k string) string { s, _ := meta[k].(string); return s }
	var b []byte
	b = ccwire.AppendStringField(b, 1, str("attachmentId"))
	b = ccwire.AppendBoolField(b, 2, truthy(meta["viewOnce"]))
	b = ccwire.AppendBoolField(b, 3, truthy(meta["revoked"]))
	b = ccwire.AppendBoolField(b, 4, truthy(meta["announcement"]))
	b = ccwire.AppendStringField(b, 5, str("audience"))
	b = ccwire.AppendBoolField(b, 6, truthy(meta["silent"]))
	b = ccwire.AppendStringField(b, 7, str("groupId"))
	b = ccwire.AppendStringField(b, 8, str("gifUrl"))
	b = ccwire.AppendBoolField(b, 9, truthy(meta["allowMultiple"]))
	if n, ok := meta["optionCount"].(float64); ok && n > 0 {
		b = ccwire.AppendVarintField(b, 10, uint64(n))
	}
	if ids, ok := meta["mentionUserIds"].([]any); ok {
		for _, v := range ids {
			if s, ok := v.(string); ok {
				b = ccwire.AppendStringField(b, 11, s)
			}
		}
	}
	b = ccwire.AppendBoolField(b, 12, truthy(meta["encrypted"]))
	b = ccwire.AppendStringField(b, 13, str("game"))
	b = ccwire.AppendStringField(b, 14, str("room"))
	return b
}

// ccwireJSONMap normalises a fan-out payload to a map.
//
// ponytail: a marshal/unmarshal round trip, because the payload is `any` — a
// map from the socket handlers, a chatsPublicMsg struct from the REST path, and
// this package cannot name the struct (routes imports realtime, not the other
// way). It runs ONLY when a CC-Wire session exists for the recipient, so with
// the flag off it never runs at all. Give the fan-out a typed payload if this
// ever shows up in a profile.
func ccwireJSONMap(payload any) map[string]any {
	if m, ok := payload.(map[string]any); ok {
		return m
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

func ccwireFrame(m ccwire.Message) []byte {
	lim := ccwire.DefaultLimits()
	payload, err := ccwire.EncodeMessage(m, lim, 0)
	if err != nil {
		log.Printf("[ccwire] refusing to fan out an invalid frame: %v", err)
		return nil
	}
	out, err := ccwire.Encode(payload, ccwire.Options{MaxBytes: lim.MaxFrameBytes})
	if err != nil {
		log.Printf("[ccwire] refusing to fan out an oversized frame: %v", err)
		return nil
	}
	return out
}

// ── the outbound queue ──────────────────────────────────────────────────

// ccwireOutQueue is the per-session fan-out buffer.
//
// It exists so a stalled CC-Wire client cannot stall the SHARED fan-out.
// FanOutToChat walks its member list synchronously and in-process; writing to a
// socket inline would let one unresponsive peer hold that loop for a write
// deadline, delaying delivery to every Socket.IO member behind it. The whole
// constraint on this work is that Socket.IO keeps behaving as it did.
//
// Overflow disconnects rather than drops: a client that is 256 frames behind
// has lost sync, and a silent hole in a message stream is worse than a
// reconnect-and-resync (resumed=false in ServerHello already tells it to).
const ccwireOutQueue = 256
const ccwireOutBytes = 2 << 20

func (s *ccwireSession) enqueue(raw []byte) {
	s.closeMu.Lock()
	closed := s.closed
	s.closeMu.Unlock()
	if closed {
		return
	}
	if len(raw) == 0 {
		return
	}
	if s.out == nil {
		// No writer goroutine (the package's socket-free tests). Write inline.
		_ = s.write(raw)
		return
	}
	s.queueMu.Lock()
	if s.queuedBytes+len(raw) > ccwireOutBytes {
		s.queueMu.Unlock()
		s.closeOnce()
		return
	}
	s.queuedBytes += len(raw)
	select {
	case s.out <- raw:
		s.queueMu.Unlock()
	default:
		s.queuedBytes -= len(raw)
		s.queueMu.Unlock()
		metrics.Inc("ccwire_slow_consumer")
		s.closeOnce()
	}
}

// ── routing ─────────────────────────────────────────────────────────────

// ccwireServeBody is the switch ccwire.go's handle() consults before falling
// through to UNKNOWN_OPERATION. Kept here so ccwire.go stays the protocol file
// and this stays the application one.
func (s *ccwireSession) serveBody(m ccwire.Message) (handled, alive bool) {
	switch m.BodyField {
	case ccwire.BodyAppEvent:
		return true, s.appEvent(m)
	case ccwire.BodySubmitMessage:
		return true, s.submit(m)
	case ccwire.BodyEditMessage:
		return true, s.edit(m)
	case ccwire.BodyDeleteMessage:
		return true, s.del(m)
	case ccwire.BodyReceipt:
		return true, s.receipt(m)
	case ccwire.BodyTypingState:
		return true, s.typing(m)
	case ccwire.BodyCursorSync:
		// 64 IN, 65 OUT. cursor.proto gives CursorBatch `more` and a
		// server-authored `continuation`, so 65 is the REPLY shape and is left
		// unserved here on purpose - it falls through to UNKNOWN_OPERATION.
		return true, s.cursorSync(m)
	case ccwire.BodyViewerState:
		return true, s.viewerState(m)
	case ccwire.BodyGeoRelay:
		return true, s.geoRelay(m)
		// 80 and 83 stay OFF this list. PresenceUpdate is entirely server-authored
		// (presence.go owns that fact, and accepting one would let a client assert
		// ANOTHER user's online state); ViewerList is the reply shape, carrying
		// other users' identities a client cannot supply - the same argument
		// cursor_batch already got. Neither is on the EPHEMERAL allow-list either.
	default:
		return false, true
	}
}
