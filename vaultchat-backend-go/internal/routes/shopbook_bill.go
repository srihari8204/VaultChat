// shopbook_bill.go — SHOP BOOK live billing (P0-C) and subscription
// entitlement (bug #8).
//
// Billing is where an order becomes a bill: the shop weighs out what it
// actually packed, adds or drops a line, gives a discount at the counter, and
// the total moves. Every one of those is a WRITE THEN A RE-DERIVE — the client
// never sends a total, and there is no endpoint that would accept one. The
// owner's screen shows what the server just computed, which is the only number
// that will ever reach the invoice.
//
// The billing window is preparing/packing. Before that the order has not been
// accepted; after 'ready' the customer has been told what to come and pay, and
// moving the total under them is exactly the behaviour a shop gets sued for.
package routes

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

func RegisterShopBookBilling(mux *http.ServeMux) {
	mux.HandleFunc("GET /shopbook/my-shop/orders/{id}/bill", httpx.RequireAuth(sbGetBill))
	mux.HandleFunc("POST /shopbook/my-shop/orders/{id}/bill", httpx.RequireAuth(sbUpdateBill))
	mux.HandleFunc("POST /shopbook/orders/{id}/buyer-tax", httpx.RequireAuth(sbSetBuyerTax))
}

// sbBillableStatuses — when the bill may still move.
var sbBillableStatuses = map[string]bool{"accepted": true, "preparing": true, "packing": true}

// sbBillJSON renders the current bill: every line with what was asked for,
// what was packed, and what it costs, plus the totals underneath.
func sbBillJSON(ctx context.Context, q sbQ, orderID string) (map[string]any, error) {
	var status, currency string
	var subtotal, discount, billDiscount, taxTotal, roundOff, total, deliveryFee int64
	var buyerTax []byte
	if err := q.QueryRow(ctx, `
		SELECT o.status, s.currency, `+sbCents("o.subtotal")+`, `+sbCents("o.discount")+`,
		       `+sbCents("o.bill_discount")+`, `+sbCents("o.tax_total")+`,
		       `+sbCents("o.round_off")+`, `+sbCents("o.total")+`,
		       `+sbCents("o.delivery_fee")+`, o.buyer_tax
		  FROM shopbook_order o JOIN shopbook_shop s ON s.id = o.shop_id
		 WHERE o.id=$1`, orderID).
		Scan(&status, &currency, &subtotal, &discount, &billDiscount, &taxTotal,
			&roundOff, &total, &deliveryFee, &buyerTax); err != nil {
		return nil, err
	}

	rows, err := q.Query(ctx, `
		SELECT id, name, brand, unit, `+sbCents("qty")+`,
		       `+sbCents("COALESCE(fulfilled_qty, qty)")+`, fulfilled_qty IS NOT NULL,
		       `+sbCents("price")+`, `+sbCents("tax_percent")+`,
		       `+sbCents("line_discount")+`, `+sbCents("line_tax")+`, `+sbCents("line_total")+`,
		       availability, removed, custom
		  FROM shopbook_order_item WHERE order_id=$1 ORDER BY id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := []map[string]any{}
	for rows.Next() {
		var id, name, brand, unit, avail string
		var reqQty, fulQty, price, taxPct, lineDisc, lineTax, lineTotal int64
		var weighed, removed, custom bool
		if rows.Scan(&id, &name, &brand, &unit, &reqQty, &fulQty, &weighed,
			&price, &taxPct, &lineDisc, &lineTax, &lineTotal,
			&avail, &removed, &custom) != nil {
			continue
		}
		lines = append(lines, map[string]any{
			"id": id, "name": name, "brand": brand, "unit": unit,
			"requestedQty": float64(reqQty) / 100,
			"fulfilledQty": float64(fulQty) / 100,
			"weighed":      weighed, // the shop set an actual quantity
			"price":        money(price).Float(), "taxPercent": float64(taxPct) / 100,
			"discount": money(lineDisc).Float(), "tax": money(lineTax).Float(),
			"total":        money(lineTotal).Float(),
			"availability": avail, "removed": removed, "custom": custom,
		})
	}
	if len(buyerTax) == 0 {
		buyerTax = []byte(`{}`)
	}
	return map[string]any{
		"orderId": orderID, "status": status, "currency": currency,
		"lines":    lines,
		"subtotal": money(subtotal).Float(),
		"discount": money(discount).Float(),
		// Split out so the owner can see which part they gave away themselves.
		"billDiscount": money(billDiscount).Float(),
		"taxTotal":     money(taxTotal).Float(),
		"roundOff":     money(roundOff).Float(),
		"deliveryFee":  money(deliveryFee).Float(),
		"total":        money(total).Float(),
		"buyerTax":     json.RawMessage(buyerTax),
		"editable":     sbBillableStatuses[status],
	}, nil
}

// GET /shopbook/my-shop/orders/{id}/bill
func sbGetBill(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	orderID := r.PathValue("id")
	if !sbOrderBelongsToShop(ctx, orderID, shopID) {
		httpx.Err(w, http.StatusNotFound, "Order not found for your shop")
		return
	}
	bill, err := sbBillJSON(ctx, db.Pool, orderID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, bill)
}

func sbOrderBelongsToShop(ctx context.Context, orderID, shopID string) bool {
	var n int
	err := db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM shopbook_order WHERE id=$1 AND shop_id=$2`, orderID, shopID).Scan(&n)
	return err == nil && n == 1
}

