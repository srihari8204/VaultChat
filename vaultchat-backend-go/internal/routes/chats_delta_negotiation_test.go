// chats_delta_negotiation_test.go — GET /chats/delta answers the same page in
// two representations, and the JSON one did not move.
//
// /chats/delta is the highest-consequence payload in the app: it carries the
// rows AND the cursor that decides what is fetched next. So the exact JSON
// bytes are pinned (map-literal key order and trailing newline included) for
// the Accept headers real clients send, presence is asserted per field in BOTH
// directions, and meta is proven to survive a large integer — the reason
// google.protobuf.Struct was rejected.
//
// The database is not involved: chatsDeltaWrite is the whole negotiation, and
// it is driven here with fixed rows.
package routes

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	ccwirev1 "vaultchat/backend-go/internal/ccwire/gen/ccwire/v1"
	"vaultchat/backend-go/internal/httpx"

	"google.golang.org/protobuf/proto"
)

func deltaTime(s string) httpx.JSTime {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return httpx.JSTime(t)
}

// Three rows covering every presence case:
//   - a fully populated row (meta carries an integer past 2^53, the case Struct
//     would have rounded),
//   - a bare row: content, meta, replyTo and all three optional times null,
//   - a soft-deleted-ish row with content "" — a VALUE, not absence.
func chatsDeltaFixture() []chatsPublicMsg {
	return []chatsPublicMsg{
		{
			ID: "9412", ChatID: "chat_direct", SenderID: "u1", Type: "text",
			Content: strptr("AAECAwQ="),
			Meta: json.RawMessage(
				`{"attachmentId":9007199254740993,"mime":"image/png","private":{"k":"v"}}`),
			ReplyToID: strptr("9400"),
			EditedAt:  jst("2026-03-04T06:00:00.123Z"),
			DeletedAt: nil,
			CreatedAt: deltaTime("2026-03-04T05:06:07.890Z"),
			ExpiresAt: jst("2026-03-05T00:00:00.000Z"),

			VanishAfterRead: true,
		},
		{
			ID: "9413", ChatID: "chat_group", SenderID: "u2", Type: "system",
			CreatedAt: deltaTime("2026-03-04T05:06:08.000Z"),
		},
		{
			ID: "9414", ChatID: "chat_group", SenderID: "u3", Type: "text",
			Content:   strptr(""),
			CreatedAt: deltaTime("2026-03-04T05:06:09.500Z"),
			DeletedAt: jst("2026-03-04T05:07:00.000Z"),
		},
	}
}

func getChatsDelta(t *testing.T, accept string, messages, mutations []chatsPublicMsg) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/chats/delta?since=9400", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	chatsDeltaWrite(w, r, messages, 9414, true, "c1.abc", mutations, "m1.def",
		deltaTime("2026-03-04T05:06:10.000Z"))
	return w
}

func chatsDeltaCall(t *testing.T, accept string) *httptest.ResponseRecorder {
	return getChatsDelta(t, accept, chatsDeltaFixture(), chatsDeltaFixture()[1:2])
}

// Hand-written from chatsPublicMsg's json tags and the handler's map literal —
// NOT captured from the serializer. encoding/json sorts map keys, so the object
// order is messages, more, mutations, nextMutationCursor, nextSince,
// serverTime, syncContinuation. nextSince is a BARE NUMBER.
const legacyChatsDeltaMsgs = `{"id":"9412","chatId":"chat_direct","senderId":"u1","type":"text",` +
	`"content":"AAECAwQ=","meta":{"attachmentId":9007199254740993,"mime":"image/png",` +
	`"private":{"k":"v"}},"replyToId":"9400","editedAt":"2026-03-04T06:00:00.123Z",` +
	`"deletedAt":null,"createdAt":"2026-03-04T05:06:07.890Z",` +
	`"expiresAt":"2026-03-05T00:00:00.000Z","vanishAfterRead":true},` +
	`{"id":"9413","chatId":"chat_group","senderId":"u2","type":"system","content":null,` +
	`"meta":null,"replyToId":null,"editedAt":null,"deletedAt":null,` +
	`"createdAt":"2026-03-04T05:06:08.000Z","expiresAt":null,"vanishAfterRead":false},` +
	`{"id":"9414","chatId":"chat_group","senderId":"u3","type":"text","content":"",` +
	`"meta":null,"replyToId":null,"editedAt":null,"deletedAt":"2026-03-04T05:07:00.000Z",` +
	`"createdAt":"2026-03-04T05:06:09.500Z","expiresAt":null,"vanishAfterRead":false}`

