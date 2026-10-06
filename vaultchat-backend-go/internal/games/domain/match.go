// match.go — Pool (101/201) and Deals (best-of-2/6) rummy scoring, layered
// over the games server's single-deal engine.
//
// Pool and Deals are, in rules terms, only scoring wrappers around repeated
// Points deals; the games server has no pool score, no elimination and no deal
// count (docs/GAMES_PROTOCOL.md), and is a deployment we do not own. So a match
// is a sequence of server-owned deals plus a score VaultChat owns. A pool score
// decides who is ELIMINATED, so every seat must agree on it and a device cannot
// be trusted to total its own — the thin-client rule (see migration 126).
//
// Score and DealResult carry JSON tags because their encoding IS the contract:
// the request body, the response body and the stored JSONB all use it.
package domain

// Variant is one of the four formats. The set is closed and matches the
// CHECK in migration 126 — a variant accepted here but rejected by the database
// would 500 on write instead of 400 on entry.
type Variant string

const (
	Pool101 Variant = "pool101"
	Pool201 Variant = "pool201"
	Deals2  Variant = "deals2"
	Deals6  Variant = "deals6"
)

// PoolLimit is the score at which a player is eliminated, and DealsTotal the
// number of deals a match runs for. Exactly one of the two applies to any
// variant; the zero value means "not this kind of match".
func (v Variant) PoolLimit() int {
	switch v {
	case Pool101:
		return 101
	case Pool201:
		return 201
	}
	return 0
}

func (v Variant) DealsTotal() int {
	switch v {
	case Deals2:
		return 2
	case Deals6:
		return 6
	}
	return 0
}

func (v Variant) Valid() bool {
	return v.PoolLimit() > 0 || v.DealsTotal() > 0
}

// Score is one player's standing in a match.
//
// Points and Chips are both carried for every variant even though each variant
// reads only one. Keeping the shape stable means the app renders one scoreboard
// component and the JSONB never changes shape between variants — a variant-
// dependent schema is how a field ends up missing on the one path nobody tested.
type Score struct {
	Name   string `json:"name"`
	Points int    `json:"points"`
	Chips  int    `json:"chips"`
	Status string `json:"status"` // "playing" | "out"
}

const (
	StatusPlaying = "playing"
	StatusOut     = "out"
)

// DealResult is one player's outcome in a single deal, as the games server
// reported it. Points is that deal's rummy points — 0 for the player who made a
// valid declaration, and the value of the unarranged cards for everyone else.
type DealResult struct {
	VaultID string `json:"vaultId"`
	Name    string `json:"name"`
	Points  int    `json:"points"`
	Winner  bool   `json:"winner"`
}

// ApplyDeal advances a match by one deal and returns the new scores.
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
func ApplyDeal(v Variant, scores map[string]Score, results []DealResult) map[string]Score {
	next := make(map[string]Score, len(scores)+len(results))
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
			next[r.VaultID] = Score{Name: r.Name, Points: 0, Chips: 0, Status: StatusPlaying}
		}
	}

	if limit := v.PoolLimit(); limit > 0 {
		for _, r := range results {
			s, ok := next[r.VaultID]
			if !ok || s.Status == StatusOut {
				continue
			}
			s.Points += max0(r.Points)
			if s.Points >= limit {
				s.Status = StatusOut
			}
			next[r.VaultID] = s
		}
		return next
	}

	// Deals: the winner collects what the others lose, so the chips in a match
	// stay conserved and a scoreboard that does not sum to zero is a bug.
	pot := 0
	for _, r := range results {
		if s, ok := next[r.VaultID]; !ok || s.Status == StatusOut || r.Winner {
			continue
		}
		pot += max0(r.Points)
	}
	for _, r := range results {
		s, ok := next[r.VaultID]
		if !ok || s.Status == StatusOut {
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

// MatchOver reports whether the match has finished, and why.
//
// Pool ends when one player is left; Deals when the agreed deals are played.
// A pool that somehow eliminates everyone in the same deal also ends — without
// this it would sit running forever with nobody able to play it.
func MatchOver(v Variant, scores map[string]Score, dealsPlayed int) bool {
	if total := v.DealsTotal(); total > 0 {
		return dealsPlayed >= total
	}
	alive := 0
	for _, s := range scores {
		if s.Status == StatusPlaying {
			alive++
		}
	}
	return alive <= 1
}

// Match statuses.
const (
	MatchRunning  = "running"
	MatchFinished = "finished"
)

// Match is one Pool or Deals match at a table.
type Match struct {
	ID, TableID string
	Variant     Variant
	Status      string
	DealsPlayed int
	Scores      map[string]Score
}

// Advance applies one deal and reports the match that results. A stale or
// duplicate report (another seat already reported this deal, or the match is
// over) is not an error — ok=false, and every client converges on the current
// state.
func (m Match) Advance(dealIndex int, results []DealResult) (next Match, ok bool) {
	if m.Status != MatchRunning || dealIndex != m.DealsPlayed {
		return m, false
	}
	next = m
	next.Scores = ApplyDeal(m.Variant, m.Scores, results)
	next.DealsPlayed = m.DealsPlayed + 1
	if MatchOver(m.Variant, next.Scores, next.DealsPlayed) {
		next.Status = MatchFinished
	}
	return next, true
}
