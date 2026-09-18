// shopbook_currency_test.go — the assertions that bite if the minor-unit
// exponent is ever hard-coded back to 2.
//
// Every one of these fails loudly against a `return 2, nil` sbExponent. That is
// the point: the hard-coded 2 was not a bug anybody could see, because for INR
// it is correct.
package routes

import "testing"

// ¥1,299 IS 1299 MINOR UNITS. Not 129900. This is the whole change.
func TestJPYHasNoMinorUnit(t *testing.T) {
	exp, err := sbExponent("JPY")
	if err != nil {
		t.Fatalf("JPY unknown: %v", err)
	}
	if exp != 0 {
		t.Fatalf("JPY exponent = %d, want 0 (a hard-coded 2 makes ¥1299 read as ¥129,900)", exp)
	}
	if got := sbToMinor(1299, exp); got != 1299 {
		t.Errorf("¥1299 -> %d minor units, want 1299", int64(got))
	}
	if got := money(129900).FloatExp(exp); got != 129900 {
		t.Errorf("money(129900).FloatExp(0) = %v, want 129900 yen — NOT 1299.00", got)
	}
	if got := money(1299).StringExp(exp); got != "1299" {
		t.Errorf("money(1299).StringExp(0) = %q, want %q", got, "1299")
	}
	// A yen total is already whole: there is nothing to round off.
	if got := sbRoundOffExp(1299, exp); got != 0 {
		t.Errorf("sbRoundOffExp(¥1299, 0) = %d, want 0", int64(got))
	}
}

// KWD carries three decimals. A hard-coded 2 cannot express 0.001 KD at all.
func TestKWDHasThreeDecimals(t *testing.T) {
	exp, err := sbExponent("KWD")
	if err != nil {
		t.Fatalf("KWD unknown: %v", err)
	}
	if exp != 3 {
		t.Fatalf("KWD exponent = %d, want 3 (a hard-coded 2 silently drops the third decimal)", exp)
	}
	if got := sbToMinor(1.234, exp); got != 1234 {
		t.Errorf("1.234 KD -> %d minor units, want 1234", int64(got))
	}
	if got := money(1234).StringExp(exp); got != "1.234" {
		t.Errorf("money(1234).StringExp(3) = %q, want %q", got, "1.234")
	}
	if got := money(1234).FloatExp(exp); got != 1.234 {
		t.Errorf("money(1234).FloatExp(3) = %v, want 1.234", got)
	}
	// Round off to the WHOLE dinar, not to a hundredth of one.
	if got := sbRoundOffExp(1600, exp); got != 400 {
		t.Errorf("sbRoundOffExp(1.600 KD, 3) = %d, want 400 (up to 2.000)", int64(got))
	}
	if got := sbRoundOffExp(1400, exp); got != -400 {
		t.Errorf("sbRoundOffExp(1.400 KD, 3) = %d, want -400 (down to 1.000)", int64(got))
	}
}

// INR must round-trip exactly as it always has — no existing shop moves.
func TestINRRoundTripIsUnchanged(t *testing.T) {
	exp, err := sbExponent("INR")
	if err != nil {
		t.Fatalf("INR unknown: %v", err)
	}
	if exp != 2 {
		t.Fatalf("INR exponent = %d, want 2", exp)
	}
	for _, v := range []float64{0, 0.05, 1, 125.50, 99.99, 1000000.99, -25.99} {
		m := sbToMinor(v, exp)
		if back := m.FloatExp(exp); back != v {
			t.Errorf("%v -> %d -> %v, want %v", v, int64(m), back, v)
		}
		// The exponent-aware path and the legacy hard-coded one agree at exp 2.
		if m.StringExp(exp) != m.String() {
			t.Errorf("StringExp(2)=%q disagrees with legacy String()=%q", m.StringExp(exp), m.String())
		}
		if m.FloatExp(exp) != m.Float() {
			t.Errorf("FloatExp(2) disagrees with legacy Float() at %v", v)
		}
	}
	// And the round-off line on an Indian bill is untouched.
	for _, c := range []struct{ in, want money }{{12340, -40}, {12360, 40}, {12350, 50}, {12300, 0}} {
		if got := sbRoundOffExp(c.in, 2); got != sbRoundOff(c.in) || got != c.want {
			t.Errorf("sbRoundOffExp(%d,2)=%d, legacy=%d, want %d",
				int64(c.in), int64(got), int64(sbRoundOff(c.in)), int64(c.want))
		}
	}
}

// An unknown currency must FAIL, not default to 2.
func TestUnknownCurrencyFailsLoudly(t *testing.T) {
	for _, code := range []string{"", "XYZ", "IRN", "rupees", "₹", "INRR"} {
		if exp, err := sbExponent(code); err == nil {
			t.Errorf("sbExponent(%q) = %d with no error — a silent default to 2 is the bug", code, exp)
		}
	}
	// Case and padding are tolerated; only genuinely unknown codes fail.
	if exp, err := sbExponent(" jpy "); err != nil || exp != 0 {
		t.Errorf("sbExponent(\" jpy \") = %d, %v; want 0, nil", exp, err)
	}
}