// POST /shopbook/my-shop/orders/{id}/bill
//
// One endpoint for every counter action, because they all end the same way:
// apply the change, re-derive the bill, return it. Splitting them into five
// endpoints would just be five chances for the client to hold a stale total.
func sbUpdateBill(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	orderID := r.PathValue("id")

	var b struct {
		// Per-line: the quantity actually packed, and removal.
		Lines []struct {
			ID           string   `json:"id"`
			FulfilledQty *float64 `json:"fulfilledQty"` // null clears → back to requested
			Removed      *bool    `json:"removed"`
		} `json:"lines"`
		// Add a line the customer asked for at the counter.
		Add *struct {
			ProductID string  `json:"productId"`
			Name      string  `json:"name"`
			Brand     string  `json:"brand"`
			Unit      string  `json:"unit"`
			Qty       float64 `json:"qty"`
			Price     float64 `json:"price"` // only honoured for a non-catalog line
			Note      string  `json:"note"`
		} `json:"add"`
		// Counter discount, in currency units.
		BillDiscount *float64 `json:"billDiscount"`
	}
	_ = httpx.Body(r, &b)

	var bill map[string]any
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(ctx,
			`SELECT status FROM shopbook_order WHERE id=$1 AND shop_id=$2 FOR UPDATE`,
			orderID, shopID).Scan(&status); err != nil {
			return err
		}
		if !sbBillableStatuses[status] {
			return errSBBillLocked
		}

		for _, l := range b.Lines {
			if l.FulfilledQty != nil {
				if *l.FulfilledQty < 0 {
					return errSBBadQty
				}
				if _, err := tx.Exec(ctx,
					`UPDATE shopbook_order_item SET fulfilled_qty=`+sbAmt("$2")+`
					  WHERE id=$1 AND order_id=$3`,
					l.ID, int64(math.Round(*l.FulfilledQty*100)), orderID); err != nil {
					return err
				}
			}
			if l.Removed != nil {
				if _, err := tx.Exec(ctx,
					`UPDATE shopbook_order_item SET removed=$2 WHERE id=$1 AND order_id=$3`,
					l.ID, *l.Removed, orderID); err != nil {
					return err
				}
			}
		}

		if b.Add != nil && strings.TrimSpace(b.Add.Name) != "" {
			// A catalog line is priced by the server exactly as at ordering
			// time; only a genuinely off-catalog item takes the owner's price,
			// and the owner is the seller, so that is theirs to set.
			cp := money(math.Round(b.Add.Price * 100))
			in := []sbLineIn{{
				ProductID: b.Add.ProductID, Name: b.Add.Name, Brand: b.Add.Brand,
				Unit: b.Add.Unit, Note: b.Add.Note,
				Qty100: int64(math.Round(b.Add.Qty * 100)),
			}}
			p, err := sbPriceLines(ctx, tx, shopID, in, "", 0)
			if err != nil {
				return err
			}
			l := p.Lines[0]
			if l.Custom {
				l.Price = cp // off-catalog: the counter names the price
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO shopbook_order_item
				   (order_id, product_id, custom, name, brand, unit, qty, price, tax_percent,
				    note, availability)
				 VALUES ($1,$2,$3,$4,$5,$6,`+sbAmt("$7")+`,`+sbAmt("$8")+`,`+sbAmt("$9")+`,
				         $10,'available')`,
				orderID, nullIfEmpty(l.ProductID), l.Custom, l.Name, l.Brand, l.Unit,
				l.Qty100, int64(l.Price), l.TaxPct100, l.Note); err != nil {
				return err
			}
		}

		if b.BillDiscount != nil {
			if *b.BillDiscount < 0 {
				return errSBBadQty
			}
			if _, err := tx.Exec(ctx,
				`UPDATE shopbook_order SET bill_discount=`+sbAmt("$2")+` WHERE id=$1`,
				orderID, int64(math.Round(*b.BillDiscount*100))); err != nil {
				return err
			}
		}

		// The re-derive. Nothing the client sent became a total.
		if err := sbRepriceOrder(ctx, tx, orderID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE shopbook_order SET billed_at=NOW() WHERE id=$1`, orderID); err != nil {
			return err
		}
		out, err := sbBillJSON(ctx, tx, orderID)
		bill = out
		return err
	})
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found for your shop")
		return
	}
	switch {
	case err == errSBBillLocked:
		httpx.Err(w, http.StatusConflict,
			"This bill can only be changed while the order is being prepared or packed")
		return
	case err == errSBBadQty:
		httpx.Err(w, http.StatusBadRequest, "Quantities and discounts cannot be negative")
		return
	case err != nil:
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, bill)
}

