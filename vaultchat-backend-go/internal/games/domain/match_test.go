package domain

import "testing"

// The scoring rules are the whole reason this layer exists, and they are pure —
// so they are tested directly, without a database. The handlers around them are
// thin by design.

func playing(name string) Score {
	return Score{Name: name, Status: StatusPlaying}
}

func TestVariantLimits(t *testing.T) {
	cases := []struct {
		v     Variant
		pool  int
		deals int
		valid bool
	}{
		{Pool101, 101, 0, true},
		{Pool201, 201, 0, true},
		{Deals2, 0, 2, true},
		{Deals6, 0, 6, true},
		{Variant("pool151"), 0, 0, false},
		{Variant(""), 0, 0, false},
	}
	for _, c := range cases {
		if got := c.v.PoolLimit(); got != c.pool {
			t.Errorf("%s poolLimit = %d, want %d", c.v, got, c.pool)
		}
		if got := c.v.DealsTotal(); got != c.deals {
			t.Errorf("%s dealsTotal = %d, want %d", c.v, got, c.deals)
		}
		if got := c.v.Valid(); got != c.valid {
			t.Errorf("%s valid = %v, want %v", c.v, got, c.valid)
		}
	}
}

func TestPoolAccumulatesAndEliminates(t *testing.T) {
	scores := map[string]Score{"a": playing("Asha"), "b": playing("Ravi")}

	// The winner of a deal scores 0; everyone else scores their unarranged cards.
	scores = ApplyDeal(Pool101, scores, []DealResult{
		{VaultID: "a", Points: 0, Winner: true},
		{VaultID: "b", Points: 60},
	})
	if scores["a"].Points != 0 || scores["b"].Points != 60 {
		t.Fatalf("after deal 1: a=%d b=%d, want 0/60", scores["a"].Points, scores["b"].Points)
	}
	if scores["b"].Status != StatusPlaying {
		t.Fatal("60 is under 101 and must not eliminate")
	}

	scores = ApplyDeal(Pool101, scores, []DealResult{
		{VaultID: "a", Points: 0, Winner: true},
		{VaultID: "b", Points: 41},
	})
	if scores["b"].Points != 101 {
		t.Fatalf("b = %d, want 101", scores["b"].Points)
	}
	// AT the limit is out, not over it — 101 pool means 101 eliminates.
	if scores["b"].Status != StatusOut {
		t.Fatal("reaching the limit exactly must eliminate")
	}
	if !MatchOver(Pool101, scores, 2) {
		t.Fatal("one player left standing ends a pool")
	}
}

func TestPool201NeedsMorePoints(t *testing.T) {
	scores := map[string]Score{"a": playing("Asha"), "b": playing("Ravi")}
	scores = ApplyDeal(Pool201, scores, []DealResult{
		{VaultID: "a", Points: 0, Winner: true},
		{VaultID: "b", Points: 101},
	})
	if scores["b"].Status != StatusPlaying {
		t.Fatal("101 must not eliminate in a 201 pool")
	}
	if MatchOver(Pool201, scores, 1) {
		t.Fatal("two players still in means the match runs on")
	}
}

// An eliminated player is skipped entirely. The games server has no concept of
// this match and will keep dealing them in, so their results DO arrive and must
// be ignored rather than assumed absent.
func TestEliminatedPlayerIsNotScoredAgain(t *testing.T) {
	scores := map[string]Score{
		"a": playing("Asha"),
		"b": {Name: "Ravi", Points: 101, Status: StatusOut},
		"c": playing("Meera"),
	}
	scores = ApplyDeal(Pool101, scores, []DealResult{
		{VaultID: "a", Points: 0, Winner: true},
		{VaultID: "b", Points: 40},
		{VaultID: "c", Points: 20},
	})
	if scores["b"].Points != 101 {
		t.Fatalf("an eliminated player's score moved: %d", scores["b"].Points)
	}
	if scores["c"].Points != 20 {
		t.Fatalf("c = %d, want 20", scores["c"].Points)
	}
}

