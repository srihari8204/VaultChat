// space_items_test.go — the pure halves of the item endpoints: the request
// gate and the sighting freshness window. The SQL enforces what these
// specify; a stale-report regression would show up here first.

package routes

import (
	"strings"
	"testing"
	"time"
)

func TestItemValid(t *testing.T) {
	cases := []struct {
		name string
		ble  string
		item string
		want bool
	}{
		{"normal tag", "AA:BB:CC:DD:EE:FF", "Keys", true},
		{"uuid style id", "0000-1111-2222-3333", "Wallet", true},
		{"empty ble", "", "Keys", false},
		{"whitespace ble", "   ", "Keys", false},
		{"empty name", "AA:BB", "", false},
		{"whitespace name", "AA:BB", "  ", false},
		{"ble too long", strings.Repeat("a", 65), "Keys", false},
		{"name too long", "AA:BB", strings.Repeat("n", 81), false},
		{"name at limit", "AA:BB", strings.Repeat("n", 80), true},
	}
	for _, c := range cases {
		if got := itemValid(c.ble, c.item); got != c.want {
			t.Errorf("%s: itemValid(%q,%q) = %v, want %v", c.name, c.ble, c.item, got, c.want)
		}
	}
}

func TestItemSightingFresh(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)

	if !itemSightingFresh(now.UnixMilli(), now) {
		t.Error("a sighting stamped now must be fresh")
	}
	if !itemSightingFresh(now.Add(-30*time.Minute).UnixMilli(), now) {
		t.Error("a 30-minute-old sighting is still worth applying")
	}
	if itemSightingFresh(now.Add(-2*time.Hour).UnixMilli(), now) {
		t.Error("a two-hour-old sighting must be refused — it would move the answer backwards")
	}
	// Clock slop: a slightly-fast device is tolerated, a wildly future one is not.
	if !itemSightingFresh(now.Add(time.Minute).UnixMilli(), now) {
		t.Error("one minute of clock skew must be tolerated")
	}
	if itemSightingFresh(now.Add(10*time.Minute).UnixMilli(), now) {
		t.Error("a sighting ten minutes in the future is a bad clock or a replay")
	}
	// The boundary itself.
	if itemSightingFresh(now.Add(-61*time.Minute).UnixMilli(), now) {
		t.Error("just past the hour window must be refused")
	}
}
