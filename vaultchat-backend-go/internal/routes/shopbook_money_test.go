// shopbook_money_test.go — the money arithmetic (P0-A).
//
// These are the calculations a shopkeeper checks by hand and a tax officer
// checks on paper, so the tests are written the same way: a bill, and what it
// must add up to. No DB — the arithmetic is pure by design, which is the whole
// reason it was pulled out of the handlers.
package routes

import "testing"

func TestMoneyStringAndFloat(t *testing.T) {
	cases := []struct {
		m    money
		want string
	}{
		{12550, "125.50"}, {5, "0.05"}, {100, "1.00"}, {0, "0.00"}, {-2599, "-25.99"},
	}
	for _, c := range cases {
		if got := c.m.String(); got != c.want {
			t.Errorf("money(%d).String() = %q, want %q", int64(c.m), got, c.want)
		}
	}
	if got := money(12550).Float(); got != 125.50 {
		t.Errorf("Float() = %v, want 125.50", got)
	}
}

func TestDivRoundIsHalfAwayFromZero(t *testing.T) {
	cases := []struct{ n, d, want int64 }{
		{5, 2, 3}, {-5, 2, -3}, {4, 2, 2}, {1, 3, 0}, {2, 3, 1}, {-2, 3, -1}, {7, 0, 0},
	}
	for _, c := range cases {
		if got := divRound(c.n, c.d); got != c.want {
			t.Errorf("divRound(%d,%d) = %d, want %d", c.n, c.d, got, c.want)
		}
	}
}

// The weight-based line from the spec: 1.18 kg of chicken at ₹240.00/kg.
// In float64 this is 283.19999999999996 and rounds correctly only by luck.
func TestMulQtyWeightBased(t *testing.T) {
	price := money(24000) // ₹240.00
	if got := price.mulQty(118); got != 28320 {
		t.Errorf("1.18kg @ ₹240 = %s, want ₹283.20", got)
	}
	// A third of a kilo at ₹10 is ₹3.33 — the half-paisa goes up, once.
	if got := money(1000).mulQty(33); got != 330 {
		t.Errorf("0.33kg @ ₹10 = %s, want ₹3.30", got)
	}
}

func TestPctOfHandlesFractionalRates(t *testing.T) {
	// 18% GST on ₹100.00
	if got := money(10000).pctOf(1800); got != 1800 {
		t.Errorf("18%% of ₹100 = %s, want ₹18.00", got)
	}
	// 2.5% CGST on ₹99.99 → ₹2.49975, rounds to ₹2.50
	if got := money(9999).pctOf(250); got != 250 {
		t.Errorf("2.5%% of ₹99.99 = %s, want ₹2.50", got)
	}
	if got := money(10000).pctOf(0); got != 0 {
		t.Errorf("0%% of ₹100 = %s, want ₹0.00", got)
	}
}

// A discount that does not add back up to itself is how a bill ends up a
// paisa away from its own lines — and how a tax return stops reconciling.
func TestAllocateSumsExactly(t *testing.T) {
	cases := []struct {
		total   money
		weights []money
	}{
		{100, []money{3333, 3333, 3333}},   // ₹1 across three equal thirds
		{1, []money{1, 1, 1}},              // one paisa, three ways
		{999, []money{100, 200, 300, 400}}, // uneven weights
		{0, []money{500, 500}},
		{5000, []money{5000}},
	}
	for _, c := range cases {
		got := sbAllocate(c.total, c.weights)
		var sum money
		for _, g := range got {
			sum += g
			if g < 0 {
				t.Errorf("sbAllocate(%d,%v) produced a negative share %d", c.total, c.weights, g)
			}
		}
		if sum != c.total {
			t.Errorf("sbAllocate(%d,%v) = %v, sums to %d", c.total, c.weights, got, sum)
		}
	}
	// Nothing to split across → nothing allocated, and no divide-by-zero.
	if got := sbAllocate(500, []money{0, 0}); got[0] != 0 || got[1] != 0 {
		t.Errorf("sbAllocate onto zero weights = %v, want all zero", got)
	}
	if got := sbAllocate(500, nil); len(got) != 0 {
		t.Errorf("sbAllocate onto no lines = %v, want empty", got)
	}
}

// The largest remainder should get the odd paisa, not line 0 by default.
func TestAllocateGivesRemainderToLargestShare(t *testing.T) {
	// ₹0.10 across weights 1:2 → 0.03 / 0.07, not 0.04 / 0.06.
	got := sbAllocate(10, []money{100, 200})
	if got[0] != 3 || got[1] != 7 {
		t.Errorf("sbAllocate(10, [100 200]) = %v, want [3 7]", got)
	}
}

// End-to-end arithmetic of a real bill, done exactly as sbPriceLines does it:
// discount apportioned across lines, tax charged on the discounted amount.
//
//	Rice   5kg  @ ₹300.00 ×1   = ₹300.00  (5% tax)
//	Oil    1L   @ ₹145.00 ×2   = ₹290.00  (5% tax)
//	Sugar  1kg  @ ₹45.00  ×2   = ₹90.00   (0% tax)
//	                    subtotal ₹680.00
//	                    −₹20.00 coupon
//	                    tax on the taxable, discounted lines
func TestBillArithmeticReconciles(t *testing.T) {
	subtotals := []money{30000, 29000, 9000}
	rates := []int64{500, 500, 0}
	discount := money(2000)

	shares := sbAllocate(discount, subtotals)
	var subtotal, taxTotal, lineSum money
	for i := range subtotals {
		subtotal += subtotals[i]
		tax := (subtotals[i] - shares[i]).pctOf(rates[i])
		taxTotal += tax
		lineSum += subtotals[i] - shares[i] + tax
	}
	total := subtotal - discount + taxTotal

	if subtotal != 68000 {
		t.Errorf("subtotal = %s, want ₹680.00", subtotal)
	}
	var shareSum money
	for _, s := range shares {
		shareSum += s
	}
	if shareSum != discount {
		t.Errorf("apportioned discount = %s, want %s", shareSum, discount)
	}
	// The invariant that matters: the lines add up to the bill. If this ever
	// fails, the invoice and the khata are about to disagree.
	if lineSum != total {
		t.Errorf("Σ(line totals) = %s but order total = %s", lineSum, total)
	}
	if total != 68000-2000+taxTotal {
		t.Errorf("total = %s, inconsistent with its own parts", total)
	}
}

// India splits a rate into CGST/SGST halves. An odd number of paise must not
// vanish between them.
func TestTaxSplitHalvesAddBack(t *testing.T) {
	for _, tax := range []money{1800, 1801, 1, 0, 333} {
		parts := sbAllocate(tax, []money{1, 1})
		if parts[0]+parts[1] != tax {
			t.Errorf("CGST %s + SGST %s != %s", parts[0], parts[1], tax)
		}
	}
}

func TestIdemKeyPrefersHeaderAndIsBounded(t *testing.T) {
	if got := sbIdemKey("  hdr  ", "body"); got != "hdr" {
		t.Errorf("sbIdemKey preferred %q, want the header", got)
	}
	if got := sbIdemKey("", " body "); got != "body" {
		t.Errorf("sbIdemKey fell back to %q, want body", got)
	}
	if got := sbIdemKey("", ""); got != "" {
		t.Errorf("sbIdemKey with nothing = %q, want empty (idempotency off)", got)
	}
	long := make([]byte, 300)
	for i := range long {
		long[i] = 'k'
	}
	if got := sbIdemKey(string(long), ""); len(got) != 100 {
		t.Errorf("sbIdemKey length = %d, want it bounded to 100", len(got))
	}
}
