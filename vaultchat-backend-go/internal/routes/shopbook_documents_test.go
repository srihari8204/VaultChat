// shopbook_documents_test.go — the invoice template.
//
// This is the artefact a customer keeps and a shop is judged on, and it renders
// into a WebView, so two things must hold: the totals it prints are the ones it
// was given, and a shop name is never executable. No DB needed — the template
// is a pure function of the document map sbLoadInvoice builds.
package routes

import (
	"strings"
	"testing"
)

func renderDoc(t *testing.T, doc map[string]any) string {
	t.Helper()
	var sb strings.Builder
	if err := sbInvoiceTmpl.Execute(&sb, doc); err != nil {
		t.Fatalf("template execute: %v", err)
	}
	return sb.String()
}

func baseDoc() map[string]any {
	return map[string]any{
		"id": "d1", "source": "khata", "title": "Invoice", "status": "issued",
		"number": 12, "currency": "₹", "total": 500.0,
		"business":     map[string]any{"name": "Doc Store", "address": "Pangidi", "phone": "7793932101"},
		"items":        []map[string]any{{"name": "Rice", "unit": "5kg", "qty": 1.0, "price": 300.0, "total": 300.0}},
		"customerName": "Ravi", "walkinName": "", "walkinPhone": "",
	}
}

func TestInvoiceRendersTotalsAndParties(t *testing.T) {
	out := renderDoc(t, baseDoc())
	for _, want := range []string{
		"Doc Store", "Pangidi", "Invoice", "No. 12", "Ravi",
		"Rice", "(5kg)", "₹300.00", "₹500.00",
		"Made with VaultChat Shop Book",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered document missing %q", want)
		}
	}
}

// A shop picks its own name. If that name reaches the customer's WebView as
// markup, the shop can run script in it.
func TestInvoiceEscapesShopControlledText(t *testing.T) {
	doc := baseDoc()
	doc["business"] = map[string]any{"name": `<script>alert(1)</script>`, "address": "", "phone": ""}
	doc["items"] = []map[string]any{
		{"name": `<img src=x onerror=alert(2)>`, "unit": "", "qty": 1.0, "price": 1.0, "total": 1.0},
	}
	out := renderDoc(t, doc)
	// Assert on the ANGLE BRACKETS, not on the payload text. `onerror=alert(2)`
	// still appears inside `&lt;img src=x onerror=alert(2)&gt;`, which is inert
	// text — testing for the payload string reports a false failure on output
	// that is actually safe.
	if strings.Contains(out, "<script>") {
		t.Error("shop name rendered as live markup")
	}
	if strings.Contains(out, "<img src=x") {
		t.Error("item name rendered as live markup")
	}
	if !strings.Contains(out, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Error("shop name was not escaped")
	}
	if !strings.Contains(out, "&lt;img src=x onerror=alert(2)&gt;") {
		t.Error("item name was not escaped")
	}
}

// A payment receipt has no goods. It must still state the amount rather than
// rendering an empty table with nothing owed on it.
func TestReceiptWithoutItemsStillStatesAmount(t *testing.T) {
	doc := baseDoc()
	doc["source"], doc["title"], doc["items"] = "receipt", "Payment Receipt", []map[string]any{}
	doc["total"] = 250.0
	out := renderDoc(t, doc)
	if !strings.Contains(out, "Payment Receipt") {
		t.Error("receipt not titled as one")
	}
	if !strings.Contains(out, "Amount received") {
		t.Error("receipt does not say what the amount is")
	}
	if !strings.Contains(out, "₹250.00") {
		t.Error("receipt does not print its amount")
	}
}

// A walk-in has no account, so customerName is empty. The document must not
// print a blank "Billed to".
func TestCounterSaleNamesAWalkIn(t *testing.T) {
	doc := baseDoc()
	doc["source"], doc["title"] = "counter", "Cash Bill"
	doc["customerName"] = ""

	out := renderDoc(t, doc)
	if !strings.Contains(out, "Walk-in customer") {
		t.Error("anonymous counter sale has no billed-to line")
	}

	doc["walkinName"], doc["walkinPhone"] = "Lakshmi", "9494078833"
	out = renderDoc(t, doc)
	if !strings.Contains(out, "Lakshmi") || !strings.Contains(out, "9494078833") {
		t.Error("named walk-in not shown")
	}
	if strings.Contains(out, "Walk-in customer") {
		t.Error("fell back to placeholder despite having a name")
	}
}

// A cancelled document that still looks issued is worse than no document.
func TestCancelledDocumentIsMarked(t *testing.T) {
	doc := baseDoc()
	doc["status"] = "cancelled"
	out := renderDoc(t, doc)
	if !strings.Contains(out, "cancelled") {
		t.Error("cancelled document does not say so")
	}
	if strings.Contains(renderDoc(t, baseDoc()), `class="void"`) {
		t.Error("an issued document shows the void banner")
	}
}

// The logo must be inline, because a PDF converter cannot fetch a remote asset
// and would print a broken box on the document the customer keeps.
func TestLogoIsInlineNotLinked(t *testing.T) {
	out := renderDoc(t, baseDoc())
	if !strings.Contains(out, "<svg") {
		t.Error("no inline logo")
	}
	if strings.Contains(out, "<img src=\"http") || strings.Contains(out, "src='http") {
		t.Error("document references a remote image; it will not survive PDF conversion")
	}
}
