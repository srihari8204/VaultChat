package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"vaultchat/backend-go/internal/ccwire"
)

// These drive cursorSync directly rather than through handle(), because the
// dispatch in serveBody is the LEAD's to add — the handler has to be right
// before the switch reaches it, and this suite is what says so.
//
// There is deliberately no cursorBatch handler to drive: cursor.proto makes
// body 65 the REPLY (its continuation is server-authored), so an inbound one is
// UNKNOWN_OPERATION, asserted in ccwire_test.go rather than here.
//
// Two seams stand in for the two things this package deliberately has no access
// to: SetCCWireRoutes for /chats/delta (the real handler is tested in
// internal/routes, against a real database), and ccwireCursorFacts for the
// provenance read. Everything else — the bound, the authorization gate, the
// cursor decision table, the backfill filter, the watermark — is the real code.

// ── harness ─────────────────────────────────────────────────────────────

// fakeDelta installs a mux carrying the EXACT pattern internal/routes
// registers for the canonical catch-up. A handler that builds a different path
// is not served at all, which is the point: the destination is the contract.
func fakeDelta(t *testing.T, calls *[]capturedCall, reply func(capturedCall) (int, map[string]any)) {
	t.Helper()
	m := http.NewServeMux()
	m.HandleFunc("GET /chats/delta", func(w http.ResponseWriter, r *http.Request) {
		c := capturedCall{r.Method, r.URL.String(), map[string]any{}}
		for k, v := range r.URL.Query() {
			c.body[k] = v[0]
		}
		*calls = append(*calls, c)
		status, out := reply(c)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(out)
	})
	SetCCWireRoutes(m)
	t.Cleanup(func() { SetCCWireRoutes(nil) })
}

// fakeFacts stands in for the provenance read.
func fakeFacts(t *testing.T, owners map[int64]string, maxID uint64) {
	t.Helper()
	prev := ccwireCursorFacts
	ccwireCursorFacts = func(context.Context, string, []int64) (map[int64]string, uint64, error) {
		return owners, maxID, nil
	}
	t.Cleanup(func() { ccwireCursorFacts = prev })
}

// member seeds the per-socket membership cache so chatMemberAllowed answers
// without a database — the same cachedPerm shape the typing test uses.
func member(chats map[string]bool) map[string]cachedPerm {
	out := map[string]cachedPerm{}
	for id, ok := range chats {
		out[id] = cachedPerm{ok: ok, gen: permGenerationOf(id), at: time.Now()}
	}
	return out
}

func cursorBody(cs ...ccwireCursor) []byte {
	var b []byte
	for _, c := range cs {
		e := ccwire.AppendStringField(nil, 1, c.ChatID)
		e = ccwire.AppendVarintField(e, 2, uint64(c.Kind))
		e = ccwire.AppendVarintField(e, 3, c.Position)
		b = ccwire.AppendBytesField(b, 1, e)
	}
	return b
}

func cursorBodyWithMutation(token string, cs ...ccwireCursor) []byte {
	b := cursorBody(cs...)
	return ccwire.AppendStringField(b, 2, token)
}

func syncedAt(chatID string, pos uint64) ccwireCursor {
	return ccwireCursor{ChatID: chatID, Kind: cursorKindSynced, Position: pos}
}

// frames decodes everything the session wrote, in order.
func frames(t *testing.T, f *fakeConn) []ccwire.Message {
	t.Helper()
	out := make([]ccwire.Message, 0, len(f.out))
	for _, raw := range f.out {
		fr, err := ccwire.Decode(raw, ccwire.Options{Strict: true})
		if err != nil {
			t.Fatalf("session emitted an unframeable message: %v", err)
		}
		m, err := ccwire.DecodeMessage(fr.Payload, ccwire.DefaultLimits(), 0, 0)
		if err != nil {
			t.Fatalf("session emitted an undecodable frame: %v", err)
		}
		out = append(out, m)
	}
	return out
}

func countBody(ms []ccwire.Message, field uint32) int {
	n := 0
	for _, m := range ms {
		if m.BodyField == field {
			n++
		}
	}
	return n
}

