// shopbook.go — SHOP BOOK mini-app API. Text-only local-commerce layer:
// customers find nearby shops, browse/type products, place & track orders;
// shop owners manage products, orders and a digital khata (ledger).
//
// All routes authenticated. Every query is scoped by the caller's user id —
// an owner may only touch their own shop; a customer only their own orders and
// ledger. No product images in MVP (text catalog only).
package routes

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

// rupees formats a money amount for push copy, e.g. 1250 → "₹1,250".
func rupees(n float64) string {
	return "₹" + fmt.Sprintf("%.0f", n)
}

func RegisterShopBook(mux *http.ServeMux) {
	// Customer
	mux.HandleFunc("GET /shopbook/shops", httpx.RequireAuth(sbNearbyShops))
	mux.HandleFunc("GET /shopbook/shops/{id}", httpx.RequireAuth(sbShopDetails))
	mux.HandleFunc("GET /shopbook/shops/{id}/products", httpx.RequireAuth(sbShopProducts))
	mux.HandleFunc("POST /shopbook/orders", httpx.RequireAuth(sbPlaceOrder))
	mux.HandleFunc("GET /shopbook/orders", httpx.RequireAuth(sbMyOrders))
	mux.HandleFunc("GET /shopbook/orders/{id}", httpx.RequireAuth(sbOrderDetails))
	mux.HandleFunc("POST /shopbook/orders/{id}/item/{itemId}/decision", httpx.RequireAuth(sbCustomerDecision))
	mux.HandleFunc("GET /shopbook/ledger/{shopId}", httpx.RequireAuth(sbCustomerLedger))
	mux.HandleFunc("GET /shopbook/search-products", httpx.RequireAuth(sbSearchProducts))

	// Customer — Phase 2
	mux.HandleFunc("GET /shopbook/favorites", httpx.RequireAuth(sbFavorites))
	mux.HandleFunc("POST /shopbook/favorites", httpx.RequireAuth(sbToggleFavorite))
	mux.HandleFunc("GET /shopbook/shops/{id}/coupons", httpx.RequireAuth(sbShopCoupons))
	mux.HandleFunc("GET /shopbook/shops/{id}/ratings", httpx.RequireAuth(sbShopRatings))
	mux.HandleFunc("POST /shopbook/orders/{id}/rate", httpx.RequireAuth(sbRateOrder))
	mux.HandleFunc("GET /shopbook/loyalty", httpx.RequireAuth(sbLoyalty))

	// Shop owner
	mux.HandleFunc("GET /shopbook/my-shop", httpx.RequireAuth(sbMyShop))
	mux.HandleFunc("POST /shopbook/my-shop", httpx.RequireAuth(sbUpsertShop))
	mux.HandleFunc("GET /shopbook/my-shop/products", httpx.RequireAuth(sbOwnerProducts))
	mux.HandleFunc("POST /shopbook/my-shop/products", httpx.RequireAuth(sbSaveProduct))
	mux.HandleFunc("POST /shopbook/my-shop/products/bulk", httpx.RequireAuth(sbBulkProducts))
	mux.HandleFunc("DELETE /shopbook/my-shop/products/{id}", httpx.RequireAuth(sbDeleteProduct))
	mux.HandleFunc("GET /shopbook/my-shop/orders", httpx.RequireAuth(sbOwnerOrders))
	mux.HandleFunc("POST /shopbook/my-shop/orders/{id}/item/{itemId}", httpx.RequireAuth(sbOwnerSetAvailability))
	mux.HandleFunc("POST /shopbook/my-shop/orders/{id}/status", httpx.RequireAuth(sbOwnerSetStatus))
	mux.HandleFunc("GET /shopbook/my-shop/dashboard", httpx.RequireAuth(sbDashboard))
	mux.HandleFunc("GET /shopbook/my-shop/ledger", httpx.RequireAuth(sbOwnerLedger))
	mux.HandleFunc("POST /shopbook/my-shop/ledger", httpx.RequireAuth(sbAddLedgerEntry))

	// Shop owner — Phase 2
	mux.HandleFunc("GET /shopbook/my-shop/coupons", httpx.RequireAuth(sbOwnerCoupons))
	mux.HandleFunc("POST /shopbook/my-shop/coupons", httpx.RequireAuth(sbSaveCoupon))
	mux.HandleFunc("DELETE /shopbook/my-shop/coupons/{id}", httpx.RequireAuth(sbDeleteCoupon))
	mux.HandleFunc("GET /shopbook/my-shop/suppliers", httpx.RequireAuth(sbOwnerSuppliers))
	mux.HandleFunc("POST /shopbook/my-shop/suppliers", httpx.RequireAuth(sbSaveSupplier))
	mux.HandleFunc("DELETE /shopbook/my-shop/suppliers/{id}", httpx.RequireAuth(sbDeleteSupplier))

	// Shop owner — Phase 2b
	mux.HandleFunc("POST /shopbook/my-shop/ledger/remind", httpx.RequireAuth(sbSendReminder))
	mux.HandleFunc("POST /shopbook/my-shop/plan", httpx.RequireAuth(sbSetPlan))
	mux.HandleFunc("GET /shopbook/my-shop/reports", httpx.RequireAuth(sbReports))
}

// ── helpers ───────────────────────────────────────────────────────

// ownerShopID returns the caller's shop id, or "" (with a 404 written) if none.
func ownerShopID(ctx context.Context, w http.ResponseWriter, userID string) (string, bool) {
	var id string
	err := db.Pool.QueryRow(ctx, `SELECT id FROM shopbook_shop WHERE owner_user_id=$1`, userID).Scan(&id)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "No shop yet — create one first")
		return "", false
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return "", false
	}
	return id, true
}

func haversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const R = 6371.0
	dLat := (lat2 - lat1) * math.Pi / 180
	dLng := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return R * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func qfloat(r *http.Request, key string) (float64, bool) {
	f, err := strconv.ParseFloat(r.URL.Query().Get(key), 64)
	return f, err == nil
}

