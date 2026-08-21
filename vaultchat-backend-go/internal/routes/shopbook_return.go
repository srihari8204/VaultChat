// shopbook_return.go — SHOP BOOK returns and credit notes (P1-B).
//
// The rule that shapes this whole file: A FINALIZED INVOICE IS NEVER EDITED.
// Goods coming back is a new event, and it gets a new document — a credit note
// that references the invoice and sits beside it. Editing the original would
// make the shop's tax records indefensible and would quietly rewrite what the
// customer was told they bought.
//
// Refund value comes from the ORIGINAL line price, never a re-quote: a price
// rise between the sale and the return must not change what is owed back.
//
// Flow: customer requests → owner approves or rejects (with a reason) →
// approval issues the credit note, posts the khata entry, and puts sellable
// goods back on the shelf.
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

func RegisterShopBookReturns(mux *http.ServeMux) {
	mux.HandleFunc("POST /shopbook/orders/{id}/return", httpx.RequireAuth(sbRequestReturn))
	mux.HandleFunc("GET /shopbook/returns", httpx.RequireAuth(sbMyReturns))
	mux.HandleFunc("GET /shopbook/my-shop/returns", httpx.RequireAuth(sbShopReturns))
	mux.HandleFunc("POST /shopbook/my-shop/returns/{id}/decide", httpx.RequireAuth(sbDecideReturn))
	mux.HandleFunc("GET /shopbook/credit-notes/{id}", httpx.RequireAuth(sbCreditNote))
}

// How long after collection a return may be raised. A window has to exist —
// without one, a shop can be asked for milk back in March — and it has to be
// visible rather than implied.
const sbReturnWindow = 7 * 24 * time.Hour

