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
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

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

	// Shop owner
	mux.HandleFunc("GET /shopbook/my-shop", httpx.RequireAuth(sbMyShop))
	mux.HandleFunc("POST /shopbook/my-shop", httpx.RequireAuth(sbUpsertShop))
	mux.HandleFunc("GET /shopbook/my-shop/products", httpx.RequireAuth(sbOwnerProducts))
	mux.HandleFunc("POST /shopbook/my-shop/products", httpx.RequireAuth(sbSaveProduct))
	mux.HandleFunc("DELETE /shopbook/my-shop/products/{id}", httpx.RequireAuth(sbDeleteProduct))
	mux.HandleFunc("GET /shopbook/my-shop/orders", httpx.RequireAuth(sbOwnerOrders))
	mux.HandleFunc("POST /shopbook/my-shop/orders/{id}/item/{itemId}", httpx.RequireAuth(sbOwnerSetAvailability))
	mux.HandleFunc("POST /shopbook/my-shop/orders/{id}/status", httpx.RequireAuth(sbOwnerSetStatus))
	mux.HandleFunc("GET /shopbook/my-shop/dashboard", httpx.RequireAuth(sbDashboard))
	mux.HandleFunc("GET /shopbook/my-shop/ledger", httpx.RequireAuth(sbOwnerLedger))
	mux.HandleFunc("POST /shopbook/my-shop/ledger", httpx.RequireAuth(sbAddLedgerEntry))
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

// ── customer: nearby shops ───────────────────────────────────────

func sbNearbyShops(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	lat, okLat := qfloat(r, "lat")
	lng, okLng := qfloat(r, "lng")
	cat := r.URL.Query().Get("category")

	// Bounding box ~ 25 km; if no location given, just return a recent slice.
	const boxDeg = 0.25
	args := []any{}
	sql := `SELECT id, name, category, address, lat, lng, phone, open_time, close_time,
	               weekly_holiday, status, pickup, prep_mins
	          FROM shopbook_shop`
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
		var (
			id, name, category, address, phone, openT, closeT, holiday, status string
			slat, slng                                                         *float64
			pickup                                                             bool
			prep                                                               int
		)
		if err := rows.Scan(&id, &name, &category, &address, &slat, &slng, &phone,
			&openT, &closeT, &holiday, &status, &pickup, &prep); err != nil {
			continue
		}
		m := map[string]any{
			"id": id, "name": name, "category": category, "address": address,
			"lat": slat, "lng": slng, "phone": phone, "openTime": openT, "closeTime": closeT,
			"weeklyHoliday": holiday, "status": status, "pickup": pickup, "prepMins": prep,
		}
		if okLat && okLng && slat != nil && slng != nil {
			m["distanceKm"] = math.Round(haversineKm(lat, lng, *slat, *slng)*100) / 100
		}
		out = append(out, m)
	}
	httpx.JSON(w, 200, map[string]any{"shops": out})
}

func sbShopDetails(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := r.PathValue("id")
	var (
		name, category, address, phone, openT, closeT, holiday, status string
		slat, slng                                                     *float64
		pickup                                                         bool
		prep                                                           int
	)
	err := db.Pool.QueryRow(ctx, `SELECT name, category, address, lat, lng, phone,
	        open_time, close_time, weekly_holiday, status, pickup, prep_mins
	        FROM shopbook_shop WHERE id=$1`, id).Scan(&name, &category, &address, &slat, &slng,
		&phone, &openT, &closeT, &holiday, &status, &pickup, &prep)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Shop not found")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"id": id, "name": name, "category": category, "address": address,
		"lat": slat, "lng": slng, "phone": phone, "openTime": openT, "closeTime": closeT,
		"weeklyHoliday": holiday, "status": status, "pickup": pickup, "prepMins": prep,
	})
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
		ShopID string `json:"shopId"`
		Note   string `json:"note"`
		Items  []struct {
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

	var orderID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		total := 0.0
		for _, it := range body.Items {
			total += it.Price * it.Qty
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO shopbook_order (shop_id, customer_user_id, note, total)
			 VALUES ($1,$2,$3,$4) RETURNING id`,
			body.ShopID, user.ID, body.Note, total).Scan(&orderID); err != nil {
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
	httpx.JSON(w, 201, map[string]any{"id": orderID, "status": "new"})
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
	var shopID, custID, status, note string
	var total float64
	var created time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT shop_id, customer_user_id, status, total, note, created_at
		   FROM shopbook_order WHERE id=$1`, orderID).Scan(&shopID, &custID, &status, &total, &note, &created)
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
	httpx.JSON(w, 200, map[string]any{
		"id": orderID, "shopId": shopID, "status": status, "total": total,
		"note": note, "createdAt": httpx.JST(&created), "items": items,
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
	var (
		id, name, category, address, phone, openT, closeT, holiday, status string
		slat, slng                                                         *float64
		pickup                                                             bool
		prep                                                               int
	)
	err := db.Pool.QueryRow(ctx, `SELECT id, name, category, address, lat, lng, phone,
	        open_time, close_time, weekly_holiday, status, pickup, prep_mins
	        FROM shopbook_shop WHERE owner_user_id=$1`, user.ID).Scan(&id, &name, &category, &address,
		&slat, &slng, &phone, &openT, &closeT, &holiday, &status, &pickup, &prep)
	if db.NoRows(err) {
		httpx.JSON(w, 200, map[string]any{"shop": nil})
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"shop": map[string]any{
		"id": id, "name": name, "category": category, "address": address,
		"lat": slat, "lng": slng, "phone": phone, "openTime": openT, "closeTime": closeT,
		"weeklyHoliday": holiday, "status": status, "pickup": pickup, "prepMins": prep,
	}})
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
	var id string
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO shopbook_shop
		  (owner_user_id, name, category, address, lat, lng, phone,
		   open_time, close_time, weekly_holiday, status, pickup, prep_mins)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (owner_user_id) DO UPDATE SET
		  name=$2, category=$3, address=$4, lat=$5, lng=$6, phone=$7,
		  open_time=$8, close_time=$9, weekly_holiday=$10, status=$11,
		  pickup=$12, prep_mins=$13, updated_at=NOW()
		RETURNING id`,
		user.ID, b.Name, b.Category, b.Address, b.Lat, b.Lng, b.Phone,
		b.OpenTime, b.CloseTime, b.WeeklyHoliday, b.Status, pickup, prep).Scan(&id)
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
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var custID string
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
			}
		}
		return nil
	})
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found for your shop")
		return
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
	httpx.JSON(w, 201, map[string]any{"id": id})
}