// shopCols / scanShop centralise the shop projection so the Phase 2 rating +
// delivery columns are read the same way everywhere. Works with both a single
// pgx.Row (QueryRow) and a row inside pgx.Rows (both expose Scan).
const shopCols = `id, name, category, address, lat, lng, phone, open_time, close_time,
	weekly_holiday, status, pickup, prep_mins, delivery, delivery_fee, rating_sum, rating_count,
	plan, lunch_start, lunch_end`

type shopScanner interface{ Scan(dest ...any) error }

func scanShop(row shopScanner) (map[string]any, error) {
	var (
		id, name, category, address, phone, openT, closeT, holiday, status string
		plan, lunchStart, lunchEnd                                         string
		slat, slng                                                         *float64
		pickup, delivery                                                   bool
		prep, ratingSum, ratingCount                                       int
		deliveryFee                                                        float64
	)
	if err := row.Scan(&id, &name, &category, &address, &slat, &slng, &phone,
		&openT, &closeT, &holiday, &status, &pickup, &prep,
		&delivery, &deliveryFee, &ratingSum, &ratingCount,
		&plan, &lunchStart, &lunchEnd); err != nil {
		return nil, err
	}
	var rating float64
	if ratingCount > 0 {
		rating = math.Round(float64(ratingSum)/float64(ratingCount)*10) / 10
	}
	return map[string]any{
		"id": id, "name": name, "category": category, "address": address,
		"lat": slat, "lng": slng, "phone": phone, "openTime": openT, "closeTime": closeT,
		"weeklyHoliday": holiday, "status": status, "pickup": pickup, "prepMins": prep,
		"delivery": delivery, "deliveryFee": deliveryFee,
		"rating": rating, "ratingCount": ratingCount,
		"plan": plan, "lunchStart": lunchStart, "lunchEnd": lunchEnd,
	}, nil
}

// sbNotify sends an Expo push (title+body, auto-rendered in fg/bg) to every
// device the user has registered. Best-effort; failures are swallowed.
func sbNotify(ctx context.Context, userID, title, body string, data map[string]any) {
	rows, err := db.Pool.Query(ctx,
		`SELECT push_token FROM devices WHERE user_id=$1 AND push_token IS NOT NULL`, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	tokens := []string{}
	for rows.Next() {
		var t *string
		if rows.Scan(&t) == nil && t != nil && *t != "" {
			tokens = append(tokens, *t)
		}
	}
	if len(tokens) == 0 {
		return
	}
	if data == nil {
		data = map[string]any{}
	}
	data["type"] = "shopbook"
	chatsSendExpoPush(ctx, tokens, title, body, data, "default")
}

// shopPlan returns a shop's plan ('free'|'pro'), defaulting to 'free'.
func shopPlan(ctx context.Context, shopID string) string {
	var plan string
	if err := db.Pool.QueryRow(ctx, `SELECT plan FROM shopbook_shop WHERE id=$1`, shopID).Scan(&plan); err != nil || plan == "" {
		return "free"
	}
	return plan
}

// ── customer: nearby shops ───────────────────────────────────────

func sbNearbyShops(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	lat, okLat := qfloat(r, "lat")
	lng, okLng := qfloat(r, "lng")
	cat := r.URL.Query().Get("category")

	// Bounding box ~ 25 km; if no location given, just return a recent slice.
	const boxDeg = 0.25
	args := []any{}
	sql := `SELECT ` + shopCols + ` FROM shopbook_shop`
	where := ""
	if okLat && okLng {
		where = ` WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`
		args = append(args, lat-boxDeg, lat+boxDeg, lng-boxDeg, lng+boxDeg)
	}
	if cat != "" && cat != "all" {
		if where == "" {
			where = " WHERE"
		} else {
			where += " AND"
		}
		where += " category=$" + strconv.Itoa(len(args)+1)
		args = append(args, cat)
	}
	rows, err := db.Pool.Query(ctx, sql+where+" LIMIT 100", args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		m, err := scanShop(rows)
		if err != nil {
			continue
		}
		slat, _ := m["lat"].(*float64)
		slng, _ := m["lng"].(*float64)
		if okLat && okLng && slat != nil && slng != nil {
			m["distanceKm"] = math.Round(haversineKm(lat, lng, *slat, *slng)*100) / 100
		}
		out = append(out, m)
	}
	httpx.JSON(w, 200, map[string]any{"shops": out})
}

func sbShopDetails(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	m, err := scanShop(db.Pool.QueryRow(ctx, `SELECT `+shopCols+` FROM shopbook_shop WHERE id=$1`, r.PathValue("id")))
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Shop not found")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, m)
}

func scanProducts(rows pgx.Rows) []map[string]any {
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id, name, brand, category, unit string
			price                           float64
			inStock, enabled                bool
		)
		if err := rows.Scan(&id, &name, &brand, &category, &unit, &price, &inStock, &enabled); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "brand": brand, "category": category,
			"unit": unit, "price": price, "inStock": inStock, "enabled": enabled,
		})
	}
	return out
}

func sbShopProducts(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Pool.Query(r.Context(),
		`SELECT id, name, brand, category, unit, price, in_stock, enabled
		   FROM shopbook_product WHERE shop_id=$1 AND enabled=TRUE ORDER BY name`, r.PathValue("id"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"products": scanProducts(rows)})
}

// ── customer: orders ─────────────────────────────────────────────

