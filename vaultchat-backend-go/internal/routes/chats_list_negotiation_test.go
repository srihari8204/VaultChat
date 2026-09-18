// chats_list_negotiation_test.go — GET /chats answers the same chats in two
// representations, and the JSON one did not move.
//
// The risk is not "does protobuf encode". It is that a content negotiation
// added to the busiest list endpoint changes what every existing client
// receives, or that the typed path quietly invents a state the JSON path has
// never had (a null flattened to "" or 0). So: the exact JSON bytes are pinned
// for the Accept headers real clients send, and presence is asserted per field
// in BOTH directions.
//
// The database is not involved: chatsListWrite is the whole negotiation, and it
// is driven here with fixed rows.
package routes

import (
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

func i64ptr(n int64) *int64 { return &n }

func jst(s string) *httpx.JSTime {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return httpx.JST(&t)
}

// Three rows, chosen so every presence case is exercised:
//   - a direct chat with everything populated (and the id asymmetry: a string
//     lastMessageId of "9412" next to a numeric peerLastReadMessageId of 9410),
//   - a group chat where every peer field and every id is null,
//   - a masked-anon row carrying "" where a null could have been, so a test
//     that confused absent with empty fails.
func chatsListFixture() []chatsListItem {
	return []chatsListItem{
		{
			ID: "chat_direct", Type: "direct",
			Name: strptr("Direct"), PhotoURL: strptr("https://cdn.test/d.png"),
			CreatedBy: strptr("u1"),
			CreatedAt: httpx.JSTime(time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)),
			UpdatedAt: httpx.JSTime(time.Date(2026, 3, 4, 6, 0, 0, 0, time.UTC)),
			// The asymmetry: JSON string here, JSON number below.
			LastMessageID: strptr("9412"),
			LastMessageAt: jst("2026-03-04T06:00:00.123Z"),
			MyRole:        "member", MyLastReadID: strptr("9400"),
			Muted: true, Pinned: true, Favourite: false, Archived: false, Hidden: false,
			ScreenshotMode: "block", VanishMode: true, UnreadCount: 12,
			PeerUserID: strptr("u2"), PeerName: strptr("Peer"),
			PeerPhotoURL: strptr("https://cdn.test/p.png"),
			PeerOnline:   true, PeerLastSeenAt: jst("2026-03-04T05:59:00.000Z"),
			PeerLastReadMessageID:      i64ptr(9410),
			PeerLastDeliveredMessageID: i64ptr(9412),
			AnonMasked:                 false,
			ExpiresAt:                  jst("2026-03-05T00:00:00.000Z"),
		},
		{
			// Group: every optional field null. Nothing here may become "" or 0.
			ID: "chat_group", Type: "group",
			CreatedAt: httpx.JSTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
			UpdatedAt: httpx.JSTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
			MyRole:    "admin", ScreenshotMode: "allow",
			UnreadCount: 0,
		},
		{
			// "" is a VALUE, not absence: present-and-empty on the wire.
			ID: "chat_anon", Type: "direct",
			Name:      strptr(""),
			CreatedAt: httpx.JSTime(time.Date(2026, 2, 2, 2, 2, 2, 2000000, time.UTC)),
			UpdatedAt: httpx.JSTime(time.Date(2026, 2, 2, 2, 2, 2, 2000000, time.UTC)),
			MyRole:    "member", ScreenshotMode: "block",
			PeerUserID: strptr("u9"), PeerName: strptr(chatsAnonName),
			AnonMasked: true, UnreadCount: 3,
		},
	}
}

func getChatsList(t *testing.T, accept string, rows []chatsListItem) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/chats", nil)
	if accept != "" {
		r.Header.Set("Accept", accept)
	}
	w := httptest.NewRecorder()
	chatsListWrite(w, r, rows)
	return w
}