func onlyBatch(t *testing.T, f *fakeConn) ccwire.Message {
	t.Helper()
	for _, m := range frames(t, f) {
		if m.BodyField == ccwire.BodyCursorBatch {
			return m
		}
	}
	t.Fatal("no CursorBatch was written")
	return ccwire.Message{}
}

// batchPositions reads the reply's cursors back out as chat_id → position.
func batchPositions(t *testing.T, m ccwire.Message) map[string]uint64 {
	t.Helper()
	out := map[string]uint64{}
	fields := pbFields(t, m.Body)
	for _, v := range fields[1] {
		c := pbFields(t, v.buf)
		id := string(c[1][0].buf)
		var pos uint64
		if len(c[3]) > 0 {
			pos = c[3][0].num
		}
		out[id] = pos
	}
	return out
}

func batchMore(t *testing.T, m ccwire.Message) bool {
	t.Helper()
	f := pbFields(t, m.Body)
	return len(f[2]) > 0 && f[2][0].num != 0
}

func batchMutationContinuation(t *testing.T, m ccwire.Message) string {
	t.Helper()
	f := pbFields(t, m.Body)
	if len(f[4]) == 0 {
		return ""
	}
	return string(f[4][0].buf)
}

// cursorFrame is what the lead's dispatch will hand the handler.
func cursorFrame(body []byte) ccwire.Message {
	return ccwire.Message{RequestID: "r", TrafficClass: ccwire.TrafficClassSync, Body: body}
}

// msg is one chatsPublicMsg as it comes back through the loopback's JSON.
func msg(id, chatID string) map[string]any {
	return map[string]any{
		"id": id, "chatId": chatID, "senderId": "u2",
		"content": "\x00vc1:{}", "createdAt": "2026-09-14T00:00:00Z",
	}
}

// ── authorization ───────────────────────────────────────────────────────

// The gate is chatMemberAllowed — join_chat's, Subscribe's, typing's. If catch-up
// ever stopped asking it, a CC-Wire client could name any chat id and be handed
// its history, which is the single worst thing a second transport can do.
func TestCCWireCursorSyncRefusesANonMember(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		t.Error("the catch-up must not be reached for a chat the caller is not in")
		return 200, nil
	})
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(map[string]bool{"c-denied": false}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c-denied", 10)))) {
		t.Fatal("a refusal must not end the session")
	}
	if code := errorCodeOf(t, f.last(t)); code != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", code)
	}
	if len(calls) != 0 {
		t.Fatalf("a refused scope still reached the catch-up: %d call(s)", len(calls))
	}
}

// One bad entry refuses the WHOLE batch. The alternative — serving the entries
// that passed — hands back a CursorBatch the client cannot distinguish from a
// complete one, and tells it which chat ids it is not in.
func TestCCWireCursorSyncRefusesWhollyOnOneUnauthorizedScope(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		t.Error("a batch with an unauthorized entry must not reach the catch-up at all")
		return 200, nil
	})
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(map[string]bool{"c-ok": true, "c-denied": false}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c-ok", 5), syncedAt("c-denied", 5)))) {
		t.Fatal("a refusal must not end the session")
	}
	if code := errorCodeOf(t, f.last(t)); code != errNotPermitted {
		t.Fatalf("expected NOT_PERMITTED, got %d", code)
	}
	if n := countBody(frames(t, f), ccwire.BodyDeliverMessage); n != 0 {
		t.Fatalf("the authorized half of a refused batch leaked %d message(s)", n)
	}
	if len(calls) != 0 {
		t.Fatalf("catch-up was called %d time(s) for a refused batch", len(calls))
	}
}

// ── cursor provenance ───────────────────────────────────────────────────