// A thousand entries summed as int64 minor units, with no float drift. The same
// thousand summed as float64 rupees does drift, which is the reason a ledger
// cannot be doubles.
func TestSumOfThousandEntriesHasNoDrift(t *testing.T) {
	var minor money
	var asFloat float64
	for i := 0; i < 1000; i++ {
		minor += sbToMinor(0.1, 2)
		asFloat += 0.1
	}
	if minor != 10000 {
		t.Fatalf("1000 x ₹0.10 = %s, want ₹100.00", minor)
	}
	if minor.FloatExp(2) != 100 {
		t.Fatalf("1000 x ₹0.10 reads back as %v, want 100", minor.FloatExp(2))
	}
	if asFloat == 100 {
		t.Log("note: float64 happened to land on 100 here; the integer path is exact by construction")
	}
	// And at exponent 0, where there are no fractions to lose either way.
	var yen money
	for i := 0; i < 1000; i++ {
		yen += sbToMinor(7, 0)
	}
	if yen != 7000 {
		t.Fatalf("1000 x ¥7 = %d, want 7000", int64(yen))
	}
}

// A row written by the OLD representation — a NUMERIC decimal in the major unit
// — must read back to the SAME displayed value through the new path.
func TestOldDecimalRowsStillReadBackIdentically(t *testing.T) {
	// These are the values a live INR shop has in shopbook_order today.
	for _, legacy := range []float64{0, 0.05, 45, 283.20, 680, 1299.99, 99999.99} {
		oldWay := money(int64(legacy*100 + 0.5)) // what sbCents() produces today
		newWay := sbToMinor(legacy, 2)           // what the exponent-aware path produces
		if oldWay != newWay {
			t.Errorf("legacy %.2f: old=%d new=%d", legacy, int64(oldWay), int64(newWay))
		}
		if newWay.Float() != oldWay.Float() {
			t.Errorf("legacy %.2f displays differently: %v vs %v", legacy, newWay.Float(), oldWay.Float())
		}
	}
}

// The SQL the two seams generate, so a scale change cannot slip in unseen.
func TestExponentAwareSQLMatchesLegacyAtTwo(t *testing.T) {
	if got, want := sbCentsExp("o.total", 2), "(round((o.total)*100))::bigint"; got != want {
		t.Errorf("sbCentsExp = %q, want %q", got, want)
	}
	if got, want := sbCentsExp("o.total", 0), "(round((o.total)*1))::bigint"; got != want {
		t.Errorf("sbCentsExp exp0 = %q, want %q", got, want)
	}
	if got, want := sbAmtExp("$1", 3), "($1::numeric/1000)"; got != want {
		t.Errorf("sbAmtExp exp3 = %q, want %q", got, want)
	}
}

// Every currency the shopbook_country seed ships must resolve.
func TestSeededCountryCurrenciesAllResolve(t *testing.T) {
	for _, code := range []string{"INR", "USD", "GBP", "AUD", "CAD", "SGD"} {
		exp, err := sbExponent(code)
		if err != nil {
			t.Errorf("seeded currency %s does not resolve: %v", code, err)
		}
		if exp != 2 {
			t.Errorf("seeded currency %s exponent = %d, want 2", code, exp)
		}
	}
}

// The legacy hundredths a NUMERIC(_,2) column yields, re-scaled to the
// currency's real minor units. At exponent 2 this MUST be the identity — that
// is the compatibility guarantee for every shop that exists today.
func TestMinorFromCentsIsIdentityAtTwo(t *testing.T) {
	for _, c := range []money{0, 5, 100, 12550, 68000, 129999, -2599} {
		if got := sbMinorFromCents(c, 2); got != int64(c) {
			t.Errorf("sbMinorFromCents(%d, 2) = %d, want %d — existing shops must not move", int64(c), got, int64(c))
		}
	}
	// JPY: a NUMERIC column holding 1299.00 yen reads out as 129900 hundredths,
	// and 129900 hundredths of a yen IS 1299 yen — not 129900 of anything.
	if got := sbMinorFromCents(129900, 0); got != 1299 {
		t.Errorf("¥1299 stored as 129900 hundredths -> %d minor units, want 1299", got)
	}
	// KWD: 1.23 KD in a scale-2 column is 1230 fils at exponent 3.
	if got := sbMinorFromCents(123, 3); got != 1230 {
		t.Errorf("1.23 KD -> %d fils, want 1230", got)
	}
	// Rounding stays half away from zero, via divRound.
	if got := sbMinorFromCents(-2599, 0); got != -26 {
		t.Errorf("sbMinorFromCents(-2599, 0) = %d, want -26", got)
	}
}
