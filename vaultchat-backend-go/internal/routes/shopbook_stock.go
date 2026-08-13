// shopbook_stock.go — SHOP BOOK inventory and stock reservation (P0-B).
//
// The whole point of this file is one UPDATE:
//
//	UPDATE shopbook_stock SET reserved = reserved + q
//	 WHERE product_id = $1 AND on_hand - reserved >= q
//
// Two customers ordering the last two bags of rice both read "2 available".
// Only one of them can win that UPDATE, because Postgres serialises the row.
// Every check performed before it — in the client, in the handler, in a
// SELECT — is advisory. This one is the guarantee.
//
// Stock is OPT-IN per product (`track_stock`). A vegetable shop selling by the
// handful should not be forced to count, and inventory is a Pro feature, so an
// untracked product behaves exactly as it did before P0-B: the `in_stock`
// boolean the owner sets by hand. Nothing about the existing catalog changes
// until someone switches tracking on.
//
// Quantities are integer hundredths throughout, matching order-item qty
// exactly — 1.18 kg is 118. See shopbook_money.go for the same treatment of
// money and the reason floats are not welcome here either.
package routes

import (
	"context"
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

func RegisterShopBookStock(mux *http.ServeMux) {
	mux.HandleFunc("GET /shopbook/my-shop/stock", httpx.RequireAuth(sbStockList))
	mux.HandleFunc("POST /shopbook/my-shop/stock/adjust", httpx.RequireAuth(sbStockAdjust))
	mux.HandleFunc("GET /shopbook/my-shop/stock/movements", httpx.RequireAuth(sbStockMovements))
}

// sbMove is one entry in the stock ledger. Deltas are signed hundredths.
type sbMove struct {
	ShopID    string
	ProductID string
	Kind      string // opening|purchase|sale|reservation|reservation_release|damage|adjustment|return
	OnHand    int64  // change to goods on the shelf
	Reserved  int64  // change to goods spoken for
	Unit      string
	Reason    string
	Actor     string // user id
	RefEntity string // 'order' | 'purchase' | 'adjustment'
	RefID     string
}

// The kinds an owner may post by hand. Reservations are never hand-posted —
// they belong to the order pipeline, which is what makes them trustworthy.
var sbManualMoveKinds = map[string]bool{
	"opening": true, "purchase": true, "damage": true,
	"adjustment": true, "return": true,
}

// sbApplyMove writes the movement and moves the running totals, atomically.
//
// Returns ok=false when the resulting position would be invalid — not enough
// available to reserve, or an adjustment that would drive stock negative. The
// caller must abort the transaction; the movement row goes with it.
//
// Idempotent per (ref, product, kind): a retried accept re-inserts nothing and
// reports success, because the goods are already reserved for that order.
func sbApplyMove(ctx context.Context, tx pgx.Tx, m sbMove) (bool, error) {
	if _, err := tx.Exec(ctx,
		`INSERT INTO shopbook_stock (product_id, shop_id) VALUES ($1,$2)
		 ON CONFLICT (product_id) DO NOTHING`, m.ProductID, m.ShopID); err != nil {
		return false, err
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO shopbook_stock_movement
		  (shop_id, product_id, kind, on_hand_delta, reserved_delta, unit, reason,
		   actor_user_id, ref_entity, ref_id)
		VALUES ($1,$2,$3,`+sbAmt("$4")+`,`+sbAmt("$5")+`,$6,$7,$8,$9,$10)
		ON CONFLICT DO NOTHING`,
		m.ShopID, m.ProductID, m.Kind, m.OnHand, m.Reserved, m.Unit, m.Reason,
		nullIfEmpty(m.Actor), m.RefEntity, m.RefID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return true, nil // already applied for this reference — nothing to do
	}

	// The guard IS the concurrency control. Every condition mirrors the table's
	// CHECK, so a race that slips past one is caught by the other.
	tag, err = tx.Exec(ctx, `
		UPDATE shopbook_stock
		   SET on_hand  = on_hand  + `+sbAmt("$2")+`,
		       reserved = reserved + `+sbAmt("$3")+`,
		       updated_at = NOW()
		 WHERE product_id = $1
		   AND on_hand  + `+sbAmt("$2")+` >= 0
		   AND reserved + `+sbAmt("$3")+` >= 0
		   AND reserved + `+sbAmt("$3")+` <= on_hand + `+sbAmt("$2")+``,
		m.ProductID, m.OnHand, m.Reserved)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ── order integration ─────────────────────────────────────────────

// sbShortfall is one line the shop cannot actually supply.
type sbShortfall struct {
	ProductID string  `json:"productId"`
	Name      string  `json:"name"`
	Unit      string  `json:"unit"`
	Wanted    float64 `json:"wanted"`
	Available float64 `json:"available"`
}

// sbOrderStockLines returns the tracked, still-wanted lines of an order,
// AGGREGATED BY PRODUCT. Unavailable lines are excluded — the shop already
// said no to those — and so are custom quote lines, which have no catalog row
// to draw stock from.
//
// The aggregation is not tidiness. Movements are unique per
// (order, product, kind) so a retry cannot reserve twice; if an order carried
// two separate lines of the same rice, the second reservation would be
// swallowed as "already applied" and the shop would reserve half of what it
// promised. One row per product, summed, keeps the guarantee.
func sbOrderStockLines(ctx context.Context, tx pgx.Tx, orderID string) ([]struct {
	ProductID, Name, Unit string
	Qty100                int64
}, error) {
	rows, err := tx.Query(ctx, `
		SELECT i.product_id::text, MIN(p.name), MIN(i.unit), `+sbCents("SUM(i.qty)")+`
		  FROM shopbook_order_item i
		  JOIN shopbook_product p ON p.id = i.product_id
		 WHERE i.order_id = $1 AND i.availability <> 'unavailable' AND p.track_stock
		 GROUP BY i.product_id
		 ORDER BY i.product_id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []struct {
		ProductID, Name, Unit string
		Qty100                int64
	}{}
	for rows.Next() {
		var l struct {
			ProductID, Name, Unit string
			Qty100                int64
		}
		if err := rows.Scan(&l.ProductID, &l.Name, &l.Unit, &l.Qty100); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// sbReserveOrder holds stock for every tracked line, at acceptance.
//
// Returns the shortfalls instead of an error: "we only have 1 kg" is an answer
// the owner needs to see per item, not a 500. A non-empty result means the
// caller must abort — nothing is half-reserved, because it all rides on one
// transaction.
func sbReserveOrder(ctx context.Context, tx pgx.Tx, shopID, orderID, actor string) ([]sbShortfall, error) {
	lines, err := sbOrderStockLines(ctx, tx, orderID)
	if err != nil {
		return nil, err
	}
	short := []sbShortfall{}
	for _, l := range lines {
		ok, err := sbApplyMove(ctx, tx, sbMove{
			ShopID: shopID, ProductID: l.ProductID, Kind: "reservation",
			Reserved: l.Qty100, Unit: l.Unit, Actor: actor,
			RefEntity: "order", RefID: orderID, Reason: "order accepted",
		})
		if err != nil {
			return nil, err
		}
		if !ok {
			var avail int64
			_ = tx.QueryRow(ctx,
				`SELECT `+sbCents("available")+` FROM shopbook_stock WHERE product_id=$1`,
				l.ProductID).Scan(&avail)
			short = append(short, sbShortfall{
				ProductID: l.ProductID, Name: l.Name, Unit: l.Unit,
				Wanted:    float64(l.Qty100) / 100,
				Available: float64(avail) / 100,
			})
		}
	}
	return short, nil
}

// sbReleaseOrder gives reserved stock back — rejection, cancellation, or an
// order nobody collected. Goods that were never handed over are still ours.
func sbReleaseOrder(ctx context.Context, tx pgx.Tx, shopID, orderID, actor, reason string) error {
	lines, err := sbOrderStockLines(ctx, tx, orderID)
	if err != nil {
		return err
	}
	for _, l := range lines {
		var held bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM shopbook_stock_movement
			 WHERE ref_entity='order' AND ref_id=$1 AND product_id=$2 AND kind='reservation')`,
			orderID, l.ProductID).Scan(&held); err != nil {
			return err
		}
		if !held {
			continue // never reserved (rejected before acceptance) — nothing to give back
		}
		ok, err := sbApplyMove(ctx, tx, sbMove{
			ShopID: shopID, ProductID: l.ProductID, Kind: "reservation_release",
			Reserved: -l.Qty100, Unit: l.Unit, Actor: actor,
			RefEntity: "order", RefID: orderID, Reason: reason,
		})
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("stock release refused for product %s on order %s", l.ProductID, orderID)
		}
	}
	return nil
}

// sbConsumeOrder turns the reservation into a sale, at collection: the goods
// leave the shelf and the hold that kept them there is released with them.
func sbConsumeOrder(ctx context.Context, tx pgx.Tx, shopID, orderID, actor string) error {
	lines, err := sbOrderStockLines(ctx, tx, orderID)
	if err != nil {
		return err
	}
	for _, l := range lines {
		var held bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM shopbook_stock_movement
			 WHERE ref_entity='order' AND ref_id=$1 AND product_id=$2 AND kind='reservation')`,
			orderID, l.ProductID).Scan(&held); err != nil {
			return err
		}
		// A sale with no prior reservation still has to move the shelf — an
		// order accepted before tracking was switched on reaches here.
		reserved := int64(0)
		if held {
			reserved = -l.Qty100
		}
		ok, err := sbApplyMove(ctx, tx, sbMove{
			ShopID: shopID, ProductID: l.ProductID, Kind: "sale",
			OnHand: -l.Qty100, Reserved: reserved, Unit: l.Unit, Actor: actor,
			RefEntity: "order", RefID: orderID, Reason: "order collected",
		})
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("stock consume refused for product %s on order %s", l.ProductID, orderID)
		}
	}
	// Freeze what these goods cost, now, on the lines that sold them. Profit
	// reported for today must not move when tomorrow's delivery arrives at a
	// different price (096).
	if _, err := tx.Exec(ctx, `
		UPDATE shopbook_order_item i
		   SET cost_at_sale = p.avg_cost
		  FROM shopbook_product p
		 WHERE i.product_id = p.id
		   AND i.order_id = $1
		   AND i.cost_at_sale IS NULL
		   AND p.avg_cost > 0`, orderID); err != nil {
		return err
	}
	return nil
}

// ── low stock ─────────────────────────────────────────────────────

// sbCheckLowStock pings the owner when a product drops to its reorder level.
// Best-effort and deduped by the notification inbox itself: one alert per
// product per day, so a busy Saturday doesn't become forty pushes.
func sbCheckLowStock(ctx context.Context, shopID, productID string) {
	var name string
	var avail, reorder int64
	err := db.Pool.QueryRow(ctx, `
		SELECT p.name, `+sbCents("s.available")+`, `+sbCents("s.reorder_level")+`
		  FROM shopbook_stock s JOIN shopbook_product p ON p.id = s.product_id
		 WHERE s.product_id=$1 AND s.reorder_level > 0 AND s.available <= s.reorder_level`,
		productID).Scan(&name, &avail, &reorder)
	if err != nil {
		return // not low, or no reorder level set
	}
	var ownerID string
	if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).
		Scan(&ownerID) != nil || ownerID == "" {
		return
	}
	var recent bool
	if db.Pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM shopbook_notification
		 WHERE user_id=$1 AND event='low_stock' AND data->>'productId'=$2
		   AND created_at::date = NOW()::date)`, ownerID, productID).Scan(&recent) != nil || recent {
		return
	}
	sbNotify(ctx, ownerID, "Low stock ⚠️",
		fmt.Sprintf("%s is down to %.2f — reorder level is %.2f",
			name, float64(avail)/100, float64(reorder)/100),
		map[string]any{"event": "low_stock", "productId": productID, "shopId": shopID})
}

// ── owner endpoints ───────────────────────────────────────────────

// GET /shopbook/my-shop/stock — the tracked catalog with its positions.
func sbStockList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT p.id, p.name, p.brand, p.unit, `+sbCents("p.cost_price")+`, `+sbCents("p.price")+`,
		       COALESCE(`+sbCents("s.on_hand")+`,0), COALESCE(`+sbCents("s.reserved")+`,0),
		       COALESCE(`+sbCents("s.available")+`,0), COALESCE(`+sbCents("s.reorder_level")+`,0)
		  FROM shopbook_product p
		  LEFT JOIN shopbook_stock s ON s.product_id = p.id
		 WHERE p.shop_id=$1 AND p.track_stock AND p.enabled
		 ORDER BY (COALESCE(s.available,0) <= COALESCE(s.reorder_level,0)) DESC, p.name`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	lowCount := 0
	for rows.Next() {
		var id, name, brand, unit string
		var cost, price, onHand, reserved, avail, reorder int64
		if rows.Scan(&id, &name, &brand, &unit, &cost, &price,
			&onHand, &reserved, &avail, &reorder) != nil {
			continue
		}
		low := reorder > 0 && avail <= reorder
		if low {
			lowCount++
		}
		out = append(out, map[string]any{
			"productId": id, "name": name, "brand": brand, "unit": unit,
			"costPrice": money(cost).Float(), "price": money(price).Float(),
			"onHand": float64(onHand) / 100, "reserved": float64(reserved) / 100,
			"available": float64(avail) / 100, "reorderLevel": float64(reorder) / 100,
			"low": low,
		})
	}
	httpx.JSON(w, 200, map[string]any{"stock": out, "lowCount": lowCount})
}

