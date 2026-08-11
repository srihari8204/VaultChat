// shopbook_purchase.go — SHOP BOOK purchases, cost and margin (P1-A), plus
// the shop audit log (P1-F).
//
// A purchase is the other half of a sale. Until stock could arrive with a
// price attached, "profit" was a number this app had no honest way to compute
// — and a dashboard that guesses at profit is worse than one that omits it.
//
// Recording a purchase does three things in one transaction: writes the
// document, moves the stock in, and updates the product's cost. They are one
// event and must not be able to half-happen.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

func RegisterShopBookPurchases(mux *http.ServeMux) {
	mux.HandleFunc("GET /shopbook/my-shop/purchases", httpx.RequireAuth(sbListPurchases))
	mux.HandleFunc("POST /shopbook/my-shop/purchases", httpx.RequireAuth(sbCreatePurchase))
	mux.HandleFunc("GET /shopbook/my-shop/purchases/{id}", httpx.RequireAuth(sbPurchaseDetails))
	mux.HandleFunc("GET /shopbook/my-shop/audit", httpx.RequireAuth(sbAuditLog))
}

// ── audit (P1-F) ──────────────────────────────────────────────────

// sbAudit records one shop-scoped action. Best-effort by design: an audit
// write must never be the reason a legitimate business action fails. It is
// loud on failure, because an audit log that quietly stops recording reads
// exactly like a shop where nothing happened.
func sbAudit(ctx context.Context, q sbQ, a sbAuditEntry) {
	before, _ := json.Marshal(a.Before)
	after, _ := json.Marshal(a.After)
	if a.Role == "" {
		a.Role = "owner"
	}
	if _, err := q.Exec(ctx, `
		INSERT INTO shopbook_audit
		  (shop_id, actor_user_id, actor_role, action, entity, entity_id,
		   before, after, reason, ip)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		a.ShopID, nullIfEmpty(a.Actor), a.Role, a.Action, a.Entity, a.EntityID,
		sbJSON(before), sbJSON(after), a.Reason, a.IP); err != nil {
		log.Printf("[shopbook] AUDIT WRITE FAILED (shop=%s action=%s entity=%s/%s): %v",
			a.ShopID, a.Action, a.Entity, a.EntityID, err)
	}
}

type sbAuditEntry struct {
	ShopID   string
	Actor    string
	Role     string
	Action   string
	Entity   string
	EntityID string
	Before   map[string]any
	After    map[string]any
	Reason   string
	IP       string
}

// sbClientIP reads the caller's address the way Caddy presents it.
func sbClientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	return r.RemoteAddr
}

// GET /shopbook/my-shop/audit?entity=&limit= — the owner's own trail.
func sbAuditLog(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	args := []any{shopID}
	sql := `SELECT a.id, COALESCE(u.name,''), a.actor_role, a.action, a.entity, a.entity_id,
	               a.before, a.after, a.reason, a.created_at
	          FROM shopbook_audit a
	          LEFT JOIN users u ON u.id = a.actor_user_id
	         WHERE a.shop_id=$1`
	if e := r.URL.Query().Get("entity"); e != "" {
		sql += ` AND a.entity=$2`
		args = append(args, e)
	}
	sql += ` ORDER BY a.id DESC LIMIT 200`
	rows, err := db.Pool.Query(ctx, sql, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var actor, role, action, entity, entityID, reason string
		var before, after []byte
		var at time.Time
		if rows.Scan(&id, &actor, &role, &action, &entity, &entityID,
			&before, &after, &reason, &at) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "actor": actor, "role": role, "action": action,
			"entity": entity, "entityId": entityID,
			"before": json.RawMessage(sbJSON(before)), "after": json.RawMessage(sbJSON(after)),
			"reason": reason, "at": httpx.JST(&at),
		})
	}
	httpx.JSON(w, 200, map[string]any{"entries": out})
}

// ── purchases (P1-A) ──────────────────────────────────────────────

// POST /shopbook/my-shop/purchases
func sbCreatePurchase(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var b struct {
		SupplierID     string `json:"supplierId"`
		SupplierName   string `json:"supplierName"`
		InvoiceNumber  string `json:"invoiceNumber"`
		PurchasedOn    string `json:"purchasedOn"` // YYYY-MM-DD, defaults to today
		Note           string `json:"note"`
		IdempotencyKey string `json:"idempotencyKey"`
		Items          []struct {
			ProductID  string  `json:"productId"`
			Name       string  `json:"name"`
			Unit       string  `json:"unit"`
			Qty        float64 `json:"qty"`
			CostPrice  float64 `json:"costPrice"`
			TaxPercent float64 `json:"taxPercent"`
		} `json:"items"`
	}
	if err := httpx.Body(r, &b); err != nil || len(b.Items) == 0 {
		httpx.Err(w, http.StatusBadRequest, "at least one item required")
		return
	}
	if len(b.Items) > 200 {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "Max 200 items per purchase")
		return
	}

	idem := sbIdemKey(r.Header.Get("Idempotency-Key"), b.IdempotencyKey)
	if idem != "" {
		var id string
		if db.Pool.QueryRow(ctx,
			`SELECT id FROM shopbook_purchase WHERE shop_id=$1 AND idempotency_key=$2`,
			shopID, idem).Scan(&id) == nil {
			httpx.JSON(w, 200, map[string]any{"id": id, "duplicate": true})
			return
		}
	}

	// The supplier's name is snapshotted: suppliers get renamed, and a purchase
	// document that changes retrospectively is not a document.
	supplierName := strings.TrimSpace(b.SupplierName)
	if b.SupplierID != "" {
		var n string
		if db.Pool.QueryRow(ctx,
			`SELECT name FROM shopbook_supplier WHERE id=$1 AND shop_id=$2`,
			b.SupplierID, shopID).Scan(&n) == nil {
			supplierName = n
		} else {
			httpx.Err(w, http.StatusNotFound, "Supplier not found for your shop")
			return
		}
	}

	type priced struct {
		productID, name, unit string
		qty100, cost, taxPct  int64
		lineTax, lineTotal    money
	}
	lines := make([]priced, 0, len(b.Items))
	var subtotal, taxTotal money
	for _, it := range b.Items {
		if strings.TrimSpace(it.Name) == "" && it.ProductID == "" {
			continue
		}
		if it.Qty <= 0 || it.CostPrice < 0 {
			httpx.Err(w, http.StatusBadRequest, "each item needs a positive quantity and a non-negative cost")
			return
		}
		p := priced{
			name: strings.TrimSpace(it.Name), unit: it.Unit,
			qty100: int64(math.Round(it.Qty * 100)),
			cost:   int64(math.Round(it.CostPrice * 100)),
			taxPct: int64(math.Round(it.TaxPercent * 100)),
		}
		// A named product must belong to this shop — a purchase against
		// someone else's catalog would move their stock.
		if it.ProductID != "" {
			var name, unit string
			if err := db.Pool.QueryRow(ctx,
				`SELECT name, unit FROM shopbook_product WHERE id=$1 AND shop_id=$2`,
				it.ProductID, shopID).Scan(&name, &unit); err != nil {
				httpx.Err(w, http.StatusNotFound, "Product not found for your shop")
				return
			}
			p.productID = it.ProductID
			if p.name == "" {
				p.name = name
			}
			if p.unit == "" {
				p.unit = unit
			}
		}
		base := money(p.cost).mulQty(p.qty100)
		p.lineTax = base.pctOf(p.taxPct)
		p.lineTotal = base + p.lineTax
		subtotal += base
		taxTotal += p.lineTax
		lines = append(lines, p)
	}
	if len(lines) == 0 {
		httpx.Err(w, http.StatusBadRequest, "at least one item required")
		return
	}
	total := subtotal + taxTotal

	purchasedOn := strings.TrimSpace(b.PurchasedOn)
	var purchaseID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO shopbook_purchase
			  (shop_id, supplier_id, supplier_name, invoice_number, purchased_on,
			   subtotal, tax_total, total, note, actor_user_id, idempotency_key)
			VALUES ($1,$2,$3,$4, COALESCE(NULLIF($5,'')::date, CURRENT_DATE),
			        `+sbAmt("$6")+`,`+sbAmt("$7")+`,`+sbAmt("$8")+`,$9,$10,$11)
			RETURNING id`,
			shopID, nullIfEmpty(b.SupplierID), supplierName, strings.TrimSpace(b.InvoiceNumber),
			purchasedOn, int64(subtotal), int64(taxTotal), int64(total),
			b.Note, user.ID, idem).Scan(&purchaseID); err != nil {
			return err
		}
		for _, l := range lines {
			if _, err := tx.Exec(ctx, `
				INSERT INTO shopbook_purchase_item
				  (purchase_id, product_id, name, unit, qty, cost_price, tax_percent,
				   line_tax, line_total)
				VALUES ($1,$2,$3,$4,`+sbAmt("$5")+`,`+sbAmt("$6")+`,`+sbAmt("$7")+`,
				        `+sbAmt("$8")+`,`+sbAmt("$9")+`)`,
				purchaseID, nullIfEmpty(l.productID), l.name, l.unit,
				l.qty100, l.cost, l.taxPct, int64(l.lineTax), int64(l.lineTotal)); err != nil {
				return err
			}
			if l.productID == "" {
				continue // a one-off buy that isn't in the catalog: no stock to move
			}
			// Cost first, so the weighted average sees the pre-delivery
			// position; then the stock-in itself.
			if err := sbUpdateAvgCost(ctx, tx, l.productID, l.qty100, money(l.cost)); err != nil {
				return err
			}
			var tracked bool
			if err := tx.QueryRow(ctx,
				`SELECT track_stock FROM shopbook_product WHERE id=$1`, l.productID).Scan(&tracked); err != nil {
				return err
			}
			if !tracked {
				continue
			}
			okMove, err := sbApplyMove(ctx, tx, sbMove{
				ShopID: shopID, ProductID: l.productID, Kind: "purchase",
				OnHand: l.qty100, Unit: l.unit, Actor: user.ID,
				RefEntity: "purchase", RefID: purchaseID,
				Reason: strings.TrimSpace("supplier " + supplierName),
			})
			if err != nil {
				return err
			}
			if !okMove {
				return fmt.Errorf("stock move refused for product %s", l.productID)
			}
		}
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID, Action: "purchase.create",
			Entity: "purchase", EntityID: purchaseID,
			After: map[string]any{
				"supplier": supplierName, "invoiceNumber": b.InvoiceNumber,
				"total": total.Float(), "items": len(lines),
			},
			IP: sbClientIP(r),
		})
		return nil
	})
	if err != nil {
		if idem != "" && strings.Contains(err.Error(), "idx_shopbook_purchase_idem") {
			var id string
			if db.Pool.QueryRow(ctx,
				`SELECT id FROM shopbook_purchase WHERE shop_id=$1 AND idempotency_key=$2`,
				shopID, idem).Scan(&id) == nil {
				httpx.JSON(w, 200, map[string]any{"id": id, "duplicate": true})
				return
			}
		}
		if strings.Contains(err.Error(), "idx_shopbook_purchase_supplier_invoice") {
			httpx.Err(w, http.StatusConflict,
				"You already recorded that supplier invoice",
				map[string]any{"code": "duplicate_supplier_invoice"})
			return
		}
		log.Printf("[shopbook] purchase failed (shop=%s): %v", shopID, err)
		httpx.Err(w, http.StatusInternalServerError, "could not record the purchase")
		return
	}
	for _, l := range lines {
		if l.productID != "" {
			sbCheckLowStock(ctx, shopID, l.productID)
		}
	}
	httpx.JSON(w, 201, map[string]any{
		"id": purchaseID, "subtotal": subtotal.Float(),
		"taxTotal": taxTotal.Float(), "total": total.Float(),
	})
}