var (
	errSBBillLocked = errSBSentinel("bill locked")
	errSBBadQty     = errSBSentinel("bad quantity")
)

type errSBSentinel string

func (e errSBSentinel) Error() string { return string(e) }

// POST /shopbook/orders/{id}/buyer-tax — the customer declares (or clears) the
// business they are buying for.
//
// Supplying a tax number turns the document into a tax invoice they can
// reclaim against; supplying nothing leaves it a retail bill. Both must look
// complete, which is why this is a decision made BEFORE the invoice is issued
// and not a template toggle afterwards.
func sbSetBuyerTax(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	orderID := r.PathValue("id")
	var b struct {
		BusinessName string `json:"businessName"`
		TaxNumber    string `json:"taxNumber"`
		Address      string `json:"address"`
	}
	_ = httpx.Body(r, &b)

	var status string
	var custID string
	if err := db.Pool.QueryRow(ctx,
		`SELECT customer_user_id, status FROM shopbook_order WHERE id=$1`,
		orderID).Scan(&custID, &status); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, http.StatusNotFound, "Order not found")
			return
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if custID != user.ID {
		httpx.Err(w, http.StatusForbidden, "Not your order")
		return
	}
	// Once the invoice exists it is immutable — this has to be said before.
	var invoiced bool
	_ = db.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM shopbook_invoice WHERE order_id=$1)`, orderID).Scan(&invoiced)
	if invoiced {
		httpx.Err(w, http.StatusConflict,
			"The invoice for this order is already issued — ask the shop for a revised bill")
		return
	}

	buyer := map[string]any{}
	if strings.TrimSpace(b.BusinessName) != "" {
		buyer["businessName"] = strings.TrimSpace(b.BusinessName)
	}
	if strings.TrimSpace(b.TaxNumber) != "" {
		buyer["taxNumber"] = strings.TrimSpace(b.TaxNumber)
	}
	if strings.TrimSpace(b.Address) != "" {
		buyer["address"] = strings.TrimSpace(b.Address)
	}
	bj, _ := json.Marshal(buyer)
	if _, err := db.Pool.Exec(ctx,
		`UPDATE shopbook_order SET buyer_tax=$2, updated_at=NOW() WHERE id=$1`,
		orderID, sbJSON(bj)); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"ok": true, "invoiceKind": map[bool]string{true: "tax", false: "retail"}[len(buyer) > 0],
	})
}

// ── subscription entitlement (bug #8) ─────────────────────────────

// sbEntitledPlan returns the plan a shop is actually entitled to, from the
// entitlement record — not from the `plan` column the owner used to be able to
// POST directly. An expired or cancelled entitlement falls back to free
// WITHOUT touching any data: restricting a feature must never delete records.
func sbEntitledPlan(ctx context.Context, shopID string) string {
	var plan, state string
	var expired bool
	err := db.Pool.QueryRow(ctx, `
		SELECT plan, state, (expires_at IS NOT NULL AND expires_at < NOW())
		  FROM shopbook_entitlement WHERE shop_id=$1`, shopID).Scan(&plan, &state, &expired)
	if err != nil {
		return "free" // no entitlement row = never purchased
	}
	return sbPlanFromEntitlement(plan, state, expired)
}

// sbPlanFromEntitlement is the entitlement state machine, kept pure so the
// rules can be asserted without a database.
//
// past_due and grace_period deliberately keep Pro working: a failed card
// should cost a shop its billing, not its Saturday trade. expired and
// cancelled drop to free — which restricts features and deletes nothing.
func sbPlanFromEntitlement(plan, state string, expired bool) string {
	if plan != "pro" {
		return "free"
	}
	switch state {
	case "grace_period":
		return "pro" // the whole point of grace is that expiry does not bite yet
	case "trial", "active", "past_due":
		if expired {
			return "free"
		}
		return "pro"
	default: // expired, cancelled
		return "free"
	}
}
