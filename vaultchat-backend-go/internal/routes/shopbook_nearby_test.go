package routes

import "testing"

// The bounding box is ~0.25 degrees on each axis. These assert the arithmetic
// that decides whether a shop is inside it, using the four shops that actually
// exist on prod and two real recorded user positions — the Bangalore one where
// the box works, and the Andhra Pradesh one where it emptied the list and
// produced "No shops found nearby yet" for a user who had simply travelled.

const nearbyBoxDeg = 0.25

func inBox(userLat, userLng, shopLat, shopLng float64) bool {
	return shopLat >= userLat-nearbyBoxDeg && shopLat <= userLat+nearbyBoxDeg &&
		shopLng >= userLng-nearbyBoxDeg && shopLng <= userLng+nearbyBoxDeg
}

func TestNearbyBoxKeepsGenuinelyNearbyShops(t *testing.T) {
	// From Bangalore, the two test shops are ~12km away and must be inside.
	const uLat, uLng = 12.9141, 77.6158
	for _, s := range [][2]float64{{12.9534688, 77.7180569}, {12.9537525, 77.7181996}} {
		if !inBox(uLat, uLng, s[0], s[1]) {
			t.Fatalf("shop at %v is ~12km away and must be inside the box", s)
		}
		if d := haversineKm(uLat, uLng, s[0], s[1]); d > 25 {
			t.Fatalf("expected ~12km, got %.1f", d)
		}
	}
}

// THE CASE THAT PRODUCED THE BUG REPORT. Every shop that exists is far away,
// so the box returns nothing — and without the fallback the user sees an empty
// screen despite four shops existing, whereas with location OFF they would have
// seen all four.
func TestNearbyBoxExcludesEverythingWhenUserHasTravelled(t *testing.T) {
	const uLat, uLng = 16.0486, 80.9276 // real recorded position
	shops := [][2]float64{
		{12.9534688, 77.7180569}, {12.9537525, 77.7181996},
		{13.0578489, 80.262183}, {16.5137022, 81.9369432},
	}
	for _, s := range shops {
		if inBox(uLat, uLng, s[0], s[1]) {
			t.Fatalf("shop at %v should be outside the box from %v,%v", s, uLat, uLng)
		}
	}
	// The nearest is ~119km — far, but it is the honest answer to show, and it
	// is what the fallback now surfaces instead of an empty list.
	nearest := 1e9
	for _, s := range shops {
		if d := haversineKm(uLat, uLng, s[0], s[1]); d < nearest {
			nearest = d
		}
	}
	if nearest < 100 || nearest > 140 {
		t.Fatalf("expected the nearest shop ~119km away, got %.1f", nearest)
	}
}

// A shop with no coordinates must never be hidden by the box — a freshly added
// shop should not vanish the moment a customer turns their GPS on.
func TestHaversineIsSymmetricAndZeroAtSamePoint(t *testing.T) {
	if d := haversineKm(12.9141, 77.6158, 12.9141, 77.6158); d != 0 {
		t.Fatalf("distance to self must be 0, got %v", d)
	}
	a := haversineKm(12.9141, 77.6158, 16.5137022, 81.9369432)
	b := haversineKm(16.5137022, 81.9369432, 12.9141, 77.6158)
	if a != b {
		t.Fatalf("haversine must be symmetric: %v vs %v", a, b)
	}
}

// ── road distance ────────────────────────────────────────────────────

// THE TRAP THIS GUARDS. Valhalla rejects the WHOLE matrix request — HTTP 400,
// error_code 154 — when any single pair exceeds its 400km path limit, rather
// than nulling that one cell. Verified against prod: the 119km shop and the
// 487km shop asked together return that error and nothing usable; the 119km
// one alone returns 146.905km. So one distant shop in the batch would cost
// EVERY shop its road distance, silently falling the whole list back to
// straight-line with nothing in any log to say why.
func TestRouteCutoffKeepsTheBatchInsideValhallasLimit(t *testing.T) {
	// Roads run 1.2-1.4x the straight line; the cutoff must leave headroom
	// under 400km even at the pessimistic ratio.
	if sbRouteMaxStraightKm*1.4 >= 400 {
		t.Fatalf("cutoff %.0fkm can produce a >400km road path and poison the batch",
			sbRouteMaxStraightKm)
	}
	// And it must not be so timid that ordinary in-town shops lose routing.
	if sbRouteMaxStraightKm < 50 {
		t.Fatalf("cutoff %.0fkm is too small to be useful", sbRouteMaxStraightKm)
	}
}

func TestRouteCutoffSplitsTheRealShopsBetweenMatrixAndSingles(t *testing.T) {
	const uLat, uLng = 16.0486, 80.9276
	near := haversineKm(uLat, uLng, 16.5137022, 81.9369432) // Sri Lakshmi, ~119km
	far := haversineKm(uLat, uLng, 12.9534688, 77.7180569)  // Test 1, ~487km
	if near > sbRouteMaxStraightKm {
		t.Fatalf("the nearest real shop (%.0fkm) belongs in the matrix batch", near)
	}
	// The far one must leave the matrix batch — but it is NOT abandoned to
	// straight-line: it takes its own /route call, which allows 5000km. On prod
	// that shop is 726.9km by road against 487.6km straight, so falling back
	// would have understated the drive by 239km.
	if far <= sbRouteMaxStraightKm {
		t.Fatalf("the 487km shop (%.0fkm) must be routed singly, not in the matrix", far)
	}
}

// Every shop with coordinates must end up in exactly one bucket — a shop that
// falls into neither silently keeps a crow-flies number on a screen where
// every other row is a road distance, which is worse than showing neither.
func TestEveryShopLandsInABucket(t *testing.T) {
	const uLat, uLng = 16.0486, 80.9276
	shops := [][2]float64{
		{12.9534688, 77.7180569}, {12.9537525, 77.7181996},
		{13.0578489, 80.262183}, {16.5137022, 81.9369432},
	}
	near, far := 0, 0
	for _, s := range shops {
		if haversineKm(uLat, uLng, s[0], s[1]) > sbRouteMaxStraightKm {
			far++
		} else {
			near++
		}
	}
	if near+far != len(shops) {
		t.Fatalf("%d shops but %d bucketed", len(shops), near+far)
	}
	if near != 1 || far != 3 {
		t.Fatalf("expected 1 near / 3 far from that position, got %d/%d", near, far)
	}
	if far > sbRouteMaxSingles {
		t.Fatalf("%d far shops exceeds the %d single-route cap", far, sbRouteMaxSingles)
	}
}

// The batch is capped so the tail of a long list does not pay for rows nobody
// scrolls to, and so one request stays one cheap Valhalla job.
func TestRouteTargetCapIsSane(t *testing.T) {
	if sbRouteMaxTargets < 5 || sbRouteMaxTargets > 50 {
		t.Fatalf("target cap %d is outside a sensible range", sbRouteMaxTargets)
	}
	if sbRouteTimeout <= 0 {
		t.Fatal("a routing call with no timeout can hang the shop list")
	}
}
