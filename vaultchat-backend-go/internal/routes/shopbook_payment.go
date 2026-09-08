// shopbook_payment.go — SHOP BOOK payments, khata and credit limits (P0-E).
//
// A payment is a RECORD of money that arrived, never a status somebody set.
// Two consequences run through this file:
//
//   - Invoice payment state is DERIVED — Σ(captured payments) against the
//     invoice total decides unpaid / partially_paid / paid. There is no column
//     to update and therefore nothing that can drift from the money.
//
//   - Nothing here confirms a payment on a client's word. Manual entries are
//     the shop asserting cash/UPI/bank in hand, which is exactly what a paper
//     khata records. A gateway will write 'pending' and settle it itself; the
//     schema is ready for that and the app will not pre-empt it.
//
// Every payment also posts its khata ledger entry inside the same transaction,
// so "recorded a payment" and "the customer owes less" cannot come apart.
package routes

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

var errSBOrderNotYours = errors.New("order does not belong to this customer/shop")

func RegisterShopBookPayments(mux *http.ServeMux) {
	mux.HandleFunc("POST /shopbook/my-shop/payments", httpx.RequireAuth(sbRecordPayment))
	mux.HandleFunc("GET /shopbook/my-shop/payments", httpx.RequireAuth(sbShopPayments))
	mux.HandleFunc("GET /shopbook/payments", httpx.RequireAuth(sbMyPayments))
	mux.HandleFunc("POST /shopbook/my-shop/customers/{id}/credit-limit", httpx.RequireAuth(sbSetCreditLimit))
}

var sbPaymentMethods = map[string]bool{
	"cash": true, "bank": true, "upi": true, "card": true, "other": true,
}

// sbInvoicePaymentState derives an invoice's payment status from its payments.
// Returned as (state, paid, due) so a caller never has to add it up again and
// arrive somewhere different.
func sbInvoicePaymentState(ctx context.Context, q sbQ, invoiceID string) (string, money, money, error) {
	var total, paid int64
	if err := q.QueryRow(ctx, `
		SELECT `+sbCents("i.total")+`,
		       COALESCE((SELECT SUM(`+sbCents("p.amount")+`) FROM shopbook_payment p
		                  WHERE p.invoice_id = i.id AND p.status='captured'), 0)
		  FROM shopbook_invoice i WHERE i.id=$1`, invoiceID).Scan(&total, &paid); err != nil {
		return "", 0, 0, err
	}
	due := money(total - paid)
	switch {
	case paid <= 0:
		return "unpaid", money(paid), due, nil
	case due > 0:
		return "partially_paid", money(paid), due, nil
	default:
		// Overpayment lands here too: due is ≤ 0 and the surplus shows as
		// credit on the khata, which is where a customer would look for it.
		return "paid", money(paid), 0, nil
	}
}

