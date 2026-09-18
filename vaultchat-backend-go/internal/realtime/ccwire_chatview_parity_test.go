package realtime

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

// ccwire_chatview_parity_test.go — chat_view arrives in TWO forms and the
// server must treat them as one operation.
//
//	typed:  body 82 ViewerState {chat_id, activity, leaving, resync}
//	                                     -> serveBody -> s.viewerState
//	legacy: body 100 AppEvent  {"chat_view", {...}} -> s.appEvent -> onChatViewPeer
//
// The client picks the typed form only when ServerHello advertises
// typed_app_bodies (lib/ccwire/eventsSocket.ts); an older server still sees the
// app_event frame byte for byte. These tests pin what makes that switch safe:
// both forms take the same membership gate, both drop an unroutable body, and
// on the allow path both produce the same effect.
//
// WHAT THESE TESTS DELIBERATELY DO NOT DO: reach a real viewer roster. cvTouch
// and cvList live in Redis (delivery.go) and this package's tests have none, so
// on the allow path both forms run to completion against an EMPTY roster — the
// gate, the leaving/heartbeat/resync branch choice and the reply are all
// asserted; who else is in the chat is not reachable here.

// chatViewFrame is the frame the CLIENT now emits: CONTROL/stream 1, the same
// class and stream the app_event form used, not EPHEMERAL.
func chatViewFrame(t *testing.T, chatID string, activity uint64, leaving, resync bool) []byte {
	t.Helper()
	return frame(t, ccwire.Message{
		RequestID:    "r",
		TrafficClass: ccwire.TrafficClassControl,
		Stream:       ccwireStreamControl,
		BodyField:    ccwire.BodyViewerState,
		Body:         viewerStateBody(chatID, activity, leaving, resync),
	})
}

func chatViewAppEvent(chatID, status, activity string, resync bool) []byte {
	m := map[string]any{"chatId": chatID, "status": status, "resync": resync}
	if activity != "" {
		m["activity"] = activity
	}
	return appEventFrame("chat_view", m)
}

func legacySession(t *testing.T, uid string, seed map[string]cachedPerm) (*ccwireSession, *fakeConn) {
	t.Helper()
	t.Setenv("CCWIRE_APP_EVENTS", "1")
	s, f := newSession(uid, seed)
	enableTestEvents(s)
	return s, f
}

// THE SECURITY-RELEVANT HALF: a non-member cannot read or join a chat's viewer
// list through either door.
func TestCCWireChatViewBothFormsTakeTheSameMembershipGate(t *testing.T) {
	denied := func() map[string]cachedPerm { return map[string]cachedPerm{"c1": permAt("c1", false)} }

	typed, tf := newSession("u1", denied())
	hello(t, typed)
	if !typed.handle(chatViewFrame(t, "c1", 1, false, true)) {
		t.Fatal("typed: a refusal must not end the session")
	}
	if got := errorCodeOf(t, tf.last(t)); got != errNotPermitted {
		t.Fatalf("typed: expected NOT_PERMITTED, got %d", got)
	}

	legacy, lf := legacySession(t, "u1", denied())
	if !legacy.handle(chatViewAppEvent("c1", "VIEWING", "reading", true)) {
		t.Fatal("app_event: a refusal must not end the session")
	}
	// The legacy form answers nothing at all — onChatViewPeer returns silently,
	// exactly as it does on Socket.IO. The DECISION is identical; only the
	// (absent) answer differs, and no client treats either as an ack.
	if len(lf.out) != 0 {
		t.Fatalf("app_event: expected silence, got %d frames", len(lf.out))
	}
}

// A body naming no chat is unroutable in both forms, and nothing is touched.
func TestCCWireChatViewBothFormsRefuseAnEmptyChatID(t *testing.T) {
	allowed := func() map[string]cachedPerm { return map[string]cachedPerm{"c1": permAt("c1", true)} }

	typed, tf := newSession("u1", allowed())
	hello(t, typed)
	if !typed.handle(chatViewFrame(t, "", 1, false, true)) {
		t.Fatal("typed: a refusal must not end the session")
	}
	if got := errorCodeOf(t, tf.last(t)); got != errPayloadInvalid {
		t.Fatalf("typed: expected PAYLOAD_INVALID, got %d", got)
	}

	legacy, lf := legacySession(t, "u1", allowed())
	if !legacy.handle(chatViewAppEvent("", "VIEWING", "reading", true)) {
		t.Fatal("app_event: a refusal must not end the session")
	}
	if len(lf.out) != 0 {
		t.Fatalf("app_event: an unroutable chat_view produced %d frames", len(lf.out))
	}
	// The client keeps the same property on its side: eventsSocket.ts takes the
	// typed branch only for a non-empty string chatId, so this frame is never
	// the one it sends.
}

