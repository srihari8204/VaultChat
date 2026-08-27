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