func sbPlaceOrder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var body struct {
		ShopID     string `json:"shopId"`
		Note       string `json:"note"`
		CouponCode string `json:"couponCode"`
		Delivery   bool   `json:"delivery"`
		Address    string `json:"address"`
		Items      []struct {
			Name  string  `json:"name"`
			Brand string  `json:"brand"`
			Qty   float64 `json:"qty"`
			Price float64 `json:"price"`
			Note  string  `json:"note"`
		} `json:"items"`
	}
	if err := httpx.Body(r, &body); err != nil || body.ShopID == "" || len(body.Items) == 0 {
		httpx.Err(w, http.StatusBadRequest, "shopId and at least one item required")
		return
	}

	subtotal := 0.0
	for _, it := range body.Items {
		q := it.Qty
		if q <= 0 {
			q = 1
		}
		subtotal += it.Price * q
	}

	// Delivery fee (only if this shop offers delivery).
	deliveryFee := 0.0
	delivery := false
	if body.Delivery {
		var shopDelivery bool
		var fee float64
		if err := db.Pool.QueryRow(ctx, `SELECT delivery, delivery_fee FROM shopbook_shop WHERE id=$1`,
			body.ShopID).Scan(&shopDelivery, &fee); err == nil && shopDelivery {
			delivery = true
			deliveryFee = fee
		}
	}

	// Coupon discount (validated server-side against the shop's active coupons).
	discount := 0.0
	appliedCoupon := ""
	if body.CouponCode != "" {
		var kind string
		var value, minOrder float64
		err := db.Pool.QueryRow(ctx,
			`SELECT kind, value, min_order FROM shopbook_coupon
			   WHERE shop_id=$1 AND UPPER(code)=UPPER($2) AND active=TRUE`,
			body.ShopID, body.CouponCode).Scan(&kind, &value, &minOrder)
		if err == nil && subtotal >= minOrder {
			if kind == "percent" {
				discount = subtotal * value / 100
			} else {
				discount = value
			}
			if discount > subtotal {
				discount = subtotal
			}
			discount = math.Round(discount*100) / 100
			appliedCoupon = body.CouponCode
		}
	}

	total := math.Round((subtotal-discount+deliveryFee)*100) / 100

	var orderID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO shopbook_order
			   (shop_id, customer_user_id, note, total, coupon_code, discount, delivery, delivery_fee, address)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
			body.ShopID, user.ID, body.Note, total, appliedCoupon, discount, delivery, deliveryFee, body.Address).Scan(&orderID); err != nil {
			return err
		}
		for _, it := range body.Items {
			qty := it.Qty
			if qty <= 0 {
				qty = 1
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO shopbook_order_item (order_id, name, brand, qty, price, note)
				 VALUES ($1,$2,$3,$4,$5,$6)`,
				orderID, it.Name, it.Brand, qty, it.Price, it.Note); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "could not place order")
		return
	}
	// Notify the shop owner of the new order.
	var ownerID string
	if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, body.ShopID).Scan(&ownerID) == nil && ownerID != "" {
		sbNotify(ctx, ownerID, "New order 🛎️",
			fmt.Sprintf("%d item(s) · %s", len(body.Items), rupees(total)),
			map[string]any{"event": "new_order", "orderId": orderID})
	}
	httpx.JSON(w, 201, map[string]any{
		"id": orderID, "status": "new", "total": total,
		"discount": discount, "deliveryFee": deliveryFee,
	})
}

func sbMyOrders(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(r.Context(),
		`SELECT o.id, o.shop_id, s.name, o.status, o.total, o.created_at
		   FROM shopbook_order o JOIN shopbook_shop s ON s.id=o.shop_id
		  WHERE o.customer_user_id=$1 ORDER BY o.created_at DESC LIMIT 100`, user.ID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, shopID, shopName, status string
		var total float64
		var created time.Time
		if err := rows.Scan(&id, &shopID, &shopName, &status, &total, &created); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "shopId": shopID, "shopName": shopName, "status": status,
			"total": total, "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{"orders": out})
}

// orderWithItems returns the order header + items, scoped so only the customer
// or the shop owner can read it.
func orderWithItems(ctx context.Context, w http.ResponseWriter, orderID, userID string) {
	var shopID, custID, status, note, couponCode, address string
	var total, discount, deliveryFee float64
	var delivery bool
	var created time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT shop_id, customer_user_id, status, total, note, created_at,
		        coupon_code, discount, delivery, delivery_fee, address
		   FROM shopbook_order WHERE id=$1`, orderID).Scan(&shopID, &custID, &status, &total, &note, &created,
		&couponCode, &discount, &delivery, &deliveryFee, &address)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	// Access: customer who placed it, or the shop's owner.
	if custID != userID {
		var owner string
		if err := db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).Scan(&owner); err != nil || owner != userID {
			httpx.Err(w, http.StatusForbidden, "Not your order")
			return
		}
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT id, name, brand, qty, price, note, availability, alt_name
		   FROM shopbook_order_item WHERE order_id=$1 ORDER BY id`, orderID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, name, brand, inote, avail, alt string
		var qty, price float64
		if err := rows.Scan(&id, &name, &brand, &qty, &price, &inote, &avail, &alt); err != nil {
			continue
		}
		items = append(items, map[string]any{
			"id": id, "name": name, "brand": brand, "qty": qty, "price": price,
			"note": inote, "availability": avail, "altName": alt,
		})
	}
	var rated bool
	_ = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM shopbook_rating WHERE order_id=$1)`, orderID).Scan(&rated)
	httpx.JSON(w, 200, map[string]any{
		"id": orderID, "shopId": shopID, "status": status, "total": total,
		"note": note, "createdAt": httpx.JST(&created), "items": items,
		"couponCode": couponCode, "discount": discount, "delivery": delivery,
		"deliveryFee": deliveryFee, "address": address, "rated": rated,
	})
}

func sbOrderDetails(w http.ResponseWriter, r *http.Request) {
	orderWithItems(r.Context(), w, r.PathValue("id"), httpx.UserFrom(r).ID)
}

// Customer accepts/rejects an owner-suggested alternative for one line item.
func sbCustomerDecision(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	orderID, itemID := r.PathValue("id"), r.PathValue("itemId")
	var body struct {
		Accept bool `json:"accept"`
	}
	_ = httpx.Body(r, &body)

	// Only the owning customer may decide.
	var custID string
	if err := db.Pool.QueryRow(ctx, `SELECT customer_user_id FROM shopbook_order WHERE id=$1`, orderID).Scan(&custID); err != nil || custID != user.ID {
		httpx.Err(w, http.StatusForbidden, "Not your order")
		return
	}
	newAvail := "unavailable"
	if body.Accept {
		newAvail = "available"
	}
	tag, err := db.Pool.Exec(ctx,
		`UPDATE shopbook_order_item SET availability=$1
		   WHERE id=$2 AND order_id=$3 AND availability='alternative'`, newAvail, itemID, orderID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "No pending alternative for that item")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "availability": newAvail})
}

