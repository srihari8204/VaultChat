// shopbook_documents.go — the three document sources that are not app orders,
// and the one renderer they all share (migration 110).
//
// 110 relaxed shopbook_invoice to carry four sources; until this file existed,
// only 'order' was ever written, so the other three were schema with no way in.
//
// THE RULE THAT SHAPES EVERYTHING HERE: a document's total must equal what the
// khata already posted. shopbook_tax.go records what happens otherwise — the
// invoice added tax on top of a total the ledger had posted without it, and
// every taxed order left the khata short by exactly the tax. So these documents
// do not compute tax. A khata credit entry's amount was derived from its lines
// as Σ(qty × price) by sbLedgerItemsTotal, and the invoice restates exactly
// that. Nothing below re-derives a monetary value; it copies.
//
// That also means item tax_percent is deliberately NOT printed: showing a rate
// that is not in the total is how a customer is taught not to trust the paper.
// A shop needing true tax invoices for counter sales wants the order path's tax
// engine, which is a bigger change than this file.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"math"
	"net/http"
	"strings"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"

	"github.com/jackc/pgx/v5"
)

func RegisterShopBookDocuments(mux *http.ServeMux) {
	mux.HandleFunc("POST /shopbook/my-shop/ledger/{id}/invoice", httpx.RequireAuth(sbIssueKhataInvoice))
	mux.HandleFunc("POST /shopbook/my-shop/ledger/{id}/receipt", httpx.RequireAuth(sbIssueKhataReceipt))
	mux.HandleFunc("POST /shopbook/my-shop/counter-sale", httpx.RequireAuth(sbCounterSale))
	mux.HandleFunc("GET /shopbook/invoices/{id}", httpx.RequireAuth(sbInvoiceJSON))
	mux.HandleFunc("GET /shopbook/invoices/{id}/render", httpx.RequireAuth(sbInvoiceRender))
}

// sbDocLine is one printed row. Mirrors the order path's line shape so the
// renderer reads one structure whatever produced the document.
type sbDocLine struct {
	Name  string  `json:"name"`
	Brand string  `json:"brand"`
	Unit  string  `json:"unit"`
	Qty   float64 `json:"qty"`
	Price float64 `json:"price"`
	Total float64 `json:"total"`
}

// sbDocSpec is everything that varies between the three non-order sources.
type sbDocSpec struct {
	ShopID      string
	Source      string // khata | counter | receipt
	LedgerID    string // khata, receipt
	CustomerID  string // khata, receipt
	WalkinName  string // counter
	WalkinPhone string // counter
	TotalCents  int64
	Lines       []sbDocLine
}

// sbIssueDocument writes one immutable document and returns its id.
//
// The per-shop number comes from the same `UPDATE shopbook_shop SET invoice_seq
// = invoice_seq + 1 RETURNING` that sbCreateInvoice uses: the row lock makes
// concurrent issues serialise, so two documents cannot share a number. Reusing
// the counter (rather than a second sequence per source) is what keeps a shop's
// paperwork a single numbered run, which is what an audit expects.
func sbIssueDocument(ctx context.Context, tx pgx.Tx, s sbDocSpec) (string, error) {
	var seq int
	var shopName, shopAddr, shopPhone, country, currency string
	var taxCfgRaw []byte
	if err := tx.QueryRow(ctx,
		`UPDATE shopbook_shop SET invoice_seq = invoice_seq + 1
		  WHERE id=$1
		  RETURNING invoice_seq, name, address, phone, country, currency, tax_config`,
		s.ShopID).Scan(&seq, &shopName, &shopAddr, &shopPhone, &country, &currency, &taxCfgRaw); err != nil {
		return "", err
	}
	taxCfg := map[string]any{}
	_ = json.Unmarshal(taxCfgRaw, &taxCfg)

	custName := s.WalkinName
	if s.CustomerID != "" {
		_ = tx.QueryRow(ctx, `SELECT COALESCE(name,'') FROM users WHERE id=$1`, s.CustomerID).Scan(&custName)
	}

	business := map[string]any{
		"name": shopName, "address": shopAddr, "phone": shopPhone, "tax": taxCfg,
	}
	bizJSON, _ := json.Marshal(business)
	itemsJSON, _ := json.Marshal(s.Lines)

	// subtotal == total and tax_total == 0, deliberately: see the file header.
	// The khata posted this amount without tax, so the document restates it.
	var id string
	err := tx.QueryRow(ctx, `
		INSERT INTO shopbook_invoice
		  (shop_id, source, ledger_id, customer_user_id, walkin_name, walkin_phone,
		   number, country, tax_type, currency,
		   subtotal, discount, tax_total, total, business, customer_name,
		   items, tax_breakdown, kind, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'',$9,
		        `+sbAmt("$10")+`,0,0,`+sbAmt("$11")+`,$12,$13,$14,'[]','retail','issued')
		RETURNING id`,
		s.ShopID, s.Source, nullIfEmpty(s.LedgerID), nullIfEmpty(s.CustomerID),
		s.WalkinName, s.WalkinPhone, seq, country, currency,
		s.TotalCents, s.TotalCents,
		sbJSON(bizJSON), custName, sbJSON(itemsJSON)).Scan(&id)
	return id, err
}

