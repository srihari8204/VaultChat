// shopbook_ledger_items_test.go — what a khata credit entry is worth.
//
// This is the number the customer owes, the number the invoice prints, and the
// number the credit-limit check fires on. All three read it from one function,
// so this is the only place the arithmetic can be wrong. No DB needed: it is
// pure arithmetic over the request body.
package routes

import "testing"

func TestSbLedgerItemsTotal(t *testing.T) {
	for _, tc := range []struct {
		name  string
		items []sbLedgerItemIn
		want  money // cents
	}{
		{"single line", []sbLedgerItemIn{{Name: "Rice", Qty: 1, Price: 300}}, 30000},
		{"multiple lines",
			[]sbLedgerItemIn{{Name: "Rice", Qty: 1, Price: 300}, {Name: "Sugar", Qty: 2, Price: 100}},
			50000},
		{"fractional qty — 1.5kg of loose dal",
			[]sbLedgerItemIn{{Name: "Dal", Qty: 1.5, Price: 120}}, 18000},
		// 0.1+0.2 float folklore, in rupees. Rounding per line is what keeps
		// this exact; summing raw floats first would not.
		{"prices that do not survive binary floats",
			[]sbLedgerItemIn{{Name: "A", Qty: 3, Price: 0.1}}, 30},
		{"paisa precision survives",
			[]sbLedgerItemIn{{Name: "Toffee", Qty: 7, Price: 2.50}}, 1750},
		{"free item is legitimate", []sbLedgerItemIn{{Name: "Sample", Qty: 1, Price: 0}}, 0},
		{"name is trimmed, not rejected",
			[]sbLedgerItemIn{{Name: "  Rice  ", Qty: 1, Price: 10}}, 1000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := sbLedgerItemsTotal(tc.items)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("total = %d cents, want %d", got, tc.want)
			}
		})
	}
}

func TestSbLedgerItemsTotalRejects(t *testing.T) {
	for _, tc := range []struct {
		name  string
		items []sbLedgerItemIn
	}{
		// A nameless line on an invoice is a charge the customer cannot check.
		{"blank name", []sbLedgerItemIn{{Name: "", Qty: 1, Price: 10}}},
		{"whitespace-only name", []sbLedgerItemIn{{Name: "   ", Qty: 1, Price: 10}}},
		{"zero qty", []sbLedgerItemIn{{Name: "Rice", Qty: 0, Price: 10}}},
		// Would silently reduce what the customer owes.
		{"negative qty", []sbLedgerItemIn{{Name: "Rice", Qty: -1, Price: 10}}},
		{"negative price", []sbLedgerItemIn{{Name: "Rice", Qty: 1, Price: -10}}},
		{"one bad line among good ones", []sbLedgerItemIn{
			{Name: "Rice", Qty: 1, Price: 300},
			{Name: "", Qty: 1, Price: 100},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := sbLedgerItemsTotal(tc.items); err == nil {
				t.Errorf("accepted %s; want rejection", tc.name)
			}
		})
	}

	big := make([]sbLedgerItemIn, 201)
	for i := range big {
		big[i] = sbLedgerItemIn{Name: "x", Qty: 1, Price: 1}
	}
	if _, err := sbLedgerItemsTotal(big); err == nil {
		t.Error("accepted 201 lines; want rejection")
	}
	if _, err := sbLedgerItemsTotal(big[:200]); err != nil {
		t.Errorf("rejected exactly 200 lines: %v", err)
	}
}

// The trim must reach the caller: sbAddLedgerEntry inserts these same structs,
// so a name validated after trimming but stored untrimmed would put "  Rice  "
// on the invoice.
func TestSbLedgerItemsTotalTrimsInPlace(t *testing.T) {
	items := []sbLedgerItemIn{{Name: "  Rice  ", Qty: 1, Price: 10}}
	if _, err := sbLedgerItemsTotal(items); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if items[0].Name != "Rice" {
		t.Errorf("stored name = %q, want %q", items[0].Name, "Rice")
	}
}
