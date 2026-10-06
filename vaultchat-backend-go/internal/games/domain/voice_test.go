package domain

import (
	"strings"
	"testing"
)

// The room name is the whole of this endpoint's isolation: the client never
// names a room, so these are the properties that stop one table's token from
// opening another room — or a call.
func TestGamesVoiceRoomIsNamespaced(t *testing.T) {
	got := VoiceRoom("rummy", "practice")
	if got != "gametable-rummy-practice" {
		t.Fatalf("room = %q", got)
	}
	// livekit.RoomName is the calls namespace. A game table must never be able
	// to collide with it, whatever it is called.
	if strings.HasPrefix(got, "call-") {
		t.Fatalf("game room %q collides with the calls namespace", got)
	}
	if VoiceRoom("ludo", "practice") == VoiceRoom("rummy", "practice") {
		t.Fatal("two different games share a voice room")
	}
	if VoiceRoom("rummy", "casual") == VoiceRoom("rummy", "pro") {
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
		if Slug(bad) != "" {
			t.Fatalf("slug accepted %q", bad)
		}
	}
	for _, ok := range []string{"rummy", "practice", "casual", "pro", "a_b-C9"} {
		if Slug(ok) == "" {
			t.Fatalf("slug rejected %q", ok)
		}
	}
}

// Only the games that actually have a voice UI may mint a room.
func TestGamesVoiceGameSet(t *testing.T) {
	for _, g := range []string{"rummy", "ludo"} {
		if !HasVoice(g) {
			t.Fatalf("%s should have table voice", g)
		}
	}
	for _, g := range []string{"chess", "tictactoe", "", "calls", "broadcast"} {
		if HasVoice(g) {
			t.Fatalf("%s should not mint a voice room", g)
		}
	}
}
