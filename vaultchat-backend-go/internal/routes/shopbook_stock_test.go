// shopbook_stock_test.go — the parts of inventory that are pure (P0-B).
//
// The reservation guard itself is a claim about Postgres and is rehearsed in
// migrations/tests/093_inventory_test.sql. What CAN be asserted here is the
// policy around it: which movement kinds an owner may post by hand, and which
// direction each of them is allowed to move stock. Both are the sort of thing
// a later edit widens by accident.
package routes

import "testing"

func TestManualMoveKindsExcludeTheOrderPipeline(t *testing.T) {
	// Reservations and sales are consequences of the order pipeline. If an
	// owner could post them by hand they could free stock they never had, or
	// record a sale with no order behind it — and the movement ledger would
	// stop being evidence of anything.
	for _, kind := range []string{"reservation", "reservation_release", "sale", "transfer"} {
		if sbManualMoveKinds[kind] {
			t.Errorf("%q is hand-postable; it belongs to the order pipeline", kind)
		}
	}
	for _, kind := range []string{"opening", "purchase", "damage", "adjustment", "return"} {
		if !sbManualMoveKinds[kind] {
			t.Errorf("%q should be hand-postable by the owner", kind)
		}
	}
}

func TestMoveSignIsForcedPerKind(t *testing.T) {
	cases := []struct {
		kind string
		in   int64
		want int64
	}{
		// Damage only ever removes, however the client phrased it.
		{"damage", 500, -500},
		{"damage", -500, -500},
		// Stock coming in only ever adds.
		{"opening", 1000, 1000},
		{"opening", -1000, 1000},
		{"purchase", -250, 250},
		{"return", -250, 250},
		// Adjustment is the one that can go either way — and the handler
		// demands a reason for exactly that reason.
		{"adjustment", -800, -800},
		{"adjustment", 800, 800},
	}
	for _, c := range cases {
		if got := sbMoveSign(c.kind, c.in); got != c.want {
			t.Errorf("sbMoveSign(%q, %d) = %d, want %d", c.kind, c.in, got, c.want)
		}
	}
}

func TestAbs64(t *testing.T) {
	for _, c := range []struct{ in, want int64 }{{-5, 5}, {5, 5}, {0, 0}} {
		if got := abs64(c.in); got != c.want {
			t.Errorf("abs64(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}