const legacyChatsDeltaJSON = `{"messages":[` + legacyChatsDeltaMsgs + `],"more":true,` +
	`"mutations":[{"id":"9413","chatId":"chat_group","senderId":"u2","type":"system",` +
	`"content":null,"meta":null,"replyToId":null,"editedAt":null,"deletedAt":null,` +
	`"createdAt":"2026-03-04T05:06:08.000Z","expiresAt":null,"vanishAfterRead":false}],` +
	`"nextMutationCursor":"m1.def","nextSince":9414,` +
	`"serverTime":"2026-03-04T05:06:10.000Z","syncContinuation":"c1.abc"}` + "\n"

func TestChatsDeltaJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := chatsDeltaCall(t, accept)
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyChatsDeltaJSON {
			t.Errorf("Accept %q: body changed\n got %s\nwant %s", accept, got, legacyChatsDeltaJSON)
		}
	}
}

func decodeChatsDelta(t *testing.T, w *httptest.ResponseRecorder) *ccwirev1.DeltaReply {
	t.Helper()
	var reply ccwirev1.DeltaReply
	if err := proto.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("response is not a valid DeltaReply: %v", err)
	}
	return &reply
}

func TestChatsDeltaProtobufSameValues(t *testing.T) {
	w := chatsDeltaCall(t, protobufMediaType)
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	bare := &ccwirev1.DeltaMessage{
		Id: 9413, ChatId: "chat_group", SenderId: "u2", Type: "system",
		CreatedAt: "2026-03-04T05:06:08.000Z",
	}
	want := &ccwirev1.DeltaReply{
		Messages: []*ccwirev1.DeltaMessage{
			{
				Id: 9412, ChatId: "chat_direct", SenderId: "u1", Type: "text",
				Content: strptr("AAECAwQ="),
				MetaJson: []byte(
					`{"attachmentId":9007199254740993,"mime":"image/png","private":{"k":"v"}}`),
				ReplyToId:       i64ptr(9400),
				EditedAt:        strptr("2026-03-04T06:00:00.123Z"),
				CreatedAt:       "2026-03-04T05:06:07.890Z",
				ExpiresAt:       strptr("2026-03-05T00:00:00.000Z"),
				VanishAfterRead: true,
			},
			bare,
			{
				Id: 9414, ChatId: "chat_group", SenderId: "u3", Type: "text",
				Content: strptr(""), DeletedAt: strptr("2026-03-04T05:07:00.000Z"),
				CreatedAt: "2026-03-04T05:06:09.500Z",
			},
		},
		NextSince: 9414, More: true, SyncContinuation: "c1.abc",
		Mutations:          []*ccwirev1.DeltaMessage{bare},
		NextMutationCursor: "m1.def",
		ServerTime:         "2026-03-04T05:06:10.000Z",
	}
	if got := decodeChatsDelta(t, w); !proto.Equal(got, want) {
		t.Errorf("decoded reply = %v\nwant %v", got, want)
	}
}

// PRESENCE, per field, both directions. proto.Equal above would still pass if
// BOTH sides had been flattened together.
func TestChatsDeltaPresencePerField(t *testing.T) {
	reply := decodeChatsDelta(t, chatsDeltaCall(t, protobufMediaType))
	if len(reply.Messages) != 3 {
		t.Fatalf("got %d messages, want 3", len(reply.Messages))
	}
	full, bare, empty := reply.Messages[0], reply.Messages[1], reply.Messages[2]

	for name, p := range map[string]*string{
		"content":   bare.Content,
		"edited_at": bare.EditedAt, "deleted_at": bare.DeletedAt,
		"expires_at": bare.ExpiresAt, "full.deleted_at": full.DeletedAt,
		"empty.edited_at": empty.EditedAt, "empty.expires_at": empty.ExpiresAt,
	} {
		if p != nil {
			t.Errorf("%s: null must be absent, got %q", name, *p)
		}
	}
	if bare.MetaJson != nil {
		t.Errorf("meta_json: null meta must be absent, got %q", bare.MetaJson)
	}
	if bare.ReplyToId != nil {
		t.Errorf("reply_to_id: null must be absent, got %d", *bare.ReplyToId)
	}

	// "" is present-and-empty: a real state, different from absent.
	if empty.Content == nil || *empty.Content != "" {
		t.Errorf("empty content must be present-and-empty, got %v", empty.Content)
	}

	// The other direction: present values survive.
	for name, p := range map[string]*string{
		"content": full.Content, "edited_at": full.EditedAt, "expires_at": full.ExpiresAt,
		"empty.deleted_at": empty.DeletedAt,
	} {
		if p == nil {
			t.Errorf("%s: a present value went missing", name)
		}
	}
	if full.ReplyToId == nil || *full.ReplyToId != 9400 {
		t.Errorf("reply_to_id = %v, want 9400", full.ReplyToId)
	}

	// Never-null fields are NOT optional: the bare row really carries these, and
	// they must decode as values rather than as absence.
	if bare.CreatedAt != "2026-03-04T05:06:08.000Z" || bare.VanishAfterRead ||
		bare.Id != 9413 || bare.ChatId != "chat_group" || bare.SenderId != "u2" ||
		bare.Type != "system" {
		t.Errorf("always-present fields wrong on the bare row: %v", bare)
	}

	// Opaque cursors travel verbatim, never parsed.
	if reply.SyncContinuation != "c1.abc" || reply.NextMutationCursor != "m1.def" {
		t.Errorf("opaque cursors changed: %q / %q",
			reply.SyncContinuation, reply.NextMutationCursor)
	}
	if reply.NextSince != 9414 {
		t.Errorf("next_since = %d, want 9414", reply.NextSince)
	}
}

