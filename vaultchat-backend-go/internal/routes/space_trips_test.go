// space_trips_test.go — the pure halves of the trip endpoints: the request
// gate and the TTL window. The SQL enforces what these specify; a drift
// between the client's TRIP_TTL_MS and tripTTL shows up here first.

package routes

import (
	"testing"
	"time"
)

func TestTripValid(t *testing.T) {
	cases := []struct {
		name string
		dest string
		lat  float64
		lng  float64
		want bool
	}{
		{"normal place", "Ramya Cafe", 17.385, 78.4867, true},
		{"empty name", "", 17.385, 78.4867, false},
		{"whitespace name", "   ", 17.385, 78.4867, false},
		{"name too long", string(make([]byte, 201)), 17.385, 78.4867, false},
		{"lat out of range", "X", 91, 0.1, false},
		{"lng out of range", "X", 0.1, 181, false},
		{"null island", "X", 0, 0, false},
		{"southern hemisphere", "X", -33.86, 151.2, true},
		{"boundary lat", "X", 90, 1, true},
	}
	for _, c := range cases {
		if got := tripValid(c.dest, c.lat, c.lng); got != c.want {
			t.Errorf("%s: tripValid(%q, %v, %v) = %v, want %v", c.name, c.dest, c.lat, c.lng, got, c.want)
		}
	}
}

func TestTripActiveSince(t *testing.T) {
	now := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	since := tripActiveSince(now)

	// The window is exactly the TTL — mirrors TRIP_TTL_MS (8h) in
	// lib/groups/trips.ts; if one moves, this test is the tripwire.
	if want := now.Add(-8 * time.Hour); !since.Equal(want) {
		t.Errorf("tripActiveSince = %v, want %v", since, want)
	}

	// A trip started inside the window is active; one outside is not.
	started := now.Add(-7 * time.Hour)
	if !started.After(since) {
		t.Error("a 7h-old trip must still be inside the active window")
	}
	stale := now.Add(-9 * time.Hour)
	if stale.After(since) {
		t.Error("a 9h-old trip must be outside the active window")
	}
}
