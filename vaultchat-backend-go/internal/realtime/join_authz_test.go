package realtime

import (
	"os"
	"strings"
	"testing"
)

// join_chat used to join whatever chatId arrived, so room membership was
// SELF-ASSERTED. FanOutToChat emits unfiltered events straight to chat:<id>,
// and handlers.go sends live_location_update, trip_update, trip_end,
// reaction_updated and message_delivered there too — so a socket in the room
// receives all of it.
//
// Guessing a chat UUID is not the threat. A REMOVED MEMBER is: they already
// know the id, and nothing re-checked whether they still belong.

// The cached path returns before touching the DB, which is what lets this run
// with no database — matching this package's "no DB, no sockets" test style.
func TestChatMemberAllowedHonoursTheCache(t *testing.T) {
	h := &Hub{}

	deny := &sockData{uid: "u1", chatMemberOk: map[string]bool{"c-denied": false}}
	if h.chatMemberAllowed(deny, "c-denied") {
		t.Fatal("a cached false must refuse — this is the removed-member case")
	}

	allow := &sockData{uid: "u1", chatMemberOk: map[string]bool{"c-ok": true}}
	if !h.chatMemberAllowed(allow, "c-ok") {
		t.Fatal("a cached true must allow, or every legitimate join breaks")
	}
}

// The gate is only worth anything if join_chat actually consults it. A source
// check is the honest tool here: the handler closes over a live socket and Hub,
// so exercising it for real would need both a DB and a socket server, and this
// package deliberately has neither.
func TestJoinChatIsAuthorized(t *testing.T) {
	src, err := os.ReadFile("handlers.go")
	if err != nil {
		t.Fatalf("read handlers.go: %v", err)
	}
	body := string(src)

	i := strings.Index(body, `s.On("join_chat"`)
	if i < 0 {
		t.Fatal(`no join_chat handler found`)
	}
	// Bound the search to this handler so a check belonging to a NEIGHBOURING
	// handler cannot make this pass by accident.
	end := strings.Index(body[i:], `s.On("leave_chat"`)
	if end < 0 {
		t.Fatal(`could not delimit the join_chat handler`)
	}
	handler := body[i : i+end]

	if !strings.Contains(handler, "chatMemberAllowed") {
		t.Error("join_chat must gate on chatMemberAllowed — without it any " +
			"authenticated socket can join any chat room and receive its fan-out")
	}
	if !strings.Contains(handler, "s.Join(") {
		t.Error("join_chat should still join the room when authorized")
	}
	// The refusal must be visible. A silently dropped join looks identical to a
	// client bug, and this one would mean a user's live location and typing
	// simply stopped arriving with nothing to explain it.
	if !strings.Contains(handler, "log.Printf") && !strings.Contains(handler, "metrics.Inc") {
		t.Error("a refused join must be logged or counted, not silently dropped")
	}
}

// One definition of "is a member": the live-location and trip handlers gate on
// the same helper. If a second, subtly different check appears, that is how the
// two drift apart.
func TestOneMembershipCheckShared(t *testing.T) {
	src, err := os.ReadFile("handlers.go")
	if err != nil {
		t.Fatalf("read handlers.go: %v", err)
	}
	if n := strings.Count(string(src), "func (h *Hub) chatMemberAllowed"); n != 1 {
		t.Errorf("expected exactly one chatMemberAllowed definition, found %d", n)
	}
	if n := strings.Count(string(src), "chatMemberAllowed(d,"); n < 6 {
		t.Errorf("expected the shared check on join_chat plus the existing "+
			"live-location/trip handlers, found %d call sites", n)
	}
}