// Hand-written from chatsListItem's json tags and the current handler — NOT
// captured from the serializer. It fails if userBigStr is "fixed", if a null
// becomes "", or if JSTime drops its milliseconds. Note the BARE ARRAY: the
// ChatListReply envelope must not leak into the JSON shape.
const legacyChatsListJSON = `[` +
	`{"id":"chat_direct","type":"direct","name":"Direct","photoURL":"https://cdn.test/d.png",` +
	`"createdBy":"u1","createdAt":"2026-03-04T05:06:07.890Z","updatedAt":"2026-03-04T06:00:00.000Z",` +
	`"lastMessageId":"9412","lastMessageAt":"2026-03-04T06:00:00.123Z","myRole":"member",` +
	`"myLastReadId":"9400","muted":true,"pinned":true,"favourite":false,"archived":false,` +
	`"hidden":false,"screenshotMode":"block","vanishMode":true,"unreadCount":12,` +
	`"peerUserId":"u2","peerName":"Peer","peerPhotoURL":"https://cdn.test/p.png","peerOnline":true,` +
	`"peerLastSeenAt":"2026-03-04T05:59:00.000Z","peerLastReadMessageId":9410,` +
	`"peerLastDeliveredMessageId":9412,"anonMasked":false,"expiresAt":"2026-03-05T00:00:00.000Z"},` +
	`{"id":"chat_group","type":"group","name":null,"photoURL":null,"createdBy":null,` +
	`"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z",` +
	`"lastMessageId":null,"lastMessageAt":null,"myRole":"admin","myLastReadId":null,` +
	`"muted":false,"pinned":false,"favourite":false,"archived":false,"hidden":false,` +
	`"screenshotMode":"allow","vanishMode":false,"unreadCount":0,"peerUserId":null,` +
	`"peerName":null,"peerPhotoURL":null,"peerOnline":false,"peerLastSeenAt":null,` +
	`"peerLastReadMessageId":null,"peerLastDeliveredMessageId":null,"anonMasked":false,` +
	`"expiresAt":null},` +
	`{"id":"chat_anon","type":"direct","name":"","photoURL":null,"createdBy":null,` +
	`"createdAt":"2026-02-02T02:02:02.002Z","updatedAt":"2026-02-02T02:02:02.002Z",` +
	`"lastMessageId":null,"lastMessageAt":null,"myRole":"member","myLastReadId":null,` +
	`"muted":false,"pinned":false,"favourite":false,"archived":false,"hidden":false,` +
	`"screenshotMode":"block","vanishMode":false,"unreadCount":3,"peerUserId":"u9",` +
	`"peerName":"` + chatsAnonName + `","peerPhotoURL":null,"peerOnline":false,` +
	`"peerLastSeenAt":null,"peerLastReadMessageId":null,"peerLastDeliveredMessageId":null,` +
	`"anonMasked":true,"expiresAt":null}` +
	`]` + "\n"

func TestChatsListJSONUnchangedWithoutNegotiation(t *testing.T) {
	for _, accept := range []string{
		"",
		"application/json",
		"*/*",
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	} {
		w := getChatsList(t, accept, chatsListFixture())
		if w.Code != 200 {
			t.Fatalf("Accept %q: status %d, want 200", accept, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
			t.Errorf("Accept %q: Content-Type %q, want the JSON one", accept, ct)
		}
		if got := w.Body.String(); got != legacyChatsListJSON {
			t.Errorf("Accept %q: body changed\n got %s\nwant %s", accept, got, legacyChatsListJSON)
		}
	}
}

func decodeChatsList(t *testing.T, w *httptest.ResponseRecorder) *ccwirev1.ChatListReply {
	t.Helper()
	var reply ccwirev1.ChatListReply
	if err := proto.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("response is not a valid ChatListReply: %v", err)
	}
	return &reply
}

