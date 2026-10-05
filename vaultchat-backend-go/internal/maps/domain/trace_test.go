package domain

import "testing"

// Decimate keeps a very long track inside Valhalla's shape limit. The property
// that matters is the ENDPOINTS: dropping the last fix silently shortens the
// day, and a travelled distance that is quietly too small is worse than one
// that is obviously missing.

func TestDecimateKeepsBothEnds(t *testing.T) {
	pts := make([]LatLng, 5000)
	for i := range pts {
		pts[i] = LatLng{float64(i) / 1000, float64(i) / 1000}
	}
	out := Decimate(pts, 100)
	if len(out) != 100 {
		t.Fatalf("expected 100 points, got %d", len(out))
	}
	if out[0] != pts[0] {
		t.Fatal("first fix must survive")
	}
	if out[len(out)-1] != pts[len(pts)-1] {
		t.Fatal("last fix must survive — dropping it shortens the day")
	}
}

func TestDecimateLeavesShortTracksAlone(t *testing.T) {
	pts := []LatLng{{1, 1}, {2, 2}, {3, 3}}
	out := Decimate(pts, 16000)
	if len(out) != 3 {
		t.Fatalf("a short track must pass through untouched, got %d", len(out))
	}
}

func TestDecimateIsMonotonicInInputOrder(t *testing.T) {
	// A reordered track would map-match into nonsense, so the sampler must
	// preserve order.
	pts := make([]LatLng, 1000)
	for i := range pts {
		pts[i] = LatLng{float64(i), 0}
	}
	out := Decimate(pts, 50)
	for i := 1; i < len(out); i++ {
		if out[i].Lat <= out[i-1].Lat {
			t.Fatalf("order broken at %d: %v then %v", i, out[i-1], out[i])
		}
	}
}

func TestDecimateHandlesDegenerateCaps(t *testing.T) {
	pts := []LatLng{{1, 1}, {2, 2}, {3, 3}}
	if got := Decimate(pts, 1); len(got) != 3 {
		t.Fatalf("a cap below 2 must not mangle the track, got %d", len(got))
	}
	if got := Decimate(pts, 0); len(got) != 3 {
		t.Fatalf("a zero cap must not mangle the track, got %d", len(got))
	}
	if got := Decimate(nil, 10); got != nil {
		t.Fatal("nil in, nil out")
	}
}

// The split budget must be able to cover a realistically long day: Valhalla
// refuses a single trace over 200km, and halving 5 times turns one request into
// at most 32 pieces — 6400km of driving, far past any real day.
func TestTraceSplitDepthCoversALongDay(t *testing.T) {
	segments := 1
	for i := 0; i < MaxTraceSplitDepth; i++ {
		segments *= 2
	}
	if float64(segments)*200.0 < 2000 {
		t.Fatalf("split depth %d only covers %dkm", MaxTraceSplitDepth, segments*200)
	}
	if MaxTraceShape > 16000 {
		t.Fatalf("shape cap %d exceeds Valhalla's own limit", MaxTraceShape)
	}
}