// sbUpdateAvgCost maintains a weighted-average cost per product.
//
//	new_avg = (avg×qty + cost×incoming) / (qty + incoming)
//
// Weighted average is the least surprising default: it does not require the
// shop to track which physical unit came from which delivery (FIFO does), and
// it does not swing the reported margin on every price change (latest-cost
// does). `cost_price` still carries the most recent price for anyone who wants
// it, so neither view is lost.
func sbUpdateAvgCost(ctx context.Context, tx pgx.Tx, productID string, qty100 int64, cost money) error {
	var avg, heldQty int64
	if err := tx.QueryRow(ctx,
		`SELECT `+sbCents("avg_cost")+`, `+sbCents("avg_cost_qty")+`
		   FROM shopbook_product WHERE id=$1`, productID).Scan(&avg, &heldQty); err != nil {
		return err
	}
	newQty := heldQty + qty100
	newAvg := cost
	if newQty > 0 {
		// Both terms are (money × qty100); dividing by the summed quantity
		// brings it back to a unit price, half-away-from-zero.
		newAvg = money(divRound(avg*heldQty+int64(cost)*qty100, newQty))
	}
	_, err := tx.Exec(ctx, `
		UPDATE shopbook_product
		   SET avg_cost=`+sbAmt("$2")+`, avg_cost_qty=`+sbAmt("$3")+`,
		       cost_price=`+sbAmt("$4")+`, updated_at=NOW()
		 WHERE id=$1`,
		productID, int64(newAvg), newQty, int64(cost))
	return err
}