// POST /shopbook/orders/{id}/return — the customer raises it.
func sbRequestReturn(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	orderID := r.PathValue("id")
	var b struct {
		Reason         string `json:"reason"`
		IdempotencyKey string `json:"idempotencyKey"`
		Items          []struct {
			OrderItemID string  `json:"orderItemId"`
			Qty         float64 `json:"qty"`
		} `json:"items"`
	}
	if err := httpx.Body(r, &b); err != nil || len(b.Items) == 0 {
		httpx.Err(w, http.StatusBadRequest, "at least one item required")
		return
	}
	if strings.TrimSpace(b.Reason) == "" {
		httpx.Err(w, http.StatusBadRequest, "a reason is required")
		return
	}

	var shopID, status string
	var completedAgo time.Duration
	var secs float64
	if err := db.Pool.QueryRow(ctx, `
		SELECT o.shop_id, o.status,
		       EXTRACT(EPOCH FROM (NOW() - COALESCE(
		         (SELECT MAX(at) FROM shopbook_order_event e
		           WHERE e.order_id=o.id AND e.status='completed'), o.updated_at)))
		  FROM shopbook_order o WHERE o.id=$1 AND o.customer_user_id=$2`,
		orderID, user.ID).Scan(&shopID, &status, &secs); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, http.StatusNotFound, "Order not found")
			return
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	completedAgo = time.Duration(secs) * time.Second
	if status != "completed" {
		httpx.Err(w, http.StatusConflict,
			"Only a completed order can be returned — if you have not collected it yet, cancel instead")
		return
	}
	if completedAgo > sbReturnWindow {
		httpx.Err(w, http.StatusConflict,
			fmt.Sprintf("The %d-day return window for this order has passed",
				int(sbReturnWindow.Hours()/24)),
			map[string]any{"code": "return_window_closed"})
		return
	}

	idem := sbIdemKey(r.Header.Get("Idempotency-Key"), b.IdempotencyKey)
	var returnID string
	var refund money
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO shopbook_return
			  (shop_id, order_id, customer_user_id, reason, idempotency_key)
			VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			shopID, orderID, user.ID, strings.TrimSpace(b.Reason), idem).Scan(&returnID); err != nil {
			return err
		}
		for _, it := range b.Items {
			if it.Qty <= 0 {
				return errSBBadQty
			}
			// Price, tax rate and the quantity actually supplied all come from
			// the order line. The client names the line and how much of it is
			// coming back; it does not get to say what that is worth.
			var name, unit string
			var price, taxPct, billedQty int64
			if err := tx.QueryRow(ctx, `
				SELECT i.name, i.unit, `+sbCents("i.price")+`, `+sbCents("i.tax_percent")+`,
				       `+sbCents("COALESCE(i.fulfilled_qty, i.qty)")+`
				  FROM shopbook_order_item i
				 WHERE i.id=$1 AND i.order_id=$2 AND i.availability <> 'unavailable' AND NOT i.removed`,
				it.OrderItemID, orderID).Scan(&name, &unit, &price, &taxPct, &billedQty); err != nil {
				return fmt.Errorf("bad line")
			}
			qty100 := int64(math.Round(it.Qty * 100))
			if qty100 > billedQty {
				return fmt.Errorf("over qty:%s", name)
			}
			base := money(price).mulQty(qty100)
			tax := base.pctOf(taxPct)
			refund += base + tax
			var pid *string
			if err := tx.QueryRow(ctx,
				`SELECT product_id::text FROM shopbook_order_item WHERE id=$1`,
				it.OrderItemID).Scan(&pid); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO shopbook_return_item
				  (return_id, order_item_id, product_id, name, unit, qty, unit_price,
				   line_tax, line_total)
				VALUES ($1,$2,$3,$4,$5,`+sbAmt("$6")+`,`+sbAmt("$7")+`,`+sbAmt("$8")+`,`+sbAmt("$9")+`)`,
				returnID, it.OrderItemID, pid, name, unit,
				qty100, price, int64(tax), int64(base+tax)); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx,
			`UPDATE shopbook_return SET refund_total=`+sbAmt("$2")+` WHERE id=$1`,
			returnID, int64(refund))
		return err
	})
	switch {
	case err == errSBBadQty:
		httpx.Err(w, http.StatusBadRequest, "Quantity must be positive")
		return
	case err != nil && strings.HasPrefix(err.Error(), "over qty:"):
		httpx.Err(w, http.StatusBadRequest,
			"You cannot return more "+strings.TrimPrefix(err.Error(), "over qty:")+" than you were billed for")
		return
	case err != nil && err.Error() == "bad line":
		httpx.Err(w, http.StatusBadRequest, "That item is not on this order")
		return
	case err != nil && sbIsUniqueViolation(err, "idx_shopbook_return_one_open"):
		httpx.Err(w, http.StatusConflict, "There is already an open return for this order")
		return
	case err != nil:
		log.Printf("[shopbook] return request failed (order=%s): %v", orderID, err)
		httpx.Err(w, http.StatusInternalServerError, "could not raise the return")
		return
	}

	var ownerID string
	if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).
		Scan(&ownerID) == nil && ownerID != "" {
		sbNotify(ctx, ownerID, "Return requested ↩️",
			fmt.Sprintf("%s — %s", sbMoney(ctx, shopID, refund.Float()), b.Reason),
			map[string]any{"event": "return_requested", "returnId": returnID, "orderId": orderID})
	}
	httpx.JSON(w, 201, map[string]any{
		"id": returnID, "status": "requested", "refundTotal": refund.Float(),
	})
}

// POST /shopbook/my-shop/returns/{id}/decide — the owner approves or rejects.
func sbDecideReturn(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	returnID := r.PathValue("id")
	var b struct {
		Approve    bool   `json:"approve"`
		Note       string `json:"note"`
		Settlement string `json:"settlement"` // refund | credit
		Restock    *bool  `json:"restock"`
	}
	_ = httpx.Body(r, &b)
	if !b.Approve && strings.TrimSpace(b.Note) == "" {
		// "Rejected." with no explanation is the most complained-about
		// outcome of any returns process. Make the shop say why.
		httpx.Err(w, http.StatusBadRequest, "a reason is required when rejecting a return")
		return
	}
	if b.Settlement != "refund" {
		b.Settlement = "credit"
	}
	restock := true
	if b.Restock != nil {
		restock = *b.Restock
	}

	var custID, orderID string
	var noteID string
	var refund money
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var status string
		var refundC int64
		if err := tx.QueryRow(ctx, `
			SELECT status, customer_user_id, order_id, `+sbCents("refund_total")+`
			  FROM shopbook_return WHERE id=$1 AND shop_id=$2 FOR UPDATE`,
			returnID, shopID).Scan(&status, &custID, &orderID, &refundC); err != nil {
			return err
		}
		if status != "requested" {
			return fmt.Errorf("already decided")
		}
		refund = money(refundC)

		if !b.Approve {
			_, err := tx.Exec(ctx, `
				UPDATE shopbook_return
				   SET status='rejected', decision_note=$2, decided_at=NOW(), decided_by=$3
				 WHERE id=$1`, returnID, strings.TrimSpace(b.Note), user.ID)
			sbAudit(ctx, tx, sbAuditEntry{
				ShopID: shopID, Actor: user.ID, Action: "return.reject",
				Entity: "return", EntityID: returnID, Reason: b.Note, IP: sbClientIP(r),
			})
			return err
		}

		if _, err := tx.Exec(ctx, `
			UPDATE shopbook_return
			   SET status='completed', decision_note=$2, settlement=$3, restock=$4,
			       decided_at=NOW(), decided_by=$5
			 WHERE id=$1`,
			returnID, strings.TrimSpace(b.Note), b.Settlement, restock, user.ID); err != nil {
			return err
		}

		// Goods back on the shelf — unless they came back damaged, which is
		// what restock=false means. Damaged stock is written off separately so
		// the loss is visible rather than absorbed.
		if restock {
			rows, err := tx.Query(ctx, `
				SELECT ri.product_id::text, ri.unit, `+sbCents("SUM(ri.qty)")+`
				  FROM shopbook_return_item ri
				  JOIN shopbook_product p ON p.id = ri.product_id
				 WHERE ri.return_id=$1 AND p.track_stock
				 GROUP BY ri.product_id, ri.unit`, returnID)
			if err != nil {
				return err
			}
			type back struct {
				pid, unit string
				qty100    int64
			}
			items := []back{}
			for rows.Next() {
				var x back
				if rows.Scan(&x.pid, &x.unit, &x.qty100) == nil {
					items = append(items, x)
				}
			}
			rows.Close()
			for _, x := range items {
				okMove, err := sbApplyMove(ctx, tx, sbMove{
					ShopID: shopID, ProductID: x.pid, Kind: "return",
					OnHand: x.qty100, Unit: x.unit, Actor: user.ID,
					RefEntity: "return", RefID: returnID, Reason: "customer return",
				})
				if err != nil {
					return err
				}
				if !okMove {
					return fmt.Errorf("restock refused for %s", x.pid)
				}
			}
		}

		// The credit note — beside the invoice, never instead of it.
		var err error
		noteID, err = sbCreateCreditNote(ctx, tx, shopID, orderID, returnID, custID, "credit",
			strings.TrimSpace(b.Note))
		if err != nil {
			return err
		}

		// The khata entry. A refund is money leaving the till; a credit sits
		// on the account. Both reduce what the customer owes, and both say so
		// in their own words rather than as an unexplained balance change.
		typ, remark := "credit_note", "Return credited"
		if b.Settlement == "refund" {
			typ, remark = "refund", "Return refunded"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark, order_id)
			VALUES ($1,$2,$3,`+sbAmt("$4")+`,$5,$6)`,
			shopID, custID, typ, int64(refund), remark, orderID); err != nil {
			return err
		}
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID, Action: "return.approve",
			Entity: "return", EntityID: returnID,
			After: map[string]any{
				"settlement": b.Settlement, "refundTotal": refund.Float(),
				"restock": restock, "creditNoteId": noteID,
			},
			Reason: b.Note, IP: sbClientIP(r),
		})
		return nil
	})
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Return not found for your shop")
		return
	}
	if err != nil {
		if err.Error() == "already decided" {
			httpx.Err(w, http.StatusConflict, "This return has already been decided")
			return
		}
		log.Printf("[shopbook] return decision failed (return=%s): %v", returnID, err)
		httpx.Err(w, http.StatusInternalServerError, "could not record the decision")
		return
	}

	if b.Approve {
		sbNotify(ctx, custID, "Return approved ✅",
			sbMoney(ctx, shopID, refund.Float())+" has been credited to your account",
			map[string]any{"event": "return_approved", "returnId": returnID, "creditNoteId": noteID})
	} else {
		sbNotify(ctx, custID, "Return declined",
			b.Note, map[string]any{"event": "return_rejected", "returnId": returnID})
	}
	out := map[string]any{"ok": true, "status": map[bool]string{true: "completed", false: "rejected"}[b.Approve]}
	if noteID != "" {
		out["creditNoteId"] = noteID
		out["refundTotal"] = refund.Float()
	}
	httpx.JSON(w, 200, out)
}

