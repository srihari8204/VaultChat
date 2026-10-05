package domain

import "testing"

func f(v float64) *float64 { return &v }

// Rows come back in the order Valhalla was ASKED, which is not the caller's
// order once unusable sources have been dropped. Attributing one member's ETA
// to another is invisible on screen, so it gets the first test.
func TestLegsRemapsIndexes(t *testing.T) {
	// Caller sent 4 sources; #1 had no coordinate, so only 0, 2, 3 were asked.
	srcIdx := []int{0, 2, 3}
	got := Legs(srcIdx, [][]MatrixCell{
		{{f(1.2), f(300)}},
		{{f(5.8), f(720)}},
		{{f(0.45), f(90)}}})
	if len(got) != 3 {
		t.Fatalf("want 3 results, got %d", len(got))
	}
	want := []struct{ idx, m, s int }{{0, 1200, 300}, {2, 5800, 720}, {3, 450, 90}}
	for i, w := range want {
		if got[i].Index != w.idx {
			t.Errorf("row %d: index = %v, want %d", i, got[i].Index, w.idx)
		}
		if got[i].DistanceM != w.m {
			t.Errorf("row %d: distanceM = %v, want %d (km must become metres)", i, got[i].DistanceM, w.m)
		}
		if got[i].DurationS != w.s {
			t.Errorf("row %d: durationS = %v, want %d", i, got[i].DurationS, w.s)
		}
	}
}

// An unreachable member must vanish from the results, not arrive as 0 — a zero
// would render as "0 m away · 1 min" and read as the NEAREST member.
func TestLegsOmitsUnreachable(t *testing.T) {
	got := Legs([]int{0, 1, 2}, [][]MatrixCell{
		{{f(2.0), f(400)}},
		{{nil, nil}},
		{{f(3.0), f(500)}}})
	if len(got) != 2 {
		t.Fatalf("want 2 reachable results, got %d", len(got))
	}
	for _, r := range got {
		if r.Index == 1 {
			t.Fatal("an unreachable source must be omitted entirely")
		}
		if r.DistanceM == 0 {
			t.Fatal("no result may be a zero distance")
		}
	}
}

// Garbage in must not produce confident numbers out.
func TestLegsRejectsJunk(t *testing.T) {
	if got := Legs([]int{0, 1}, nil); len(got) != 0 {
		t.Fatalf("no rows should yield no results, got %d", len(got))
	}

	// More rows than the caller had sources, an empty row, and a negative.
	got := Legs([]int{0}, [][]MatrixCell{
		{{f(1.0), f(100)}},
		{},
		{{f(-4.0), f(100)}},
		{{f(9.0), f(900)}}})
	if len(got) != 1 || got[0].Index != 0 {
		t.Fatalf("rows beyond the caller's sources must be dropped, got %v", got)
	}
}

func TestLatLngValid(t *testing.T) {
	ok := [][2]float64{{17.385, 78.4867}, {-33.9, 151.2}, {90, 180}, {-90, -180}}
	for _, c := range ok {
		if !(LatLng{c[0], c[1]}).Valid() {
			t.Errorf("Valid(%v, %v) = false, want true", c[0], c[1])
		}
	}
	bad := [][2]float64{
		{0, 0},     // null island — what a missing fix serialises to
		{91, 10},   // latitude past the pole
		{10, 181},  // longitude past the antimeridian
		{-90.1, 0}, //
	}
	for _, c := range bad {
		if (LatLng{c[0], c[1]}).Valid() {
			t.Errorf("Valid(%v, %v) = true, want false", c[0], c[1])
		}
	}
}