// META. The field's contract is "the exact JSON bytes", so the bytes must be
// the bytes the JSON path emits — including an integer past 2^53, which
// google.protobuf.Struct (double-only) would have rounded to ...992.
func TestChatsDeltaMetaExactBytes(t *testing.T) {
	reply := decodeChatsDelta(t, chatsDeltaCall(t, protobufMediaType))
	const want = `{"attachmentId":9007199254740993,"mime":"image/png","private":{"k":"v"}}`
	if got := string(reply.Messages[0].MetaJson); got != want {
		t.Errorf("meta_json = %s\n     want %s", got, want)
	}

	// Precision, proven rather than asserted: decode with json.Number so the
	// test itself cannot be the thing that rounds.
	dec := json.NewDecoder(bytes.NewReader(reply.Messages[0].MetaJson))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatalf("meta_json is not JSON: %v", err)
	}
	if n, _ := m["attachmentId"].(json.Number); n.String() != "9007199254740993" {
		t.Errorf("attachmentId = %v, want 9007199254740993 exactly", m["attachmentId"])
	}
	// What Struct would have done to it: its only number type is double.
	if int64(float64(9007199254740993)) != 9007199254740992 {
		t.Fatal("the double round-trip assumption behind THE meta DECISION no longer holds")
	}

	// A map meta (the shape pgx actually produces) round-trips byte-exactly
	// against the JSON path's own encoding of the same value.
	rows := chatsDeltaFixture()[:1]
	rows[0].Meta = map[string]any{"b": 2, "a": "x"}
	pb := decodeChatsDelta(t, getChatsDelta(t, protobufMediaType, rows, nil))
	var js struct {
		Messages []struct {
			Meta json.RawMessage `json:"meta"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(getChatsDelta(t, "application/json", rows, nil).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if string(pb.Messages[0].MetaJson) != string(js.Messages[0].Meta) {
		t.Errorf("meta bytes differ: typed %s vs json %s",
			pb.Messages[0].MetaJson, js.Messages[0].Meta)
	}
}

// An id that cannot be parsed is a SERVER BUG. `id` is required, so there is no
// honest typed rendering: 0 is a value a client would act on and dropping the
// row would lose a message from a catch-up page. The whole reply degrades to
// JSON, which ships the raw string as it always has.
func TestChatsDeltaUnparseableIDFallsBackToJSON(t *testing.T) {
	rows := chatsDeltaFixture()[:1]
	rows[0].ID = "not-a-number"
	w := getChatsDelta(t, protobufMediaType, rows, nil)
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type %q, want the JSON one", ct)
	}
	var js map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if got := js["messages"].([]any)[0].(map[string]any)["id"]; got != "not-a-number" {
		t.Errorf("legacy JSON changed: %#v", got)
	}

	// reply_to_id is OPTIONAL, so a corrupt one is simply absent — the reply
	// stays typed and no other row is punished for it.
	rows = chatsDeltaFixture()[:1]
	rows[0].ReplyToID = strptr("not-a-number")
	pb := getChatsDelta(t, protobufMediaType, rows, nil)
	if ct := pb.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("a corrupt reply_to_id must not drop the typed path, got %q", ct)
	}
	if got := decodeChatsDelta(t, pb); got.Messages[0].ReplyToId != nil {
		t.Errorf("unparseable reply_to_id must be absent, got %d", *got.Messages[0].ReplyToId)
	}
}

// An empty page is the steady state of a connected client: zero rows,
// more=false, and the JSON still `[]` rather than null.
func TestChatsDeltaEmptyPage(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/chats/delta?since=9414", nil)
	w := httptest.NewRecorder()
	chatsDeltaWrite(w, r, []chatsPublicMsg{}, 9414, false, "", []chatsPublicMsg{}, "",
		deltaTime("2026-03-04T05:06:10.000Z"))
	const want = `{"messages":[],"more":false,"mutations":[],"nextMutationCursor":"",` +
		`"nextSince":9414,"serverTime":"2026-03-04T05:06:10.000Z","syncContinuation":""}` + "\n"
	if got := w.Body.String(); got != want {
		t.Errorf("empty page JSON = %s\n                want %s", got, want)
	}

	r = httptest.NewRequest(http.MethodGet, "/chats/delta?since=9414", nil)
	r.Header.Set("Accept", protobufMediaType)
	w = httptest.NewRecorder()
	chatsDeltaWrite(w, r, []chatsPublicMsg{}, 9414, false, "", []chatsPublicMsg{}, "",
		deltaTime("2026-03-04T05:06:10.000Z"))
	reply := decodeChatsDelta(t, w)
	if len(reply.Messages) != 0 || len(reply.Mutations) != 0 || reply.More ||
		reply.NextSince != 9414 || reply.SyncContinuation != "" ||
		reply.NextMutationCursor != "" {
		t.Errorf("empty page decoded wrong: %v", reply)
	}
}

// CROSS-LANGUAGE BYTE PIN. One fixed reply, its exact wire bytes. Pinning the
// bytes rather than only the semantics is what makes Go and TypeScript one
// contract instead of two independent readings of the schema: semantic
// agreement alone would let them drift onto different field numbers and both
// still "pass". lib/chatsDeltaProto.selftest.ts §0b rebuilds this same reply
// with its own hand-rolled writer and asserts this same hex (GO_GOLDEN_WIRE
// there), character for character — so a change on either side breaks both.
//
// 0a3e messages[0], 62 bytes: 08 c449 id=9412 (#1), 1203"c_1" chat_id,
// 1a02"u1" sender_id, 2204"text" type, 2a02"hi" content (#5), 3207{"a":1} the
// meta JSON bytes verbatim (#6), 38 b849 reply_to_id=9400 (#7), 5218<iso>
// created_at (#10), 6001 vanish_after_read (#12). Then the reply's own fields:
// 10 c649 next_since=9414 (#2), 1801 more (#3), 2203"c1." sync_continuation
// (#4), 3203"m1." next_mutation_cursor (#6), 3a18<iso> server_time (#7).
// Absent by design and therefore not on the wire at all: edited_at, deleted_at,
// expires_at, and mutations (empty).
func chatsDeltaPinRows() []chatsPublicMsg {
	return []chatsPublicMsg{{
		ID: "9412", ChatID: "c_1", SenderID: "u1", Type: "text",
		Content:   strptr("hi"),
		Meta:      json.RawMessage(`{"a":1}`),
		ReplyToID: strptr("9400"),
		CreatedAt: deltaTime("2026-03-04T05:06:07.890Z"),

		VanishAfterRead: true,
	}}
}

const chatsDeltaGoldenWire = "0a3e08c4491203635f311a0275312204746578742a02686932077b2261223a317d38b849" +
	"5218323032362d30332d30345430353a30363a30372e3839305a600110c6491801220363312e32036d312e" +
	"3a18323032362d30332d30345430353a30363a31302e3030305a"

func TestChatsDeltaWireBytePin(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/chats/delta?since=9400", nil)
	r.Header.Set("Accept", protobufMediaType)
	w := httptest.NewRecorder()
	chatsDeltaWrite(w, r, chatsDeltaPinRows(), 9414, true, "c1.", nil, "m1.",
		deltaTime("2026-03-04T05:06:10.000Z"))
	if got := hex.EncodeToString(w.Body.Bytes()); got != chatsDeltaGoldenWire {
		t.Errorf("wire bytes = %s\n          want %s", got, chatsDeltaGoldenWire)
	}
}
