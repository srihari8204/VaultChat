// chats_send_characterization_test.go — what POST /chats/{id}/messages ACTUALLY
// does today (tasks 2.1 and 2.2 of openspec/changes/protobuf-migration).
//
// CHARACTERIZATION, NOT SPECIFICATION. Every assertion below pins the behaviour
// of the handler as it is written, with a comment naming the file:line it
// pins. If one of these fails after a refactor, the refactor changed observable
// behaviour — that is the whole point: nothing may be extracted out of
// chatsMessagePost until there is evidence of what extraction would have to
// preserve.
//
// WHY THIS FILE EXISTS. A CC-Wire SubmitMessage is not persisted by
// internal/realtime; it is turned into this REST request and run through
// chatsMessagePost itself (ccwire_messages.go:169-230), which is how it inherits
// the send rate limit (chats_helpers.go:436), chatsRequireMem (:443), the block
// check (:460), the group send/media/slow-mode policies (:470-509), the
// announcement permission and audience (:539-556), the per-type ladder
// (:589-730), the 1 MB content cap (:732), the RLS transaction (:758) and the
// ON CONFLICT idempotency (:769). Every CC-Wire test in
// internal/realtime/ccwire_messages_test.go routes into a `fakeRoutes` stand-in
// (:33-51), so until this file nothing anywhere exercised the real handler's
// insert path at all.
//
// DATABASE. Skipped unless CALL_TEST_DB=1, exactly like the suites next door
// (cross_tenant_test.go:191-193, chats_unread_concurrency_test.go:40,
// auth_onboarding_flow_test.go:56-57). It WRITES. Point DB_* at a scratch
// database on port 15499 — NOT 15432, which on the author's machine is an SSH
// tunnel to PRODUCTION Postgres. Fixtures go through adminExec /
// adminQueryRow (call_sessions_test.go:92,109) because `chats` has RLS enabled
// and no INSERT policy for the app role.
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=15499 DB_NAME=vaultchat_test \
//	DB_USER=vaultchat_app DB_PASS=... JWT_SECRET=test \
//	CALL_TEST_ADMIN_DSN='postgres://postgres@127.0.0.1:15499/vaultchat_test' \
//	go test ./internal/routes/ -run TestSend -v
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"vaultchat/backend-go/internal/ccwire"
	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/realtime"
)

// Own fixture ids: seed()/cleanupFixtures() in call_sessions_test.go wipe their
// own chat, and sharing one would make these tests order-dependent.
const (
	csSender = "0c210000-0000-4000-8000-0000000000a1"
	csPeer   = "0c210000-0000-4000-8000-0000000000a2"
	csChat   = "0c210000-0000-4000-8000-0000000000c1"
	// A NUL byte is not storable in a Postgres `text` column, so the fixture
	// ciphertext uses the printable half of the '\0vc1:' wrapper only. The
	// handler never opens it (chats_helpers.go:511-515: content is carried
	// verbatim), so its exact bytes are irrelevant to what is under test.
	csSealed = "vc1:Y2lwaGVydGV4dA"
)

func csSkip(t *testing.T) context.Context {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* (port 15499, NOT 15432) to run the send characterization tests")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	return ctx
}

func csCleanup(ctx context.Context) {
	for _, q := range []string{
		// chats.last_message_id references the row being deleted.
		fmt.Sprintf(`UPDATE chats SET last_message_id = NULL, last_message_at = NULL WHERE id = '%s'`, csChat),
		fmt.Sprintf(`DELETE FROM messages WHERE chat_id = '%s'`, csChat),
		fmt.Sprintf(`DELETE FROM chat_members WHERE chat_id = '%s'`, csChat),
		fmt.Sprintf(`DELETE FROM chats WHERE id = '%s'`, csChat),
		fmt.Sprintf(`DELETE FROM users WHERE id IN ('%s','%s')`, csSender, csPeer),
	} {
		_ = adminExec(ctx, q)
	}
}

