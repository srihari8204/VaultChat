// Package routes — games_matches.go: Pool (101/201) and Deals (best-of-2/6)
// rummy, layered over the games server's single-deal engine.
//
// WHY THIS IS HERE AND NOT ON THE GAMES SERVER
//
// docs/GAMES_PROTOCOL.md: "There is no pool (101/201) and no deals variant on
// this server: the wire protocol has no pool score, no elimination and no deal
// count, and the engine only ever settles a single deal at a time." That server
// is a separate, distroless deployment we do not own the source of.
//
// Pool and Deals are, in rules terms, only scoring wrappers around repeated
// Points deals — and the games server already hands every client both inputs:
// the per-deal result, and `start` to re-deal the same table. So a match is a
// sequence of server-owned deals plus a score VaultChat owns. This file is that
// score, and the rules that advance it.
//
// WHY THE SCORING IS HERE RATHER THAN IN THE APP
//
// A pool score decides who is ELIMINATED, so every seat must agree on it and a
// device cannot be trusted to total its own. A client that misses one deal
// while reconnecting would otherwise carry a lower total than everyone else,
// which in Pool is the difference between out and still playing. One
// implementation, server-side — the thin-client rule (see migration 126).
package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

// matchVariant is one of the four formats. The set is closed and matches the
// CHECK in migration 126 — a variant accepted here but rejected by the database
// would 500 on write instead of 400 on entry.
type matchVariant string

const (
	variantPool101 matchVariant = "pool101"
	variantPool201 matchVariant = "pool201"
	variantDeals2  matchVariant = "deals2"
	variantDeals6  matchVariant = "deals6"
)

// poolLimit is the score at which a player is eliminated, and dealsTotal the
// number of deals a match runs for. Exactly one of the two applies to any
// variant; the zero value means "not this kind of match".
func (v matchVariant) poolLimit() int {
	switch v {
	case variantPool101:
		return 101
	case variantPool201:
		return 201
	}
	return 0
}

func (v matchVariant) dealsTotal() int {
	switch v {
	case variantDeals2:
		return 2
	case variantDeals6:
		return 6
	}
	return 0
}

func (v matchVariant) valid() bool {
	return v.poolLimit() > 0 || v.dealsTotal() > 0
}

// matchScore is one player's standing in a match.
//
// Points and Chips are both carried for every variant even though each variant
// reads only one. Keeping the shape stable means the app renders one scoreboard
// component and the JSONB never changes shape between variants — a variant-
// dependent schema is how a field ends up missing on the one path nobody tested.
type matchScore struct {
	Name   string `json:"name"`
	Points int    `json:"points"`
	Chips  int    `json:"chips"`
	Status string `json:"status"` // "playing" | "out"
}

const (
	statusPlaying = "playing"
	statusOut     = "out"
)

// dealResult is one player's outcome in a single deal, as the games server
// reported it. Points is that deal's rummy points — 0 for the player who made a
// valid declaration, and the value of the unarranged cards for everyone else.
type dealResult struct {
	VaultID string `json:"vaultId"`
	Name    string `json:"name"`
	Points  int    `json:"points"`
	Winner  bool   `json:"winner"`
}

