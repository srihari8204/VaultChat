// shopbook_tax.go — SHOP BOOK Country Tax Engine, invoices, notification
// inbox and cross-shop ledger summary (openspec: shop-book-upgrade).
//
// The tax engine is data, not code: shopbook_country rows (seeded by
// migration 064, admin-editable) carry currency, tax type, optional field
// definitions and document checklists. Invoices snapshot every resolved
// value at issue time so later config edits never mutate history.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

// ── country configs ───────────────────────────────────────────────

type sbCountry struct {
	Code           string          `json:"code"`
	Name           string          `json:"name"`
	CurrencySymbol string          `json:"currencySymbol"`
	CurrencyCode   string          `json:"currencyCode"`
	TaxType        string          `json:"taxType"`
	TaxSplit       []string        `json:"taxSplit"`
	TaxFields      json.RawMessage `json:"taxFields"`
	Documents      json.RawMessage `json:"documents"`
	DateFormat     string          `json:"dateFormat"`
}

func scanCountry(row shopScanner) (sbCountry, error) {
	var c sbCountry
	var split, fields, docs []byte
	if err := row.Scan(&c.Code, &c.Name, &c.CurrencySymbol, &c.CurrencyCode,
		&c.TaxType, &split, &fields, &docs, &c.DateFormat); err != nil {
		return c, err
	}
	_ = json.Unmarshal(split, &c.TaxSplit)
	c.TaxFields = json.RawMessage(fields)
	c.Documents = json.RawMessage(docs)
	return c, nil
}

const countryCols = `code, name, currency_symbol, currency_code, tax_type,
	tax_split, tax_fields, documents, date_format`

func sbLoadCountry(ctx context.Context, code string) (sbCountry, bool) {
	row := db.Pool.QueryRow(ctx,
		`SELECT `+countryCols+` FROM shopbook_country WHERE code=$1 AND enabled`, code)
	c, err := scanCountry(row)
	return c, err == nil
}

// GET /shopbook/countries — the tax engine configs (customer + owner apps).
func sbCountries(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Pool.Query(r.Context(),
		`SELECT `+countryCols+` FROM shopbook_country WHERE enabled ORDER BY sort, name`)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []sbCountry{}
	for rows.Next() {
		if c, err := scanCountry(rows); err == nil {
			out = append(out, c)
		}
	}
	httpx.JSON(w, 200, map[string]any{"countries": out})
}

// GET /shopbook/starter-catalog?category=grocery — server-managed starter
// items so new categories/catalogs need no app release.
func sbStarterCatalog(w http.ResponseWriter, r *http.Request) {
	cat := strings.TrimSpace(r.URL.Query().Get("category"))
	if cat == "" {
		httpx.Err(w, http.StatusBadRequest, "category required")
		return
	}
	rows, err := db.Pool.Query(r.Context(),
		`SELECT name, unit FROM shopbook_starter_item WHERE category_id=$1 ORDER BY sort, name`, cat)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var name, unit string
		if rows.Scan(&name, &unit) == nil {
			items = append(items, map[string]any{"name": name, "unit": unit})
		}
	}
	httpx.JSON(w, 200, map[string]any{"items": items})
}

// ── invoices ──────────────────────────────────────────────────────

// sbTaxConfigured: tax sections appear on invoices only when the shop has
// filled in at least one tax field (all tax fields are optional, always).
func sbTaxConfigured(taxConfig map[string]any) bool {
	for _, v := range taxConfig {
		switch t := v.(type) {
		case string:
			if strings.TrimSpace(t) != "" {
				return true
			}
		case bool:
			if t {
				return true
			}
		}
	}
	return false
}

// sbInvoiceLine is one priced order line as it reaches the invoice.
type sbInvoiceLine struct {
	Name       string  `json:"name"`
	Brand      string  `json:"brand"`
	Unit       string  `json:"unit"`
	Qty        float64 `json:"qty"`
	Price      float64 `json:"price"`
	TaxPercent float64 `json:"taxPercent"`
}

// sbIncludedTax returns the tax CONTAINED WITHIN the amount charged, plus the
// per-rate split. Shop Book catalog prices are shelf prices (tax-inclusive
// retail), so a line at price P with rate r carries P·r/(100+r) of tax —
// never P·r/100, which would add tax on top and make the receipt disagree
// with the cart and the khata.
//
// `gross` is the sum of line amounts and `charged` is the order total after
// discount; when they differ the tax is scaled by charged/gross so a discount
// reduces the included tax proportionally.
func sbIncludedTax(lines []sbInvoiceLine, gross, charged float64) (float64, map[float64]float64) {
	byRate := map[float64]float64{}
	total := 0.0
	for _, l := range lines {
		if l.TaxPercent > 0 {
			inc := l.Price * l.Qty * l.TaxPercent / (100 + l.TaxPercent)
			byRate[l.TaxPercent] += inc
			total += inc
		}
	}
	if gross > 0 && charged >= 0 && charged != gross {
		f := charged / gross
		total *= f
		for rate := range byRate {
			byRate[rate] *= f
		}
	}
	return total, byRate
}

