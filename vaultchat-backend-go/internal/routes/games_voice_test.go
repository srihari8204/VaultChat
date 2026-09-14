package routes

import (
	"strings"
	"testing"

	"vaultchat/backend-go/internal/livekit"
)

// The room name is the whole of this endpoint's isolation: the client never
// names a room, so these are the properties that stop one table's token from
// opening another room — or a call.
func TestGamesVoiceRoomIsNamespaced(t *testing.T) {
	got := gamesVoiceRoom("rummy", "practice")
	if got != "gametable-rummy-practice" {
		t.Fatalf("room = %q", got)
	}
	// livekit.RoomName is the calls namespace. A game table must never be able
	// to collide with it, whatever it is called.
	if strings.HasPrefix(got, "call-") {
		t.Fatalf("game room %q collides with the calls namespace", got)
	}
	if gamesVoiceRoom("ludo", "practice") == gamesVoiceRoom("rummy", "practice") {
		t.Fatal("two different games share a voice room")
	}
	if gamesVoiceRoom("rummy", "casual") == gamesVoiceRoom("rummy", "pro") {
		t.Fatal("two different tables share a voice room")
	}
}

// Both halves are slugged before they reach gamesVoiceRoom. This pins the
// reason: anything that could introduce a separator, a path or a space would
// let a caller forge a room name.
func TestGamesVoiceSlugRejectsSeparators(t *testing.T) {
	for _, bad := range []string{
		"rummy-practice/../call", "a b", "call-x/y", "room?x=1", "", strings.Repeat("a", 65),
		"table.1", "a:b", "a#b",
	} {
		if gamesNotifySlug(bad) != "" {
			t.Fatalf("slug accepted %q", bad)
		}
	}
	for _, ok := range []string{"rummy", "practice", "casual", "pro", "a_b-C9"} {
		if gamesNotifySlug(ok) == "" {
			t.Fatalf("slug rejected %q", ok)
		}
	}
}

// Only the games that actually have a voice UI may mint a room.
func TestGamesVoiceGameSet(t *testing.T) {
	for _, g := range []string{"rummy", "ludo"} {
		if !gamesVoiceGames[g] {
			t.Fatalf("%s should have table voice", g)
		}
	}
	for _, g := range []string{"chess", "tictactoe", "", "calls", "broadcast"} {
		if gamesVoiceGames[g] {
			t.Fatalf("%s should not mint a voice room", g)
		}
	}
}

// A player may speak; a spectator may not, AT THE MEDIA SERVER rather than by
// the client agreeing to keep its own track disabled. And neither may administer
// the room — RoomAdmin is the power to mute and remove other players.
func TestGamesVoiceRolesGrantTheRightThings(t *testing.T) {
	const room = "gametable-rummy-practice"

	player := livekit.GrantFor(livekit.RoleSpeaker, room)
	if !player.CanPublish || !player.CanSubscribe || !player.RoomJoin {
		t.Fatal("a seated player must be able to join, publish and subscribe")
	}
	if player.RoomAdmin {
		t.Fatal("a player must not be able to mute or remove the rest of the table")
	}

	spectator := livekit.GrantFor(livekit.RoleAudience, room)
	if spectator.CanPublish {
		t.Fatal("a spectator must not be able to publish")
	}
	if !spectator.CanSubscribe || !spectator.RoomJoin {
		t.Fatal("a spectator must still be able to listen")
	}
	if spectator.RoomAdmin {
		t.Fatal("a spectator must not administer the room")
	}
}