// applyDeal advances a match by one deal and returns the new scores.
//
// THE RULES, both of which are the standard ones:
//
//   - Pool: a deal's points are added to the running total. A player whose
//     total reaches or passes the limit is out, and takes no part in later
//     deals. The match ends when one player is left standing.
//   - Deals: chips move. Each player loses their deal points; the winner
//     collects the sum of everyone else's. After the agreed number of deals the
//     highest chip count wins.
//
// A player already out is skipped entirely — not scored, not re-eliminated.
// The games server will happily keep dealing them in (it has no concept of this
// match), so results for eliminated players do arrive and MUST be ignored here
// rather than assumed absent.
func applyDeal(v matchVariant, scores map[string]matchScore, results []dealResult) map[string]matchScore {
	next := make(map[string]matchScore, len(scores)+len(results))
	for id, s := range scores {
		next[id] = s
	}

	// Seat anyone new. A match spans deals and the games server may seat a
	// player who was not there when the match opened.
	for _, r := range results {
		if r.VaultID == "" {
			continue
		}
		if _, ok := next[r.VaultID]; !ok {
			next[r.VaultID] = matchScore{Name: r.Name, Points: 0, Chips: 0, Status: statusPlaying}
		}
	}

	if limit := v.poolLimit(); limit > 0 {
		for _, r := range results {
			s, ok := next[r.VaultID]
			if !ok || s.Status == statusOut {
				continue
			}
			s.Points += max0(r.Points)
			if s.Points >= limit {
				s.Status = statusOut
			}
			next[r.VaultID] = s
		}
		return next
	}

	// Deals: the winner collects what the others lose, so the chips in a match
	// stay conserved and a scoreboard that does not sum to zero is a bug.
	pot := 0
	for _, r := range results {
		if s, ok := next[r.VaultID]; !ok || s.Status == statusOut || r.Winner {
			continue
		}
		pot += max0(r.Points)
	}
	for _, r := range results {
		s, ok := next[r.VaultID]
		if !ok || s.Status == statusOut {
			continue
		}
		if r.Winner {
			s.Chips += pot
		} else {
			s.Chips -= max0(r.Points)
		}
		next[r.VaultID] = s
	}
	return next
}

// max0 clamps a reported score at zero. Rummy points are never negative, and a
// negative value arriving from a client would otherwise let a player subtract
// their way out of an elimination.
func max0(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// matchOver reports whether the match has finished, and why.
//
// Pool ends when one player is left; Deals when the agreed deals are played.
// A pool that somehow eliminates everyone in the same deal also ends — without
// this it would sit running forever with nobody able to play it.
func matchOver(v matchVariant, scores map[string]matchScore, dealsPlayed int) bool {
	if total := v.dealsTotal(); total > 0 {
		return dealsPlayed >= total
	}
	alive := 0
	for _, s := range scores {
		if s.Status == statusPlaying {
			alive++
		}
	}
	return alive <= 1
}

func RegisterGamesMatches(mux *http.ServeMux) {
	mux.HandleFunc("POST /games/matches", httpx.RequireAuth(gamesCreateMatch))
	mux.HandleFunc("GET /games/matches", httpx.RequireAuth(gamesGetMatch))
	mux.HandleFunc("POST /games/matches/deal", httpx.RequireAuth(gamesAdvanceMatch))
}

// vaultIDFor resolves the caller's vault id.
//
// Vault ids are the ONLY identity the games server ever sees — the launch token
// carries vaultId and name and nothing else — so they are the only id that can
// be matched to a seat at a table. A user without one cannot be in a match; the
// backend assigns one lazily on /user/profile, which is why this is a 409 with
// a name rather than a 500.
func vaultIDFor(r *http.Request) (string, error) {
	var vid *string
	err := db.Pool.QueryRow(r.Context(),
		`SELECT vault_id FROM users WHERE id = $1`, httpx.UserFrom(r).ID).Scan(&vid)
	if err != nil {
		return "", err
	}
	if vid == nil || *vid == "" {
		return "", errNoVaultID
	}
	return *vid, nil
}

var errNoVaultID = errors.New("user has no vault id")

// gamesCreateMatch opens a match at a table, or returns the one already running
// there.
//
// It is deliberately idempotent on the table: every client at the table may try
// to open the match when the host announces it, and the partial unique index in
// migration 126 makes the loser of that race read back the winner's row instead
// of failing.
func gamesCreateMatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TableID string `json:"tableId"`
		Variant string `json:"variant"`
		// The client asserts the table is a practice one. See below for why this
		// is trusted, and what that does and does not mean.
		Practice bool `json:"practice"`
	}
	if err := httpx.Body(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Invalid body")
		return
	}
	tableID := strings.TrimSpace(body.TableID)
	variant := matchVariant(strings.TrimSpace(body.Variant))
	if tableID == "" || !variant.valid() {
		httpx.Err(w, http.StatusBadRequest, "A table and a known variant are required")
		return
	}

	// PRACTICE TABLES ONLY.
	//
	// A staked table settles coins on EVERY deal, but a pool's stake moves once
	// at the end — so a pool over a staked table charges the player per deal by
	// the games server and per match by us, the same loss taken twice.
	//
	// Only the games server knows a table's pointValue and it exposes no API to
	// ask, so this claim comes from the client. That is a real limitation and is
	// stated rather than papered over: a modified client could open a match on a
	// staked table. It would not gain anything by it — these are play coins, the
	// per-deal settlement is the games server's own and is unaffected by
	// anything here, and no coin moves through this file at all.
	if !body.Practice {
		httpx.Err(w, http.StatusBadRequest,
			"Pool and Deals matches run on practice tables only")
		return
	}

	vid, err := vaultIDFor(r)
	if errors.Is(err, errNoVaultID) {
		httpx.Err(w, http.StatusConflict, "User has no VaultID")
		return
	} else if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to open match")
		return
	}

	var (
		id          string
		vr          string
		status      string
		dealsPlayed int
		raw         []byte
	)
	// ON CONFLICT DO NOTHING then a read would be two round trips and a race of
	// its own; this returns the existing row in one statement either way.
	err = db.Pool.QueryRow(r.Context(), `
		WITH ins AS (
		  INSERT INTO games_matches (table_id, variant, host_vault_id, scores)
		  VALUES ($1, $2, $3, '{}'::JSONB)
		  ON CONFLICT (table_id) WHERE status = 'running' DO NOTHING
		  RETURNING id, variant, status, deals_played, scores
		)
		SELECT id, variant, status, deals_played, scores FROM ins
		UNION ALL
		SELECT id, variant, status, deals_played, scores FROM games_matches
		  WHERE table_id = $1 AND status = 'running'
		LIMIT 1`,
		tableID, string(variant), vid,
	).Scan(&id, &vr, &status, &dealsPlayed, &raw)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to open match")
		return
	}

	httpx.JSON(w, 200, matchJSON(id, tableID, matchVariant(vr), status, dealsPlayed, decodeScores(raw)))
}