func TestChatsListProtobufSameValues(t *testing.T) {
	w := getChatsList(t, protobufMediaType, chatsListFixture())
	if w.Code != 200 {
		t.Fatalf("status %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != protobufMediaType {
		t.Fatalf("Content-Type %q, want %s", ct, protobufMediaType)
	}
	got := decodeChatsList(t, w)
	want := &ccwirev1.ChatListReply{Chats: []*ccwirev1.ChatSummary{
		{
			Id: "chat_direct", Type: "direct", Name: strptr("Direct"),
			PhotoUrl: strptr("https://cdn.test/d.png"), CreatedBy: strptr("u1"),
			CreatedAt: "2026-03-04T05:06:07.890Z", UpdatedAt: "2026-03-04T06:00:00.000Z",
			LastMessageId: i64ptr(9412), LastMessageAt: strptr("2026-03-04T06:00:00.123Z"),
			MyRole: "member", MyLastReadId: i64ptr(9400),
			Muted: true, Pinned: true, ScreenshotMode: "block", VanishMode: true,
			UnreadCount: 12, PeerUserId: strptr("u2"), PeerName: strptr("Peer"),
			PeerPhotoUrl: strptr("https://cdn.test/p.png"), PeerOnline: true,
			PeerLastSeenAt:        strptr("2026-03-04T05:59:00.000Z"),
			PeerLastReadMessageId: i64ptr(9410), PeerLastDeliveredMessageId: i64ptr(9412),
			ExpiresAt: strptr("2026-03-05T00:00:00.000Z"),
		},
		{
			Id: "chat_group", Type: "group",
			CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
			MyRole: "admin", ScreenshotMode: "allow",
		},
		{
			Id: "chat_anon", Type: "direct", Name: strptr(""),
			CreatedAt: "2026-02-02T02:02:02.002Z", UpdatedAt: "2026-02-02T02:02:02.002Z",
			MyRole: "member", ScreenshotMode: "block", UnreadCount: 3,
			PeerUserId: strptr("u9"), PeerName: strptr(chatsAnonName), AnonMasked: true,
		},
	}}
	if !proto.Equal(got, want) {
		t.Errorf("decoded reply = %v\nwant %v", got, want)
	}
}

// PRESENCE, asserted per field. proto.Equal above would still pass if BOTH
// sides had been flattened together, so absence is checked directly — and so is
// the opposite direction: a value that exists must not go missing.
func TestChatsListPresencePerField(t *testing.T) {
	reply := decodeChatsList(t, getChatsList(t, protobufMediaType, chatsListFixture()))
	if len(reply.Chats) != 3 {
		t.Fatalf("got %d chats, want 3", len(reply.Chats))
	}
	full, group, anon := reply.Chats[0], reply.Chats[1], reply.Chats[2]

	// Every optional field, nil in the fixture, must be ABSENT — not "" or 0.
	absentStr := map[string]*string{
		"name": group.Name, "photo_url": group.PhotoUrl, "created_by": group.CreatedBy,
		"last_message_at": group.LastMessageAt, "peer_user_id": group.PeerUserId,
		"peer_name": group.PeerName, "peer_photo_url": group.PeerPhotoUrl,
		"peer_last_seen_at": group.PeerLastSeenAt, "expires_at": group.ExpiresAt,
		"anon.photo_url": anon.PhotoUrl, "anon.created_by": anon.CreatedBy,
	}
	for name, p := range absentStr {
		if p != nil {
			t.Errorf("%s: null must be absent, got %q", name, *p)
		}
	}
	absentID := map[string]*int64{
		"last_message_id": group.LastMessageId, "my_last_read_id": group.MyLastReadId,
		"peer_last_read_message_id":      group.PeerLastReadMessageId,
		"peer_last_delivered_message_id": group.PeerLastDeliveredMessageId,
		"anon.last_message_id":           anon.LastMessageId,
	}
	for name, p := range absentID {
		if p != nil {
			t.Errorf("%s: null must be absent, got %d", name, *p)
		}
	}

	// "" is present-and-empty, which is a DIFFERENT state from absent.
	if anon.Name == nil || *anon.Name != "" {
		t.Errorf("an empty name must be present-and-empty, got %v", anon.Name)
	}

	// And the other direction: present values survive.
	for name, p := range map[string]*string{
		"name": full.Name, "photo_url": full.PhotoUrl, "created_by": full.CreatedBy,
		"last_message_at": full.LastMessageAt, "peer_user_id": full.PeerUserId,
		"peer_name": full.PeerName, "peer_photo_url": full.PeerPhotoUrl,
		"peer_last_seen_at": full.PeerLastSeenAt, "expires_at": full.ExpiresAt,
	} {
		if p == nil {
			t.Errorf("%s: a present value went missing", name)
		}
	}

	// The collapsed fields are NOT optional: a false/0/"block" is a value the
	// group row really carries, and it must decode as such rather than as
	// absence. (Generated Go gives these no pointer at all, which is the point —
	// this asserts the schema did not drift to optional.)
	if group.PeerOnline || group.UnreadCount != 0 || group.ScreenshotMode != "allow" {
		t.Errorf("collapsed fields wrong: online=%v unread=%d mode=%q",
			group.PeerOnline, group.UnreadCount, group.ScreenshotMode)
	}
}

// The id asymmetry, both halves in one row: a JSON string of "9412" and a JSON
// number of 9410 must both land as int64 on the wire, while the legacy JSON
// keeps emitting one as a string and the other as a number.
func TestChatsListIDAsymmetry(t *testing.T) {
	reply := decodeChatsList(t, getChatsList(t, protobufMediaType, chatsListFixture()))
	c := reply.Chats[0]
	if c.GetLastMessageId() != 9412 || c.GetPeerLastReadMessageId() != 9410 {
		t.Errorf("typed ids = %d/%d, want 9412/9410",
			c.GetLastMessageId(), c.GetPeerLastReadMessageId())
	}
	var js []map[string]any
	if err := json.Unmarshal(getChatsList(t, "application/json", chatsListFixture()).Body.Bytes(), &js); err != nil {
		t.Fatalf("json: %v", err)
	}
	if v, ok := js[0]["lastMessageId"].(string); !ok || v != "9412" {
		t.Errorf("legacy lastMessageId = %#v, want the string \"9412\"", js[0]["lastMessageId"])
	}
	if v, ok := js[0]["peerLastReadMessageId"].(float64); !ok || v != 9410 {
		t.Errorf("legacy peerLastReadMessageId = %#v, want the number 9410", js[0]["peerLastReadMessageId"])
	}
}

// An id string that cannot be parsed is ABSENT, never 0. 0 is a real value the
// client acts on (it clears a read pointer); fabricating one from a corrupt row
// would silently clear a badge.
func TestChatsListUnparseableIDIsAbsent(t *testing.T) {
	rows := chatsListFixture()[:1]
	rows[0].LastMessageID = strptr("not-a-number")
	reply := decodeChatsList(t, getChatsList(t, protobufMediaType, rows))
	if reply.Chats[0].LastMessageId != nil {
		t.Errorf("unparseable id must be absent, got %d", *reply.Chats[0].LastMessageId)
	}
	// The JSON path is untouched by this: it still ships the raw string.
	var js []map[string]any
	_ = json.Unmarshal(getChatsList(t, "application/json", rows).Body.Bytes(), &js)
	if js[0]["lastMessageId"] != "not-a-number" {
		t.Errorf("legacy JSON changed: %#v", js[0]["lastMessageId"])
	}
}

// Empty is the cold-start case, and the one shape a repeated field gets wrong:
// proto3 writes nothing at all, while the JSON branch must keep writing `[]`
// and never `null`.
func TestChatsListEmptyIsEmptyInBoth(t *testing.T) {
	if got, want := getChatsList(t, "", []chatsListItem{}).Body.String(), "[]\n"; got != want {
		t.Errorf("empty JSON body = %q, want %q", got, want)
	}
	w := getChatsList(t, protobufMediaType, []chatsListItem{})
	if w.Body.Len() != 0 {
		t.Errorf("empty protobuf body = %x, want zero bytes", w.Body.Bytes())
	}
	if reply := decodeChatsList(t, w); len(reply.Chats) != 0 {
		t.Errorf("empty reply decoded to %d chats", len(reply.Chats))
	}
}

// CROSS-LANGUAGE BYTE PIN. One fixed row, its exact wire bytes. Pinning the
// bytes rather than only the semantics is what makes Go and TypeScript one
// contract instead of two independent readings of the schema: semantic
// agreement alone would let them drift onto different field numbers and both
// still "pass". lib/chatsListProto.selftest.ts rebuilds this same row with its
// own hand-rolled encoder and asserts this same hex (GO_GOLDEN_WIRE there),
// character for character — so a change on either side breaks both.
func chatsListPinRow() []chatsListItem {
	return []chatsListItem{{
		ID: "pin", Type: "direct",
		CreatedAt:     httpx.JSTime(time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)),
		UpdatedAt:     httpx.JSTime(time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)),
		LastMessageID: strptr("9412"),
		MyRole:        "member",
		Muted:         true,
		ScreenshotMode: "block", UnreadCount: 7,
		PeerLastReadMessageID: i64ptr(9410),
	}}
}

// Field by field: 0a5d = chats[0], 93 bytes. 0a03"pin" id, 1206"direct" type,
// 3218/3a18 the two ISO timestamps verbatim, 40 c449 last_message_id=9412
// (#8 varint), 5206"member" my_role, 6001 muted, 8a0105"block" screenshot_mode
// (#17), 980107 unread_count=7 (#19), c801 c249 peer_last_read=9410 (#25).
// Absent by design and therefore not on the wire at all: name, photo_url,
// created_by, last_message_at, my_last_read_id, peer_* strings,
// peer_last_delivered_message_id, expires_at — plus every false bool and the
// zero-valued non-optional fields, which proto3 elides.
const chatsListGoldenWire = "0a5d0a0370696e12066469726563743218323032362d30332d30345430353a30363a30372e3839305a" +
	"3a18323032362d30332d30345430353a30363a30372e3839305a40c44952066d656d62657260018a0105626c6f636b980107c801c249"

func TestChatsListWireBytePin(t *testing.T) {
	w := getChatsList(t, protobufMediaType, chatsListPinRow())
	if got := hex.EncodeToString(w.Body.Bytes()); got != chatsListGoldenWire {
		t.Errorf("wire bytes = %s\n          want %s", got, chatsListGoldenWire)
	}
}
