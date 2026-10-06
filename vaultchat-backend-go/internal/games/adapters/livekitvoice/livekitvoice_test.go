package livekitvoice

import (
	"testing"

	"vaultchat/backend-go/internal/livekit"
)

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