// messages.id is one global BIGSERIAL, so a cursor taken from another chat
// parses perfectly and would silently skip every message in THIS chat below it.
func TestCCWireCursorRefusesACrossChatCursor(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		t.Error("a cursor from another chat must not reach the catch-up")
		return 200, nil
	})
	fakeFacts(t, map[int64]string{500: "c-other"}, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 500)))) {
		t.Fatal("a refusal must not end the session")
	}
	if code := errorCodeOf(t, f.last(t)); code != errPayloadInvalid {
		t.Fatalf("expected PAYLOAD_INVALID, got %d", code)
	}
	if len(calls) != 0 {
		t.Fatalf("catch-up ran on an unvalidated cursor: %d call(s)", len(calls))
	}
}

// A position above the sequence high-water mark was never issued by this
// server. Honouring it would set a watermark ahead of reality and drop every
// message written until the sequence caught up.
func TestCCWireCursorRefusesAPositionNoServerIssued(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		t.Error("an out-of-range cursor must not reach the catch-up")
		return 200, nil
	})
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 1<<40)))) {
		t.Fatal("a refusal must not end the session")
	}
	if code := errorCodeOf(t, f.last(t)); code != errPayloadInvalid {
		t.Fatalf("expected PAYLOAD_INVALID, got %d", code)
	}
	if len(calls) != 0 {
		t.Fatalf("catch-up ran on an out-of-range cursor: %d call(s)", len(calls))
	}
}

// PURGED HISTORY. The server reclaims message bodies after delivery and expires
// disappearing messages, so the row a long-offline client's cursor names may
// simply be gone. That is the client catch-up exists for — it must be served,
// not told its cursor is invalid.
func TestCCWireCursorHonoursAPurgedHistoryCursor(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{
			"messages": []any{msg("777", "c1")}, "nextSince": "777", "more": false,
		}
	})
	// 400 is inside the sequence range but resolves to no row at all.
	fakeFacts(t, map[int64]string{}, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 400)))) {
		t.Fatal("a purged-history cursor must be served")
	}
	if len(calls) != 1 {
		t.Fatalf("expected one catch-up call, got %d", len(calls))
	}
	if calls[0].body["since"] != "400" {
		t.Fatalf("the purged cursor was not carried into the catch-up: since=%v", calls[0].body["since"])
	}
	if n := countBody(frames(t, f), ccwire.BodyDeliverMessage); n != 1 {
		t.Fatalf("expected one backfilled message, got %d", n)
	}
	if got := batchPositions(t, onlyBatch(t, f))["c1"]; got != 777 {
		t.Fatalf("watermark did not advance to the last delivered row: %d", got)
	}
}

// ── bounds ──────────────────────────────────────────────────────────────

// Past the bound the answer is a refusal, never a short answer. A truncated
// batch returns a CursorBatch that looks complete and leaves the rest of the
// client's chats behind forever.
func TestCCWireCursorSyncRefusesPastTheBoundRatherThanTruncating(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		t.Error("an oversized batch must not be partially served")
		return 200, nil
	})
	fakeFacts(t, nil, 1000)

	cs := make([]ccwireCursor, 0, ccwireMaxBatchItems+1)
	seed := map[string]bool{}
	for i := 0; i <= ccwireMaxBatchItems; i++ {
		id := "c" + string(rune('a'+i%26)) + strconv.Itoa(i)
		cs = append(cs, syncedAt(id, 1))
		seed[id] = true
	}
	s, f := newSession("u1", member(seed))
	if !s.cursorSync(cursorFrame(cursorBody(cs...))) {
		t.Fatal("a refusal must not end the session")
	}
	if code := errorCodeOf(t, f.last(t)); code != errPayloadInvalid {
		t.Fatalf("expected PAYLOAD_INVALID, got %d", code)
	}
	if n := countBody(frames(t, f), ccwire.BodyCursorBatch); n != 0 {
		t.Fatalf("an oversized batch was answered with %d CursorBatch frame(s)", n)
	}
	if len(calls) != 0 {
		t.Fatalf("an oversized batch reached the catch-up %d time(s)", len(calls))
	}
}

