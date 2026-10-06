package domain

// VoiceRoom is the LiveKit room for one game table.
//
// PREFIXED, and the prefix is load-bearing rather than decorative: it is what
// keeps this namespace disjoint from `call-<id>` and from Go Live's rooms. Both
// halves must already be slugs (Slug), so no separator can be smuggled in to
// forge a room in someone else's namespace. The client never names a room.
func VoiceRoom(game, room string) string {
	return "gametable-" + game + "-" + room
}

// voiceGames is the set of games that have a voice UI on their board.
//
// A closed set rather than "any slug": the room name is derived from it, and an
// open one would let a caller mint a room per arbitrary string — free storage
// of a sort, and a namespace nobody is watching.
var voiceGames = map[string]bool{
	"rummy": true,
	"ludo":  true,
}

// HasVoice reports whether game has table voice.
func HasVoice(game string) bool { return voiceGames[game] }