// GET /shopbook/my-shop/purchases
func sbListPurchases(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT p.id, p.supplier_name, p.invoice_number, p.purchased_on,
		       `+sbCents("p.subtotal")+`, `+sbCents("p.tax_total")+`, `+sbCents("p.total")+`,
		       p.note, (SELECT COUNT(*) FROM shopbook_purchase_item i WHERE i.purchase_id=p.id)
		  FROM shopbook_purchase p
		 WHERE p.shop_id=$1
		 ORDER BY p.purchased_on DESC, p.created_at DESC LIMIT 200`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	var totalSpend money
	for rows.Next() {
		var id, supplier, invNo, note string
		var on time.Time
		var subtotal, taxTotal, total int64
		var items int
		if rows.Scan(&id, &supplier, &invNo, &on, &subtotal, &taxTotal, &total, &note, &items) != nil {
			continue
		}
		totalSpend += money(total)
		out = append(out, map[string]any{
			"id": id, "supplierName": supplier, "invoiceNumber": invNo,
			"purchasedOn": on.Format("2006-01-02"),
			"subtotal":    money(subtotal).Float(), "taxTotal": money(taxTotal).Float(),
			"total": money(total).Float(), "note": note, "itemCount": items,
		})
	}
	httpx.JSON(w, 200, map[string]any{"purchases": out, "totalSpend": totalSpend.Float()})
}

// GET /shopbook/my-shop/purchases/{id}
func sbPurchaseDetails(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	id := r.PathValue("id")
	var supplier, invNo, note string
	var on time.Time
	var subtotal, taxTotal, total int64
	if err := db.Pool.QueryRow(ctx, `
		SELECT supplier_name, invoice_number, purchased_on,
		       `+sbCents("subtotal")+`, `+sbCents("tax_total")+`, `+sbCents("total")+`, note
		  FROM shopbook_purchase WHERE id=$1 AND shop_id=$2`, id, shopID).
		Scan(&supplier, &invNo, &on, &subtotal, &taxTotal, &total, &note); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, http.StatusNotFound, "Purchase not found for your shop")
			return
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT COALESCE(product_id::text,''), name, unit, `+sbCents("qty")+`,
		       `+sbCents("cost_price")+`, `+sbCents("tax_percent")+`,
		       `+sbCents("line_tax")+`, `+sbCents("line_total")+`
		  FROM shopbook_purchase_item WHERE purchase_id=$1 ORDER BY id`, id)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var pid, name, unit string
		var qty, cost, taxPct, lineTax, lineTotal int64
		if rows.Scan(&pid, &name, &unit, &qty, &cost, &taxPct, &lineTax, &lineTotal) != nil {
			continue
		}
		items = append(items, map[string]any{
			"productId": pid, "name": name, "unit": unit,
			"qty": float64(qty) / 100, "costPrice": money(cost).Float(),
			"taxPercent": float64(taxPct) / 100,
			"lineTax":    money(lineTax).Float(), "lineTotal": money(lineTotal).Float(),
		})
	}
	httpx.JSON(w, 200, map[string]any{
		"id": id, "supplierName": supplier, "invoiceNumber": invNo,
		"purchasedOn": on.Format("2006-01-02"), "note": note,
		"subtotal": money(subtotal).Float(), "taxTotal": money(taxTotal).Float(),
		"total": money(total).Float(), "items": items,
	})
}