// A MULTI-SCOPE CursorSync IS THE BATCH. cursor.proto gives CursorSync
// `repeated Cursor cursors = 1` bounded at max_batch_items, so two scopes in
// one frame is the ordinary case, not a schema error — this asserts both are
// SERVED, because refusing them (as an earlier reading of the brief did) would
// have left a client with two chats unable to catch up on either.
func TestCCWireCursorSyncServesManyScopesInOneFrame(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{
			"messages":  []any{msg("2", "c1"), msg("3", "c2")},
			"nextSince": "3", "more": false,
		}
	})
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true, "c2": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 1), syncedAt("c2", 1)))) {
		t.Fatal("a two-scope cursor_sync must be served")
	}
	if len(calls) != 1 {
		t.Fatalf("expected one catch-up call, got %d", len(calls))
	}
	if n := countBody(frames(t, f), ccwire.BodyDeliverMessage); n != 2 {
		t.Fatalf("expected both scopes backfilled, got %d message frame(s)", n)
	}
	pos := batchPositions(t, onlyBatch(t, f))
	if pos["c1"] != 2 || pos["c2"] != 3 {
		t.Fatalf("both scopes must come back with their own watermark: %v", pos)
	}
}

// An empty frame is answered, never dropped — the silent drop is the bug
// ERROR_CODE_UNKNOWN_OPERATION exists to stop.
func TestCCWireCursorRefusesAnEmptyFrame(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) { return 200, nil })
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(nil))
	if !s.cursorSync(cursorFrame(nil)) {
		t.Fatal("a refusal must not end the session")
	}
	if code := errorCodeOf(t, f.last(t)); code != errPayloadInvalid {
		t.Fatalf("expected PAYLOAD_INVALID, got %d", code)
	}
}

// READ and DELIVERED pointers belong to POST /chats/{id}/read and /delivered,
// reached over this transport by the Receipt body — which also runs the
// read-receipt reciprocity rule and the Vanish-Mode sweep. A second write path
// for the same pointers here would be a second policy.
func TestCCWireCursorRefusesReceiptKinds(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) { return 200, nil })
	fakeFacts(t, nil, 1000)

	for _, kind := range []uint32{cursorKindUnspecified, cursorKindRead, cursorKindDelivered} {
		s, f := newSession("u1", member(map[string]bool{"c1": true}))
		body := cursorBody(ccwireCursor{ChatID: "c1", Kind: kind, Position: 1})
		if !s.cursorSync(cursorFrame(body)) {
			t.Fatalf("kind %d: a refusal must not end the session", kind)
		}
		if code := errorCodeOf(t, f.last(t)); code != errUnknownOperation {
			t.Fatalf("kind %d: expected UNKNOWN_OPERATION, got %d", kind, code)
		}
	}
	if len(calls) != 0 {
		t.Fatalf("a receipt-kind cursor reached the catch-up: %d call(s)", len(calls))
	}
}

// ── the served path ─────────────────────────────────────────────────────

// Nothing new is still an answer, and the watermark must NOT move: advancing a
// cursor past messages that were never sent is how a client loses history
// permanently.
func TestCCWireCursorEmptyDeltaAnswersWithAnUnchangedWatermark(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{
			"messages": []any{}, "nextSince": "42", "more": false, "mutations": []any{},
		}
	})
	fakeFacts(t, map[int64]string{42: "c1"}, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 42)))) {
		t.Fatal("an empty delta must still be answered")
	}
	ms := frames(t, f)
	if n := countBody(ms, ccwire.BodyDeliverMessage); n != 0 {
		t.Fatalf("an empty delta produced %d message frame(s)", n)
	}
	b := onlyBatch(t, f)
	if got := batchPositions(t, b)["c1"]; got != 42 {
		t.Fatalf("watermark moved on an empty delta: %d", got)
	}
	if batchMore(t, b) {
		t.Fatal("more was set on an exhausted delta")
	}
}

