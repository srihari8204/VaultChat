package routes

import (
	"encoding/json"
	"net/http"
	"strings"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/livekit"
	"vaultchat/backend-go/internal/vault"
)

// games_voice.go — a LiveKit room for the people sitting at a game table.
//
// WHY THIS EXISTS, AND WHY IT IS NOT ONE OF THE TWO TOKEN ROUTES WE ALREADY HAVE
//
// Table voice used to be a peer-to-peer WebRTC mesh signalled over the games
// server's own socket. That works, but it is O(n²) connections: a six-handed
// rummy table is five uploads of your microphone from a phone that is also
// animating thirteen cards. VaultChat already runs a LiveKit SFU for calls and
// for Go Live, so the same audio costs each phone ONE upload and one download.
//
// Neither existing token route could be reused. `POST /calls/{id}/sfu-token`
// requires a `calls` row plus a live `call_participants` row, and answers 403
// otherwise; `POST /broadcasts/{id}/token` requires a `broadcast_sessions` row.
// A game table has neither, and cannot: the games server is a separate,
// external deployment we do not own the source of, and this backend is nowhere
// in its join path.
//
// WHAT THIS CAN AND CANNOT PROVE — stated plainly, because it is a real
// difference from the mesh it replaces.
//
// The mesh's membership was enforced by the thing that actually knows the
// seating: the games server relayed `voice-*` frames only between peers at the
// same table. We cannot ask it who is seated — there is no such endpoint — and
// `games_live_tables` is written only when a turn/invite push arrives, so a
// player who has just sat down has no row and gating on one would refuse voice
// to exactly the people who want it.
//
// So the honest description of this authz is: a signed-in VaultChat user who
// knows a table's room id may join that table's audio room. Room ids travel in
// invite links, so the exposure is "someone who was invited, or who has an
// invite link". That is weaker than the mesh, and it is the price of the SFU.
// Making it stronger needs the games server to vouch for a seat.
//
// Three things keep it as tight as it can be without that:
//   - The room name is composed HERE and slug-validated. The client cannot name
//     a room, so it cannot join `call-<uuid>` or a broadcast room by asking.
//   - The role is `speaker`, never `host`/`cohost` — those carry RoomAdmin, i.e.
//     the power to mute and remove other players at the table.
//   - A spectator gets `audience`, which cannot publish AT THE MEDIA SERVER.
//     The mesh could only ask the client not to send.

// gamesVoiceRoom is the LiveKit room for one table.
//
// PREFIXED, and the prefix is load-bearing rather than decorative: it is what
// keeps this namespace disjoint from `call-<id>` (livekit.RoomName) and from Go
// Live's rooms. Both halves are slugs — see the validation in the handler — so
// no separator can be smuggled in to forge a room in someone else's namespace.
func gamesVoiceRoom(game, room string) string {
	return "gametable-" + game + "-" + room
}

// gamesVoiceToken mints a LiveKit join token for a game table's voice room.
func gamesVoiceToken(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)

	var body struct {
		Game string `json:"game"`
		Room string `json:"room"`
		// The client says whether it is a spectator. That is NOT a security
		// boundary — a client could always claim to be a player — it is how a
		// spectator opts into listen-only, and it buys a real server-side
		// guarantee for the honest case: LiveKit refuses the publish outright
		// rather than trusting the app to keep its own microphone track
		// disabled. Claiming to be a player gets you what a player gets, which
		// is what the mesh already gave everyone.
		Spectator bool `json:"spectator"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Same validator the notify path uses, and for the same reason: both of
	// these end up concatenated into an identifier.
	game := gamesNotifySlug(body.Game)
	room := gamesNotifySlug(body.Room)
	if game == "" || room == "" {
		httpx.Err(w, http.StatusBadRequest, "game and room required")
		return
	}
	if !gamesVoiceGames[game] {
		httpx.Err(w, http.StatusBadRequest, "Unknown game")
		return
	}

	cfg := livekit.ConfigFromEnv()
	if !cfg.Configured() {
		// Distinguishable from a failure on purpose: the board shows "voice is
		// unavailable here" rather than "voice failed", which is the difference
		// between a player waiting and a player retrying forever.
		httpx.Err(w, http.StatusServiceUnavailable, "Table voice is not configured")
		return
	}

	// IDENTITY IS THE VAULTID, NOT THE INTERNAL USER ID.
	//
	// The games server speaks vaultIds end to end: the socket's `hello`/`joined`
	// carry one, `lobby.members[].vaultId` is one, and the rummy board decides
	// which SEAT to light up by asking `voice.speaking.has(pid(player))`. Mint
	// this with `user.ID` and the audio works perfectly while every seat ring
	// stays dark — a bug that looks like a rendering fault and is not.
	var vaultID string
	var fnc, lnc, legacyName *string
	if err := db.Pool.QueryRow(r.Context(),
		`SELECT COALESCE(vault_id, ''), first_name_cipher, last_name_cipher, name
		   FROM users WHERE id = $1 AND is_deleted = FALSE`,
		user.ID,
	).Scan(&vaultID, &fnc, &lnc, &legacyName); err != nil {
		httpx.Err(w, http.StatusNotFound, "User not found")
		return
	}
	if vaultID == "" {
		httpx.Err(w, http.StatusConflict, "User has no VaultID")
		return
	}
	name := vaultID
	if nm := vault.IdentityFromRow(fnc, lnc, nil, nil, nil, nil, legacyName, nil, nil, nil, nil).Name; nm != nil {
		if trimmed := strings.TrimSpace(*nm); trimmed != "" {
			name = trimmed
		}
	}

	lkRoom := gamesVoiceRoom(game, room)
	role := livekit.RoleSpeaker
	if body.Spectator {
		role = livekit.RoleAudience
	}
	tok, err := livekit.Mint(cfg, livekit.MintArgs{
		Identity: vaultID,
		Name:     name,
		Room:     lkRoom,
		Role:     role,
	})
	if err != nil {
		httpx.Err(w, http.StatusServiceUnavailable, "Could not mint a voice token")
		return
	}

	httpx.JSON(w, 200, map[string]any{
		"ok":       true,
		"token":    tok,
		"url":      cfg.URL,
		"room":     lkRoom,
		"identity": vaultID,
		"role":     string(role),
	})
}

// gamesVoiceGames is the set of games that have a voice UI on their board.
//
// A closed set rather than "any slug": the room name is derived from it, and an
// open one would let a caller mint a room per arbitrary string — free storage
// of a sort, and a namespace nobody is watching.
var gamesVoiceGames = map[string]bool{
	"rummy": true,
	"ludo":  true,
}