// sbLedgerDoc loads a khata entry and checks it belongs to the caller's shop.
func sbLedgerDoc(ctx context.Context, q sbQ, shopID, ledgerID string) (
	typ, custID string, totalC int64, lines []sbDocLine, err error) {
	err = q.QueryRow(ctx,
		`SELECT type, customer_user_id, `+sbCents("amount")+`
		   FROM shopbook_ledger WHERE id=$1 AND shop_id=$2`,
		ledgerID, shopID).Scan(&typ, &custID, &totalC)
	if err != nil {
		return
	}
	rows, qerr := q.Query(ctx,
		`SELECT name, brand, unit, qty, price
		   FROM shopbook_ledger_item WHERE ledger_id=$1 ORDER BY id`, ledgerID)
	if qerr != nil {
		err = qerr
		return
	}
	defer rows.Close()
	lines = []sbDocLine{}
	for rows.Next() {
		var l sbDocLine
		if rows.Scan(&l.Name, &l.Brand, &l.Unit, &l.Qty, &l.Price) != nil {
			continue
		}
		l.Total = math.Round(l.Qty*l.Price*100) / 100
		lines = append(lines, l)
	}
	return
}

// POST /shopbook/my-shop/ledger/{id}/invoice — paper for goods given on credit.
func sbIssueKhataInvoice(w http.ResponseWriter, r *http.Request) {
	sbIssueFromLedger(w, r, "khata", "purchase",
		"Only a credit entry can be invoiced — use /receipt for a payment")
}

// POST /shopbook/my-shop/ledger/{id}/receipt — paper for money received.
func sbIssueKhataReceipt(w http.ResponseWriter, r *http.Request) {
	sbIssueFromLedger(w, r, "receipt", "payment",
		"Only a payment can produce a receipt — use /invoice for goods given")
}

// One body for both, because they differ only in which ledger type they accept
// and what the document is called. Splitting them into two near-identical
// handlers is how the second one drifts.
func sbIssueFromLedger(w http.ResponseWriter, r *http.Request, source, wantType, mismatchMsg string) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	ledgerID := r.PathValue("id")

	typ, custID, totalC, lines, err := sbLedgerDoc(ctx, db.Pool, shopID, ledgerID)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "That entry is not in your khata")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if typ != wantType {
		httpx.Err(w, http.StatusBadRequest, mismatchMsg)
		return
	}

	var id string
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var e error
		id, e = sbIssueDocument(ctx, tx, sbDocSpec{
			ShopID: shopID, Source: source, LedgerID: ledgerID,
			CustomerID: custID, TotalCents: totalC, Lines: lines,
		})
		if e != nil {
			return e
		}
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID,
			Action: "document." + source, Entity: "invoice", EntityID: id,
			After: map[string]any{"ledgerId": ledgerID, "total": money(totalC).Float()},
			IP:    sbClientIP(r),
		})
		return nil
	})
	if err != nil {
		// The partial unique index on ledger_id is what enforces one document
		// per entry; a retry must read as "already issued", not as a failure.
		if sbIsUniqueViolation(err, "idx_shopbook_invoice_ledger_once") {
			_ = db.Pool.QueryRow(ctx,
				`SELECT id FROM shopbook_invoice WHERE ledger_id=$1`, ledgerID).Scan(&id)
			httpx.JSON(w, 200, map[string]any{"id": id, "duplicate": true})
			return
		}
		log.Printf("[shopbook] %s document failed (shop=%s ledger=%s): %v", source, shopID, ledgerID, err)
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 201, map[string]any{"id": id})
}

