package routes

import (
	"encoding/json"
	"testing"
)

func f(v float64) *float64 { return &v }

// Rows come back in the order Valhalla was ASKED, which is not the caller's
// order once unusable sources have been dropped. Attributing one member's ETA
// to another is invisible on screen, so it gets the first test.
func TestNormalizeMatrixRemapsIndexes(t *testing.T) {
	// Caller sent 4 sources; #1 had no coordinate, so only 0, 2, 3 were asked.
	srcIdx := []int{0, 2, 3}
	var v valhallaMatrix
	if err := json.Unmarshal([]byte(`{"sources_to_targets":[
		[{"distance":1.2,"time":300}],
		[{"distance":5.8,"time":720}],
		[{"distance":0.45,"time":90}]]}`), &v); err != nil {
		t.Fatal(err)
	}
	got := normalizeMatrix(srcIdx, v)
	if len(got) != 3 {
		t.Fatalf("want 3 results, got %d", len(got))
	}
	want := []struct{ idx, m, s int }{{0, 1200, 300}, {2, 5800, 720}, {3, 450, 90}}
	for i, w := range want {
		if got[i]["index"] != w.idx {
			t.Errorf("row %d: index = %v, want %d", i, got[i]["index"], w.idx)
		}
		if got[i]["distanceM"] != w.m {
			t.Errorf("row %d: distanceM = %v, want %d (km must become metres)", i, got[i]["distanceM"], w.m)
		}
		if got[i]["durationS"] != w.s {
			t.Errorf("row %d: durationS = %v, want %d", i, got[i]["durationS"], w.s)
		}
	}
}

// An unreachable member must vanish from the results, not arrive as 0 — a zero
// would render as "0 m away · 1 min" and read as the NEAREST member.
func TestNormalizeMatrixOmitsUnreachable(t *testing.T) {
	var v valhallaMatrix
	if err := json.Unmarshal([]byte(`{"sources_to_targets":[
		[{"distance":2.0,"time":400}],
		[{"distance":null,"time":null}],
		[{"distance":3.0,"time":500}]]}`), &v); err != nil {
		t.Fatal(err)
	}
	got := normalizeMatrix([]int{0, 1, 2}, v)
	if len(got) != 2 {
		t.Fatalf("want 2 reachable results, got %d", len(got))
	}
	for _, r := range got {
		if r["index"] == 1 {
			t.Fatal("an unreachable source must be omitted entirely")
		}
		if r["distanceM"] == 0 {
			t.Fatal("no result may be a zero distance")
		}
	}
}

// Garbage in must not produce confident numbers out.
func TestNormalizeMatrixRejectsJunk(t *testing.T) {
	var empty valhallaMatrix
	if got := normalizeMatrix([]int{0, 1}, empty); len(got) != 0 {
		t.Fatalf("no rows should yield no results, got %d", len(got))
	}

	var v valhallaMatrix
	// More rows than the caller had sources, an empty row, and a negative.
	if err := json.Unmarshal([]byte(`{"sources_to_targets":[
		[{"distance":1.0,"time":100}],
		[],
		[{"distance":-4.0,"time":100}],
		[{"distance":9.0,"time":900}]]}`), &v); err != nil {
		t.Fatal(err)
	}
	got := normalizeMatrix([]int{0}, v)
	if len(got) != 1 || got[0]["index"] != 0 {
		t.Fatalf("rows beyond the caller's sources must be dropped, got %v", got)
	}
}

func TestValidLatLng(t *testing.T) {
	ok := [][2]float64{{17.385, 78.4867}, {-33.9, 151.2}, {90, 180}, {-90, -180}}
	for _, c := range ok {
		if !validLatLng(c[0], c[1]) {
			t.Errorf("validLatLng(%v, %v) = false, want true", c[0], c[1])
		}
	}
	bad := [][2]float64{
		{0, 0},     // null island — what a missing fix serialises to
		{91, 10},   // latitude past the pole
		{10, 181},  // longitude past the antimeridian
		{-90.1, 0}, //
	}
	for _, c := range bad {
		if validLatLng(c[0], c[1]) {
			t.Errorf("validLatLng(%v, %v) = true, want false", c[0], c[1])
		}
	}
}
