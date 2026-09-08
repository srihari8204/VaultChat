package realtime

import (
	"os"
	"strings"
	"testing"
	"time"
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

	// A cached entry is only usable at the chat's CURRENT generation, so the
	// fixtures stamp the live one.
	at := func(chat string, ok bool) map[string]cachedPerm {
		return map[string]cachedPerm{chat: {ok: ok, gen: permGenerationOf(chat), at: time.Now()}}
	}

	deny := &sockData{uid: "u1", chatMemberOk: at("c-denied", false)}
	if h.chatMemberAllowed(deny, "c-denied") {
		t.Fatal("a cached false must refuse — this is the removed-member case")
	}

	allow := &sockData{uid: "u1", chatMemberOk: at("c-ok", true)}
	if !h.chatMemberAllowed(allow, "c-ok") {
		t.Fatal("a cached true must allow, or every legitimate join breaks")
	}
}

// AUDIT F02: the cache used to last for the socket's LIFETIME. Removing someone
// from a group refreshed the fan-out roster but never touched the decision
// their live connection was holding, so a removed member could keep publishing
// into the chat until they happened to reconnect — on a phone, possibly hours.
//
// Asserted on the cache entry rather than through chatMemberAllowed: once the
// entry is invalid that function re-queries the database, and this package has
// none (by design — see TestJoinChatIsAuthorized). Re-querying IS the fix; what
// needs proving is that the bump makes the held decision unusable.
func TestBumpChatPermissionsInvalidatesLiveSockets(t *testing.T) {
	const chat = "c-removed"

	held := cachedPerm{ok: true, gen: permGenerationOf(chat), at: time.Now()}
	if !held.fresh(permGenerationOf(chat)) {
		t.Fatal("precondition: a just-made decision should be usable")
	}

	BumpChatPermissions(chat) // what removing a member now triggers

	if held.fresh(permGenerationOf(chat)) {
		t.Fatal("a removed member's socket kept its cached authorisation")
	}
}

// A stale entry must expire even if nothing bumped the generation — the
// backstop for a second replica, whose in-process counter never sees the bump.
func TestCachedPermExpires(t *testing.T) {
	gen := permGenerationOf("c-any")
	stale := cachedPerm{ok: true, gen: gen, at: time.Now().Add(-permTTL - time.Second)}
	if stale.fresh(gen) {
		t.Fatalf("an entry older than permTTL (%s) is still being trusted", permTTL)
	}
	warm := cachedPerm{ok: true, gen: gen, at: time.Now()}
	if !warm.fresh(gen) {
		t.Fatal("a fresh entry at the current generation should be usable")
	}
	if warm.fresh(gen + 1) {
		t.Fatal("an entry from an older generation must not be usable")
	}
}

// One chat's change must not invalidate every other chat on the socket, or a
// busy group would push every conversation into a database round trip.
func TestBumpIsScopedToOneChat(t *testing.T) {
	a := cachedPerm{ok: true, gen: permGenerationOf("c-a"), at: time.Now()}
	b := cachedPerm{ok: true, gen: permGenerationOf("c-b"), at: time.Now()}

	BumpChatPermissions("c-a")

	if a.fresh(permGenerationOf("c-a")) {
		t.Fatal("c-a should have been invalidated")
	}
	if !b.fresh(permGenerationOf("c-b")) {
		t.Fatal("c-b was invalidated by an unrelated chat's membership change")
	}
}

// The wiring that makes any of this fire: the roster invalidation every
// membership change already calls must also drop socket authorisation.
func TestInvalidateChatMembersBumpsPermissions(t *testing.T) {
	src, err := os.ReadFile("delivery.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "BumpChatPermissions(chatID)") {
		t.Fatal("InvalidateChatMembers no longer drops cached socket authorisation")
	}
}