// POST /shopbook/my-shop/counter-sale {name, phone, items[]}
// A cash sale to somebody who is not a VaultChat user and never placed an
// order. It writes NO ledger entry on purpose: nothing is owed, so putting it
// in the khata would invent a debt that is already settled.
func sbCounterSale(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var b struct {
		Name  string           `json:"name"`
		Phone string           `json:"phone"`
		Items []sbLedgerItemIn `json:"items"`
	}
	if err := httpx.Body(r, &b); err != nil || len(b.Items) == 0 {
		httpx.Err(w, http.StatusBadRequest, "at least one item is required")
		return
	}
	// Same validator, same rounding, same rejections as the khata path.
	totalC, err := sbLedgerItemsTotal(b.Items)
	if err != nil {
		httpx.Err(w, http.StatusBadRequest, err.Error())
		return
	}
	if totalC <= 0 {
		httpx.Err(w, http.StatusBadRequest, "a counter sale cannot total zero")
		return
	}

	lines := make([]sbDocLine, 0, len(b.Items))
	for _, it := range b.Items {
		lines = append(lines, sbDocLine{
			Name: it.Name, Brand: it.Brand, Unit: it.Unit,
			Qty: it.Qty, Price: it.Price,
			Total: math.Round(it.Qty*it.Price*100) / 100,
		})
	}

	var id string
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var e error
		id, e = sbIssueDocument(ctx, tx, sbDocSpec{
			ShopID: shopID, Source: "counter",
			WalkinName: strings.TrimSpace(b.Name), WalkinPhone: strings.TrimSpace(b.Phone),
			TotalCents: int64(totalC), Lines: lines,
		})
		if e != nil {
			return e
		}
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID,
			Action: "document.counter", Entity: "invoice", EntityID: id,
			After: map[string]any{"total": totalC.Float(), "items": len(lines)},
			IP:    sbClientIP(r),
		})
		return nil
	})
	if err != nil {
		log.Printf("[shopbook] counter sale failed (shop=%s): %v", shopID, err)
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 201, map[string]any{"id": id, "total": totalC.Float()})
}

// sbLoadInvoice fetches a document and authorises the caller: the shop that
// issued it, or the customer named on it. A walk-in document has no customer,
// so only the shop can ever read it.
func sbLoadInvoice(ctx context.Context, userID, invoiceID string) (map[string]any, error) {
	var shopID, source, custID, walkinName, walkinPhone, custName, currency, status string
	var number int
	var totalC int64
	var bizRaw, itemsRaw []byte
	var createdAt any
	err := db.Pool.QueryRow(ctx, `
		SELECT i.shop_id, i.source, COALESCE(i.customer_user_id::text,''),
		       i.walkin_name, i.walkin_phone, i.customer_name, i.currency, i.status,
		       i.number, `+sbCents("i.total")+`, i.business, i.items, i.created_at
		  FROM shopbook_invoice i WHERE i.id=$1`, invoiceID).
		Scan(&shopID, &source, &custID, &walkinName, &walkinPhone, &custName,
			&currency, &status, &number, &totalC, &bizRaw, &itemsRaw, &createdAt)
	if err != nil {
		return nil, err
	}
	var owner string
	_ = db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).Scan(&owner)
	if owner != userID && custID != userID {
		return nil, errSBDocForbidden
	}

	business := map[string]any{}
	_ = json.Unmarshal(bizRaw, &business)
	items := []map[string]any{}
	_ = json.Unmarshal(itemsRaw, &items)

	title := map[string]string{
		"order": "Invoice", "khata": "Invoice", "counter": "Cash Bill", "receipt": "Payment Receipt",
	}[source]

	return map[string]any{
		"id": invoiceID, "source": source, "title": title, "status": status,
		"number": number, "currency": currency, "total": money(totalC).Float(),
		"business": business, "items": items,
		"customerName": custName, "walkinName": walkinName, "walkinPhone": walkinPhone,
		"createdAt": createdAt,
	}, nil
}

var errSBDocForbidden = errSBSentinel("document forbidden")

// GET /shopbook/invoices/{id}
func sbInvoiceJSON(w http.ResponseWriter, r *http.Request) {
	doc, err := sbLoadInvoice(r.Context(), httpx.UserFrom(r).ID, r.PathValue("id"))
	switch {
	case db.NoRows(err):
		httpx.Err(w, http.StatusNotFound, "Document not found")
	case err == errSBDocForbidden:
		httpx.Err(w, http.StatusForbidden, "Not your document")
	case err != nil:
		httpx.Err(w, http.StatusInternalServerError, "db error")
	default:
		httpx.JSON(w, 200, doc)
	}
}