// ── customer: ledger with one shop ───────────────────────────────

func sbCustomerLedger(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	ledgerJSON(r.Context(), w, r.PathValue("shopId"), user.ID)
}

func ledgerJSON(ctx context.Context, w http.ResponseWriter, shopID, custID string) {
	rows, err := db.Pool.Query(ctx,
		`SELECT id, type, amount, remark, created_at
		   FROM shopbook_ledger WHERE shop_id=$1 AND customer_user_id=$2
		  ORDER BY created_at DESC LIMIT 200`, shopID, custID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	entries := []map[string]any{}
	var purchase, paid float64
	for rows.Next() {
		var id, typ, remark string
		var amount float64
		var created time.Time
		if err := rows.Scan(&id, &typ, &amount, &remark, &created); err != nil {
			continue
		}
		if typ == "purchase" {
			purchase += amount
		} else {
			paid += amount
		}
		entries = append(entries, map[string]any{
			"id": id, "type": typ, "amount": amount, "remark": remark, "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{
		"entries": entries, "totalPurchase": purchase, "totalPaid": paid,
		"pending": math.Round((purchase-paid)*100) / 100,
	})
}

// ── owner: shop profile ──────────────────────────────────────────

func sbMyShop(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	m, err := scanShop(db.Pool.QueryRow(ctx, `SELECT `+shopCols+` FROM shopbook_shop WHERE owner_user_id=$1`, user.ID))
	if db.NoRows(err) {
		httpx.JSON(w, 200, map[string]any{"shop": nil})
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"shop": m})
}

func sbUpsertShop(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		Name          string   `json:"name"`
		Category      string   `json:"category"`
		Address       string   `json:"address"`
		Lat           *float64 `json:"lat"`
		Lng           *float64 `json:"lng"`
		Phone         string   `json:"phone"`
		OpenTime      string   `json:"openTime"`
		CloseTime     string   `json:"closeTime"`
		WeeklyHoliday string   `json:"weeklyHoliday"`
		Status        string   `json:"status"`
		Pickup        *bool    `json:"pickup"`
		PrepMins      *int     `json:"prepMins"`
		Delivery      *bool    `json:"delivery"`
		DeliveryFee   *float64 `json:"deliveryFee"`
		LunchStart    string   `json:"lunchStart"`
		LunchEnd      string   `json:"lunchEnd"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Name == "" {
		httpx.Err(w, http.StatusBadRequest, "name required")
		return
	}
	if b.Category == "" {
		b.Category = "grocery"
	}
	if b.OpenTime == "" {
		b.OpenTime = "09:00"
	}
	if b.CloseTime == "" {
		b.CloseTime = "21:00"
	}
	if b.Status != "open" && b.Status != "busy" && b.Status != "closed" {
		b.Status = "open"
	}
	pickup := true
	if b.Pickup != nil {
		pickup = *b.Pickup
	}
	prep := 20
	if b.PrepMins != nil {
		prep = *b.PrepMins
	}
	delivery := false
	if b.Delivery != nil {
		delivery = *b.Delivery
	}
	deliveryFee := 0.0
	if b.DeliveryFee != nil {
		deliveryFee = *b.DeliveryFee
	}
	var id string
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO shopbook_shop
		  (owner_user_id, name, category, address, lat, lng, phone,
		   open_time, close_time, weekly_holiday, status, pickup, prep_mins, delivery, delivery_fee,
		   lunch_start, lunch_end)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		ON CONFLICT (owner_user_id) DO UPDATE SET
		  name=$2, category=$3, address=$4, lat=$5, lng=$6, phone=$7,
		  open_time=$8, close_time=$9, weekly_holiday=$10, status=$11,
		  pickup=$12, prep_mins=$13, delivery=$14, delivery_fee=$15,
		  lunch_start=$16, lunch_end=$17, updated_at=NOW()
		RETURNING id`,
		user.ID, b.Name, b.Category, b.Address, b.Lat, b.Lng, b.Phone,
		b.OpenTime, b.CloseTime, b.WeeklyHoliday, b.Status, pickup, prep, delivery, deliveryFee,
		b.LunchStart, b.LunchEnd).Scan(&id)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "could not save shop")
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id})
}

// ── owner: products ──────────────────────────────────────────────

func sbOwnerProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT id, name, brand, category, unit, price, in_stock, enabled
		   FROM shopbook_product WHERE shop_id=$1 ORDER BY name`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"products": scanProducts(rows)})
}

func sbSaveProduct(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		ID       string  `json:"id"`
		Name     string  `json:"name"`
		Brand    string  `json:"brand"`
		Category string  `json:"category"`
		Unit     string  `json:"unit"`
		Price    float64 `json:"price"`
		InStock  *bool   `json:"inStock"`
		Enabled  *bool   `json:"enabled"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Name == "" {
		httpx.Err(w, http.StatusBadRequest, "name required")
		return
	}
	inStock, enabled := true, true
	if b.InStock != nil {
		inStock = *b.InStock
	}
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	var id string
	if b.ID != "" {
		// Update — scoped to this owner's shop.
		err := db.Pool.QueryRow(ctx, `
			UPDATE shopbook_product SET name=$1, brand=$2, category=$3, unit=$4,
			   price=$5, in_stock=$6, enabled=$7
			 WHERE id=$8 AND shop_id=$9 RETURNING id`,
			b.Name, b.Brand, b.Category, b.Unit, b.Price, inStock, enabled, b.ID, shopID).Scan(&id)
		if db.NoRows(err) {
			httpx.Err(w, http.StatusNotFound, "Product not found")
			return
		}
		if err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
	} else {
		if err := db.Pool.QueryRow(ctx, `
			INSERT INTO shopbook_product (shop_id, name, brand, category, unit, price, in_stock, enabled)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
			shopID, b.Name, b.Brand, b.Category, b.Unit, b.Price, inStock, enabled).Scan(&id); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"id": id})
}

func sbDeleteProduct(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	tag, err := db.Pool.Exec(ctx, `DELETE FROM shopbook_product WHERE id=$1 AND shop_id=$2`,
		r.PathValue("id"), shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "Product not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── owner: orders ────────────────────────────────────────────────

func sbOwnerOrders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	sql := `SELECT o.id, o.customer_user_id, COALESCE(u.name,''), o.status, o.total, o.created_at
	          FROM shopbook_order o LEFT JOIN users u ON u.id=o.customer_user_id
	         WHERE o.shop_id=$1`
	args := []any{shopID}
	if status != "" && status != "all" {
		sql += " AND o.status=$2"
		args = append(args, status)
	}
	sql += " ORDER BY o.created_at DESC LIMIT 100"
	rows, err := db.Pool.Query(ctx, sql, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, custID, custName, st string
		var total float64
		var created time.Time
		if err := rows.Scan(&id, &custID, &custName, &st, &total, &created); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "customerId": custID, "customerName": custName, "status": st,
			"total": total, "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{"orders": out})
}

// Owner marks one line item available / unavailable / suggests an alternative.
func sbOwnerSetAvailability(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	orderID, itemID := r.PathValue("id"), r.PathValue("itemId")
	var b struct {
		Availability string `json:"availability"` // available | unavailable | alternative
		AltName      string `json:"altName"`
	}
	_ = httpx.Body(r, &b)
	switch b.Availability {
	case "available", "unavailable", "alternative":
	default:
		httpx.Err(w, http.StatusBadRequest, "availability must be available|unavailable|alternative")
		return
	}
	// Ensure the order belongs to this owner's shop.
	tag, err := db.Pool.Exec(ctx, `
		UPDATE shopbook_order_item SET availability=$1, alt_name=$2
		 WHERE id=$3 AND order_id=$4
		   AND order_id IN (SELECT id FROM shopbook_order WHERE shop_id=$5)`,
		b.Availability, b.AltName, itemID, orderID, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "Item not found for your shop")
		return
	}
	if b.Availability == "alternative" {
		var custID string
		if db.Pool.QueryRow(ctx, `SELECT customer_user_id FROM shopbook_order WHERE id=$1`, orderID).Scan(&custID) == nil && custID != "" {
			body := "The shop suggested an alternative — tap to accept or reject"
			if b.AltName != "" {
				body = "Alternative suggested: " + b.AltName
			}
			sbNotify(ctx, custID, "Alternative available 🔁", body, map[string]any{"event": "alternative", "orderId": orderID})
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

var orderFlow = map[string]bool{
	"new": true, "preparing": true, "packing": true, "ready": true,
	"completed": true, "cancelled": true,
}

// Owner advances an order through the fulfilment states. Marking 'completed'
// also posts the order total to the customer's khata as a purchase.
func sbOwnerSetStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	orderID := r.PathValue("id")
	var b struct {
		Status string `json:"status"`
	}
	_ = httpx.Body(r, &b)
	if !orderFlow[b.Status] {
		httpx.Err(w, http.StatusBadRequest, "invalid status")
		return
	}
	var custID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var total float64
		if err := tx.QueryRow(ctx,
			`UPDATE shopbook_order SET status=$1, updated_at=NOW()
			   WHERE id=$2 AND shop_id=$3 RETURNING customer_user_id, total`,
			b.Status, orderID, shopID).Scan(&custID, &total); err != nil {
			return err
		}
		if b.Status == "completed" {
			// Idempotent: only post to the ledger once per order.
			var exists bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM shopbook_ledger WHERE order_id=$1 AND type='purchase')`,
				orderID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				if _, err := tx.Exec(ctx,
					`INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark, order_id)
					 VALUES ($1,$2,'purchase',$3,'Order completed',$4)`,
					shopID, custID, total, orderID); err != nil {
					return err
				}
				// Loyalty: 1 point per ₹100 spent, stamped on the order.
				points := int(total / 100)
				if _, err := tx.Exec(ctx,
					`UPDATE shopbook_order SET points_earned=$1 WHERE id=$2`, points, orderID); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found for your shop")
		return
	}
	if err == nil && custID != "" {
		msg := map[string]string{
			"new": "Your order was accepted", "preparing": "Your order is being prepared",
			"packing": "Your order is being packed", "ready": "Your order is ready to collect 🎉",
			"completed": "Order completed — thank you!", "cancelled": "Your order was cancelled",
		}[b.Status]
		sbNotify(ctx, custID, "Order update", msg, map[string]any{"event": "order_status", "orderId": orderID, "status": b.Status})
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "status": b.Status})
}

// ── owner: dashboard ─────────────────────────────────────────────

func sbDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var todayOrders, pendingOrders, lowStock int
	var todaySales, totalPending float64
	// Today's orders + sales.
	_ = db.Pool.QueryRow(ctx,
		`SELECT COUNT(*), COALESCE(SUM(total),0) FROM shopbook_order
		  WHERE shop_id=$1 AND created_at::date = NOW()::date`, shopID).Scan(&todayOrders, &todaySales)
	// Open orders needing action.
	_ = db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM shopbook_order
		  WHERE shop_id=$1 AND status IN ('new','preparing','packing','ready')`, shopID).Scan(&pendingOrders)
	// Out-of-stock enabled products.
	_ = db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM shopbook_product WHERE shop_id=$1 AND enabled=TRUE AND in_stock=FALSE`, shopID).Scan(&lowStock)
	// Total pending across the khata.
	_ = db.Pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END),0)
		  FROM shopbook_ledger WHERE shop_id=$1`, shopID).Scan(&totalPending)

	httpx.JSON(w, 200, map[string]any{
		"todayOrders":   todayOrders,
		"todaySales":    todaySales,
		"pendingOrders": pendingOrders,
		"lowStock":      lowStock,
		"totalPending":  math.Round(totalPending*100) / 100,
	})
}

// ── owner: khata ─────────────────────────────────────────────────

func sbOwnerLedger(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	custID := r.URL.Query().Get("customerId")
	if custID != "" {
		ledgerJSON(ctx, w, shopID, custID)
		return
	}
	// No customer selected → summarise pending per customer.
	rows, err := db.Pool.Query(ctx, `
		SELECT l.customer_user_id, COALESCE(u.name,''),
		       SUM(CASE WHEN l.type='purchase' THEN l.amount ELSE -l.amount END) AS pending
		  FROM shopbook_ledger l LEFT JOIN users u ON u.id=l.customer_user_id
		 WHERE l.shop_id=$1
		 GROUP BY l.customer_user_id, u.name
		 ORDER BY pending DESC`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name string
		var pending float64
		if err := rows.Scan(&id, &name, &pending); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"customerId": id, "customerName": name, "pending": math.Round(pending*100) / 100,
		})
	}
	httpx.JSON(w, 200, map[string]any{"customers": out})
}

func sbAddLedgerEntry(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		CustomerID string  `json:"customerId"`
		Type       string  `json:"type"` // purchase | payment
		Amount     float64 `json:"amount"`
		Remark     string  `json:"remark"`
	}
	if err := httpx.Body(r, &b); err != nil || b.CustomerID == "" || (b.Type != "purchase" && b.Type != "payment") || b.Amount <= 0 {
		httpx.Err(w, http.StatusBadRequest, "customerId, type(purchase|payment) and positive amount required")
		return
	}
	var id string
	if err := db.Pool.QueryRow(ctx,
		`INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		shopID, b.CustomerID, b.Type, b.Amount, b.Remark).Scan(&id); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if b.Type == "payment" {
		sbNotify(ctx, b.CustomerID, "Payment recorded ✅",
			rupees(b.Amount)+" payment recorded on your account",
			map[string]any{"event": "payment", "shopId": shopID})
	}
	httpx.JSON(w, 201, map[string]any{"id": id})
}

// ════════════════════════════════════════════════════════════════
//  Phase 2
// ════════════════════════════════════════════════════════════════

// ── favorites ────────────────────────────────────────────────────

func sbFavorites(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	rows, err := db.Pool.Query(r.Context(), `
		SELECT `+shopColsPrefixed("s")+`
		  FROM shopbook_favorite f JOIN shopbook_shop s ON s.id=f.shop_id
		 WHERE f.customer_user_id=$1 ORDER BY f.created_at DESC`, user.ID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		if m, err := scanShop(rows); err == nil {
			out = append(out, m)
		}
	}
	httpx.JSON(w, 200, map[string]any{"shops": out})
}

// shopColsPrefixed returns shopCols with a table alias, for JOINs.
func shopColsPrefixed(alias string) string {
	cols := []string{
		"id", "name", "category", "address", "lat", "lng", "phone", "open_time", "close_time",
		"weekly_holiday", "status", "pickup", "prep_mins", "delivery", "delivery_fee",
		"rating_sum", "rating_count", "plan", "lunch_start", "lunch_end",
	}
	out := ""
	for i, c := range cols {
		if i > 0 {
			out += ", "
		}
		out += alias + "." + c
	}
	return out
}

func sbToggleFavorite(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var b struct {
		ShopID string `json:"shopId"`
	}
	if err := httpx.Body(r, &b); err != nil || b.ShopID == "" {
		httpx.Err(w, http.StatusBadRequest, "shopId required")
		return
	}
	// Toggle: delete if present, else insert.
	tag, err := db.Pool.Exec(ctx,
		`DELETE FROM shopbook_favorite WHERE customer_user_id=$1 AND shop_id=$2`, user.ID, b.ShopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() > 0 {
		httpx.JSON(w, 200, map[string]any{"favorite": false})
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO shopbook_favorite (customer_user_id, shop_id) VALUES ($1,$2)
		 ON CONFLICT DO NOTHING`, user.ID, b.ShopID); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"favorite": true})
}

// ── coupons (customer view) ──────────────────────────────────────

func sbShopCoupons(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Pool.Query(r.Context(),
		`SELECT code, kind, value, min_order FROM shopbook_coupon
		   WHERE shop_id=$1 AND active=TRUE ORDER BY created_at DESC`, r.PathValue("id"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var code, kind string
		var value, minOrder float64
		if err := rows.Scan(&code, &kind, &value, &minOrder); err != nil {
			continue
		}
		out = append(out, map[string]any{"code": code, "kind": kind, "value": value, "minOrder": minOrder})
	}
	httpx.JSON(w, 200, map[string]any{"coupons": out})
}

// ── ratings ──────────────────────────────────────────────────────

func sbShopRatings(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Pool.Query(r.Context(),
		`SELECT rt.stars, rt.review, COALESCE(u.name,''), rt.created_at
		   FROM shopbook_rating rt LEFT JOIN users u ON u.id=rt.customer_user_id
		  WHERE rt.shop_id=$1 ORDER BY rt.created_at DESC LIMIT 50`, r.PathValue("id"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var stars int
		var review, name string
		var created time.Time
		if err := rows.Scan(&stars, &review, &name, &created); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"stars": stars, "review": review, "customerName": name, "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{"ratings": out})
}

// Customer rates a completed order once; the shop's cached rating is bumped.
func sbRateOrder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	orderID := r.PathValue("id")
	var b struct {
		Stars  int    `json:"stars"`
		Review string `json:"review"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Stars < 1 || b.Stars > 5 {
		httpx.Err(w, http.StatusBadRequest, "stars must be 1-5")
		return
	}
	// Verify the order belongs to this customer and is completed.
	var shopID, status string
	err := db.Pool.QueryRow(ctx,
		`SELECT shop_id, status FROM shopbook_order WHERE id=$1 AND customer_user_id=$2`,
		orderID, user.ID).Scan(&shopID, &status)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusForbidden, "Not your order")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if status != "completed" {
		httpx.Err(w, http.StatusBadRequest, "Only completed orders can be rated")
		return
	}
	err = db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`INSERT INTO shopbook_rating (shop_id, customer_user_id, order_id, stars, review)
			 VALUES ($1,$2,$3,$4,$5) ON CONFLICT (order_id) DO NOTHING`,
			shopID, user.ID, orderID, b.Stars, b.Review)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil // already rated
		}
		_, err = tx.Exec(ctx,
			`UPDATE shopbook_shop SET rating_sum=rating_sum+$1, rating_count=rating_count+1 WHERE id=$2`,
			b.Stars, shopID)
		return err
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── loyalty ──────────────────────────────────────────────────────

