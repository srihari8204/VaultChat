package routes

import (
	"math"
	"testing"
)

func round2(f float64) float64 { return math.Round(f*100) / 100 }

// Shop Book catalog prices are shelf prices, so tax is CONTAINED IN the
// amount charged. Getting this backwards (P·r/100 instead of P·r/(100+r))
// makes the receipt total disagree with the cart and the khata, which is the
// bug this test exists to prevent.
func TestSbIncludedTaxIsInclusiveNotAdditive(t *testing.T) {
	lines := []sbInvoiceLine{
		{Name: "Atta", Qty: 1, Price: 105, TaxPercent: 5},
	}
	gross := 105.0
	tax, byRate := sbIncludedTax(lines, gross, gross)

	// 105 shelf price at 5% = 100 net + 5 tax.
	if got := round2(tax); got != 5 {
		t.Fatalf("included tax = %v, want 5 (tax inside the price, not added on top)", got)
	}
	if got := round2(byRate[5]); got != 5 {
		t.Fatalf("byRate[5] = %v, want 5", got)
	}
	// The taxable (ex-tax) value the owner's tax report aggregates.
	if got := round2(gross - tax); got != 100 {
		t.Fatalf("taxable value = %v, want 100", got)
	}
}

func TestSbIncludedTaxNeverExceedsTheAmountCharged(t *testing.T) {
	lines := []sbInvoiceLine{
		{Name: "A", Qty: 2, Price: 118, TaxPercent: 18},
		{Name: "B", Qty: 1, Price: 105, TaxPercent: 5},
		{Name: "C", Qty: 3, Price: 40, TaxPercent: 0}, // untaxed line
	}
	gross := 2*118 + 105 + 3*40.0
	tax, _ := sbIncludedTax(lines, gross, gross)
	if tax <= 0 || tax >= gross {
		t.Fatalf("tax %v must be >0 and < charged %v", tax, gross)
	}
	// Untaxed lines contribute nothing.
	want := round2(236*18/118.0 + 105*5/105.0)
	if got := round2(tax); got != want {
		t.Fatalf("tax = %v, want %v", got, want)
	}
}

// A discount reduces the amount charged, so the tax inside it shrinks
// proportionally — otherwise the receipt would report more tax than was paid.
func TestSbIncludedTaxScalesWithDiscount(t *testing.T) {
	lines := []sbInvoiceLine{{Name: "A", Qty: 1, Price: 200, TaxPercent: 10}}
	gross := 200.0
	full, _ := sbIncludedTax(lines, gross, gross)
	half, byRate := sbIncludedTax(lines, gross, gross/2)

	if got, want := round2(half), round2(full/2); got != want {
		t.Fatalf("half-price tax = %v, want %v", got, want)
	}
	if got, want := round2(byRate[10]), round2(full/2); got != want {
		t.Fatalf("byRate scaled = %v, want %v", got, want)
	}
}

func TestSbIncludedTaxZeroCases(t *testing.T) {
	if tax, byRate := sbIncludedTax(nil, 0, 0); tax != 0 || len(byRate) != 0 {
		t.Fatalf("no lines → no tax, got %v / %v", tax, byRate)
	}
	lines := []sbInvoiceLine{{Name: "A", Qty: 1, Price: 50, TaxPercent: 0}}
	if tax, _ := sbIncludedTax(lines, 50, 50); tax != 0 {
		t.Fatalf("untaxed line → 0 tax, got %v", tax)
	}
	// A fully discounted order charges nothing, so it contains no tax.
	if tax, _ := sbIncludedTax([]sbInvoiceLine{{Qty: 1, Price: 100, TaxPercent: 10}}, 100, 0); round2(tax) != 0 {
		t.Fatalf("zero charged → 0 tax, got %v", tax)
	}
}

// India splits a rate into equal CGST/SGST halves; the parts must sum back to
// the whole, or the receipt's tax lines won't reconcile with the total.
func TestSbTaxBreakdownSplitsSumToTotal(t *testing.T) {
	byRate := map[float64]float64{18: 36}
	out := sbTaxBreakdown(byRate, "GST", []string{"CGST", "SGST"}, true)
	if len(out) != 2 {
		t.Fatalf("want 2 split lines, got %d", len(out))
	}
	sum := 0.0
	for _, l := range out {
		sum += l["amount"].(float64)
	}
	if round2(sum) != 36 {
		t.Fatalf("split lines sum to %v, want 36", sum)
	}
	if got := out[0]["label"]; got != "CGST (9%)" {
		t.Fatalf("label = %v, want CGST (9%%)", got)
	}
}

func TestSbTaxBreakdownWithoutSplit(t *testing.T) {
	out := sbTaxBreakdown(map[float64]float64{20: 15}, "VAT", nil, true)
	if len(out) != 1 || out[0]["label"] != "VAT (20%)" || round2(out[0]["amount"].(float64)) != 15 {
		t.Fatalf("unexpected breakdown: %#v", out)
	}
	if got := sbTaxBreakdown(nil, "VAT", nil, true); len(got) != 0 {
		t.Fatalf("no tax → no breakdown lines, got %#v", got)
	}
}

// Tax sections appear only when the shop filled in at least one tax field —
// every tax field is optional, always.
func TestSbTaxConfigured(t *testing.T) {
	cases := []struct {
		name string
		cfg  map[string]any
		want bool
	}{
		{"empty", map[string]any{}, false},
		{"blank string", map[string]any{"gstin": ""}, false},
		{"whitespace only", map[string]any{"gstin": "   "}, false},
		{"false flag", map[string]any{"registered": false}, false},
		{"filled id", map[string]any{"gstin": "22AAAAA0000A1Z5"}, true},
		{"true flag", map[string]any{"registered": true}, true},
	}
	for _, c := range cases {
		if got := sbTaxConfigured(c.cfg); got != c.want {
			t.Errorf("%s: sbTaxConfigured = %v, want %v", c.name, got, c.want)
		}
	}
}