// GET /shopbook/invoices/{id}/render — the SAME document as HTML.
//
// One layout, server-side, for every transport: the app shows it in a WebView,
// feeds it to expo-print for a PDF to send on WhatsApp, or (later) re-renders
// it as ESC/POS for a counter printer. The phone never lays out a line or adds
// up a column, which is the whole point of keeping this here.
//
// The logo is an inline SVG rather than a linked image: a PDF converter cannot
// fetch a remote asset, and an <img src="https://…"> would silently print as a
// broken box on exactly the document a customer keeps.
func sbInvoiceRender(w http.ResponseWriter, r *http.Request) {
	doc, err := sbLoadInvoice(r.Context(), httpx.UserFrom(r).ID, r.PathValue("id"))
	switch {
	case db.NoRows(err):
		httpx.Err(w, http.StatusNotFound, "Document not found")
		return
	case err == errSBDocForbidden:
		httpx.Err(w, http.StatusForbidden, "Not your document")
		return
	case err != nil:
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Deny embedding: this document carries a name, a phone and a total.
	w.Header().Set("X-Frame-Options", "DENY")
	if err := sbInvoiceTmpl.Execute(w, doc); err != nil {
		// Too late for a status code — the body is already going out. Log it so
		// a truncated document is not mistaken for a rendering quirk.
		log.Printf("[shopbook] invoice render failed (id=%s): %v", r.PathValue("id"), err)
	}
}

// html/template escapes every interpolation, so a shop named `<script>` prints
// as text rather than executing in the customer's WebView.
var sbInvoiceTmpl = template.Must(template.New("invoice").Funcs(template.FuncMap{
	"money": func(cur string, v float64) string {
		if cur == "" {
			cur = "₹"
		}
		return fmt.Sprintf("%s%.2f", cur, v)
	},
}).Parse(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.title}} #{{.number}}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#fff; color:#111;
         font:14px/1.5 -apple-system,Roboto,"Segoe UI",sans-serif; }
  .doc { max-width:720px; margin:0 auto; }
  header { display:flex; justify-content:space-between; align-items:flex-start;
           gap:16px; border-bottom:2px solid #111; padding-bottom:14px; }
  .shop  { font-size:20px; font-weight:700; }
  .muted { color:#555; font-size:12px; }
  .title { text-align:right; }
  .title h1 { margin:0; font-size:19px; letter-spacing:.02em; }
  .meta  { margin:16px 0; display:flex; justify-content:space-between; gap:16px; }
  table  { width:100%; border-collapse:collapse; margin-top:8px; }
  th,td  { padding:8px 6px; text-align:left; border-bottom:1px solid #e3e3e3; }
  th     { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#555; }
  td.n,th.n { text-align:right; white-space:nowrap; }
  tfoot td { border:0; font-weight:700; font-size:16px; padding-top:14px; }
  .brand { display:flex; align-items:center; gap:6px; justify-content:center;
           margin-top:28px; padding-top:12px; border-top:1px solid #eee;
           color:#777; font-size:11px; }
  .void { margin-top:14px; padding:8px 10px; border:1px solid #b00; color:#b00;
          font-weight:700; text-align:center; letter-spacing:.08em; }
  @media print { body { padding:0; } }
</style>
<div class="doc">
  <header>
    <div>
      <div class="shop">{{.business.name}}</div>
      {{with .business.address}}<div class="muted">{{.}}</div>{{end}}
      {{with .business.phone}}<div class="muted">{{.}}</div>{{end}}
    </div>
    <div class="title">
      <h1>{{.title}}</h1>
      <div class="muted">No. {{.number}}</div>
    </div>
  </header>

  {{if ne .status "issued"}}<div class="void">{{.status}}</div>{{end}}

  <div class="meta">
    <div>
      <div class="muted">Billed to</div>
      <div><strong>{{if .customerName}}{{.customerName}}{{else if .walkinName}}{{.walkinName}}{{else}}Walk-in customer{{end}}</strong></div>
      {{with .walkinPhone}}<div class="muted">{{.}}</div>{{end}}
    </div>
  </div>

  {{if .items}}
  <table>
    <thead><tr>
      <th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th>
    </tr></thead>
    <tbody>
      {{range .items}}
      <tr>
        <td>{{.name}}{{with .unit}} <span class="muted">({{.}})</span>{{end}}</td>
        <td class="n">{{.qty}}</td>
        <td class="n">{{money $.currency .price}}</td>
        <td class="n">{{money $.currency .total}}</td>
      </tr>
      {{end}}
    </tbody>
    <tfoot><tr>
      <td colspan="3" class="n">Total</td>
      <td class="n">{{money .currency .total}}</td>
    </tr></tfoot>
  </table>
  {{else}}
  <table><tfoot><tr>
    <td>{{if eq .source "receipt"}}Amount received{{else}}Amount{{end}}</td>
    <td class="n">{{money .currency .total}}</td>
  </tr></tfoot></table>
  {{end}}

  <div class="brand">
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2 4 5.5v6c0 5 3.4 9.4 8 10.5 4.6-1.1 8-5.5 8-10.5v-6L12 2z"
            fill="none" stroke="#16a34a" stroke-width="2" stroke-linejoin="round"/>
    </svg>
    <span>Made with VaultChat Shop Book</span>
  </div>
</div>
`))