// gamesGetMatch reads the running match at a table, if there is one.
//
// "No match" is a 200 with match:null, not a 404. The app asks this on every
// board open, and an error status for the ordinary case (no match at this
// table) would make a normal state indistinguishable from a broken backend —
// the same tolerance rule the live-tables endpoint follows.
func gamesGetMatch(w http.ResponseWriter, r *http.Request) {
	tableID := strings.TrimSpace(r.URL.Query().Get("tableId"))
	if tableID == "" {
		httpx.Err(w, http.StatusBadRequest, "tableId is required")
		return
	}

	var (
		id          string
		vr          string
		status      string
		dealsPlayed int
		raw         []byte
	)
	err := db.Pool.QueryRow(r.Context(), `
		SELECT id, variant, status, deals_played, scores
		  FROM games_matches
		 WHERE table_id = $1 AND status = 'running'`, tableID,
	).Scan(&id, &vr, &status, &dealsPlayed, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, 200, map[string]any{"ok": true, "match": nil})
		return
	} else if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to read match")
		return
	}

	httpx.JSON(w, 200, matchJSON(id, tableID, matchVariant(vr), status, dealsPlayed, decodeScores(raw)))
}

// gamesAdvanceMatch applies one deal's result.
//
// EXACTLY-ONCE, AND WHY IT MATTERS MORE THAN IT LOOKS
//
// Every seat at the table watches the same deal end, so all six will post it.
// The caller sends the deal index it believes it is reporting and the UPDATE
// applies only where deals_played still equals that index: the first writer
// wins, the other five change nothing and read back the same state. Without
// this guard one deal is counted once per player and every score is multiplied
// by the seat count — which in Pool eliminates the whole table at once.
func gamesAdvanceMatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MatchID   string       `json:"matchId"`
		DealIndex int          `json:"dealIndex"`
		Results   []dealResult `json:"results"`
	}
	if err := httpx.Body(r, &body); err != nil {
		httpx.Err(w, http.StatusBadRequest, "Invalid body")
		return
	}
	if strings.TrimSpace(body.MatchID) == "" || len(body.Results) == 0 {
		httpx.Err(w, http.StatusBadRequest, "A match and its deal results are required")
		return
	}

	if _, err := vaultIDFor(r); errors.Is(err, errNoVaultID) {
		httpx.Err(w, http.StatusConflict, "User has no VaultID")
		return
	} else if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to advance match")
		return
	}

	var (
		tableID     string
		vr          string
		status      string
		dealsPlayed int
		raw         []byte
	)
	err := db.Pool.QueryRow(r.Context(), `
		SELECT table_id, variant, status, deals_played, scores
		  FROM games_matches WHERE id = $1`, body.MatchID,
	).Scan(&tableID, &vr, &status, &dealsPlayed, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Err(w, http.StatusNotFound, "No such match")
		return
	} else if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to advance match")
		return
	}

	variant := matchVariant(vr)
	scores := decodeScores(raw)

	// A stale or duplicate report is NOT an error — it is the expected case for
	// five of the six seats. Return the current state so every client converges
	// on it rather than showing a failure for behaving correctly.
	if status != "running" || body.DealIndex != dealsPlayed {
		httpx.JSON(w, 200, matchJSON(body.MatchID, tableID, variant, status, dealsPlayed, scores))
		return
	}

	next := applyDeal(variant, scores, body.Results)
	nextDeals := dealsPlayed + 1
	nextStatus := "running"
	if matchOver(variant, next, nextDeals) {
		nextStatus = "finished"
	}

	encoded, err := json.Marshal(next)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to advance match")
		return
	}

	// The WHERE deals_played = $4 is the guard itself. Two clients that read the
	// same index and both compute an advance will both try to write it; only one
	// row is updated, and the other reads the winner's state below.
	var okWrite bool
	err = db.Pool.QueryRow(r.Context(), `
		UPDATE games_matches
		   SET scores = $1, deals_played = $2, status = $3, updated_at = now()
		 WHERE id = $4 AND deals_played = $5 AND status = 'running'
		RETURNING TRUE`,
		encoded, nextDeals, nextStatus, body.MatchID, dealsPlayed,
	).Scan(&okWrite)
	if errors.Is(err, pgx.ErrNoRows) {
		// Lost the race. Re-read and return what the winner wrote.
		_ = db.Pool.QueryRow(r.Context(), `
			SELECT variant, status, deals_played, scores FROM games_matches WHERE id = $1`,
			body.MatchID).Scan(&vr, &status, &dealsPlayed, &raw)
		httpx.JSON(w, 200, matchJSON(body.MatchID, tableID, matchVariant(vr), status, dealsPlayed, decodeScores(raw)))
		return
	} else if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "Failed to advance match")
		return
	}

	httpx.JSON(w, 200, matchJSON(body.MatchID, tableID, variant, nextStatus, nextDeals, next))
}

// decodeScores never fails the request over a bad blob: an unreadable scoreboard
// reads as an empty one, which the client renders as "no scores yet" rather than
// an error screen over a live game.
func decodeScores(raw []byte) map[string]matchScore {
	out := map[string]matchScore{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}

// matchJSON is the one shape every match response uses. The client reads the
// match from three endpoints and a shape that differed between them is how a
// field ends up missing on the path nobody tested.
func matchJSON(id, tableID string, v matchVariant, status string, dealsPlayed int, scores map[string]matchScore) map[string]any {
	if scores == nil {
		scores = map[string]matchScore{}
	}
	return map[string]any{
		"ok": true,
		"match": map[string]any{
			"id":          id,
			"tableId":     tableID,
			"variant":     string(v),
			"status":      status,
			"dealsPlayed": dealsPlayed,
			// Both limits are published so the app renders "83 / 101" and
			// "deal 2 of 6" without knowing the rules — the thin-client rule.
			"poolLimit":  v.poolLimit(),
			"dealsTotal": v.dealsTotal(),
			"scores":     scores,
		},
	}
}