// csSeed builds a two-person group chat. Group rather than direct so the
// chatsBlockedDirect gate (chats_helpers.go:460) is not what these tests are
// accidentally measuring.
func csSeed(t *testing.T, ctx context.Context) {
	t.Helper()
	csCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		 ('%s','cs-sender@t.test','Sender'), ('%s','cs-peer@t.test','Peer')`, csSender, csPeer),
		fmt.Sprintf(`INSERT INTO chats (id, type) VALUES ('%s','group')`, csChat),
		fmt.Sprintf(`INSERT INTO chat_members (chat_id, user_id, role) VALUES
		 ('%s','%s','owner'), ('%s','%s','member')`, csChat, csSender, csChat, csPeer),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	t.Cleanup(func() { csCleanup(ctx) })
}

func csMux(t *testing.T) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	RegisterChats(mux)
	// RegisterChats hands realtime the CC-Wire loopback mux when the flag is on
	// (chats.go:106); leave nothing installed behind this test.
	t.Cleanup(func() { realtime.SetCCWireRoutes(nil) })
	return mux
}

// ── fan-out capture ───────────────────────────────────────────────────

type csEvent struct {
	event   string
	payload map[string]any
}

// csFanOut replaces emitx's local fan-out leaf. With it nil, emitx.ChatNewMessage
// POSTs to another node (emitx.go:97-103); installing it both captures the event
// and keeps the test off the network. The fan-out is submitted to the workx pool
// (emitx.go:126), so it is observed with a deadline, never synchronously.
func csFanOut(t *testing.T) chan csEvent {
	t.Helper()
	ch := make(chan csEvent, 16)
	prev := emitx.LocalFanOutChat
	emitx.LocalFanOutChat = func(_ context.Context, _, event string, payload any, _ string) {
		m, _ := payload.(map[string]any)
		if m == nil {
			// chatsMessagePost passes a chatsPublicMsg struct, not a map
			// (chats_helpers.go:830,869) — normalise through JSON so the
			// assertions read the wire shape the recipient gets.
			b, _ := json.Marshal(payload)
			_ = json.Unmarshal(b, &m)
		}
		ch <- csEvent{event: event, payload: m}
	}
	t.Cleanup(func() { emitx.LocalFanOutChat = prev })
	return ch
}

func csAwaitEvent(t *testing.T, ch chan csEvent, what string) csEvent {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(5 * time.Second):
		t.Fatalf("no fan-out event within 5s (%s)", what)
		return csEvent{}
	}
}

// ── small DB readers (admin role: the app role cannot see past RLS here) ──

func csCount(t *testing.T, ctx context.Context, q string) int {
	t.Helper()
	var n int
	if err := adminQueryRow(ctx, q, &n); err != nil {
		t.Fatalf("count (%s): %v", q, err)
	}
	return n
}

func csMsgCount(t *testing.T, ctx context.Context) int {
	return csCount(t, ctx, fmt.Sprintf(`SELECT COUNT(*) FROM messages WHERE chat_id = '%s'`, csChat))
}

func csUnread(t *testing.T, ctx context.Context, uid string) int {
	return csCount(t, ctx, fmt.Sprintf(
		`SELECT unread_count FROM chat_members WHERE chat_id = '%s' AND user_id = '%s'`, csChat, uid))
}

func csSend(t *testing.T, mux *http.ServeMux, body string) (int, map[string]any) {
	t.Helper()
	return call(t, mux, csSender, "POST", "/chats/"+csChat+"/messages", body)
}

// ── 1. the happy path, end to end ─────────────────────────────────────

// INSERT → response echo → emitx.ChatNewMessage, in that order, for the only
// message type CC-Wire can submit today (ccwire_messages.go:204: the type is not
// on that wire, so a submit is always `text`).
func TestSendHappyPathInsertsEchoesAndFansOut(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	events := csFanOut(t)
	mux := csMux(t)

	code, res := csSend(t, mux, fmt.Sprintf(`{"type":"text","content":%q}`, csSealed))
	if code != 200 {
		t.Fatalf("a member's text send was refused: %d %v", code, res)
	}

	// The response is chatsMsgRow.public() (chats_helpers.go:830, chats.go:312).
	id, _ := res["id"].(string)
	if id == "" {
		t.Fatalf("no server-assigned id in the response: %v", res)
	}
	// senderId comes off the INSERTed row, which was written from the
	// authenticated user (chats_helpers.go:771 binds user.ID), never from the body.
	if res["senderId"] != csSender {
		t.Errorf("senderId = %v, want the authenticated sender %s", res["senderId"], csSender)
	}
	if res["type"] != "text" {
		t.Errorf("type = %v, want text", res["type"])
	}
	// chats_helpers.go:860-866: the content echoed back is the value THIS request
	// carried, not the value re-read from the spine. That echo is what replaces
	// the sender's optimistic bubble.
	if res["content"] != csSealed {
		t.Errorf("content = %v, want the submitted ciphertext echoed verbatim", res["content"])
	}
	if res["chatId"] != csChat {
		t.Errorf("chatId = %v, want %s", res["chatId"], csChat)
	}

	// One durable row.
	if n := csMsgCount(t, ctx); n != 1 {
		t.Fatalf("messages rows = %d, want exactly 1", n)
	}

	// chats_helpers.go:869 — the same payload the sender got is what every online
	// recipient gets, under the `new_message` event Socket.IO and CC-Wire share.
	e := csAwaitEvent(t, events, "happy path")
	if e.event != "new_message" {
		t.Errorf("fan-out event = %q, want new_message", e.event)
	}
	if e.payload["id"] != id {
		t.Errorf("fan-out carried id %v, response carried %q — the two must be the same message",
			e.payload["id"], id)
	}
	if e.payload["content"] != csSealed {
		t.Errorf("fan-out content = %v; a null/spine content here is an empty message on every online device",
			e.payload["content"])
	}
}

// ── 2 + 3. ON CONFLICT idempotency and the duplicate re-read ──────────

// chats_helpers.go:769 — ON CONFLICT (chat_id, sender_id, client_id) DO NOTHING,
// then :772-796 re-reads the ORIGINAL row and marks the send duplicate.
func TestSendSameClientIDYieldsOneRowAndReReadsTheOriginal(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	events := csFanOut(t)
	mux := csMux(t)

	body := fmt.Sprintf(`{"type":"text","content":%q,"clientId":"cs-retry-1"}`, csSealed)

	code, first := csSend(t, mux, body)
	if code != 200 {
		t.Fatalf("first send refused: %d %v", code, first)
	}
	csAwaitEvent(t, events, "first send")

	// The retry is NOT an error: it is a 200 carrying the original row.
	code, second := csSend(t, mux, body)
	if code != 200 {
		t.Fatalf("a retry of the same clientId must be a 200, got %d %v", code, second)
	}
	if second["id"] != first["id"] {
		t.Errorf("retry returned id %v, original was %v — the dedup lookup at :784-787 did not find the original row",
			second["id"], first["id"])
	}
	if n := csMsgCount(t, ctx); n != 1 {
		t.Fatalf("messages rows = %d after a retry, want 1 — the partial unique index (client_id IS NOT NULL) is not deduplicating", n)
	}
	// The duplicate branch is EXCLUDED from the echo at :860 (`if !duplicate`),
	// so these values came out of the re-read at :784-787, not out of the request.
	// With the body store off, the spine still holds the ciphertext, so they
	// agree; the property under test is that a duplicate answers with the
	// PERSISTED row.
	if second["senderId"] != csSender || second["type"] != "text" {
		t.Errorf("re-read row is not the original message: %v", second)
	}
	if second["createdAt"] != first["createdAt"] {
		t.Errorf("retry createdAt %v != original %v — a retry must not look like a new message",
			second["createdAt"], first["createdAt"])
	}

	// A DIFFERENT clientId is a different message. Same request otherwise, so
	// this isolates the idempotency key.
	code, other := csSend(t, mux, fmt.Sprintf(`{"type":"text","content":%q,"clientId":"cs-retry-2"}`, csSealed))
	if code != 200 || other["id"] == first["id"] {
		t.Fatalf("a new clientId must produce a new row: %d %v", code, other)
	}
	if n := csMsgCount(t, ctx); n != 2 {
		t.Fatalf("messages rows = %d, want 2", n)
	}

	// No clientId at all: the ON CONFLICT clause is `WHERE client_id IS NOT NULL`
	// (:769), so two identical bodies are two messages.
	plain := fmt.Sprintf(`{"type":"text","content":%q}`, csSealed)
	csSend(t, mux, plain)
	csSend(t, mux, plain)
	if n := csMsgCount(t, ctx); n != 4 {
		t.Fatalf("messages rows = %d, want 4 — without a clientId there is nothing to deduplicate on", n)
	}
}

// ── 4. THE ASYMMETRY: fan-out on a duplicate, unread bump and push not ──

// chats_helpers.go:869 sits OUTSIDE the `if !duplicate` guard and :872 inside
// it, and the comment at :868 says why: recipients dedup by id, so
// re-broadcasting is how a retry repairs a delivery the first attempt lost —
// but re-bumping the badge or re-ringing the phone would be a second
// notification for one message.
func TestSendDuplicateRebroadcastsButDoesNotBumpUnread(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	events := csFanOut(t)
	mux := csMux(t)

	body := fmt.Sprintf(`{"type":"text","content":%q,"clientId":"cs-dup-1"}`, csSealed)
	code, first := csSend(t, mux, body)
	if code != 200 {
		t.Fatalf("first send refused: %d %v", code, first)
	}
	csAwaitEvent(t, events, "first send")

	// The bump is queued on the workx pool (:876-888), so wait for it rather
	// than assuming it has landed. This wait also calibrates the negative
	// assertion below: the duplicate gets at least as long to (not) bump.
	deadline := time.Now().Add(5 * time.Second)
	for csUnread(t, ctx, csPeer) == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	before := csUnread(t, ctx, csPeer)
	if before != 1 {
		t.Fatalf("recipient unread_count = %d after one send, want 1 (vc_bump_unread at :885)", before)
	}

	code, second := csSend(t, mux, body)
	if code != 200 {
		t.Fatalf("retry refused: %d %v", code, second)
	}

	// :869 — the re-broadcast happens on the duplicate too.
	e := csAwaitEvent(t, events, "duplicate re-broadcast")
	if e.event != "new_message" || e.payload["id"] != first["id"] {
		t.Errorf("duplicate did not re-broadcast the original message: %+v", e)
	}

	// :872 — and the bump did not run. Give it the same 5s the positive case got.
	time.Sleep(time.Second)
	after := csUnread(t, ctx, csPeer)
	if after != before {
		t.Errorf("recipient unread_count went %d → %d on a retry; the bump at :885 is guarded by `if !duplicate` at :872",
			before, after)
	}
}

// Reactions are the other asymmetry on the same lines: :810 skips the
// last_message/un-hide updates for them, and :872 skips the bump and push.
func TestSendReactionDoesNotBecomeTheLastMessage(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	csFanOut(t)
	mux := csMux(t)

	// Hide the chat for the peer first, so the un-hide at :816-820 has something
	// to do if it (wrongly) runs.
	if err := adminExec(ctx, fmt.Sprintf(
		`UPDATE chat_members SET hidden = TRUE WHERE chat_id = '%s' AND user_id = '%s'`, csChat, csPeer)); err != nil {
		t.Fatalf("hide: %v", err)
	}

	code, res := csSend(t, mux, fmt.Sprintf(`{"type":"reaction","content":%q}`, csSealed))
	if code != 200 {
		t.Fatalf("reaction refused: %d %v", code, res)
	}
	if n := csMsgCount(t, ctx); n != 1 {
		t.Fatalf("reaction rows = %d, want 1 — a reaction IS a message row", n)
	}
	// :810 — `if msgType != "reaction"`.
	if n := csCount(t, ctx, fmt.Sprintf(
		`SELECT COUNT(*) FROM chats WHERE id = '%s' AND last_message_id IS NOT NULL`, csChat)); n != 0 {
		t.Errorf("a reaction became the chat's last message; :810 excludes it")
	}
	if n := csCount(t, ctx, fmt.Sprintf(
		`SELECT COUNT(*) FROM chat_members WHERE chat_id = '%s' AND user_id = '%s' AND hidden = TRUE`,
		csChat, csPeer)); n != 1 {
		t.Errorf("a reaction un-hid the chat; :810 excludes it from the un-hide at :816-820")
	}
	// :872 — no bump for a reaction either.
	time.Sleep(time.Second)
	if n := csUnread(t, ctx, csPeer); n != 0 {
		t.Errorf("a reaction bumped unread_count to %d; :872 excludes it", n)
	}
}

// ── 5. the per-type validation ladder (:589-730) ──────────────────────

// The status codes and message strings are Node-parity contracts: clients match
// on them. Table-driven because the ladder is a table.
func TestSendValidationLadderRefusals(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	csFanOut(t)
	mux := csMux(t)

	cases := []struct {
		name string
		body string
		code int
		msg  string
		pin  string
	}{
		{
			name: "unknown type", // :583-586, before the ladder
			body: `{"type":"telepathy","content":"x"}`,
			code: 400, msg: "invalid type", pin: "chats_helpers.go:584",
		},
		{
			name: "text with no content", // :590-594
			body: `{"type":"text"}`,
			code: 400, msg: "content required for text messages", pin: "chats_helpers.go:592",
		},
		{
			name: "text with an empty string", // :591 — "" is refused, not stored
			body: `{"type":"text","content":""}`,
			code: 400, msg: "content required for text messages", pin: "chats_helpers.go:592",
		},
		{
			name: "text with a non-string content", // contentIsStr is false
			body: `{"type":"text","content":{"a":1}}`,
			code: 400, msg: "content required for text messages", pin: "chats_helpers.go:592",
		},
		{
			name: "sticker with no id", // :595-599
			body: `{"type":"sticker"}`,
			code: 400, msg: "content (sticker id) required", pin: "chats_helpers.go:597",
		},
		{
			name: "sticker id over 64 runes", // :600-603
			body: fmt.Sprintf(`{"type":"sticker","content":%q}`, strings.Repeat("s", 65)),
			code: 400, msg: "sticker id too long", pin: "chats_helpers.go:602",
		},
		{
			name: "media with no attachmentId", // :689-692
			body: `{"type":"image","meta":{}}`,
			code: 400, msg: "meta.attachmentId required for media messages", pin: "chats_helpers.go:690",
		},
		{
			name: "media with no meta at all", // :689 — meta == nil takes the same branch
			body: `{"type":"file"}`,
			code: 400, msg: "meta.attachmentId required for media messages", pin: "chats_helpers.go:690",
		},
		{
			// PINS THE EARLIER GATE, AND THE DEAD BRANCH BELOW IT.
			//
			// This case was written expecting 400 from chats_helpers.go:609
			// ("meta.groupId required for a group reference"). Running it
			// showed 403 "A group reference needs a group" instead, because
			// chatsValidateGroupRef fires first at :561-566 and refuses the
			// SAME condition — meta == nil or a blank groupId
			// (chats_membership.go:1084,1088).
			//
			// So :608-611 is UNREACHABLE for this input: one rule validated
			// twice, with two different status codes, the second dead. Pinned
			// as 403 because that is what the handler does; if the dead branch
			// is ever removed, this test keeps passing, which is correct — it
			// guards the behaviour, not the duplication.
			name: "group_ref with no groupId", // gate at :561-566, not :609
			body: `{"type":"group_ref","meta":{}}`,
			code: 403, msg: "A group reference needs a group", pin: "chats_helpers.go:563",
		},
		{
			name: "game_invite with no meta", // :623-626
			body: `{"type":"game_invite","content":"x"}`,
			code: 400, msg: "meta.game and meta.room required for a game invite", pin: "chats_helpers.go:624",
		},
		{
			name: "game_invite naming a game that does not exist", // :627-630
			body: `{"type":"game_invite","content":"x","meta":{"game":"poker","room":"abc123"}}`,
			code: 400, msg: "meta.game must be one of chess, rummy, ludo, tictactoe", pin: "chats_helpers.go:628",
		},
		{
			name: "game_invite with a room id that rewrites the URL", // :631-634
			body: `{"type":"game_invite","content":"x","meta":{"game":"chess","room":"../../evil"}}`,
			code: 400, msg: "meta.room is not a room id", pin: "chats_helpers.go:632",
		},
		{
			name: "reaction with no content", // :635-639
			body: `{"type":"reaction"}`,
			code: 400, msg: "content (encrypted reaction) required", pin: "chats_helpers.go:637",
		},
		{
			name: "reaction payload over 4096 runes", // :640-643
			body: fmt.Sprintf(`{"type":"reaction","content":%q}`, strings.Repeat("r", 4097)),
			code: 400, msg: "reaction payload too long", pin: "chats_helpers.go:642",
		},
		{
			name: "poll with no question", // :644-648
			body: `{"type":"poll","meta":{"optionCount":3}}`,
			code: 400, msg: "content (poll question) required", pin: "chats_helpers.go:646",
		},
		{
			name: "poll with one option", // :680-683
			body: `{"type":"poll","content":"q","meta":{"optionCount":1}}`,
			code: 400, msg: "a poll needs between 2 and 10 options", pin: "chats_helpers.go:681",
		},
		{
			name: "poll with eleven options", // :680-683, the upper bound
			body: `{"type":"poll","content":"q","meta":{"optionCount":11}}`,
			code: 400, msg: "a poll needs between 2 and 10 options", pin: "chats_helpers.go:681",
		},
		{
			name: "poll with an empty option string (legacy shape)", // :668-675
			body: `{"type":"poll","content":"q","meta":{"options":["a",""]}}`,
			code: 400, msg: "each option must be a non-empty string ≤ 100 chars", pin: "chats_helpers.go:672",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, res := csSend(t, mux, tc.body)
			if code != tc.code {
				t.Fatalf("status %d, want %d (%s): %v", code, tc.code, tc.pin, res)
			}
			// httpx.Err puts the string in `error`; clients match on it, so the
			// exact text is part of the contract, not a log line.
			if got, _ := res["error"].(string); got != tc.msg {
				t.Errorf("message %q, want %q (%s)", got, tc.msg, tc.pin)
			}
		})
	}

	// THE LADDER RUNS BEFORE THE INSERT (:589-730 precede the transaction at
	// :758). Not one of those refusals may have left a row behind.
	if n := csMsgCount(t, ctx); n != 0 {
		t.Fatalf("%d rows were written by requests the ladder refused", n)
	}
}

// The 1 MB content ceiling at :732-735, which is NOT part of the per-type
// ladder and applies to every type that reached it.
func TestSendContentOverAMegabyteIsRefused(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	csFanOut(t)
	mux := csMux(t)

	code, res := csSend(t, mux, fmt.Sprintf(`{"type":"text","content":%q}`, strings.Repeat("x", 1_000_001)))
	// http.StatusRequestEntityTooLarge — NOT 400. Note the 2 MB httpx body cap
	// (httpx.go) sits further out still; 1_000_001 runes stays under it so this
	// reaches the handler's own check.
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413 (chats_helpers.go:733): %v", code, res)
	}
	if got, _ := res["error"].(string); got != "content too large (max 1 MB)" {
		t.Errorf("message %q, want %q (chats_helpers.go:733)", got, "content too large (max 1 MB)")
	}
	if n := csMsgCount(t, ctx); n != 0 {
		t.Fatalf("an over-size send wrote %d rows", n)
	}
}

// ── 6. transaction atomicity ──────────────────────────────────────────

// db.WithUser (:758) wraps the spine INSERT (:759-771), the chats
// last_message_id/last_message_at update (:811-815) and the chat_members
// un-hide (:816-820) in ONE transaction under the sender's RLS identity. A
// successful 200 therefore means all of them committed, and there is no state
// in which the message exists but the chat list does not show it.
func TestSendCommitsSpineChatPointerAndUnhideTogether(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	csFanOut(t)
	mux := csMux(t)

	// The recipient deleted/hid the chat before the send.
	if err := adminExec(ctx, fmt.Sprintf(
		`UPDATE chat_members SET hidden = TRUE WHERE chat_id = '%s' AND user_id = '%s'`, csChat, csPeer)); err != nil {
		t.Fatalf("hide: %v", err)
	}

	code, res := csSend(t, mux, fmt.Sprintf(`{"type":"text","content":%q}`, csSealed))
	if code != 200 {
		t.Fatalf("send refused: %d %v", code, res)
	}
	id, _ := res["id"].(string)

	// :811-815 — the chat now points at exactly this message, with its timestamp.
	if n := csCount(t, ctx, fmt.Sprintf(
		`SELECT COUNT(*) FROM chats c JOIN messages m ON m.id = c.last_message_id
		  WHERE c.id = '%s' AND m.id::text = '%s' AND c.last_message_at = m.created_at`,
		csChat, id)); n != 1 {
		t.Errorf("chats.last_message_id/last_message_at do not point at the row that was just inserted (:811-815)")
	}
	// :816-820 — the recipient's hidden flag is cleared…
	if n := csCount(t, ctx, fmt.Sprintf(
		`SELECT COUNT(*) FROM chat_members WHERE chat_id = '%s' AND user_id = '%s' AND hidden = FALSE`,
		csChat, csPeer)); n != 1 {
		t.Errorf("the recipient's chat stayed hidden; the un-hide at :816-820 did not commit with the insert")
	}
	// …and the SENDER's row is untouched: the statement carries
	// `user_id <> $2` (:817), so a sender who hid the chat themselves stays hidden.
	if err := adminExec(ctx, fmt.Sprintf(
		`UPDATE chat_members SET hidden = TRUE WHERE chat_id = '%s' AND user_id = '%s'`, csChat, csSender)); err != nil {
		t.Fatalf("hide sender: %v", err)
	}
	if code, res = csSend(t, mux, fmt.Sprintf(`{"type":"text","content":%q}`, csSealed)); code != 200 {
		t.Fatalf("second send refused: %d %v", code, res)
	}
	if n := csCount(t, ctx, fmt.Sprintf(
		`SELECT COUNT(*) FROM chat_members WHERE chat_id = '%s' AND user_id = '%s' AND hidden = TRUE`,
		csChat, csSender)); n != 1 {
		t.Errorf("the sender's own hidden flag was cleared; :817 excludes the sender (`user_id <> $2`)")
	}
}

// A refusal INSIDE the transaction rolls back everything. The reachable case
// without a fault injector is a non-member: chatsRequireMem (:443) refuses
// before the transaction opens, so nothing at all is written and the chat
// pointer is untouched — the same end state a rollback produces.
func TestSendFromANonMemberWritesNothing(t *testing.T) {
	ctx := csSkip(t)
	csSeed(t, ctx)
	csFanOut(t)
	mux := csMux(t)

	if err := adminExec(ctx, fmt.Sprintf(
		`DELETE FROM chat_members WHERE chat_id = '%s' AND user_id = '%s'`, csChat, csSender)); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	code, res := csSend(t, mux, fmt.Sprintf(`{"type":"text","content":%q}`, csSealed))
	if code != 403 {
		t.Fatalf("status %d, want 403 (chats_helpers.go:443): %v", code, res)
	}
	if got, _ := res["error"].(string); got != "Not a member of this chat" {
		t.Errorf("message %q, want %q (chats_helpers.go:443)", got, "Not a member of this chat")
	}
	if n := csMsgCount(t, ctx); n != 0 {
		t.Fatalf("a non-member wrote %d rows", n)
	}
}

// ── task 2.2: the CC-Wire loopback against the REAL mux ───────────────

// Nothing wires SetCCWireRoutes to the real `cw` mux today — every test in
// internal/realtime installs `fakeRoutes` (ccwire_messages_test.go:33-51), so
// the loopback and the handler meet only in production. This test is the only
// place the two are joined: RegisterChats builds the real cw mux and hands it to
// realtime (chats.go:97-106, registered ONLY when realtime.CCWireEnabled()), a
// real CC-Wire session is opened over a real WebSocket upgrade, and the
// SubmitMessage it sends must come out the other side as a row written by
// chatsMessagePost — having passed the same gates an HTTP send passes.

func csDial(t *testing.T, srv *httptest.Server, uid string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + realtime.CCWirePath
	c, resp, err := websocket.DefaultDialer.Dial(url, http.Header{
		"Authorization": {"Bearer " + tokenFor(t, uid)},
	})
	if err != nil {
		t.Fatalf("ccwire upgrade failed (%v): %v", resp, err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func csFrame(t *testing.T, m ccwire.Message) []byte {
	t.Helper()
	payload, err := ccwire.EncodeMessage(m, ccwire.DefaultLimits(), 0)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := ccwire.Encode(payload, ccwire.Options{})
	if err != nil {
		t.Fatalf("frame: %v", err)
	}
	return out
}

func csRead(t *testing.T, c *websocket.Conn) ccwire.Message {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, buf, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	fr, err := ccwire.Decode(buf, ccwire.Options{Strict: true})
	if err != nil {
		t.Fatalf("undecodable frame: %v", err)
	}
	m, err := ccwire.DecodeMessage(fr.Payload, ccwire.DefaultLimits(), 0, 0)
	if err != nil {
		t.Fatalf("undecodable message: %v", err)
	}
	return m
}

// csAckID reads Ack.message_id (field 1, length-delimited). Ids are short
// decimal BIGINTs, so the single-byte length form is the only one that occurs;
// anything else is a wire change this test should notice.
func csAckID(t *testing.T, m ccwire.Message) string {
	t.Helper()
	if m.BodyField != ccwire.BodyAck {
		t.Fatalf("expected an Ack, got body field %d (%x)", m.BodyField, m.Body)
	}
	if len(m.Body) < 2 || m.Body[0] != 0x0a || int(m.Body[1])+2 > len(m.Body) {
		t.Fatalf("Ack body is not a single string field 1: %x", m.Body)
	}
	return string(m.Body[2 : 2+int(m.Body[1])])
}

func csSubmitFrame(t *testing.T, chatID, clientMsgID, sealed string) []byte {
	t.Helper()
	// envelope: field 1 chat_id, field 3 client_msg_id; body: field 1 envelope,
	// field 2 sealed (ccwire_messages_test.go:115-120 builds the same shape).
	env := ccwire.AppendStringField(nil, 1, chatID)
	env = ccwire.AppendStringField(env, 3, clientMsgID)
	body := ccwire.AppendBytesField(nil, 1, env)
	body = ccwire.AppendBytesField(body, 2, []byte(sealed))
	return csFrame(t, ccwire.Message{
		RequestID:    "cs-req",
		TrafficClass: ccwire.TrafficClassMessaging,
		BodyField:    ccwire.BodySubmitMessage,
		Body:         body,
	})
}

func TestCCWireSubmitReachesTheRealSendHandler(t *testing.T) {
	ctx := csSkip(t)
	// chats.go:105 — the cw mux exists only with the flag on, and
	// realtime.RegisterCCWire (ccwire.go:64-69) mounts the listener on the same
	// condition. Setting it is what joins the two halves.
	t.Setenv("CCWIRE_WS", "1")
	if !realtime.CCWireEnabled() {
		t.Fatal("CCWIRE_WS=1 did not enable CC-Wire; chats.go:105 would not register the loopback mux")
	}
	csSeed(t, ctx)
	events := csFanOut(t)

	pub := http.NewServeMux()
	RegisterChats(pub) // installs the REAL cw mux into realtime (chats.go:106)
	t.Cleanup(func() { realtime.SetCCWireRoutes(nil) })
	realtime.RegisterCCWire(pub, realtime.New())
	srv := httptest.NewServer(pub)
	t.Cleanup(srv.Close)

	c := csDial(t, srv, csSender)
	if err := c.WriteMessage(websocket.BinaryMessage, csFrame(t, ccwire.Message{
		TrafficClass: ccwire.TrafficClassControl,
		BodyField:    ccwire.BodyClientHello,
	})); err != nil {
		t.Fatalf("ClientHello: %v", err)
	}
	if m := csRead(t, c); m.BodyField != ccwire.BodyServerHello {
		t.Fatalf("expected ServerHello, got body field %d", m.BodyField)
	}

	// ── the submission ──
	if err := c.WriteMessage(websocket.BinaryMessage, csSubmitFrame(t, csChat, "cs-cw-1", csSealed)); err != nil {
		t.Fatalf("submit: %v", err)
	}
	id := csAckID(t, csRead(t, c))
	if id == "" {
		t.Fatal("Ack carried no server-assigned id")
	}

	// It was written by chatsMessagePost: the row exists, carries the
	// AUTHENTICATED sender (never anything off the payload — SubmitMessage has no
	// such field, ccwire_messages.go:22-25) and the type the loopback hard-codes
	// (ccwire_messages.go:204).
	if n := csCount(t, ctx, fmt.Sprintf(
		`SELECT COUNT(*) FROM messages WHERE chat_id = '%s' AND id::text = '%s'
		   AND sender_id = '%s' AND type = 'text' AND client_id = 'cs-cw-1'`,
		csChat, id, csSender)); n != 1 {
		t.Fatalf("no row matching the Ack id %s was written by the real handler", id)
	}
	// :869 — the fan-out at the end of the REST handler is what a CC-Wire send
	// inherits; there is no second broadcast in internal/realtime.
	if e := csAwaitEvent(t, events, "ccwire submit"); e.payload["id"] != id {
		t.Errorf("fan-out carried %v, Ack carried %s", e.payload["id"], id)
	}

	// ── the ON CONFLICT gate is inherited, not re-implemented ──
	if err := c.WriteMessage(websocket.BinaryMessage, csSubmitFrame(t, csChat, "cs-cw-1", csSealed)); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if again := csAckID(t, csRead(t, c)); again != id {
		t.Errorf("retry Ack id %s != %s — chats_helpers.go:769 did not deduplicate the CC-Wire retry", again, id)
	}
	if n := csMsgCount(t, ctx); n != 1 {
		t.Fatalf("messages rows = %d after a CC-Wire retry, want 1", n)
	}
}

// The membership gate reaches CC-Wire only because the submission runs through
// chatsRequireMem (chats_helpers.go:443) inside the handler. A non-member's
// submit must come back as an Error frame, not an Ack, and must write nothing.
func TestCCWireSubmitInheritsTheMembershipRefusal(t *testing.T) {
	ctx := csSkip(t)
	t.Setenv("CCWIRE_WS", "1")
	csSeed(t, ctx)
	csFanOut(t)

	if err := adminExec(ctx, fmt.Sprintf(
		`DELETE FROM chat_members WHERE chat_id = '%s' AND user_id = '%s'`, csChat, csSender)); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	pub := http.NewServeMux()
	RegisterChats(pub)
	t.Cleanup(func() { realtime.SetCCWireRoutes(nil) })
	realtime.RegisterCCWire(pub, realtime.New())
	srv := httptest.NewServer(pub)
	t.Cleanup(srv.Close)

	c := csDial(t, srv, csSender)
	if err := c.WriteMessage(websocket.BinaryMessage, csFrame(t, ccwire.Message{
		TrafficClass: ccwire.TrafficClassControl,
		BodyField:    ccwire.BodyClientHello,
	})); err != nil {
		t.Fatalf("ClientHello: %v", err)
	}
	csRead(t, c) // ServerHello

	if err := c.WriteMessage(websocket.BinaryMessage, csSubmitFrame(t, csChat, "cs-cw-deny", csSealed)); err != nil {
		t.Fatalf("submit: %v", err)
	}
	// ccwire_messages.go:222-226 maps the REST status to an error code and does
	// NOT echo the REST error string.
	if m := csRead(t, c); m.BodyField != ccwire.BodyError {
		t.Fatalf("a non-member's submit produced body field %d, want an Error", m.BodyField)
	}
	if n := csMsgCount(t, ctx); n != 0 {
		t.Fatalf("a non-member's CC-Wire submit wrote %d rows", n)
	}
}