// Chips are conserved: the winner collects exactly what the others lose, so a
// scoreboard that does not sum to zero is a bug.
func TestDealsChipsAreConserved(t *testing.T) {
	scores := map[string]Score{
		"a": playing("Asha"), "b": playing("Ravi"), "c": playing("Meera"),
	}
	scores = ApplyDeal(Deals2, scores, []DealResult{
		{VaultID: "a", Points: 0, Winner: true},
		{VaultID: "b", Points: 30},
		{VaultID: "c", Points: 25},
	})
	if scores["a"].Chips != 55 {
		t.Fatalf("winner chips = %d, want 55", scores["a"].Chips)
	}
	if scores["b"].Chips != -30 || scores["c"].Chips != -25 {
		t.Fatalf("losers = %d/%d, want -30/-25", scores["b"].Chips, scores["c"].Chips)
	}
	sum := 0
	for _, s := range scores {
		sum += s.Chips
	}
	if sum != 0 {
		t.Fatalf("chips must be conserved, sum = %d", sum)
	}
	if MatchOver(Deals2, scores, 1) {
		t.Fatal("a best-of-2 is not over after one deal")
	}
	if !MatchOver(Deals2, scores, 2) {
		t.Fatal("a best-of-2 ends after two deals, whatever the scores")
	}
}

// A pool never ends on a deal count, and a deals match never ends on
// elimination — mixing the two conditions is the easy mistake here.
func TestDealsDoesNotEndOnElimination(t *testing.T) {
	scores := map[string]Score{
		"a": playing("Asha"),
		"b": {Name: "Ravi", Status: StatusOut},
	}
	if MatchOver(Deals6, scores, 3) {
		t.Fatal("a deals match runs its full count regardless of who is out")
	}
}

// A player who joins partway through is seated rather than dropped: a match
// spans deals and the games server may seat someone new between them.
func TestLateJoinerIsSeated(t *testing.T) {
	scores := map[string]Score{"a": playing("Asha")}
	scores = ApplyDeal(Pool101, scores, []DealResult{
		{VaultID: "a", Points: 10},
		{VaultID: "z", Name: "Newcomer", Points: 15},
	})
	if _, ok := scores["z"]; !ok {
		t.Fatal("a new seat must be added to the match")
	}
	if scores["z"].Name != "Newcomer" || scores["z"].Points != 15 {
		t.Fatalf("late joiner = %+v", scores["z"])
	}
}

// Rummy points are never negative. A negative value from a client would let a
// player subtract their way back out of an elimination.
func TestNegativePointsCannotUnwindAScore(t *testing.T) {
	scores := map[string]Score{"a": {Name: "Asha", Points: 90, Status: StatusPlaying}}
	scores = ApplyDeal(Pool101, scores, []DealResult{{VaultID: "a", Points: -50}})
	if scores["a"].Points != 90 {
		t.Fatalf("a = %d, want 90 — a negative report must not reduce a score", scores["a"].Points)
	}
}

// applyDeal must not mutate the map it was given: the handler keeps the
// pre-advance scores to return when it loses the concurrency race.
func TestApplyDealDoesNotMutateInput(t *testing.T) {
	before := map[string]Score{"a": {Name: "Asha", Points: 10, Status: StatusPlaying}}
	ApplyDeal(Pool101, before, []DealResult{{VaultID: "a", Points: 20}})
	if before["a"].Points != 10 {
		t.Fatalf("input mutated: %d", before["a"].Points)
	}
}

// A pool where everyone crosses the limit in the same deal still ends; without
// this it would sit running forever with nobody able to play it.
func TestPoolEndsIfEveryoneIsEliminatedAtOnce(t *testing.T) {
	scores := map[string]Score{"a": playing("Asha"), "b": playing("Ravi")}
	scores = ApplyDeal(Pool101, scores, []DealResult{
		{VaultID: "a", Points: 120},
		{VaultID: "b", Points: 130},
	})
	if !MatchOver(Pool101, scores, 1) {
		t.Fatal("a pool with nobody left must end")
	}
}