// sbCreateCreditNote issues a sequential, immutable credit (or debit) note
// against an order's invoice. The number is allocated with UPDATE … RETURNING
// inside the caller's transaction, so two concurrent returns cannot collide.
func sbCreateCreditNote(ctx context.Context, tx pgx.Tx, shopID, orderID, returnID, custID, kind, reason string) (string, error) {
	var invoiceID, currency, custName string
	var business []byte
	if err := tx.QueryRow(ctx, `
		SELECT id::text, currency, customer_name, business
		  FROM shopbook_invoice WHERE order_id=$1`, orderID).
		Scan(&invoiceID, &currency, &custName, &business); err != nil {
		return "", fmt.Errorf("no invoice to credit: %w", err)
	}

	seqCol := "credit_note_seq"
	if kind == "debit" {
		seqCol = "debit_note_seq"
	}
	var seq int
	if err := tx.QueryRow(ctx,
		`UPDATE shopbook_shop SET `+seqCol+` = `+seqCol+` + 1 WHERE id=$1 RETURNING `+seqCol,
		shopID).Scan(&seq); err != nil {
		return "", err
	}

	rows, err := tx.Query(ctx, `
		SELECT name, unit, `+sbCents("qty")+`, `+sbCents("unit_price")+`,
		       `+sbCents("line_tax")+`, `+sbCents("line_total")+`
		  FROM shopbook_return_item WHERE return_id=$1 ORDER BY id`, returnID)
	if err != nil {
		return "", err
	}
	type line struct {
		Name  string  `json:"name"`
		Unit  string  `json:"unit"`
		Qty   float64 `json:"qty"`
		Price float64 `json:"price"`
		Tax   float64 `json:"tax"`
		Total float64 `json:"total"`
	}
	lines := []line{}
	var subtotal, taxTotal, total money
	for rows.Next() {
		var name, unit string
		var qty, price, tax, lineTotal int64
		if rows.Scan(&name, &unit, &qty, &price, &tax, &lineTotal) != nil {
			continue
		}
		lines = append(lines, line{
			Name: name, Unit: unit, Qty: float64(qty) / 100,
			Price: money(price).Float(), Tax: money(tax).Float(),
			Total: money(lineTotal).Float(),
		})
		subtotal += money(lineTotal) - money(tax)
		taxTotal += money(tax)
		total += money(lineTotal)
	}
	rows.Close()

	itemsJSON, _ := json.Marshal(lines)
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO shopbook_credit_note
		  (shop_id, invoice_id, return_id, customer_user_id, kind, number, reason,
		   subtotal, tax_total, total, items, business, customer_name, currency)
		VALUES ($1,$2,$3,$4,$5,$6,$7,`+sbAmt("$8")+`,`+sbAmt("$9")+`,`+sbAmt("$10")+`,
		        $11,$12,$13,$14)
		RETURNING id`,
		shopID, invoiceID, returnID, custID, kind, seq, reason,
		int64(subtotal), int64(taxTotal), int64(total),
		sbJSON(itemsJSON), sbJSON(business), custName, currency).Scan(&id)
	return id, err
}

// GET /shopbook/credit-notes/{id} — readable by the customer or the shop.
func sbCreditNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	id := r.PathValue("id")

	var shopID, custID, kind, reason, currency, custName string
	var number int
	var subtotal, taxTotal, total int64
	var items, business []byte
	var created time.Time
	if err := db.Pool.QueryRow(ctx, `
		SELECT shop_id::text, customer_user_id::text, kind, number, reason, currency,
		       customer_name, `+sbCents("subtotal")+`, `+sbCents("tax_total")+`,
		       `+sbCents("total")+`, items, business, created_at
		  FROM shopbook_credit_note WHERE id=$1`, id).
		Scan(&shopID, &custID, &kind, &number, &reason, &currency, &custName,
			&subtotal, &taxTotal, &total, &items, &business, &created); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, http.StatusNotFound, "Credit note not found")
			return
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if custID != user.ID {
		var owner string
		if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).
			Scan(&owner) != nil || owner != user.ID {
			httpx.Err(w, http.StatusForbidden, "Not your credit note")
			return
		}
	}
	prefix := "CN"
	if kind == "debit" {
		prefix = "DN"
	}
	httpx.JSON(w, 200, map[string]any{
		"id": id, "kind": kind, "number": number,
		"noteNo": fmt.Sprintf("%s-%04d", prefix, number),
		"reason": reason, "currency": currency, "customerName": custName,
		"subtotal": money(subtotal).Float(), "taxTotal": money(taxTotal).Float(),
		"total":     money(total).Float(),
		"items":     json.RawMessage(sbJSON(items)),
		"business":  json.RawMessage(sbJSON(business)),
		"createdAt": httpx.JST(&created),
	})
}

// sbReturnRows renders a return list for either side of the counter.
func sbReturnRows(ctx context.Context, where string, args ...any) ([]map[string]any, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT rt.id, rt.order_id, rt.status, rt.reason, rt.decision_note, rt.settlement,
		       `+sbCents("rt.refund_total")+`, rt.requested_at,
		       COALESCE(u.name,''), s.name, s.currency,
		       COALESCE((SELECT cn.id::text FROM shopbook_credit_note cn WHERE cn.return_id=rt.id),'')
		  FROM shopbook_return rt
		  JOIN shopbook_shop s ON s.id = rt.shop_id
		  LEFT JOIN users u ON u.id = rt.customer_user_id
		 WHERE `+where+`
		 ORDER BY rt.requested_at DESC LIMIT 100`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, orderID, status, reason, note, settlement string
		var custName, shopName, currency, noteID string
		var refund int64
		var at time.Time
		if rows.Scan(&id, &orderID, &status, &reason, &note, &settlement,
			&refund, &at, &custName, &shopName, &currency, &noteID) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "orderId": orderID, "status": status, "reason": reason,
			"decisionNote": note, "settlement": settlement,
			"refundTotal": money(refund).Float(), "requestedAt": httpx.JST(&at),
			"customerName": custName, "shopName": shopName, "currency": currency,
			"creditNoteId": noteID,
		})
	}
	return out, nil
}

// GET /shopbook/returns — the customer's own.
func sbMyReturns(w http.ResponseWriter, r *http.Request) {
	out, err := sbReturnRows(r.Context(), `rt.customer_user_id=$1`, httpx.UserFrom(r).ID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"returns": out})
}

// GET /shopbook/my-shop/returns?status=
func sbShopReturns(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	where, args := `rt.shop_id=$1`, []any{shopID}
	if st := r.URL.Query().Get("status"); st != "" && st != "all" {
		where += ` AND rt.status=$2`
		args = append(args, st)
	}
	out, err := sbReturnRows(ctx, where, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"returns": out})
}
