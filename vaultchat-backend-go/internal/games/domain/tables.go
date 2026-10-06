package domain

import (
	"strings"
	"time"
)

// Event is one signed notification from the games server, after verification.
type Event struct {
	Recipient string // vaultId
	ID        string // jti, the dedupe key
	Kind      string // turn | invite | friend
	Title     string
	Body      string
	Game      string // file stem, e.g. "rummy"
	Room      string // table id — the tap must open THIS table
	ExpiresAt *time.Time
}

// LiveTable is one table the player is sitting at, as the last notification
// about it described. A LAUNCHER, NOT A SOURCE OF TRUTH: the games server owns
// the game and is re-read the moment the board opens.
type LiveTable struct {
	Game, Room  string
	YourTurn    bool
	Title, Body string
	UpdatedAt   time.Time
}

// tableKinds are the notification kinds that mean "you have a table".
//
// The contract's kinds are turn | invite | friend. A friend request is about a
// person, not a table, and writing a row for one would put a game in the list
// that the player is not sitting at. An unknown kind is treated the same way:
// the games server can add kinds without telling us, and a list is a promise
// about where the player can pick up a game.
var tableKinds = map[string]bool{"turn": true, "invite": true}

// IsTableKind reports whether a notification of this kind puts a table in the
// player's list.
func IsTableKind(kind string) bool { return tableKinds[strings.ToLower(strings.TrimSpace(kind))] }

// IsYourTurn reports whether the kind says it is the player's move. A record of
// what we were last told, not a claim about the board.
func IsYourTurn(kind string) bool { return strings.EqualFold(strings.TrimSpace(kind), "turn") }
