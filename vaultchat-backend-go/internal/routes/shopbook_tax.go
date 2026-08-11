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
	"sort"
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

	// The order's finalized snapshot IS the invoice. Recomputing it here is
	// what let the invoice and the khata disagree: the invoice added tax on
	// top of a total the ledger had already posted without it. Nothing below
	// re-derives a monetary value — it copies.
	var shopID, custID string
	var subtotalC, discountC, taxTotalC, totalC int64
	var snapRaw []byte
	if err := tx.QueryRow(ctx,
		`SELECT shop_id, customer_user_id, `+sbCents("subtotal")+`, `+sbCents("discount")+`,
		        `+sbCents("tax_total")+`, `+sbCents("total")+`, tax_snapshot
		   FROM shopbook_order WHERE id=$1`,
		orderID).Scan(&shopID, &custID, &subtotalC, &discountC, &taxTotalC, &totalC, &snapRaw); err != nil {
		return err
	}
	snap := map[string]any{}
	_ = json.Unmarshal(snapRaw, &snap)

	// The buyer decides the document's shape: a tax number means a business
	// purchase and a compliant tax invoice; nothing means a retail bill with
	// no blank statutory fields on it (addendum B).
	var buyerRaw []byte
	_ = tx.QueryRow(ctx, `SELECT buyer_tax FROM shopbook_order WHERE id=$1`, orderID).Scan(&buyerRaw)
	buyer := map[string]any{}
	_ = json.Unmarshal(buyerRaw, &buyer)
	invKind := "retail"
	if s, _ := buyer["taxNumber"].(string); strings.TrimSpace(s) != "" {
		invKind = "tax"
	}
	var roundOffC int64
	_ = tx.QueryRow(ctx,
		`SELECT `+sbCents("round_off")+` FROM shopbook_order WHERE id=$1`, orderID).Scan(&roundOffC)

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
		`SELECT name, brand, unit, `+sbCents("qty")+`, `+sbCents("price")+`,
		        `+sbCents("tax_percent")+`, `+sbCents("line_discount")+`,
		        `+sbCents("line_tax")+`, `+sbCents("line_total")+`, availability
		   FROM shopbook_order_item WHERE order_id=$1 ORDER BY id`, orderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type line struct {
		Name       string  `json:"name"`
		Brand      string  `json:"brand"`
		Unit       string  `json:"unit"`
		Qty        float64 `json:"qty"`
		Price      float64 `json:"price"`
		TaxPercent float64 `json:"taxPercent"`
		Discount   float64 `json:"discount"`
		Tax        float64 `json:"tax"`
		Total      float64 `json:"total"`
	}
	lines := []line{}
	byRate := map[int64]money{} // tax rate (hundredths of a percent) → tax charged
	for rows.Next() {
		var l line
		var avail string
		var qty, price, taxPct, disc, tax, tot int64
		if rows.Scan(&l.Name, &l.Brand, &l.Unit, &qty, &price, &taxPct, &disc, &tax, &tot, &avail) != nil {
			continue
		}
		if avail == "unavailable" {
			continue
		}
		l.Qty, l.Price = float64(qty)/100, money(price).Float()
		l.TaxPercent = float64(taxPct) / 100
		l.Discount, l.Tax, l.Total = money(disc).Float(), money(tax).Float(), money(tot).Float()
		if tax > 0 {
			byRate[taxPct] += money(tax)
		}
		lines = append(lines, l)
	}
	rows.Close()

	// Tax presentation comes from the order's frozen snapshot, so a country
	// config edited after the sale cannot restate a historical invoice.
	taxType, _ := snap["taxType"].(string)
	split := []string{}
	if raw, ok := snap["taxSplit"].([]any); ok {
		for _, p := range raw {
			if s, ok := p.(string); ok {
				split = append(split, s)
			}
		}
	}
	breakdown := []map[string]any{}
	for rate, amt := range byRate {
		if len(split) > 0 {
			// e.g. India: split each rate into equal CGST/SGST halves. The
			// halves are apportioned, not divided, so they add back to `amt`.
			equal := make([]money, len(split))
			for i := range equal {
				equal[i] = 1
			}
			parts := sbAllocate(amt, equal)
			for i, part := range split {
				breakdown = append(breakdown, map[string]any{
					"label":  fmt.Sprintf("%s (%.4g%%)", part, float64(rate)/100/float64(len(split))),
					"amount": parts[i].Float(),
				})
			}
		} else {
			breakdown = append(breakdown, map[string]any{
				"label":  fmt.Sprintf("%s (%.4g%%)", taxType, float64(rate)/100),
				"amount": amt.Float(),
			})
		}
	}
	sort.Slice(breakdown, func(i, j int) bool {
		return breakdown[i]["label"].(string) < breakdown[j]["label"].(string)
	})

	business := map[string]any{
		"name": shopName, "address": shopAddr, "phone": shopPhone, "tax": taxCfg,
	}
	itemsJSON, _ := json.Marshal(lines)
	bizJSON, _ := json.Marshal(business)
	bdJSON, _ := json.Marshal(breakdown)

	_, err = tx.Exec(ctx, `
		INSERT INTO shopbook_invoice
		  (shop_id, order_id, customer_user_id, number, country, tax_type, currency,
		   subtotal, discount, tax_total, total, business, customer_name, items, tax_breakdown,
		   kind, status, buyer, round_off)
		VALUES ($1,$2,$3,$4,$5,$6,$7,`+sbAmt("$8")+`,`+sbAmt("$9")+`,`+sbAmt("$10")+`,`+sbAmt("$11")+`,
		        $12,$13,$14,$15,$16,'issued',$17,`+sbAmt("$18")+`)`,
		shopID, orderID, custID, seq, country, taxType, currency,
		subtotalC, discountC, taxTotalC, totalC,
		sbJSON(bizJSON), custName, sbJSON(itemsJSON), sbJSON(bdJSON),
		invKind, sbJSON(buyerRaw), roundOffC)
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

	var id, country, taxType, currency, custName, kind, status string
	var number int
	var subtotalC, discountC, taxTotalC, roundOffC, totalC int64
	var business, items, breakdown, buyer []byte
	var created time.Time
	err = db.Pool.QueryRow(ctx, `
		SELECT id, number, country, tax_type, currency,
		       `+sbCents("subtotal")+`, `+sbCents("discount")+`, `+sbCents("tax_total")+`,
		       `+sbCents("round_off")+`, `+sbCents("total")+`,
		       business, customer_name, items, tax_breakdown, kind, status, buyer, created_at
		  FROM shopbook_invoice WHERE order_id=$1`, orderID).
		Scan(&id, &number, &country, &taxType, &currency,
			&subtotalC, &discountC, &taxTotalC, &roundOffC, &totalC,
			&business, &custName, &items, &breakdown, &kind, &status, &buyer, &created)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "No invoice for this order yet")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	// Payment state is derived from the payments themselves, so the invoice can
	// never claim to be paid by money that is not there (P0-E).
	payState, paid, due := "unpaid", money(0), money(totalC)
	if st, p, d, err := sbInvoicePaymentState(ctx, db.Pool, id); err == nil {
		payState, paid, due = st, p, d
	}
	httpx.JSON(w, 200, map[string]any{
		"id": id, "orderId": orderID, "number": number,
		// A human-facing series, never the database id (spec: invoice numbering).
		"invoiceNo": fmt.Sprintf("INV-%04d", number),
		"country":   country, "taxType": taxType, "currency": currency,
		"subtotal": money(subtotalC).Float(), "discount": money(discountC).Float(),
		"taxTotal": money(taxTotalC).Float(), "roundOff": money(roundOffC).Float(),
		"total":    money(totalC).Float(),
		"business": json.RawMessage(business), "customerName": custName,
		"items": json.RawMessage(items), "taxBreakdown": json.RawMessage(breakdown),
		// 'tax' carries both parties' tax numbers and is reclaimable;
		// 'retail' is a plain bill with no statutory fields left blank.
		"kind": kind, "status": status, "buyer": json.RawMessage(sbJSON(buyer)),
		"paymentStatus": payState, "paid": paid.Float(), "due": due.Float(),
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
