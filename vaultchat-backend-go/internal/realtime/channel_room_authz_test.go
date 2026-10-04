// channel_room_authz_test.go — broadcast-channel rooms are authorised on both
// transports by the one check, channelAllowed: a user who is not (or is no
// longer) the admin or a subscriber can neither join the room nor receive
// from it, and a leave (BumpChannelPermissions) takes effect on the next
// delivery for a session that is still in the room.
//
// DB-free: decisions are seeded into the per-socket cache exactly as the
// database would leave them; with no database a cache miss fails closed.
package realtime

import (
	"testing"

	"vaultchat/backend-go/internal/ccwire"
)

func TestChannelRoomJoinRefusedWithoutSubscription(t *testing.T) {
	h := &Hub{}
	left, out := newSession("left-user", map[string]cachedPerm{"channel:c1": permAt("channel:c1", false)})
	stranger, out2 := newSession("stranger", nil) // nothing cached, no DB → closed
	left.hub, stranger.hub = h, h
	enableTestEvents(left)
	enableTestEvents(stranger)
	h.ccwireRegister(left)
	h.ccwireRegister(stranger)

	// Socket-style event join.
	left.handle(appEventFrame("channel_join", map[string]any{"channelId": "c1"}))
	stranger.handle(appEventFrame("channel_join", map[string]any{"channelId": "c1"}))
	if _, in := left.subs["channel:c1"]; in {
		t.Fatal("a non-subscriber joined the channel room")
	}
	if _, in := stranger.subs["channel:c1"]; in {
		t.Fatal("an unknown user joined the channel room with no database")
	}
	h.ccwireRooms([]string{"channel:c1"}, "", "channel_post", map[string]any{"channelId": "c1", "text": "x"})
	if len(out.out) != 0 || len(out2.out) != 0 {
		t.Fatal("a refused user received a channel post")
	}

	// CC-Wire scope subscribe: same gate.
	if ok, _, _ := left.subscribeAllowed(ccwire.ScopeKindChannel, "c1"); ok {
		t.Fatal("SCOPE_KIND_CHANNEL subscribe allowed a non-subscriber")
	}
	if ok, _, _ := stranger.subscribeAllowed(ccwire.ScopeKindChannel, "c1"); ok {
		t.Fatal("SCOPE_KIND_CHANNEL subscribe allowed with no database")
	}
}

func TestChannelRoomLeaveStopsDeliveryToAJoinedSession(t *testing.T) {
	h := &Hub{}
	sub, out := newSession("subscriber", map[string]cachedPerm{"channel:c2": permAt("channel:c2", true)})
	sub.hub = h
	enableTestEvents(sub)
	h.ccwireRegister(sub)
	if ok, _, _ := sub.subscribeAllowed(ccwire.ScopeKindChannel, "c2"); !ok {
		t.Fatal("a subscriber was refused")
	}
	sub.handle(appEventFrame("channel_join", map[string]any{"channelId": "c2"}))
	h.ccwireRooms([]string{"channel:c2"}, "", "channel_post", map[string]any{"channelId": "c2"})
	if len(out.out) != 1 {
		t.Fatalf("subscriber got %d frames, want 1", len(out.out))
	}

	// POST /channels/c2/leave bumps the generation. The session never sent
	// channel_leave (a stale client), yet the next post must not reach it:
	// the cached "yes" is stale and, with no subscription row (no DB here),
	// the recheck fails closed.
	BumpChannelPermissions("c2")
	h.ccwireRooms([]string{"channel:c2"}, "", "channel_post", map[string]any{"channelId": "c2"})
	if len(out.out) != 1 {
		t.Fatal("a user who left still received a live post")
	}
	// And it cannot come back in.
	if ok, _, _ := sub.subscribeAllowed(ccwire.ScopeKindChannel, "c2"); ok {
		t.Fatal("a user who left re-subscribed")
	}
}