func TestCCWireCursorBackfillsMutationsAndAdvancesServerToken(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(c capturedCall) (int, map[string]any) {
		if c.body["mutationCursor"] != "2026-09-14T00:00:00Z|7" {
			t.Fatalf("mutation continuation not echoed: %v", c.body["mutationCursor"])
		}
		return 200, map[string]any{
			"messages": []any{}, "more": false,
			"mutations": []any{
				map[string]any{"id": "8", "chatId": "c1", "content": "sealed", "editedAt": "2026-09-14T01:00:00Z"},
				map[string]any{"id": "9", "chatId": "c1", "deletedAt": "2026-09-14T02:00:00Z"},
			},
			"nextMutationCursor": "2026-09-14T02:00:00Z|9",
		}
	})
	fakeFacts(t, nil, 1000)
	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBodyWithMutation("2026-09-14T00:00:00Z|7", syncedAt("c1", 0)))) {
		t.Fatal("mutation backfill ended the session")
	}
	ms := frames(t, f)
	if countBody(ms, ccwire.BodyEditMessage) != 1 || countBody(ms, ccwire.BodyDeleteMessage) != 1 {
		t.Fatalf("mutation bodies missing: %#v", ms)
	}
	if got := batchMutationContinuation(t, onlyBatch(t, f)); got != "2026-09-14T02:00:00Z|9" {
		t.Fatalf("next mutation continuation: %q", got)
	}
}

func TestCCWireCursorFullMutationPageRequestsContinuation(t *testing.T) {
	mutations := make([]any, 500)
	for i := range mutations {
		mutations[i] = map[string]any{
			"id": strconv.Itoa(i + 1), "chatId": "c1", "content": "sealed",
			"editedAt": "2026-09-14T01:00:00Z",
		}
	}
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{
			"messages": []any{}, "more": false, "mutations": mutations,
			"nextMutationCursor": "2026-09-14T01:00:00Z|500",
		}
	})
	fakeFacts(t, nil, 1000)
	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBodyWithMutation("2026-09-14T00:00:00Z|0", syncedAt("c1", 0)))) {
		t.Fatal("full mutation page ended the session")
	}
	if !batchMore(t, onlyBatch(t, f)) {
		t.Fatal("500 mutations must set more even when message pagination is complete")
	}
}

func TestCCWireCursorBootstrapsMutationTokenWithoutChangingOldRequest(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(c capturedCall) (int, map[string]any) {
		if _, sent := c.body["mutationCursor"]; sent {
			t.Fatal("an old peer's empty field must not request historical mutations")
		}
		return 200, map[string]any{"messages": []any{}, "more": false, "serverTime": "2026-09-14T03:00:00Z"}
	})
	fakeFacts(t, nil, 1000)
	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 0)))) {
		t.Fatal("bootstrap ended the session")
	}
	if got := batchMutationContinuation(t, onlyBatch(t, f)); got != "2026-09-14T03:00:00Z|0" {
		t.Fatalf("bootstrap mutation continuation: %q", got)
	}
}

// One frame, one /chats/delta page, at the LOWEST cursor asked for — the shared
// page is then filtered per chat by that chat's own cursor. Rows belonging to
// the caller's OTHER chats are not smuggled in on the back of it.
func TestCCWireCursorSyncPagesOnceAndFiltersPerChat(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{
			"messages": []any{
				msg("11", "c1"), // <= c1's cursor of 20: already had it
				msg("25", "c1"),
				msg("30", "c2"), // <= c2's cursor of 50: already had it
				msg("60", "c2"),
				msg("70", "c-not-asked"), // a chat this frame did not ask about
			},
			"nextSince": "70", "more": true,
		}
	})
	fakeFacts(t, map[int64]string{20: "c1", 50: "c2"}, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true, "c2": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 20), syncedAt("c2", 50)))) {
		t.Fatal("a valid batch must be served")
	}
	if len(calls) != 1 {
		t.Fatalf("a batch of 2 scopes must be ONE catch-up call, got %d", len(calls))
	}
	if calls[0].body["since"] != "20" {
		t.Fatalf("catch-up ran from the wrong cursor: since=%v", calls[0].body["since"])
	}
	if n := countBody(frames(t, f), ccwire.BodyDeliverMessage); n != 2 {
		t.Fatalf("expected exactly the 2 unseen rows for the asked-about chats, got %d", n)
	}
	b := onlyBatch(t, f)
	pos := batchPositions(t, b)
	if pos["c1"] != 25 || pos["c2"] != 60 {
		t.Fatalf("watermarks are not the per-chat maxima actually delivered: %v", pos)
	}
	if !batchMore(t, b) {
		t.Fatal("more was dropped from a paged answer")
	}
}