func sbLoyalty(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	var points, orders int
	var spent float64
	_ = db.Pool.QueryRow(r.Context(), `
		SELECT COALESCE(SUM(points_earned),0), COUNT(*), COALESCE(SUM(total),0)
		  FROM shopbook_order WHERE customer_user_id=$1 AND status='completed'`,
		user.ID).Scan(&points, &orders, &spent)
	httpx.JSON(w, 200, map[string]any{
		"points": points, "completedOrders": orders, "totalSpent": math.Round(spent*100) / 100,
	})
}

// ── owner: coupons ───────────────────────────────────────────────

func sbOwnerCoupons(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT id, code, kind, value, min_order, active FROM shopbook_coupon
		   WHERE shop_id=$1 ORDER BY created_at DESC`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, code, kind string
		var value, minOrder float64
		var active bool
		if err := rows.Scan(&id, &code, &kind, &value, &minOrder, &active); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "code": code, "kind": kind, "value": value, "minOrder": minOrder, "active": active,
		})
	}
	httpx.JSON(w, 200, map[string]any{"coupons": out})
}

func sbSaveCoupon(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		Code     string  `json:"code"`
		Kind     string  `json:"kind"`
		Value    float64 `json:"value"`
		MinOrder float64 `json:"minOrder"`
		Active   *bool   `json:"active"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Code == "" || (b.Kind != "percent" && b.Kind != "flat") || b.Value <= 0 {
		httpx.Err(w, http.StatusBadRequest, "code, kind(percent|flat) and positive value required")
		return
	}
	active := true
	if b.Active != nil {
		active = *b.Active
	}
	var id string
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO shopbook_coupon (shop_id, code, kind, value, min_order, active)
		VALUES ($1,UPPER($2),$3,$4,$5,$6)
		ON CONFLICT (shop_id, code) DO UPDATE SET
		  kind=$3, value=$4, min_order=$5, active=$6
		RETURNING id`,
		shopID, b.Code, b.Kind, b.Value, b.MinOrder, active).Scan(&id)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id})
}

func sbDeleteCoupon(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	tag, err := db.Pool.Exec(ctx, `DELETE FROM shopbook_coupon WHERE id=$1 AND shop_id=$2`,
		r.PathValue("id"), shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "Coupon not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ── owner: suppliers ─────────────────────────────────────────────

func sbOwnerSuppliers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT id, name, phone, items, note FROM shopbook_supplier
		   WHERE shop_id=$1 ORDER BY name`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, phone, items, note string
		if err := rows.Scan(&id, &name, &phone, &items, &note); err != nil {
			continue
		}
		out = append(out, map[string]any{"id": id, "name": name, "phone": phone, "items": items, "note": note})
	}
	httpx.JSON(w, 200, map[string]any{"suppliers": out})
}

func sbSaveSupplier(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Phone string `json:"phone"`
		Items string `json:"items"`
		Note  string `json:"note"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Name == "" {
		httpx.Err(w, http.StatusBadRequest, "name required")
		return
	}
	var id string
	if b.ID != "" {
		err := db.Pool.QueryRow(ctx,
			`UPDATE shopbook_supplier SET name=$1, phone=$2, items=$3, note=$4
			   WHERE id=$5 AND shop_id=$6 RETURNING id`,
			b.Name, b.Phone, b.Items, b.Note, b.ID, shopID).Scan(&id)
		if db.NoRows(err) {
			httpx.Err(w, http.StatusNotFound, "Supplier not found")
			return
		}
		if err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
	} else {
		if err := db.Pool.QueryRow(ctx,
			`INSERT INTO shopbook_supplier (shop_id, name, phone, items, note)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
			shopID, b.Name, b.Phone, b.Items, b.Note).Scan(&id); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	httpx.JSON(w, 200, map[string]any{"id": id})
}

func sbDeleteSupplier(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	tag, err := db.Pool.Exec(ctx, `DELETE FROM shopbook_supplier WHERE id=$1 AND shop_id=$2`,
		r.PathValue("id"), shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "Supplier not found")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// ════════════════════════════════════════════════════════════════
//  Phase 2b — reminders, plan, reports
// ════════════════════════════════════════════════════════════════

// Owner sends a pending-payment reminder push to a customer (no gateway —
// payments are recorded manually; this just nudges the customer).
func sbSendReminder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		CustomerID string `json:"customerId"`
	}
	if err := httpx.Body(r, &b); err != nil || b.CustomerID == "" {
		httpx.Err(w, http.StatusBadRequest, "customerId required")
		return
	}
	var pending float64
	var shopName string
	_ = db.Pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END),0)
		  FROM shopbook_ledger WHERE shop_id=$1 AND customer_user_id=$2`,
		shopID, b.CustomerID).Scan(&pending)
	_ = db.Pool.QueryRow(ctx, `SELECT name FROM shopbook_shop WHERE id=$1`, shopID).Scan(&shopName)
	if pending <= 0 {
		httpx.JSON(w, 200, map[string]any{"ok": true, "sent": false, "reason": "no_pending"})
		return
	}
	sbNotify(ctx, b.CustomerID, "Payment reminder 🔔",
		fmt.Sprintf("%s pending at %s", rupees(pending), shopName),
		map[string]any{"event": "reminder", "shopId": shopID})
	httpx.JSON(w, 200, map[string]any{"ok": true, "sent": true, "pending": math.Round(pending*100) / 100})
}

// Owner sets the shop plan manually (free|pro). No payment gateway — the owner
// upgrades out-of-band and flips this flag.
func sbSetPlan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		Plan string `json:"plan"`
	}
	if err := httpx.Body(r, &b); err != nil || (b.Plan != "free" && b.Plan != "pro") {
		httpx.Err(w, http.StatusBadRequest, "plan must be free|pro")
		return
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE shopbook_shop SET plan=$1, updated_at=NOW() WHERE id=$2`, b.Plan, shopID); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "plan": b.Plan})
}