// sbTaxBreakdown renders the per-rate tax amounts as customer/owner-readable
// lines, splitting each rate across a country's components (e.g. India's
// CGST/SGST halves). Returns an empty slice when no tax applies.
func sbTaxBreakdown(byRate map[float64]float64, taxType string, split []string, haveCountry bool) []map[string]any {
	out := []map[string]any{}
	for rate, amt := range byRate {
		if haveCountry && len(split) > 0 {
			n := float64(len(split))
			for _, part := range split {
				out = append(out, map[string]any{
					"label":  fmt.Sprintf("%s (%.2g%%)", part, rate/n),
					"amount": math.Round(amt/n*100) / 100,
				})
			}
			continue
		}
		out = append(out, map[string]any{
			"label":  fmt.Sprintf("%s (%.2g%%)", taxType, rate),
			"amount": math.Round(amt*100) / 100,
		})
	}
	return out
}

// sbCreateInvoice issues the immutable invoice for an order inside the
// collection transaction. Idempotent per order (order_id UNIQUE) — a repeat
// call is a no-op. Line items with availability 'unavailable' are excluded.
func sbCreateInvoice(ctx context.Context, tx pgx.Tx, orderID string) error {
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM shopbook_invoice WHERE order_id=$1)`, orderID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}

	var shopID, custID string
	var discount, total float64
	if err := tx.QueryRow(ctx,
		`SELECT shop_id, customer_user_id, discount, total FROM shopbook_order WHERE id=$1`,
		orderID).Scan(&shopID, &custID, &discount, &total); err != nil {
		return err
	}

	var shopName, shopAddr, shopPhone, country, currency string
	var taxCfgRaw []byte
	var seq int
	if err := tx.QueryRow(ctx,
		`UPDATE shopbook_shop SET invoice_seq = invoice_seq + 1
		  WHERE id=$1
		  RETURNING invoice_seq, name, address, phone, country, currency, tax_config`,
		shopID).Scan(&seq, &shopName, &shopAddr, &shopPhone, &country, &currency, &taxCfgRaw); err != nil {
		return err
	}
	taxCfg := map[string]any{}
	_ = json.Unmarshal(taxCfgRaw, &taxCfg)

	var custName string
	_ = tx.QueryRow(ctx, `SELECT COALESCE(name,'') FROM users WHERE id=$1`, custID).Scan(&custName)

	rows, err := tx.Query(ctx,
		`SELECT name, brand, unit, qty, price, tax_percent, availability
		   FROM shopbook_order_item WHERE order_id=$1 ORDER BY id`, orderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	lines := []sbInvoiceLine{}
	subtotal := 0.0
	for rows.Next() {
		var l sbInvoiceLine
		var avail string
		if rows.Scan(&l.Name, &l.Brand, &l.Unit, &l.Qty, &l.Price, &l.TaxPercent, &avail) != nil {
			continue
		}
		if avail == "unavailable" {
			continue
		}
		lines = append(lines, l)
		subtotal += l.Price * l.Qty
	}
	rows.Close()

	// Tax applies only when the shop configured any tax detail.
	taxType, taxTotal := "", 0.0
	byRate := map[float64]float64{}
	var cc sbCountry
	okC := false
	if sbTaxConfigured(taxCfg) {
		cc, okC = sbLoadCountry(ctx, country)
		if okC {
			taxType = cc.TaxType
		}
		taxTotal, byRate = sbIncludedTax(lines, subtotal, total)
	}
	breakdown := sbTaxBreakdown(byRate, taxType, cc.TaxSplit, okC)

	taxTotal = math.Round(taxTotal*100) / 100
	// Tax-inclusive retail: catalog prices are shelf prices, so the amount
	// charged already contains the tax. `subtotal` is therefore the taxable
	// (ex-tax) value, which is what the owner's tax report aggregates.
	subtotal = math.Round((total-taxTotal)*100) / 100

	business := map[string]any{
		"name": shopName, "address": shopAddr, "phone": shopPhone, "tax": taxCfg,
	}
	itemsJSON, _ := json.Marshal(lines)
	bizJSON, _ := json.Marshal(business)
	bdJSON, _ := json.Marshal(breakdown)

	_, err = tx.Exec(ctx, `
		INSERT INTO shopbook_invoice
		  (shop_id, order_id, customer_user_id, number, country, tax_type, currency,
		   subtotal, discount, tax_total, total, business, customer_name, items, tax_breakdown)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		shopID, orderID, custID, seq, country, taxType, currency,
		subtotal, discount, taxTotal, math.Round(total*100)/100,
		bizJSON, custName, itemsJSON, bdJSON)
	return err
}