// POST /shopbook/my-shop/stock/adjust — the owner's hand on the shelf.
//
// Every adjustment needs a reason. "Stock is 40 now" with no explanation is
// how shrinkage becomes invisible; the movement ledger exists so the question
// "where did 8 kg go?" always has an answer.
func sbStockAdjust(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var b struct {
		ProductID string  `json:"productId"`
		Kind      string  `json:"kind"` // opening|purchase|damage|adjustment|return
		Qty       float64 `json:"qty"`  // signed for 'adjustment', else magnitude
		Reason    string  `json:"reason"`
	}
	if err := httpx.Body(r, &b); err != nil || b.ProductID == "" || !sbManualMoveKinds[b.Kind] {
		httpx.Err(w, http.StatusBadRequest,
			"productId and kind (opening|purchase|damage|adjustment|return) required")
		return
	}
	if strings.TrimSpace(b.Reason) == "" {
		httpx.Err(w, http.StatusBadRequest, "reason required — stock never changes silently")
		return
	}
	qty := int64(math.Round(b.Qty * 100))
	if qty == 0 {
		httpx.Err(w, http.StatusBadRequest, "qty must be non-zero")
		return
	}
	qty = sbMoveSign(b.Kind, qty)

	// Scope: the product must be this shop's, and it must be tracked — moving
	// stock for an untracked product would create a position nobody reads.
	var unit string
	var tracked bool
	if err := db.Pool.QueryRow(ctx,
		`SELECT unit, track_stock FROM shopbook_product WHERE id=$1 AND shop_id=$2`,
		b.ProductID, shopID).Scan(&unit, &tracked); err != nil {
		if db.NoRows(err) {
			httpx.Err(w, http.StatusNotFound, "Product not found for your shop")
			return
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if !tracked {
		httpx.Err(w, http.StatusBadRequest,
			"Turn on stock tracking for this product before recording movements")
		return
	}

	var applied bool
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var beforeOnHand int64
		_ = tx.QueryRow(ctx,
			`SELECT `+sbCents("on_hand")+` FROM shopbook_stock WHERE product_id=$1`,
			b.ProductID).Scan(&beforeOnHand)
		okMove, err := sbApplyMove(ctx, tx, sbMove{
			ShopID: shopID, ProductID: b.ProductID, Kind: b.Kind,
			OnHand: qty, Unit: unit, Reason: strings.TrimSpace(b.Reason),
			Actor: user.ID, RefEntity: "adjustment",
		})
		applied = okMove
		if err != nil {
			return err
		}
		if !okMove {
			return fmt.Errorf("would go negative")
		}
		// Stock moving by hand is exactly the action an audit exists for
		// (P1-F): the movement ledger says what changed, this says who and why.
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID, Action: "stock." + b.Kind,
			Entity: "product", EntityID: b.ProductID,
			Before: map[string]any{"onHand": float64(beforeOnHand) / 100},
			After:  map[string]any{"onHand": float64(beforeOnHand+qty) / 100},
			Reason: strings.TrimSpace(b.Reason), IP: sbClientIP(r),
		})
		return nil
	})
	if err != nil {
		if !applied {
			httpx.Err(w, http.StatusConflict,
				"That change would take stock below zero, or below what is already reserved")
			return
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbCheckLowStock(ctx, shopID, b.ProductID)

	var onHand, avail int64
	_ = db.Pool.QueryRow(ctx,
		`SELECT `+sbCents("on_hand")+`, `+sbCents("available")+`
		   FROM shopbook_stock WHERE product_id=$1`, b.ProductID).Scan(&onHand, &avail)
	httpx.JSON(w, 200, map[string]any{
		"ok": true, "onHand": float64(onHand) / 100, "available": float64(avail) / 100,
	})
}

// sbMoveSign fixes the direction a manual movement can only go, so a mistyped
// sign cannot turn breakage into a delivery. Damage always removes;
// opening/purchase/return always add; only 'adjustment' is free to do either,
// which is exactly why it is the one that demands a reason.
func sbMoveSign(kind string, qty int64) int64 {
	switch kind {
	case "damage":
		return -abs64(qty)
	case "opening", "purchase", "return":
		return abs64(qty)
	default: // adjustment — the owner's sign stands
		return qty
	}
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// GET /shopbook/my-shop/stock/movements?productId=&limit= — the audit trail
// for one product, or the shop's recent movements.
func sbStockMovements(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	args := []any{shopID}
	sql := `SELECT m.id, m.product_id::text, p.name, m.kind,
	               ` + sbCents("m.on_hand_delta") + `, ` + sbCents("m.reserved_delta") + `,
	               m.unit, m.reason, COALESCE(u.name,''), m.ref_entity, m.ref_id, m.created_at
	          FROM shopbook_stock_movement m
	          JOIN shopbook_product p ON p.id = m.product_id
	          LEFT JOIN users u ON u.id = m.actor_user_id
	         WHERE m.shop_id=$1`
	if pid := r.URL.Query().Get("productId"); pid != "" {
		sql += ` AND m.product_id=$2`
		args = append(args, pid)
	}
	sql += ` ORDER BY m.id DESC LIMIT 200`
	rows, err := db.Pool.Query(ctx, sql, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var productID, name, kind, unit, reason, actor, refEntity, refID string
		var onHand, reserved int64
		var at time.Time
		if rows.Scan(&id, &productID, &name, &kind, &onHand, &reserved,
			&unit, &reason, &actor, &refEntity, &refID, &at) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "productId": productID, "name": name, "kind": kind,
			"onHandDelta": float64(onHand) / 100, "reservedDelta": float64(reserved) / 100,
			"unit": unit, "reason": reason, "actor": actor,
			"refEntity": refEntity, "refId": refID, "at": httpx.JST(&at),
		})
	}
	httpx.JSON(w, 200, map[string]any{"movements": out})
}

// sbStockLogFailure keeps a refused stock move visible — a silent refusal
// looks identical to "nothing needed doing".
func sbStockLogFailure(op, orderID string, err error) {
	log.Printf("[shopbook] stock %s failed (order=%s): %v", op, orderID, err)
}