// POST /shopbook/my-shop/payments — the owner records money received.
func sbRecordPayment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var b struct {
		CustomerID     string  `json:"customerId"`
		OrderID        string  `json:"orderId"`
		Amount         float64 `json:"amount"`
		Method         string  `json:"method"`
		Reference      string  `json:"reference"`
		Note           string  `json:"note"`
		IdempotencyKey string  `json:"idempotencyKey"`
	}
	if err := httpx.Body(r, &b); err != nil || b.CustomerID == "" || b.Amount <= 0 {
		httpx.Err(w, http.StatusBadRequest, "customerId and a positive amount required")
		return
	}
	if b.Method == "" {
		b.Method = "cash"
	}
	if !sbPaymentMethods[b.Method] {
		httpx.Err(w, http.StatusBadRequest, "method must be cash|bank|upi|card|other")
		return
	}
	amount := money(math.Round(b.Amount * 100))

	// Same rule as the ledger: a shop may only take payment against a khata it
	// already has. An arbitrary customerId would let one shop write into a
	// stranger's financial history.
	var related bool
	if err := db.Pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM shopbook_customer WHERE shop_id=$1 AND customer_user_id=$2)
		    OR EXISTS(SELECT 1 FROM shopbook_order    WHERE shop_id=$1 AND customer_user_id=$2)`,
		shopID, b.CustomerID).Scan(&related); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if !related {
		httpx.Err(w, http.StatusForbidden,
			"That customer has no account with your shop yet")
		return
	}

	idem := sbIdemKey(r.Header.Get("Idempotency-Key"), b.IdempotencyKey)
	if idem != "" {
		var id string
		if db.Pool.QueryRow(ctx,
			`SELECT id FROM shopbook_payment WHERE shop_id=$1 AND idempotency_key=$2`,
			shopID, idem).Scan(&id) == nil {
			httpx.JSON(w, 200, map[string]any{"id": id, "duplicate": true})
			return
		}
	}

	var paymentID, invoiceID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		// AUDIT F04: THE ORDER MUST BELONG TO THIS CUSTOMER, AND THIS SHOP.
		//
		// The invoice used to be looked up on (order_id, shop_id) alone, with
		// the customer never brought into it — and a failed lookup was ignored
		// while the supplied order id was still written to the ledger and the
		// payment row. So a payment recorded for customer A quoting customer
		// B's order credited A's khata AND settled B's invoice: money moving
		// between two people's books from one request. The schema cannot catch
		// it either; the foreign keys are separate and nothing ties the pair.
		//
		// Resolved inside the transaction, against the order itself, so the
		// relationship that is written is the relationship that was checked.
		var invID *string
		if b.OrderID != "" {
			var orderCustomer string
			switch err := tx.QueryRow(ctx,
				`SELECT customer_user_id::text FROM shopbook_order
				  WHERE id=$1 AND shop_id=$2`, b.OrderID, shopID).Scan(&orderCustomer); {
			case err != nil && db.NoRows(err):
				return errSBOrderNotYours
			case err != nil:
				return err
			case orderCustomer != b.CustomerID:
				return errSBOrderNotYours
			}
			// Only now is it safe to settle against that order's invoice.
			var found string
			if err := tx.QueryRow(ctx,
				`SELECT i.id::text FROM shopbook_invoice i
				  WHERE i.order_id=$1 AND i.shop_id=$2`, b.OrderID, shopID).Scan(&found); err == nil {
				invID = &found
				invoiceID = found
			} else if !db.NoRows(err) {
				return err
			}
		}
		// The khata entry and the payment are one fact recorded twice; they
		// are written together or not at all.
		var ledgerID string
		if err := tx.QueryRow(ctx, `
			INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark, order_id)
			VALUES ($1,$2,'payment',`+sbAmt("$3")+`,$4,$5) RETURNING id`,
			shopID, b.CustomerID, int64(amount),
			strings.TrimSpace(b.Method+" "+b.Reference), nullIfEmpty(b.OrderID)).Scan(&ledgerID); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `
			INSERT INTO shopbook_payment
			  (shop_id, customer_user_id, order_id, invoice_id, amount, method, status,
			   reference, note, actor_user_id, ledger_id, idempotency_key)
			VALUES ($1,$2,$3,$4,`+sbAmt("$5")+`,$6,'captured',$7,$8,$9,$10,$11)
			RETURNING id`,
			shopID, b.CustomerID, nullIfEmpty(b.OrderID), invID, int64(amount), b.Method,
			b.Reference, b.Note, user.ID, ledgerID, idem).Scan(&paymentID)
	})
	if err != nil {
		if errors.Is(err, errSBOrderNotYours) {
			httpx.Err(w, http.StatusBadRequest,
				"That order belongs to a different customer or shop")
			return
		}
		if idem != "" && sbIsUniqueViolation(err, "idx_shopbook_payment_idem") {
			var id string
			if db.Pool.QueryRow(ctx,
				`SELECT id FROM shopbook_payment WHERE shop_id=$1 AND idempotency_key=$2`,
				shopID, idem).Scan(&id) == nil {
				httpx.JSON(w, 200, map[string]any{"id": id, "duplicate": true})
				return
			}
		}
		httpx.Err(w, http.StatusInternalServerError, "could not record payment")
		return
	}

	out := map[string]any{"id": paymentID, "amount": amount.Float(), "method": b.Method}
	if invoiceID != "" {
		if state, paid, due, err := sbInvoicePaymentState(ctx, db.Pool, invoiceID); err == nil {
			out["invoiceId"] = invoiceID
			out["paymentStatus"] = state
			out["paid"] = paid.Float()
			out["due"] = due.Float()
		}
	}
	sbNotify(ctx, b.CustomerID, "Payment recorded ✅",
		fmt.Sprintf("%s received by the shop (%s)", sbMoney(ctx, shopID, amount.Float()), b.Method),
		map[string]any{"event": "payment", "shopId": shopID, "paymentId": paymentID})
	httpx.JSON(w, 201, out)
}

// sbPaymentRows renders a payment list for either side of the counter.
func sbPaymentRows(ctx context.Context, where string, args ...any) ([]map[string]any, error) {
	rows, err := db.Pool.Query(ctx, `
		SELECT p.id, p.customer_user_id, COALESCE(u.name,''), COALESCE(p.order_id::text,''),
		       `+sbCents("p.amount")+`, p.method, p.status, p.reference, p.note,
		       s.currency, s.name, p.created_at
		  FROM shopbook_payment p
		  JOIN shopbook_shop s ON s.id = p.shop_id
		  LEFT JOIN users u ON u.id = p.customer_user_id
		 WHERE `+where+`
		 ORDER BY p.created_at DESC LIMIT 200`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, custID, custName, orderID, method, status, reference, note string
		var currency, shopName string
		var amount int64
		var at time.Time
		if rows.Scan(&id, &custID, &custName, &orderID, &amount, &method, &status,
			&reference, &note, &currency, &shopName, &at) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "customerId": custID, "customerName": custName, "orderId": orderID,
			"amount": money(amount).Float(), "method": method, "status": status,
			"reference": reference, "note": note, "currency": currency,
			"shopName": shopName, "createdAt": httpx.JST(&at),
		})
	}
	return out, nil
}

// GET /shopbook/my-shop/payments?customerId=
func sbShopPayments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	where, args := `p.shop_id=$1`, []any{shopID}
	if c := r.URL.Query().Get("customerId"); c != "" {
		where += ` AND p.customer_user_id=$2`
		args = append(args, c)
	}
	out, err := sbPaymentRows(ctx, where, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"payments": out})
}

// GET /shopbook/payments — the customer's own payment history, every shop.
func sbMyPayments(w http.ResponseWriter, r *http.Request) {
	out, err := sbPaymentRows(r.Context(), `p.customer_user_id=$1`, httpx.UserFrom(r).ID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"payments": out})
}

// ── credit limit ──────────────────────────────────────────────────

// POST /shopbook/my-shop/customers/{id}/credit-limit — 0 clears it.
func sbSetCreditLimit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	custID := r.PathValue("id")
	var b struct {
		CreditLimit float64 `json:"creditLimit"`
		Note        string  `json:"note"`
	}
	if err := httpx.Body(r, &b); err != nil || b.CreditLimit < 0 {
		httpx.Err(w, http.StatusBadRequest, "creditLimit must be ≥ 0")
		return
	}
	tag, err := db.Pool.Exec(ctx, `
		INSERT INTO shopbook_customer (shop_id, customer_user_id, credit_limit, note)
		VALUES ($1,$2,`+sbAmt("$3")+`,$4)
		ON CONFLICT (shop_id, customer_user_id)
		DO UPDATE SET credit_limit=`+sbAmt("$3")+`, note=$4`,
		shopID, custID, int64(math.Round(b.CreditLimit*100)), b.Note)
	if err != nil || tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "creditLimit": b.CreditLimit})
}

// sbCreditCheck reports whether a new order would take a customer past the
// credit limit their shop set for them.
//
// It WARNS rather than blocks. A shopkeeper knows their customers better than
// a threshold does, and refusing an order outright at the counter is how a
// real relationship gets broken by software. The owner sees the number and
// decides. (Blocking is a per-shop policy P1 can add on top of this.)
// Exactly one of custID / khataCustID identifies the party, matching the
// ledger's party CHECK. Both paths derive `pending` the same way — SUM over the
// ledger — so there is one balance model and one ceiling rule, only two ways of
// naming whose ledger it is.
//
// ONE CEILING RULE, TWO PLACES TO KEEP IT. An account customer's limit lives on
// shopbook_customer (keyed by customer_user_id, which is a users FK); a walk-in's
// lives on shopbook_khata_customer (migration 112), because a walk-in has no
// users row and Postgres refuses that shape. Both are NUMERIC rupees read
// through sbCents, and both are compared against the SAME derived balance —
// SUM over the ledger. There is no second balance and no second rule.
//
// Zero still means "no ceiling configured" for either party, which is what keeps
// every walk-in created before 112 behaving exactly as it did.
func sbCreditCheck(ctx context.Context, q sbQ, shopID, custID, khataCustID string, orderTotal money) (bool, money, money) {
	var limit, pending int64
	var err error
	if khataCustID != "" {
		err = q.QueryRow(ctx, `
			SELECT COALESCE((SELECT `+sbCents("credit_limit")+` FROM shopbook_khata_customer
			                  WHERE id=$2 AND shop_id=$1), 0),
			       COALESCE((SELECT SUM(CASE WHEN type='purchase' THEN `+sbCents("amount")+`
			                                 ELSE -`+sbCents("amount")+` END)
			                   FROM shopbook_ledger WHERE shop_id=$1 AND khata_customer_id=$2), 0)`,
			shopID, khataCustID).Scan(&limit, &pending)
	} else {
		err = q.QueryRow(ctx, `
			SELECT COALESCE((SELECT `+sbCents("credit_limit")+` FROM shopbook_customer
			                  WHERE shop_id=$1 AND customer_user_id=$2), 0),
			       COALESCE((SELECT SUM(CASE WHEN type='purchase' THEN `+sbCents("amount")+`
			                                 ELSE -`+sbCents("amount")+` END)
			                   FROM shopbook_ledger WHERE shop_id=$1 AND customer_user_id=$2), 0)`,
			shopID, custID).Scan(&limit, &pending)
	}
	if err != nil || limit <= 0 {
		return false, 0, 0 // no limit configured → nothing to warn about
	}
	return money(pending)+orderTotal > money(limit), money(pending), money(limit)
}