// GET /shopbook/orders/{id}/invoice — readable by the customer or the owner.
func sbOrderInvoice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	orderID := r.PathValue("id")

	var custID, shopID string
	err := db.Pool.QueryRow(ctx,
		`SELECT customer_user_id, shop_id FROM shopbook_order WHERE id=$1`, orderID).Scan(&custID, &shopID)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if custID != user.ID {
		var owner string
		if err := db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).Scan(&owner); err != nil || owner != user.ID {
			httpx.Err(w, http.StatusForbidden, "Not your order")
			return
		}
	}

	var id, country, taxType, currency, custName string
	var number int
	var subtotal, discount, taxTotal, total float64
	var business, items, breakdown []byte
	var created time.Time
	err = db.Pool.QueryRow(ctx, `
		SELECT id, number, country, tax_type, currency, subtotal, discount, tax_total, total,
		       business, customer_name, items, tax_breakdown, created_at
		  FROM shopbook_invoice WHERE order_id=$1`, orderID).
		Scan(&id, &number, &country, &taxType, &currency, &subtotal, &discount, &taxTotal, &total,
			&business, &custName, &items, &breakdown, &created)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "No invoice for this order yet")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"id": id, "orderId": orderID, "number": number,
		"invoiceNo": fmt.Sprintf("INV-%04d", number),
		"country":   country, "taxType": taxType, "currency": currency,
		"subtotal": subtotal, "discount": discount, "taxTotal": taxTotal, "total": total,
		"business": json.RawMessage(business), "customerName": custName,
		"items": json.RawMessage(items), "taxBreakdown": json.RawMessage(breakdown),
		"createdAt": httpx.JST(&created),
	})
}

// ── notification inbox ────────────────────────────────────────────

// GET /shopbook/notifications — newest first, with unread count.
func sbNotifications(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(r.Context(), `
		SELECT id, title, body, event, data, read, created_at
		  FROM shopbook_notification WHERE user_id=$1
		 ORDER BY created_at DESC LIMIT 100`, user.ID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	unread := 0
	for rows.Next() {
		var id, title, body, event string
		var data []byte
		var read bool
		var created time.Time
		if rows.Scan(&id, &title, &body, &event, &data, &read, &created) != nil {
			continue
		}
		if !read {
			unread++
		}
		out = append(out, map[string]any{
			"id": id, "title": title, "body": body, "event": event,
			"data": json.RawMessage(data), "read": read, "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{"notifications": out, "unread": unread})
}

// POST /shopbook/notifications/read {"all":true} or {"ids":[...]}.
func sbNotificationsRead(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	var b struct {
		All bool     `json:"all"`
		IDs []string `json:"ids"`
	}
	_ = httpx.Body(r, &b)
	var err error
	if b.All {
		_, err = db.Pool.Exec(r.Context(),
			`UPDATE shopbook_notification SET read=TRUE WHERE user_id=$1 AND read=FALSE`, user.ID)
	} else if len(b.IDs) > 0 {
		_, err = db.Pool.Exec(r.Context(),
			`UPDATE shopbook_notification SET read=TRUE WHERE user_id=$1 AND id=ANY($2)`, user.ID, b.IDs)
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── customer: cross-shop pending summary ──────────────────────────

// GET /shopbook/my-ledgers — the customer dashboard's "pending amount"
// overview: every shop where this customer has ledger history.
func sbMyLedgers(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(r.Context(), `
		SELECT s.id, s.name, s.currency,
		       COALESCE(SUM(CASE WHEN l.type='purchase' THEN l.amount ELSE -l.amount END),0) AS pending,
		       COALESCE(SUM(CASE WHEN l.type='purchase' THEN l.amount ELSE 0 END),0) AS purchases
		  FROM shopbook_ledger l JOIN shopbook_shop s ON s.id=l.shop_id
		 WHERE l.customer_user_id=$1
		 GROUP BY s.id, s.name, s.currency
		 ORDER BY pending DESC`, user.ID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	totalPending := 0.0
	for rows.Next() {
		var id, name, currency string
		var pending, purchases float64
		if rows.Scan(&id, &name, &currency, &pending, &purchases) != nil {
			continue
		}
		totalPending += pending
		out = append(out, map[string]any{
			"shopId": id, "shopName": name, "currency": currency,
			"pending": math.Round(pending*100) / 100, "totalPurchase": math.Round(purchases*100) / 100,
		})
	}
	httpx.JSON(w, 200, map[string]any{
		"ledgers": out, "totalPending": math.Round(totalPending*100) / 100,
	})
}