// Daily reports — Pro only. Last 7 days of orders + sales, and top products.
func sbReports(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	if shopPlan(ctx, shopID) != "pro" {
		httpx.Err(w, http.StatusForbidden, "Reports are a Pro feature", map[string]any{"upgrade": true})
		return
	}
	// Daily sales for the last 7 days (completed orders).
	rows, err := db.Pool.Query(ctx, `
		SELECT to_char(created_at::date,'YYYY-MM-DD') AS d, COUNT(*), COALESCE(SUM(total),0)
		  FROM shopbook_order
		 WHERE shop_id=$1 AND status='completed' AND created_at >= NOW() - INTERVAL '7 days'
		 GROUP BY d ORDER BY d`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	days := []map[string]any{}
	for rows.Next() {
		var d string
		var count int
		var sales float64
		if rows.Scan(&d, &count, &sales) == nil {
			days = append(days, map[string]any{"date": d, "orders": count, "sales": sales})
		}
	}
	// Top products by quantity across all this shop's orders.
	prows, err := db.Pool.Query(ctx, `
		SELECT oi.name, SUM(oi.qty) AS q
		  FROM shopbook_order_item oi JOIN shopbook_order o ON o.id=oi.order_id
		 WHERE o.shop_id=$1
		 GROUP BY oi.name ORDER BY q DESC LIMIT 5`, shopID)
	top := []map[string]any{}
	if err == nil {
		defer prows.Close()
		for prows.Next() {
			var name string
			var q float64
			if prows.Scan(&name, &q) == nil {
				top = append(top, map[string]any{"name": name, "qty": q})
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"days": days, "topProducts": top})
}

// ════════════════════════════════════════════════════════════════
//  Phase 2c — cross-shop product search + bulk catalog add
// ════════════════════════════════════════════════════════════════

// Customer: find one product across nearby shops ("who has Maggi?").
func sbSearchProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		httpx.JSON(w, 200, map[string]any{"results": []any{}})
		return
	}
	lat, okLat := qfloat(r, "lat")
	lng, okLng := qfloat(r, "lng")
	args := []any{q}
	sql := `SELECT s.id, s.name, s.category, s.lat, s.lng, s.rating_sum, s.rating_count,
	               p.name, p.brand, p.price, p.unit
	          FROM shopbook_product p JOIN shopbook_shop s ON s.id=p.shop_id
	         WHERE p.enabled AND p.in_stock AND p.name ILIKE '%'||$1||'%'`
	if okLat && okLng {
		const boxDeg = 0.25
		sql += ` AND s.lat BETWEEN $2 AND $3 AND s.lng BETWEEN $4 AND $5`
		args = append(args, lat-boxDeg, lat+boxDeg, lng-boxDeg, lng+boxDeg)
	}
	sql += ` ORDER BY p.price LIMIT 60`
	rows, err := db.Pool.Query(ctx, sql, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var shopID, shopName, category, pName, pBrand, pUnit string
		var slat, slng *float64
		var ratingSum, ratingCount int
		var price float64
		if err := rows.Scan(&shopID, &shopName, &category, &slat, &slng, &ratingSum, &ratingCount,
			&pName, &pBrand, &price, &pUnit); err != nil {
			continue
		}
		var rating float64
		if ratingCount > 0 {
			rating = math.Round(float64(ratingSum)/float64(ratingCount)*10) / 10
		}
		m := map[string]any{
			"shopId": shopID, "shopName": shopName, "category": category,
			"rating": rating, "ratingCount": ratingCount,
			"productName": pName, "productBrand": pBrand, "price": price, "unit": pUnit,
		}
		if okLat && okLng && slat != nil && slng != nil {
			m["distanceKm"] = math.Round(haversineKm(lat, lng, *slat, *slng)*100) / 100
		}
		out = append(out, m)
	}
	httpx.JSON(w, 200, map[string]any{"results": out})
}

// Owner: bulk-add products from a pasted/parsed list. Insert-only (fast setup).
func sbBulkProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		Items []struct {
			Name     string  `json:"name"`
			Brand    string  `json:"brand"`
			Category string  `json:"category"`
			Unit     string  `json:"unit"`
			Price    float64 `json:"price"`
		} `json:"items"`
	}
	if err := httpx.Body(r, &b); err != nil || len(b.Items) == 0 {
		httpx.Err(w, http.StatusBadRequest, "items required")
		return
	}
	if len(b.Items) > 500 {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "Max 500 products per bulk add")
		return
	}
	added := 0
	err := db.WithUser(ctx, httpx.UserFrom(r).ID, func(tx pgx.Tx) error {
		for _, it := range b.Items {
			if strings.TrimSpace(it.Name) == "" {
				continue
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO shopbook_product (shop_id, name, brand, category, unit, price)
				 VALUES ($1,$2,$3,$4,$5,$6)`,
				shopID, it.Name, it.Brand, it.Category, it.Unit, it.Price); err != nil {
				return err
			}
			added++
		}
		return nil
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "could not add products")
		return
	}
	httpx.JSON(w, 200, map[string]any{"added": added})
}