// THE ALLOW PATH, AS FAR AS IT IS REACHABLE HERE. A resync asks for the roster
// and the typed form answers with one, through the frame the client now sends.
//
// THE APP_EVENT FORM IS NOT ASSERTED PAST THE GATE, and that is a limit of this
// package's tests, not a gap in the parity: onChatViewPeer calls
// loadGhostTargets (presence.go) BEFORE it looks at whether the roster is
// empty, so on a hub with no Postgres pool the legacy allow path dereferences a
// nil pgxpool. viewerState reaches the same call only when the roster is
// non-empty, which needs Redis. Both sides of the allow path therefore end in
// the same two stores, and neither is available without a database this test
// suite must never touch. What IS asserted above and below — the gate, the
// unroutable body and the heartbeat — is every branch the two forms share
// before that boundary.
func TestCCWireChatViewTypedResyncAnswersWithAViewerList(t *testing.T) {
	typed, tf := newSession("u1", map[string]cachedPerm{"c1": permAt("c1", true)})
	hello(t, typed)
	if !typed.handle(chatViewFrame(t, "c1", 2, false, true)) {
		t.Fatal("typed: a member's chat_view was refused")
	}
	m := tf.last(t)
	if m.BodyField != ccwire.BodyViewerList {
		t.Fatalf("typed: expected ViewerList, got body %d", m.BodyField)
	}
	if got := pbStr(t, pbFields(t, m.Body), 1); got != "c1" {
		t.Fatalf("typed: viewer_list chat_id %q", got)
	}
	// Same shape onChatViewPeer emits on the other transport — s.Emit(
	// "viewer_list", {chatId, viewers}) — which is why the client can read one
	// reply for both forms.
}

// A plain heartbeat (no resync, no state change) answers nothing in EITHER
// form, so the migration cannot start a reply where there was none.
func TestCCWireChatViewBothFormsStaySilentOnAHeartbeat(t *testing.T) {
	allowed := func() map[string]cachedPerm { return map[string]cachedPerm{"c1": permAt("c1", true)} }

	typed, tf := newSession("u1", allowed())
	hello(t, typed) // writes the ServerHello, so count from here
	base := len(tf.out)
	if !typed.handle(chatViewFrame(t, "c1", 1, false, false)) {
		t.Fatal("typed: a heartbeat was refused")
	}
	if len(tf.out) != base {
		t.Fatalf("typed: a heartbeat wrote %d frames", len(tf.out)-base)
	}

	legacy, lf := legacySession(t, "u1", allowed())
	if !legacy.handle(chatViewAppEvent("c1", "VIEWING", "reading", false)) {
		t.Fatal("app_event: a heartbeat was refused")
	}
	if len(lf.out) != 0 {
		t.Fatalf("app_event: a heartbeat wrote %d frames", len(lf.out))
	}
}

// THE FIELD MAPPING THE CLIENT ENCODES, read back off the server's own tables.
//
// eventsSocket.ts turns {chatId, status, activity, resync} into
// {chat_id, leaving: status == "LEFT", activity: enum, resync}. The activity
// half is viewerActivityWire, which is the SAME table onChatViewPeer's string
// goes into cvTouch as — so the two forms cannot drift into different
// vocabularies. An activity name the enum has no number for would become "" on
// the typed path, which is why the client keeps such a payload on app_event.
func TestCCWireChatViewActivityMappingMatchesTheSocketIOStrings(t *testing.T) {
	for enum, name := range map[uint32]string{1: "reading", 2: "typing", 3: "uploading"} {
		if got := viewerActivityWire[enum]; got != name {
			t.Fatalf("activity %d is %q, but the client encodes %q as %d", enum, got, name, enum)
		}
		if got := viewerActivityEnum(name); got != uint64(enum) {
			t.Fatalf("activity %q round-trips to %d, want %d", name, got, enum)
		}
	}
	if viewerActivityWire[0] != "" {
		t.Fatal("VIEWER_ACTIVITY_UNSPECIFIED must reach cvTouch as the empty string, as an absent activity does on Socket.IO")
	}

	// ViewerState carries NO identity field: the decoder reads 1..4 and the
	// handler takes the actor from the session. There is nothing here for a
	// client to spoof, unlike TypingState.sender_uid (field 3).
	b := viewerStateBody("c1", 1, false, false)
	b = ccwire.AppendStringField(b, 5, "victim")
	decoded, err := ccwire.DecodeBody(ccwire.BodyViewerState, b, ccwire.DefaultLimits(), 1)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	v, ok := decoded.(ccwire.ViewerState)
	if !ok {
		t.Fatalf("decoded %T", decoded)
	}
	if v.ChatID != "c1" || v.Activity != 1 || v.Leaving || v.Resync {
		t.Fatalf("decoded %+v", v)
	}
	for _, u := range v.Unknown {
		if string(u) == "victim" {
			t.Fatal("an unknown field was surfaced as data")
		}
	}
}
