package domain

import (
	"strings"
	"testing"
)

func TestSlugRejectsUrlBreakingInput(t *testing.T) {
	// Each of these becomes part of games.corefinite.com/<game>.html?room=<room>.
	for _, bad := range []string{
		"", "   ", "../../etc/passwd", "rummy.html", "a b", "a&b=1", "a?b",
		"a/b", "a#b", "a'b", `a"b`, "a%2e%2e", strings.Repeat("a", 65),
	} {
		if got := Slug(bad); got != "" {
			t.Fatalf("Slug(%q) = %q, want rejected", bad, got)
		}
	}
	for _, good := range []string{"rummy", "tic-tac-toe", "snakes_ladders", "t-42", "ABC123"} {
		if got := Slug(good); got != good {
			t.Fatalf("Slug(%q) = %q, want it kept", good, got)
		}
	}
}

func TestTextIsBounded(t *testing.T) {
	if got := Text("  hi  "); got != "hi" {
		t.Fatalf("trim: %q", got)
	}
	if got := Text(strings.Repeat("x", 500)); len(got) != MaxText {
		t.Fatalf("len = %d, want %d", len(got), MaxText)
	}
}

// A friend request is about a person, not a table. Writing a row for one would
// put a game in the list that the player is not sitting at — and an unknown
// kind is treated the same way, because the games server can add kinds without
// telling us and this list is a promise about where a game can be picked up.
func TestOnlyTableKindsBecomeALiveTable(t *testing.T) {
	for _, kind := range []string{"turn", "invite", " TURN ", "Invite"} {
		if !IsTableKind(kind) {
			t.Errorf("kind %q means the player has a table and must be remembered", kind)
		}
	}
	for _, kind := range []string{"friend", "", "achievement"} {
		if IsTableKind(kind) {
			t.Errorf("kind %q must not create a live table", kind)
		}
	}
	if !IsYourTurn(" Turn") || IsYourTurn("invite") {
		t.Error("only a turn notification means it is the player's move")
	}
}

func TestDisplayNameFallsBackToVaultID(t *testing.T) {
	s := func(v string) *string { return &v }
	if got := DisplayName("v1", s("  Alice ")); got != "Alice" {
		t.Errorf("got %q", got)
	}
	for _, n := range []*string{nil, s(""), s("   ")} {
		if got := DisplayName("v1", n); got != "v1" {
			t.Errorf("an empty name must fall back to the vaultId, got %q", got)
		}
	}
}