// The catch-up reply rides STREAM_ID_SYNC, behind the messages it covers. A
// watermark that overtook its own backfill would acknowledge messages the
// client never got.
func TestCCWireCursorRepliesOnTheSyncStreamAfterItsMessages(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{"messages": []any{msg("9", "c1")}, "nextSince": "9", "more": false}
	})
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 0)))) {
		t.Fatal("a cold cursor must be served")
	}
	ms := frames(t, f)
	if len(ms) != 2 {
		t.Fatalf("expected a message then a batch, got %d frame(s)", len(ms))
	}
	if ms[0].BodyField != ccwire.BodyDeliverMessage || ms[1].BodyField != ccwire.BodyCursorBatch {
		t.Fatalf("watermark did not come last: %d then %d", ms[0].BodyField, ms[1].BodyField)
	}
	for _, m := range ms {
		if m.Stream != ccwireStreamSync || m.TrafficClass != ccwire.TrafficClassSync {
			t.Fatalf("catch-up frame left the sync stream: stream=%d class=%d", m.Stream, m.TrafficClass)
		}
	}
}

// A backfilled message is encoded by the SAME function the live fan-out uses,
// so the client needs one merge path rather than two. This asserts the payload
// actually arrives, identity and all — sender_id comes off the persisted row.
func TestCCWireCursorBackfillCarriesTheLiveDeliverShape(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return 200, map[string]any{"messages": []any{msg("9", "c1")}, "nextSince": "9", "more": false}
	})
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 0)))) {
		t.Fatal("a cold cursor must be served")
	}
	body := frames(t, f)[0].Body
	fields := pbFields(t, body)
	env := pbSub(t, fields, 1)
	if got := pbStr(t, env, 1); got != "c1" {
		t.Fatalf("backfilled chat_id: %q", got)
	}
	if got := pbStr(t, env, 2); got != "9" {
		t.Fatalf("backfilled message_id: %q", got)
	}
	if got := pbStr(t, fields, 2); got != "\x00vc1:{}" {
		t.Fatalf("sealed body was not carried verbatim: %q", got)
	}
	if got := pbStr(t, fields, 3); got != "u2" {
		t.Fatalf("sender_uid did not come off the persisted row: %q", got)
	}
}

// A refusal from the canonical handler is relayed as a refusal, not swallowed
// into an empty-but-successful catch-up.
func TestCCWireCursorRelaysACatchUpRefusal(t *testing.T) {
	var calls []capturedCall
	fakeDelta(t, &calls, func(capturedCall) (int, map[string]any) {
		return http.StatusTooManyRequests, map[string]any{"error": "slow down"}
	})
	fakeFacts(t, nil, 1000)

	s, f := newSession("u1", member(map[string]bool{"c1": true}))
	if !s.cursorSync(cursorFrame(cursorBody(syncedAt("c1", 0)))) {
		t.Fatal("a refusal must not end the session")
	}
	if code := errorCodeOf(t, f.last(t)); code != errRateLimited {
		t.Fatalf("expected RATE_LIMITED, got %d", code)
	}
}

// ── the decision table, directly ─────────────────────────────────────────

func TestCCWireCursorCheckDecisionTable(t *testing.T) {
	owners := map[int64]string{7: "c1", 8: "c2"}
	const maxID = 100
	for _, tc := range []struct {
		name string
		c    ccwireCursor
		want bool
	}{
		{"cold start", syncedAt("c1", 0), true},
		{"own message", syncedAt("c1", 7), true},
		{"another chat's message", syncedAt("c1", 8), false},
		{"purged row, in range", syncedAt("c1", 50), true},
		{"at the high-water mark", syncedAt("c1", maxID), true},
		{"past the high-water mark", syncedAt("c1", maxID+1), false},
	} {
		if got := ccwireCursorCheck(tc.c, owners, maxID); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}
