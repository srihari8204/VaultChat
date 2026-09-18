// shopbook.go — SHOP BOOK mini-app API. Text-only local-commerce layer:
// customers find nearby shops, browse/type products, place & track orders;
// shop owners manage products, orders and a digital khata (ledger).
//
// All routes authenticated. Every query is scoped by the caller's user id —
// an owner may only touch their own shop; a customer only their own orders and
// ledger. No product images in MVP (text catalog only).
package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/emitx"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/storage"
)

// sbJSON hands JSON to a jsonb parameter.
//
// pgx encodes a Go []byte (and json.RawMessage, which is one) as bytea. Its
// text form starts with "\x", so Postgres rejects it with `invalid input
// syntax for type json — Token "\" is invalid`. A string is sent as text,
// which jsonb parses. Every jsonb write in Shop Book silently failed on this
// for the whole life of the tax-engine upgrade: no invoice, no notification
// and no admin-log row was ever stored, and shop save returned "db error".
// Always wrap jsonb parameters in this.
func sbJSON(b []byte) string {
	if len(b) == 0 {
		return "{}"
	}
	return string(b)
}

// sbMoney formats a money amount for push copy in the shop's currency,
// e.g. "₹1,250" / "$12". Falls back to ₹ when the shop is unknown.
func sbMoney(ctx context.Context, shopID string, n float64) string {
	cur := "₹"
	if shopID != "" {
		var c string
		if db.Pool.QueryRow(ctx, `SELECT currency FROM shopbook_shop WHERE id=$1`, shopID).Scan(&c) == nil && c != "" {
			cur = c
		}
	}
	return cur + fmt.Sprintf("%.0f", n)
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

	// Upgrade (openspec: shop-book-upgrade) — tax engine, full order
	// pipeline, invoices, notification inbox, cross-shop ledger summary.
	mux.HandleFunc("GET /shopbook/countries", httpx.RequireAuth(sbCountries))
	mux.HandleFunc("GET /shopbook/starter-catalog", httpx.RequireAuth(sbStarterCatalog))
	mux.HandleFunc("POST /shopbook/orders/{id}/cancel", httpx.RequireAuth(sbCustomerCancel))
	mux.HandleFunc("POST /shopbook/orders/{id}/collected", httpx.RequireAuth(sbCustomerCollect))
	mux.HandleFunc("GET /shopbook/orders/{id}/invoice", httpx.RequireAuth(sbOrderInvoice))
	mux.HandleFunc("GET /shopbook/notifications", httpx.RequireAuth(sbNotifications))
	mux.HandleFunc("POST /shopbook/notifications/read", httpx.RequireAuth(sbNotificationsRead))
	mux.HandleFunc("GET /shopbook/my-ledgers", httpx.RequireAuth(sbMyLedgers))
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

// sbExistingShopID is ownerShopID without the 404 — for callers that only
// want to know whether a shop is already there (an upsert, not a lookup).
func sbExistingShopID(ctx context.Context, userID string) (string, bool) {
	var id string
	err := db.Pool.QueryRow(ctx, `SELECT id FROM shopbook_shop WHERE owner_user_id=$1`, userID).Scan(&id)
	return id, err == nil
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
	plan, lunch_start, lunch_end, approved, verified, country, currency, tax_config`

type shopScanner interface{ Scan(dest ...any) error }

func scanShop(row shopScanner) (map[string]any, error) {
	var (
		id, name, category, address, phone, openT, closeT, holiday, status string
		plan, lunchStart, lunchEnd, country, currency                      string
		slat, slng                                                         *float64
		pickup, delivery, approved, verified                               bool
		prep, ratingSum, ratingCount                                       int
		deliveryFee                                                        float64
		taxCfg                                                             []byte
	)
	if err := row.Scan(&id, &name, &category, &address, &slat, &slng, &phone,
		&openT, &closeT, &holiday, &status, &pickup, &prep,
		&delivery, &deliveryFee, &ratingSum, &ratingCount,
		&plan, &lunchStart, &lunchEnd,
		&approved, &verified, &country, &currency, &taxCfg); err != nil {
		return nil, err
	}
	var rating float64
	if ratingCount > 0 {
		rating = math.Round(float64(ratingSum)/float64(ratingCount)*10) / 10
	}
	if len(taxCfg) == 0 {
		taxCfg = []byte(`{}`)
	}
	return map[string]any{
		"id": id, "name": name, "category": category, "address": address,
		"lat": slat, "lng": slng, "phone": phone, "openTime": openT, "closeTime": closeT,
		"weeklyHoliday": holiday, "status": status, "pickup": pickup, "prepMins": prep,
		"delivery": delivery, "deliveryFee": deliveryFee,
		"rating": rating, "ratingCount": ratingCount,
		"plan": plan, "lunchStart": lunchStart, "lunchEnd": lunchEnd,
		"approved": approved, "verified": verified,
		"country": country, "currency": currency, "taxConfig": json.RawMessage(taxCfg),
	}, nil
}

// sbNotify sends an Expo push (title+body, auto-rendered in fg/bg) to every
// device the user has registered, persists a copy to the in-app notification
// inbox so missed pushes remain visible, AND emits a realtime event so an open
// app updates without waiting for a push or a manual refresh (P1-E).
//
// Three channels, one call, deliberately layered by reliability:
//
//	inbox    — durable. Survives a missed push and a closed app.
//	realtime — instant, but only if a socket happens to be connected.
//	push     — wakes a backgrounded app; may be dropped by the OS.
//
// The realtime event carries no state of its own beyond the identifiers: the
// client re-fetches. A socket message is a hint that something changed, never
// the record of what it changed to — the app must show the right thing after a
// cold start, when no socket event was ever received.
func sbNotify(ctx context.Context, userID, title, body string, data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	event, _ := data["event"].(string)
	// Emitted before the push so a foregrounded app reacts first and the push
	// arrives as confirmation rather than as the news.
	emitx.ToUids([]string{userID}, "shopbook:event", map[string]any{
		"event": event, "title": title, "body": body, "data": data,
	})
	if dataJSON, err := json.Marshal(data); err == nil {
		// Never swallow this: a silent failure here is invisible until someone
		// notices the inbox has been empty for weeks (which is what happened).
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO shopbook_notification (user_id, title, body, event, data)
			 VALUES ($1,$2,$3,$4,$5)`, userID, title, body, event, sbJSON(dataJSON)); err != nil {
			log.Printf("[shopbook] notification insert failed (user=%s event=%s): %v", userID, event, err)
		}
	}
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

// shopPlan returns the plan a shop is ENTITLED to ('free'|'pro').
//
// It used to read shopbook_shop.plan, which the owner could set themselves via
// POST /shopbook/my-shop/plan — so Pro was free to anyone who read the API.
// The column still exists (it is what the UI displays), but every gate now
// asks the entitlement record, which only an admin or a verified purchase
// writes. See sbEntitledPlan.
func shopPlan(ctx context.Context, shopID string) string {
	return sbEntitledPlan(ctx, shopID)
}

// ── customer: nearby shops ───────────────────────────────────────

// ── road distance, not crow-flies ────────────────────────────────────
//
// Haversine says how far a bird flies. Nobody drives that. A shop across a
// river or the far side of a one-way system reads as "close" and then takes
// half an hour, and the sort puts it above one that is genuinely easier to
// reach. Valhalla already runs for the family map and /nav/matrix, so the road
// network is right there.
//
// ONE source (the customer) to MANY targets (the shops) — the inverse of what
// /nav/matrix does, same endpoint, one job for the whole list rather than one
// call per shop.
//
// IT MUST NEVER FAIL THE SHOP LIST. Every failure path — engine down, slow,
// malformed answer, a shop the road network cannot reach — leaves that shop's
// straight-line distance in place. A worse number beats an empty screen, which
// is the same rule the media compressor follows: degrade, never block.

/** Most shops worth asking the router about. The list is already sorted
 *  nearest-first by straight line, and matrix cost grows with targets, so the
 *  tail would be paying for rows nobody scrolls to. */
const sbRouteMaxTargets = 25

/** Shorter than /nav/matrix's 20s: this is a list someone is waiting on, not a
 *  dedicated routing screen, and a slow answer is worth less than a fast
 *  approximate one. */
const sbRouteTimeout = 5 * time.Second

/** How many far shops get their own /route call. Bounded so a sparse list full
 *  of distant shops cannot turn one screen into an unbounded fan-out. */
const sbRouteMaxSingles = 10

/** Straight-line cutoff for the MATRIX call.
 *
 *  VALHALLA REFUSES THE WHOLE REQUEST, NOT THE OFFENDING PAIR. A single target
 *  beyond its 400km path limit answers
 *  `{"error_code":154,"error":"Path distance exceeds the max distance limit"}`
 *  with HTTP 400 — so one distant shop would strip road distance from every
 *  other shop in the same batch. Verified against prod: asking for a 119km
 *  shop and a 487km shop together returns that error and nothing usable;
 *  asking for the 119km one alone returns 146.9km.
 *
 *  Roads run 1.2-1.4x the straight line, so 250km straight stays comfortably
 *  inside the 400km road limit.
 *
 *  Shops PAST this cutoff are not abandoned to straight-line: the same engine
 *  allows 5,000km on the single-route endpoint (service_limits.auto.max_distance
 *  is 5000000 against a max_matrix_distance of 400000), so each gets its own
 *  /route call instead. Measured on prod, one of those answers in ~65ms, and
 *  the difference is not cosmetic — the shop showing 487.6km straight-line is
 *  726.9km by road, over 8 hours of driving. */
const sbRouteMaxStraightKm = 250.0

// routeKmFor returns road distances in km keyed by the index of `targets`.
// Missing keys mean "no road answer" — the caller keeps what it had.
type sbRoute struct {
	km   float64
	secs int
}

func valhallaBase() string {
	if b := os.Getenv("VALHALLA_URL"); b != "" {
		return b
	}
	return "http://valhalla:8002"
}

// routeKmOne asks for ONE road distance via /route, which permits far longer
// paths than the matrix does. Returns ok=false on any failure so the caller
// keeps whatever it already had.
func routeKmOne(ctx context.Context, lat, lng, tlat, tlng float64) (sbRoute, bool) {
	payload, err := json.Marshal(map[string]any{
		"locations":          []map[string]any{{"lat": lat, "lon": lng}, {"lat": tlat, "lon": tlng}},
		"costing":            "auto",
		"directions_options": map[string]any{"units": "kilometers"},
	})
	if err != nil {
		return sbRoute{}, false
	}
	rctx, cancel := context.WithTimeout(ctx, sbRouteTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, "POST", valhallaBase()+"/route", bytes.NewReader(payload))
	if err != nil {
		return sbRoute{}, false
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: sbRouteTimeout}).Do(req)
	if err != nil {
		return sbRoute{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return sbRoute{}, false
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return sbRoute{}, false
	}
	var vr struct {
		Trip struct {
			Summary struct {
				Length *float64 `json:"length"` // km, per directions_options
				Time   *float64 `json:"time"`   // seconds
			} `json:"summary"`
		} `json:"trip"`
	}
	if err := json.Unmarshal(data, &vr); err != nil {
		return sbRoute{}, false
	}
	sm := vr.Trip.Summary
	if sm.Length == nil || *sm.Length < 0 {
		return sbRoute{}, false
	}
	out := sbRoute{km: math.Round(*sm.Length*100) / 100}
	if sm.Time != nil && *sm.Time >= 0 {
		out.secs = int(*sm.Time + 0.5)
	}
	return out, true
}

func routeKmFor(ctx context.Context, lat, lng float64, targets [][2]float64) map[int]sbRoute {
	out := map[int]sbRoute{}
	if len(targets) == 0 {
		return out
	}
	tg := make([]map[string]any, 0, len(targets))
	for _, t := range targets {
		tg = append(tg, map[string]any{"lat": t[0], "lon": t[1]})
	}
	payload, err := json.Marshal(map[string]any{
		"sources":            []map[string]any{{"lat": lat, "lon": lng}},
		"targets":            tg,
		"costing":            "auto",
		"directions_options": map[string]any{"units": "kilometers"},
	})
	if err != nil {
		return out
	}
	base := os.Getenv("VALHALLA_URL")
	if base == "" {
		base = "http://valhalla:8002"
	}
	rctx, cancel := context.WithTimeout(ctx, sbRouteTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, "POST", base+"/sources_to_targets", bytes.NewReader(payload))
	if err != nil {
		return out
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: sbRouteTimeout}).Do(req)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return out
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return out
	}
	var vres valhallaMatrix
	if err := json.Unmarshal(data, &vres); err != nil {
		return out
	}
	// One source, so exactly one row; its cells line up with `targets`.
	if len(vres.SourcesToTargets) == 0 {
		return out
	}
	for i, c := range vres.SourcesToTargets[0] {
		if i >= len(targets) || c.Distance == nil || *c.Distance < 0 {
			continue // unreachable by road: keep the straight-line figure rather than drop the shop
		}
		e := sbRoute{km: math.Round(*c.Distance*100) / 100}
		if c.Time != nil && *c.Time >= 0 {
			e.secs = int(*c.Time + 0.5)
		}
		out[i] = e
	}
	return out
}

func sbNearbyShops(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if !sbRateLimit(w, r, "nearby", sbRateNearby, 60) {
		return
	}
	lat, okLat := qfloat(r, "lat")
	lng, okLng := qfloat(r, "lng")
	cat := r.URL.Query().Get("category")

	// Bounding box ~ 25 km; if no location given, just return a recent slice.
	// Shops without coordinates are still returned (they just carry no distance)
	// so a freshly-added shop never disappears the moment the customer's GPS is on.
	const boxDeg = 0.25
	args := []any{}
	sql := `SELECT ` + shopCols + ` FROM shopbook_shop`
	// Only admin-approved shops are discoverable.
	where := ` WHERE approved=TRUE`
	if okLat && okLng {
		where += ` AND (lat IS NULL OR lng IS NULL OR (lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4))`
		args = append(args, lat-boxDeg, lat+boxDeg, lng-boxDeg, lng+boxDeg)
	}
	if cat != "" && cat != "all" {
		where += " AND category=$" + strconv.Itoa(len(args)+1)
		args = append(args, cat)
	}
	collect := func(q string, a []any) ([]map[string]any, error) {
		rows, err := db.Pool.Query(ctx, q, a...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		acc := []map[string]any{}
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
			acc = append(acc, m)
		}
		return acc, nil
	}

	out, err := collect(sql+where+" LIMIT 100", args)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}

	// LOCATION MUST NEVER SHOW YOU LESS THAN NO LOCATION DID.
	//
	// Without coordinates this handler returns a recent slice of every approved
	// shop. With coordinates it applied a ~25km box — so switching location ON,
	// the feature whose whole purpose is helping you find shops, could take you
	// from "four shops" to "No shops found nearby yet". That is backwards, and
	// it is what a real user hit: they had moved, and the nearest shop of the
	// four that exist was 119km away, so the box emptied the list.
	//
	// An empty box now falls back to the unboxed set, still sorted nearest
	// first and still carrying the true distanceKm — so the answer becomes
	// "the closest one is 119km away" instead of silence. The box stays the
	// PREFERRED result: where there are nearby shops, distant ones are never
	// mixed in. This only changes the case that was previously empty.
	if len(out) == 0 && okLat && okLng {
		wide := ` WHERE approved=TRUE`
		wideArgs := []any{}
		if cat != "" && cat != "all" {
			wide += " AND category=$1"
			wideArgs = append(wideArgs, cat)
		}
		if o, err := collect(sql+wide+" LIMIT 100", wideArgs); err == nil {
			out = o
		}
	}

	// Upgrade straight-line to road distance where the router can answer, THEN
	// sort — so the ordering reflects what the customer will actually travel,
	// not what a bird would.
	if okLat && okLng && len(out) > 0 {
		apply := func(i int, rt sbRoute) {
			out[i]["distanceKm"] = rt.km
			out[i]["distanceIsRoute"] = true
			if rt.secs > 0 {
				out[i]["durationS"] = rt.secs
			}
		}

		// Two routes to the same answer, split by what each endpoint allows.
		// NEAR shops ride one matrix call — cheap for many. FAR ones exceed the
		// matrix's 400km limit and would poison that whole batch, so each takes
		// its own /route call, which permits 5,000km.
		nearIdx, nearTg := []int{}, [][2]float64{}
		farIdx, farTg := []int{}, [][2]float64{}
		for i, m := range out {
			slat, _ := m["lat"].(*float64)
			slng, _ := m["lng"].(*float64)
			if slat == nil || slng == nil {
				continue
			}
			d, haveD := m["distanceKm"].(float64)
			switch {
			case haveD && d > sbRouteMaxStraightKm:
				if len(farTg) < sbRouteMaxSingles {
					farIdx = append(farIdx, i)
					farTg = append(farTg, [2]float64{*slat, *slng})
				}
			case len(nearTg) < sbRouteMaxTargets:
				nearIdx = append(nearIdx, i)
				nearTg = append(nearTg, [2]float64{*slat, *slng})
			}
		}

		var wg sync.WaitGroup
		var mu sync.Mutex

		wg.Add(1)
		go func() {
			defer wg.Done()
			res := routeKmFor(ctx, lat, lng, nearTg)
			mu.Lock()
			defer mu.Unlock()
			for k, rt := range res {
				if k < len(nearIdx) {
					apply(nearIdx[k], rt)
				}
			}
		}()

		// Concurrent, because these are independent calls and the customer is
		// waiting on the whole screen, not on any one of them.
		for k := range farIdx {
			wg.Add(1)
			go func(k int) {
				defer wg.Done()
				rt, ok := routeKmOne(ctx, lat, lng, farTg[k][0], farTg[k][1])
				if !ok {
					return // keep the straight-line figure
				}
				mu.Lock()
				defer mu.Unlock()
				apply(farIdx[k], rt)
			}(k)
		}
		wg.Wait()
	}

	// Nearest first when we have the customer's location; shops without a known
	// distance (no coordinates, or outside the box) sort to the end.
	if okLat && okLng {
		distOf := func(m map[string]any) (float64, bool) {
			d, ok := m["distanceKm"].(float64)
			return d, ok
		}
		sort.SliceStable(out, func(i, j int) bool {
			di, oi := distOf(out[i])
			dj, oj := distOf(out[j])
			if oi != oj {
				return oi // one has a distance, the other doesn't → the one with distance ranks first
			}
			return di < dj
		})
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

// productCols reads the catalog row alongside its stock position. `p`/`st` are
// the aliases every caller must use (see the FROM clauses below).
const productCols = `p.id, p.name, p.brand, p.category, p.unit, ` + `(p.price*100)::bigint` + `,
	p.in_stock, p.enabled, ` + `(p.tax_percent*100)::bigint` + `, p.updated_at,
	p.track_stock, ` + `(p.cost_price*100)::bigint` + `,
	COALESCE((st.available*100)::bigint, 0), COALESCE((st.on_hand*100)::bigint, 0),
	COALESCE((st.reserved*100)::bigint, 0), COALESCE((st.reorder_level*100)::bigint, 0)`

const productFrom = ` FROM shopbook_product p LEFT JOIN shopbook_stock st ON st.product_id = p.id`

// scanProducts renders the catalog. `owner` gates the commercially sensitive
// half of the row: cost price, on-hand and reserved quantities are the shop's
// business, and this same function serves the public customer catalog.
func scanProducts(rows pgx.Rows, owner bool) []map[string]any {
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id, name, brand, category, unit      string
			price, taxPercent, cost              int64
			available, onHand, reserved, reorder int64
			inStockFlag, enabled, tracked        bool
			updated                              time.Time
		)
		if err := rows.Scan(&id, &name, &brand, &category, &unit, &price, &inStockFlag, &enabled,
			&taxPercent, &updated, &tracked, &cost,
			&available, &onHand, &reserved, &reorder); err != nil {
			continue
		}
		// For a tracked product the count decides availability; for everyone
		// else the owner's hand-set flag still does, exactly as before P0-B.
		inStock := inStockFlag
		if tracked {
			inStock = available > 0
		}
		m := map[string]any{
			"id": id, "name": name, "brand": brand, "category": category,
			"unit": unit, "price": money(price).Float(), "inStock": inStock, "enabled": enabled,
			"taxPercent": float64(taxPercent) / 100, "updatedAt": httpx.JST(&updated),
			"trackStock": tracked,
		}
		if tracked && owner {
			m["available"] = float64(available) / 100
			m["onHand"] = float64(onHand) / 100
			m["reserved"] = float64(reserved) / 100
			m["reorderLevel"] = float64(reorder) / 100
			m["costPrice"] = money(cost).Float()
		}
		out = append(out, m)
	}
	return out
}

func sbShopProducts(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Pool.Query(r.Context(),
		`SELECT `+productCols+productFrom+
			` WHERE p.shop_id=$1 AND p.enabled=TRUE ORDER BY p.name`, r.PathValue("id"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"products": scanProducts(rows, false)})
}

// ── customer: orders ─────────────────────────────────────────────

// sbPlaceOrder — the customer's order, priced entirely by the server.
//
// The client's `price` is read for ONE purpose: to detect that what the
// customer was shown is no longer what the shop charges, and to stop and say
// so rather than silently billing the new number. Nothing else in the body
// reaches a monetary column.
func sbPlaceOrder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	var body struct {
		ShopID         string `json:"shopId"`
		Note           string `json:"note"`
		CouponCode     string `json:"couponCode"`
		Delivery       bool   `json:"delivery"`
		Address        string `json:"address"`
		ConfirmPricing bool   `json:"confirmPricing"` // customer saw the new prices
		IdempotencyKey string `json:"idempotencyKey"`
		Items          []struct {
			ProductID string   `json:"productId"`
			Name      string   `json:"name"`
			Brand     string   `json:"brand"`
			Unit      string   `json:"unit"`
			Qty       float64  `json:"qty"`
			Price     *float64 `json:"price"` // displayed price — compared, never trusted
			Note      string   `json:"note"`
		} `json:"items"`
	}
	if !sbRateLimit(w, r, "order", sbRateWrite, 60) {
		return
	}
	if err := httpx.Body(r, &body); err != nil || body.ShopID == "" || len(body.Items) == 0 {
		httpx.Err(w, http.StatusBadRequest, "shopId and at least one item required")
		return
	}
	if len(body.Items) > 200 {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "Max 200 items per order")
		return
	}

	// Idempotency: a retried POST must resolve to the order the first attempt
	// created, not a second one. Checked here for the common case and enforced
	// by a unique index for the concurrent one.
	idem := sbIdemKey(r.Header.Get("Idempotency-Key"), body.IdempotencyKey)
	if idem != "" {
		var id, status string
		var total int64
		if err := db.Pool.QueryRow(ctx,
			`SELECT id, status, `+sbCents("total")+` FROM shopbook_order
			  WHERE customer_user_id=$1 AND idempotency_key=$2`, user.ID, idem).
			Scan(&id, &status, &total); err == nil {
			httpx.JSON(w, 200, map[string]any{
				"id": id, "status": status, "total": money(total).Float(), "duplicate": true,
			})
			return
		}
	}

	// The shop must actually be able to take this order (bug #12). Frontend
	// state is a cache of what the shop looked like when the screen loaded;
	// a shop that closed, was suspended, or was never approved must not be
	// able to receive an order the customer will then walk to collect.
	if msg := sbShopAcceptsOrders(ctx, body.ShopID); msg != "" {
		httpx.Err(w, http.StatusConflict, msg, map[string]any{"code": "shop_unavailable"})
		return
	}

	// Free-plan limit: up to 200 unique customers per shop. Existing customers
	// keep working — only a brand-new relationship is blocked (spec:
	// subscription-plans / Customer limit reached).
	if ok, err := sbCustomerLimitOK(ctx, body.ShopID, user.ID, ""); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	} else if !ok {
		httpx.Err(w, http.StatusForbidden,
			"This shop reached its customer limit on the Free plan",
			map[string]any{"upgrade": true, "limit": "customers"})
		return
	}

	// Delivery fee (only if this shop offers delivery).
	var deliveryFee money
	delivery := false
	if body.Delivery {
		var shopDelivery bool
		var fee int64
		if err := db.Pool.QueryRow(ctx,
			`SELECT delivery, `+sbCents("delivery_fee")+` FROM shopbook_shop WHERE id=$1`,
			body.ShopID).Scan(&shopDelivery, &fee); err == nil && shopDelivery {
			delivery, deliveryFee = true, money(fee)
		}
	}

	in := make([]sbLineIn, 0, len(body.Items))
	for _, it := range body.Items {
		l := sbLineIn{
			ProductID: it.ProductID, Name: it.Name, Brand: it.Brand,
			Unit: it.Unit, Note: it.Note, Qty100: int64(math.Round(it.Qty * 100)),
		}
		if it.Price != nil {
			cp := money(math.Round(*it.Price * 100))
			l.ClientPrice = &cp
		}
		in = append(in, l)
	}

	var orderID string
	var priced sbPriced
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		p, err := sbPriceLines(ctx, tx, body.ShopID, in, body.CouponCode, deliveryFee)
		if err != nil {
			return err
		}
		priced = p
		// Never silently re-price a customer. They confirm, then we commit.
		if len(p.Changes) > 0 && !body.ConfirmPricing {
			return errSBPriceChanged
		}
		snap, _ := json.Marshal(p.TaxSnapshot)
		if err := tx.QueryRow(ctx,
			`INSERT INTO shopbook_order
			   (shop_id, customer_user_id, note, subtotal, discount, tax_total, round_off, total,
			    coupon_code, delivery, delivery_fee, address, tax_snapshot, idempotency_key)
			 VALUES ($1,$2,$3,`+sbAmt("$4")+`,`+sbAmt("$5")+`,`+sbAmt("$6")+`,`+sbAmt("$7")+`,`+sbAmt("$8")+`,
			         $9,$10,`+sbAmt("$11")+`,$12,$13,$14) RETURNING id`,
			body.ShopID, user.ID, body.Note,
			int64(p.Subtotal), int64(p.Discount), int64(p.TaxTotal), int64(p.RoundOff), int64(p.Total),
			p.Coupon, delivery, int64(p.DeliveryFee), body.Address, sbJSON(snap), idem).Scan(&orderID); err != nil {
			return err
		}
		for _, l := range p.Lines {
			var pid any
			if l.ProductID != "" {
				pid = l.ProductID
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO shopbook_order_item
				   (order_id, product_id, custom, name, brand, unit, qty, price, tax_percent, note,
				    line_discount, line_tax, line_total)
				 VALUES ($1,$2,$3,$4,$5,$6,`+sbAmt("$7")+`,`+sbAmt("$8")+`,`+sbAmt("$9")+`,$10,
				         `+sbAmt("$11")+`,`+sbAmt("$12")+`,`+sbAmt("$13")+`)`,
				orderID, pid, l.Custom, l.Name, l.Brand, l.Unit,
				l.Qty100, int64(l.Price), l.TaxPct100, l.Note,
				int64(l.Discount), int64(l.Tax), int64(l.Total)); err != nil {
				return err
			}
		}
		return sbOrderEvent(ctx, tx, orderID, "pending", "Order placed")
	})
	if errors.Is(err, errSBPriceChanged) {
		changes := []map[string]any{}
		for _, l := range priced.Changes {
			changes = append(changes, map[string]any{
				"name": l.Name, "brand": l.Brand, "unit": l.Unit,
				"oldPrice": l.WasPrice.Float(), "newPrice": l.Price.Float(),
			})
		}
		httpx.Err(w, http.StatusConflict, "Prices changed at the shop — review and confirm",
			map[string]any{
				"code": "price_changed", "changes": changes,
				"subtotal": priced.Subtotal.Float(), "total": priced.Total.Float(),
			})
		return
	}
	if err != nil {
		// A duplicate key here is the concurrent retry the pre-check missed.
		if idem != "" && sbIsUniqueViolation(err, "idx_shopbook_order_idem") {
			var id, status string
			if db.Pool.QueryRow(ctx,
				`SELECT id, status FROM shopbook_order WHERE customer_user_id=$1 AND idempotency_key=$2`,
				user.ID, idem).Scan(&id, &status) == nil {
				httpx.JSON(w, 200, map[string]any{"id": id, "status": status, "duplicate": true})
				return
			}
		}
		log.Printf("[shopbook] place order failed (customer=%s shop=%s): %v", user.ID, body.ShopID, err)
		httpx.Err(w, http.StatusInternalServerError, "could not place order")
		return
	}
	// Notify the shop owner of the new order.
	var ownerID string
	if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, body.ShopID).Scan(&ownerID) == nil && ownerID != "" {
		sbNotify(ctx, ownerID, "New order 🛎️",
			fmt.Sprintf("%d item(s) · %s", len(body.Items), sbMoney(ctx, body.ShopID, priced.Total.Float())),
			map[string]any{"event": "new_order", "orderId": orderID})
	}
	httpx.JSON(w, 201, map[string]any{
		"id": orderID, "status": "pending",
		"subtotal": priced.Subtotal.Float(), "discount": priced.Discount.Float(),
		"taxTotal": priced.TaxTotal.Float(), "deliveryFee": priced.DeliveryFee.Float(),
		"total": priced.Total.Float(),
	})
}

// errSBPriceChanged aborts the pricing transaction so the customer can be
// shown the new prices before anything is written.
var errSBPriceChanged = errors.New("price changed")

// errSBOutOfStock aborts acceptance when the shelf cannot cover the order, so
// no line is left half-reserved and the owner is told which item is short.
var errSBOutOfStock = errors.New("out of stock")

// sbShopAcceptsOrders returns "" when the shop may receive an order right now,
// or the reason it may not (bug #12).
//
// The hard states — unapproved, suspended, closed, on holiday, not offering
// pickup — are absolute and always enforced. Business HOURS are only enforced
// when the shop has told us its timezone: judging a Chennai shop's opening
// time against UTC would close it every morning, and a wrong rejection is
// worse than a late order. Shops without a timezone keep taking orders at any
// hour, exactly as they always have.
func sbShopAcceptsOrders(ctx context.Context, shopID string) string {
	var approved, pickup, withinHours, hoursKnown bool
	var status, verifyState string
	err := db.Pool.QueryRow(ctx, `
		SELECT s.approved, s.pickup, s.status, s.verify_state,
		       s.timezone <> '' AS hours_known,
		       CASE WHEN s.timezone = '' THEN TRUE ELSE (
		         -- not the weekly holiday, and inside opening hours
		         lower(to_char(NOW() AT TIME ZONE s.timezone, 'dy')) IS DISTINCT FROM lower(s.weekly_holiday)
		         AND (
		           CASE WHEN s.close_time::time >= s.open_time::time
		                THEN (NOW() AT TIME ZONE s.timezone)::time
		                       BETWEEN s.open_time::time AND s.close_time::time
		                -- shops that close after midnight
		                ELSE (NOW() AT TIME ZONE s.timezone)::time >= s.open_time::time
		                  OR (NOW() AT TIME ZONE s.timezone)::time <= s.close_time::time
		           END)
		         AND NOT (s.lunch_start <> '' AND s.lunch_end <> ''
		                  AND (NOW() AT TIME ZONE s.timezone)::time
		                        BETWEEN s.lunch_start::time AND s.lunch_end::time)
		       ) END AS within_hours
		  FROM shopbook_shop s WHERE s.id=$1`, shopID).
		Scan(&approved, &pickup, &status, &verifyState, &hoursKnown, &withinHours)
	if db.NoRows(err) {
		return "That shop no longer exists"
	}
	if err != nil {
		// A malformed time string would fail the cast; refusing every order
		// because of a bad HH:MM is worse than accepting one out of hours.
		log.Printf("[shopbook] shop availability check failed (shop=%s): %v", shopID, err)
		return ""
	}
	switch {
	case !approved:
		return "This shop is not open for orders yet"
	case verifyState == "suspended":
		return "This shop is temporarily suspended"
	case status == "closed":
		return "This shop is closed right now"
	case status == "holiday":
		return "This shop is closed for a holiday"
	case status == "vacation":
		return "This shop is on vacation"
	case !pickup:
		return "This shop is not taking pickup orders"
	case hoursKnown && !withinHours:
		return "This shop is outside its business hours right now"
	}
	return ""
}

// sbOrderEvent appends one timestamped entry to the order's status timeline.
func sbOrderEvent(ctx context.Context, tx pgx.Tx, orderID, status, note string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO shopbook_order_event (order_id, status, note) VALUES ($1,$2,$3)`,
		orderID, status, note)
	return err
}

// sbCustomerLimitOK enforces the Free plan's 200-unique-customer cap at
// relationship-creation time. Pro shops and existing relationships pass.
// sbCustomerLimitOK enforces the Free plan's customer cap.
//
// TWO KINDS OF CUSTOMER, ONE CAP. An account customer is identified by
// customer_user_id; a walk-in by khata_customer_id (migration 111). Exactly one
// of custID / khataCustID is non-empty — the ledger's party CHECK enforces the
// same exclusivity in the database.
//
// WHY THE COUNT CHANGED. It used to be:
//
//	SELECT COUNT(*) FROM (SELECT customer_user_id FROM shopbook_order …
//	                      UNION SELECT customer_user_id FROM shopbook_ledger …)
//
// Every walk-in ledger row contributes a NULL there, and UNION collapses them
// to ONE row that COUNT(*) then counts as a customer. So a thousand walk-ins
// counted as one, and the cap became avoidable simply by using walk-in khata —
// a paywall bypass that nothing would have reported. NULLs are now excluded
// explicitly and walk-ins counted on their own identity.
func sbCustomerLimitOK(ctx context.Context, shopID, custID, khataCustID string) (bool, error) {
	if shopPlan(ctx, shopID) == "pro" {
		return true, nil
	}
	// An existing customer's next transaction never consumes quota — they are
	// already inside the count. Asked on the identity being written, so a
	// walk-in is recognised by the same rule an account customer is.
	var existing bool
	var err error
	if khataCustID != "" {
		err = db.Pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM shopbook_ledger WHERE shop_id=$1 AND khata_customer_id=$2)`,
			shopID, khataCustID).Scan(&existing)
	} else {
		err = db.Pool.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM shopbook_order  WHERE shop_id=$1 AND customer_user_id=$2)
			    OR EXISTS(SELECT 1 FROM shopbook_ledger WHERE shop_id=$1 AND customer_user_id=$2)`,
			shopID, custID).Scan(&existing)
	}
	if err != nil {
		return false, err
	}
	if existing {
		return true, nil
	}
	// Distinct account customers PLUS distinct walk-ins. The IS NOT NULL guards
	// are what stop the walk-in NULLs being counted as a phantom customer on
	// the account side and double-counted on the walk-in side.
	var count int
	err = db.Pool.QueryRow(ctx, `
		SELECT (SELECT COUNT(*) FROM (
					SELECT customer_user_id FROM shopbook_order
					 WHERE shop_id=$1 AND customer_user_id IS NOT NULL
					UNION
					SELECT customer_user_id FROM shopbook_ledger
					 WHERE shop_id=$1 AND customer_user_id IS NOT NULL
				) t)
		     + (SELECT COUNT(DISTINCT khata_customer_id) FROM shopbook_ledger
		         WHERE shop_id=$1 AND khata_customer_id IS NOT NULL)`,
		shopID).Scan(&count)
	if err != nil {
		return false, err
	}
	return count < 200, nil
}

// sbRecomputeOrderTotal re-derives an order's money after availability or
// alternative decisions change its effective line items. Delegates to the one
// authoritative pricing path (sbRepriceOrder) — this wrapper exists so the
// failure is logged rather than swallowed: a bill that quietly failed to
// re-add itself is the worst possible outcome of an owner's edit.
func sbRecomputeOrderTotal(ctx context.Context, orderID string) {
	if err := sbRepriceOrder(ctx, db.Pool, orderID); err != nil {
		log.Printf("[shopbook] reprice failed (order=%s): %v", orderID, err)
	}
}

func sbMyOrders(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	limit := sbPageLimit(r, 50, 100)
	args := []any{user.ID}
	sql := `SELECT o.id, o.shop_id, s.name, s.currency, o.status,
	               ` + sbCents("o.total") + `, o.created_at
	          FROM shopbook_order o JOIN shopbook_shop s ON s.id=o.shop_id
	         WHERE o.customer_user_id=$1`
	if cur, ok := sbCursor(r); ok {
		sql += " AND o.created_at < $2"
		args = append(args, cur)
	}
	sql += " ORDER BY o.created_at DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, err := db.Pool.Query(r.Context(), sql, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	var last time.Time
	for rows.Next() {
		var id, shopID, shopName, currency, status string
		var total int64
		var created time.Time
		if err := rows.Scan(&id, &shopID, &shopName, &currency, &status, &total, &created); err != nil {
			continue
		}
		if status == "new" {
			status = "pending"
		}
		last = created
		out = append(out, map[string]any{
			"id": id, "shopId": shopID, "shopName": shopName, "currency": currency,
			"status": status, "total": money(total).Float(), "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{
		"orders": out, "nextCursor": sbNextCursor(len(out), limit, last),
	})
}

// orderWithItems returns the order header + items, scoped so only the customer
// or the shop owner can read it.
func orderWithItems(ctx context.Context, w http.ResponseWriter, orderID, userID string) {
	var shopID, custID, status, note, couponCode, address string
	var cancelReason, cancelledBy, rejectReason, notCollectedReason, currency string
	// Shop identity for the bill header (spec: invoicing / shop profile).
	var shopName, shopAddress, shopPhone, shopCountry, ownerName string
	var shopTaxCfg []byte
	// What the buyer declared they are buying FOR. Sent back so the customer can
	// see and correct it — a tax number typed once and never shown again is a
	// number nobody can check before the invoice freezes it.
	var buyerTax []byte
	var totalC, subtotalC, discountC, taxTotalC, roundOffC, deliveryFeeC int64
	var delivery bool
	var created time.Time
	err := db.Pool.QueryRow(ctx,
		`SELECT o.shop_id, o.customer_user_id, o.status, `+sbCents("o.total")+`, o.note, o.created_at,
		        o.coupon_code, `+sbCents("o.discount")+`, o.delivery, `+sbCents("o.delivery_fee")+`, o.address,
		        `+sbCents("o.subtotal")+`, `+sbCents("o.tax_total")+`, `+sbCents("o.round_off")+`,
		        o.cancel_reason, o.cancelled_by, o.reject_reason, o.not_collected_reason,
		        s.currency, s.name, s.address, s.phone, s.country, s.tax_config,
		        COALESCE(u.name,''), o.buyer_tax
		   FROM shopbook_order o
		   JOIN shopbook_shop s ON s.id=o.shop_id
		   LEFT JOIN users u ON u.id=s.owner_user_id
		  WHERE o.id=$1`, orderID).Scan(&shopID, &custID, &status, &totalC, &note, &created,
		&couponCode, &discountC, &delivery, &deliveryFeeC, &address,
		&subtotalC, &taxTotalC, &roundOffC,
		&cancelReason, &cancelledBy, &rejectReason, &notCollectedReason, &currency,
		&shopName, &shopAddress, &shopPhone, &shopCountry, &shopTaxCfg, &ownerName, &buyerTax)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if status == "new" { // rows predating migration 064's backfill
		status = "pending"
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
		`SELECT id, name, brand, unit, `+sbCents("qty")+`, `+sbCents("price")+`,
		        `+sbCents("tax_percent")+`, note, availability, alt_name, `+sbCents("alt_price")+`,
		        `+sbCents("line_discount")+`, `+sbCents("line_tax")+`, `+sbCents("line_total")+`,
		        custom, COALESCE(product_id::text,''), removed,
		        `+sbCents("COALESCE(fulfilled_qty, qty)")+`
		   FROM shopbook_order_item WHERE order_id=$1 ORDER BY id`, orderID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, name, brand, unit, inote, avail, alt, productID string
		var custom, removed bool
		var qty, price, taxPercent, altPrice, lineDisc, lineTax, lineTotal, billedQty int64
		if err := rows.Scan(&id, &name, &brand, &unit, &qty, &price, &taxPercent, &inote, &avail,
			&alt, &altPrice, &lineDisc, &lineTax, &lineTotal, &custom, &productID,
			&removed, &billedQty); err != nil {
			continue
		}
		items = append(items, map[string]any{
			"id": id, "productId": productID, "custom": custom, "removed": removed,
			"name": name, "brand": brand, "unit": unit,
			// `qty` is what the customer is BILLED for — the quantity actually
			// packed, where the shop weighed it out. requestedQty keeps what
			// they originally asked for, which a return must not silently lose.
			"qty":          float64(billedQty) / 100,
			"requestedQty": float64(qty) / 100,
			"price":        money(price).Float(),
			"taxPercent":   float64(taxPercent) / 100, "note": inote, "availability": avail,
			"altName": alt, "altPrice": money(altPrice).Float(),
			"lineDiscount": money(lineDisc).Float(), "lineTax": money(lineTax).Float(),
			"lineTotal": money(lineTotal).Float(),
		})
	}
	rows.Close()

	// Timestamped status timeline (spec: order-management / progress tracking).
	timeline := []map[string]any{}
	if evRows, err := db.Pool.Query(ctx,
		`SELECT status, note, at FROM shopbook_order_event WHERE order_id=$1 ORDER BY id`, orderID); err == nil {
		defer evRows.Close()
		for evRows.Next() {
			var st, evNote string
			var at time.Time
			if evRows.Scan(&st, &evNote, &at) == nil {
				timeline = append(timeline, map[string]any{"status": st, "note": evNote, "at": httpx.JST(&at)})
			}
		}
	}

	var rated bool
	_ = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM shopbook_rating WHERE order_id=$1)`, orderID).Scan(&rated)
	var hasInvoice bool
	_ = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM shopbook_invoice WHERE order_id=$1)`, orderID).Scan(&hasInvoice)
	httpx.JSON(w, 200, map[string]any{
		"id": orderID, "shopId": shopID, "status": status, "total": money(totalC).Float(),
		"note": note, "createdAt": httpx.JST(&created), "items": items,
		"subtotal": money(subtotalC).Float(), "taxTotal": money(taxTotalC).Float(),
		"roundOff":   money(roundOffC).Float(),
		"couponCode": couponCode, "discount": money(discountC).Float(), "delivery": delivery,
		"deliveryFee": money(deliveryFeeC).Float(), "address": address, "rated": rated,
		"cancelReason": cancelReason, "cancelledBy": cancelledBy,
		"rejectReason": rejectReason, "notCollectedReason": notCollectedReason,
		"currency": currency,
		// Additive minor-unit view of the SAME amounts (shopbook_currency.go).
		// The decimal fields above are unchanged and stay authoritative for
		// every shipped client; this is the representation a client that knows
		// about ISO 4217 exponents should read, and the only one that is
		// correct for JPY (exponent 0) and KWD (exponent 3).
		"money": sbCurrencyBlock(ctx, shopCountry, map[string]money{
			"total": money(totalC), "subtotal": money(subtotalC),
			"discount": money(discountC), "taxTotal": money(taxTotalC),
			"roundOff": money(roundOffC), "deliveryFee": money(deliveryFeeC),
		}),
		// Shop identity — the bill is worthless without who issued it.
		"shop": map[string]any{
			"name": shopName, "address": shopAddress, "phone": shopPhone,
			"country": shopCountry, "ownerName": ownerName,
			"taxConfig": json.RawMessage(sbJSON(shopTaxCfg)),
		},
		"timeline": timeline, "hasInvoice": hasInvoice,
		"buyerTax": json.RawMessage(sbJSON(buyerTax)),
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

	// Only the owning customer may decide, and only while the order can still
	// absorb the change (bug #11) — an alternative accepted after Ready would
	// move a total the customer has already been quoted.
	var custID, shopID, curStatus string
	if err := db.Pool.QueryRow(ctx,
		`SELECT customer_user_id, shop_id, status FROM shopbook_order WHERE id=$1`,
		orderID).Scan(&custID, &shopID, &curStatus); err != nil || custID != user.ID {
		httpx.Err(w, http.StatusForbidden, "Not your order")
		return
	}
	if !sbReviewableStatuses[curStatus] {
		httpx.Err(w, http.StatusConflict,
			"This order has moved past review — contact the shop to change it")
		return
	}
	// Accepting adopts the suggested substitute: the line is replaced with
	// the alternative's name/price and the order total is re-derived.
	q := `UPDATE shopbook_order_item SET availability='unavailable'
	       WHERE id=$1 AND order_id=$2 AND availability='alternative'`
	if body.Accept {
		q = `UPDATE shopbook_order_item SET availability='available',
		       name  = COALESCE(NULLIF(alt_name,''), name),
		       price = CASE WHEN alt_price > 0 THEN alt_price ELSE price END
		     WHERE id=$1 AND order_id=$2 AND availability='alternative'`
	}
	tag, err := db.Pool.Exec(ctx, q, itemID, orderID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "No pending alternative for that item")
		return
	}
	sbRecomputeOrderTotal(ctx, orderID)
	newAvail := "unavailable"
	verdict := "rejected"
	if body.Accept {
		newAvail, verdict = "available", "accepted"
	}
	// Owner notification (spec: notifications / Customer accepted alternative).
	var ownerID string
	if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).Scan(&ownerID) == nil && ownerID != "" {
		sbNotify(ctx, ownerID, "Alternative "+verdict,
			"The customer "+verdict+" your suggested alternative",
			map[string]any{"event": "alternative_decision", "orderId": orderID, "accepted": body.Accept})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "availability": newAvail})
}

// ── customer: ledger with one shop ───────────────────────────────

func sbCustomerLedger(w http.ResponseWriter, r *http.Request) {
	user := httpx.UserFrom(r)
	ledgerJSON(r.Context(), w, r.PathValue("shopId"), user.ID, false)
}

func ledgerJSON(ctx context.Context, w http.ResponseWriter, shopID, partyID string, isKhata bool) {
	partyCol := "l.customer_user_id"
	if isKhata {
		partyCol = "l.khata_customer_id"
	}
	// Lines come back with their entry in one query. A per-entry follow-up
	// would be 200 round trips to render one khata screen.
	rows, err := db.Pool.Query(ctx,
		`SELECT l.id, l.type, l.amount, l.remark, l.created_at,
		        COALESCE((SELECT json_agg(json_build_object(
		                    'name', i.name, 'brand', i.brand, 'unit', i.unit,
		                    'qty', i.qty, 'price', i.price, 'taxPercent', i.tax_percent))
		                    FROM shopbook_ledger_item i WHERE i.ledger_id = l.id), '[]')
		   FROM shopbook_ledger l WHERE l.shop_id=$1 AND `+partyCol+`=$2
		  ORDER BY l.created_at DESC LIMIT 200`, shopID, partyID)
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
		var items []byte
		if err := rows.Scan(&id, &typ, &amount, &remark, &created, &items); err != nil {
			continue
		}
		if typ == "purchase" {
			purchase += amount
		} else {
			paid += amount
		}
		entries = append(entries, map[string]any{
			"id": id, "type": typ, "amount": amount, "remark": remark, "createdAt": httpx.JST(&created),
			"items": json.RawMessage(items),
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
		Name          string          `json:"name"`
		Category      string          `json:"category"`
		Address       string          `json:"address"`
		Lat           *float64        `json:"lat"`
		Lng           *float64        `json:"lng"`
		Phone         string          `json:"phone"`
		OpenTime      string          `json:"openTime"`
		CloseTime     string          `json:"closeTime"`
		WeeklyHoliday string          `json:"weeklyHoliday"`
		Status        string          `json:"status"`
		Pickup        *bool           `json:"pickup"`
		PrepMins      *int            `json:"prepMins"`
		Delivery      *bool           `json:"delivery"`
		DeliveryFee   *float64        `json:"deliveryFee"`
		LunchStart    string          `json:"lunchStart"`
		LunchEnd      string          `json:"lunchEnd"`
		Country       string          `json:"country"`
		TaxConfig     json.RawMessage `json:"taxConfig"`
		// P1-D: shop identity. Photos are object keys uploaded straight to
		// storage, never bytes through this endpoint.
		FrontPhotoKey *string `json:"frontPhotoKey"`
		LogoKey       *string `json:"logoKey"`
		Email         *string `json:"email"`
		Description   *string `json:"description"`
		Timezone      *string `json:"timezone"`
		RoundOff      *bool   `json:"roundOffEnabled"`
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
	switch b.Status {
	case "open", "busy", "closed", "holiday", "vacation":
	default:
		b.Status = "open"
	}
	// Country selection loads the tax engine config; the shop's currency is
	// stamped from it (spec: country-tax-engine / configuration loading).
	if b.Country == "" {
		b.Country = "IN"
	}
	currency := "₹"
	if cc, okC := sbLoadCountry(ctx, b.Country); okC {
		currency = cc.CurrencySymbol
	} else {
		httpx.Err(w, http.StatusBadRequest, "unknown country")
		return
	}
	taxCfg := []byte(`{}`)
	if len(b.TaxConfig) > 0 {
		probe := map[string]any{}
		if json.Unmarshal(b.TaxConfig, &probe) != nil {
			httpx.Err(w, http.StatusBadRequest, "taxConfig must be an object")
			return
		}
		taxCfg = b.TaxConfig
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
	// A verified shop's pin is fixed (P1-D). Customers walk to it, so moving
	// it after a badge was granted goes through review, not a settings save.
	// Small drift is a corrected GPS fix and passes silently.
	if existing, okE := sbExistingShopID(ctx, user.ID); okE {
		if msg, allowed := sbLocationGate(ctx, existing, b.Lat, b.Lng); !allowed {
			httpx.Err(w, http.StatusConflict, msg,
				map[string]any{"code": "location_locked"})
			return
		}
	}

	// SHOP IDENTITY PHOTOS ARE CLIENT-SUPPLIED OBJECT KEYS — VALIDATE THEM.
	//
	// frontPhotoKey and logoKey arrive verbatim in the request body and were
	// written to the shop row unchecked, so an owner could point their shop at
	// ANY key in the bucket, including another shop's verification documents.
	// It was inert only because nothing presigns these keys for read today —
	// an inertness that would end the moment someone added a display endpoint.
	//
	// Same rule the document path already enforces (shopbook_verify.go): the
	// key must be one WE minted for THIS shop, and the object must actually be
	// there. Verified against the EXISTING shop id, so a new shop cannot claim
	// a key at creation time — it has no namespace yet.
	if b.FrontPhotoKey != nil || b.LogoKey != nil {
		existingID, hasShop := sbExistingShopID(ctx, user.ID)
		for _, k := range []*string{b.FrontPhotoKey, b.LogoKey} {
			if k == nil || *k == "" {
				continue
			}
			if !hasShop || !strings.HasPrefix(*k, "shopbook/"+existingID+"/") {
				httpx.Err(w, http.StatusForbidden, "That image does not belong to your shop")
				return
			}
			// No traversal out of the namespace the prefix just established.
			if strings.Contains(*k, "..") {
				httpx.Err(w, http.StatusForbidden, "That image does not belong to your shop")
				return
			}
			if !storage.ObjectExists(ctx, *k) {
				httpx.Err(w, http.StatusBadRequest, "The upload did not complete — try again")
				return
			}
		}
	}

	// New shops start unapproved (spec: shop-accounts / approval before
	// public listing); shops existing before migration 064 stay approved.
	var id string
	var approved bool
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO shopbook_shop
		  (owner_user_id, name, category, address, lat, lng, phone,
		   open_time, close_time, weekly_holiday, status, pickup, prep_mins, delivery, delivery_fee,
		   lunch_start, lunch_end, country, currency, tax_config,
		   front_photo_key, logo_key, email, description, timezone, round_off_enabled,
		   origin_lat, origin_lng)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
		        COALESCE($21,''), COALESCE($22,''), COALESCE($23,''), COALESCE($24,''),
		        COALESCE($25,''), COALESCE($26,FALSE), $5, $6)
		ON CONFLICT (owner_user_id) DO UPDATE SET
		  name=$2, category=$3, address=$4, lat=$5, lng=$6, phone=$7,
		  open_time=$8, close_time=$9, weekly_holiday=$10, status=$11,
		  pickup=$12, prep_mins=$13, delivery=$14, delivery_fee=$15,
		  lunch_start=$16, lunch_end=$17, country=$18, currency=$19, tax_config=$20,
		  -- Each optional field is only overwritten when the client actually
		  -- sent it; a settings screen that omits a field must not blank it.
		  front_photo_key   = COALESCE($21, shopbook_shop.front_photo_key),
		  logo_key          = COALESCE($22, shopbook_shop.logo_key),
		  email             = COALESCE($23, shopbook_shop.email),
		  description       = COALESCE($24, shopbook_shop.description),
		  timezone          = COALESCE($25, shopbook_shop.timezone),
		  round_off_enabled = COALESCE($26, shopbook_shop.round_off_enabled),
		  updated_at=NOW()
		RETURNING id, approved`,
		user.ID, b.Name, b.Category, b.Address, b.Lat, b.Lng, b.Phone,
		b.OpenTime, b.CloseTime, b.WeeklyHoliday, b.Status, pickup, prep, delivery, deliveryFee,
		b.LunchStart, b.LunchEnd, b.Country, currency, sbJSON(taxCfg),
		b.FrontPhotoKey, b.LogoKey, b.Email, b.Description, b.Timezone, b.RoundOff).
		Scan(&id, &approved)
	if err != nil {
		log.Printf("[shopbook] shop upsert failed (owner=%s country=%s): %v", user.ID, b.Country, err)
		httpx.Err(w, http.StatusInternalServerError, "could not save shop")
		return
	}
	httpx.JSON(w, 200, map[string]any{"id": id, "approved": approved})
}

// ── owner: products ──────────────────────────────────────────────

func sbOwnerProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	rows, err := db.Pool.Query(ctx,
		`SELECT `+productCols+productFrom+` WHERE p.shop_id=$1 ORDER BY p.name`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"products": scanProducts(rows, true)})
}

func sbSaveProduct(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		ID           string   `json:"id"`
		Name         string   `json:"name"`
		Brand        string   `json:"brand"`
		Category     string   `json:"category"`
		Unit         string   `json:"unit"`
		Price        float64  `json:"price"`
		CostPrice    float64  `json:"costPrice"`
		TaxPercent   float64  `json:"taxPercent"`
		InStock      *bool    `json:"inStock"`
		Enabled      *bool    `json:"enabled"`
		TrackStock   *bool    `json:"trackStock"`
		ReorderLevel *float64 `json:"reorderLevel"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Name == "" {
		httpx.Err(w, http.StatusBadRequest, "name required")
		return
	}
	if b.Price < 0 || b.CostPrice < 0 || b.TaxPercent < 0 || b.TaxPercent > 100 {
		httpx.Err(w, http.StatusBadRequest, "price/cost must be ≥ 0 and tax between 0 and 100")
		return
	}
	inStock, enabled := true, true
	if b.InStock != nil {
		inStock = *b.InStock
	}
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	// Inventory is a Pro feature (spec: subscription-plans). Turning tracking
	// ON needs the plan; a product already tracked keeps working if the plan
	// later lapses — restricting a feature must never corrupt stock records.
	track := false
	if b.TrackStock != nil {
		track = *b.TrackStock
	}
	if track && shopPlan(ctx, shopID) != "pro" {
		var already bool
		if b.ID != "" {
			_ = db.Pool.QueryRow(ctx,
				`SELECT track_stock FROM shopbook_product WHERE id=$1 AND shop_id=$2`,
				b.ID, shopID).Scan(&already)
		}
		if !already {
			httpx.Err(w, http.StatusForbidden,
				"Stock tracking is a Pro feature",
				map[string]any{"upgrade": true, "limit": "inventory"})
			return
		}
	}
	price := int64(math.Round(b.Price * 100))
	cost := int64(math.Round(b.CostPrice * 100))
	taxPct := int64(math.Round(b.TaxPercent * 100))

	// A price change is the single most consequential edit an owner makes to
	// their catalog, so it is captured before and after (P1-F).
	var beforePrice int64
	var beforeName string
	if b.ID != "" {
		_ = db.Pool.QueryRow(ctx,
			`SELECT `+sbCents("price")+`, name FROM shopbook_product WHERE id=$1 AND shop_id=$2`,
			b.ID, shopID).Scan(&beforePrice, &beforeName)
	}

	var id string
	if b.ID != "" {
		// Update — scoped to this owner's shop. updated_at feeds the
		// price-comparison freshness indicator.
		err := db.Pool.QueryRow(ctx, `
			UPDATE shopbook_product SET name=$1, brand=$2, category=$3, unit=$4,
			   price=`+sbAmt("$5")+`, in_stock=$6, enabled=$7, tax_percent=`+sbAmt("$8")+`,
			   cost_price=`+sbAmt("$11")+`, track_stock=$12, updated_at=NOW()
			 WHERE id=$9 AND shop_id=$10 RETURNING id`,
			b.Name, b.Brand, b.Category, b.Unit, price, inStock, enabled, taxPct,
			b.ID, shopID, cost, track).Scan(&id)
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
			INSERT INTO shopbook_product
			  (shop_id, name, brand, category, unit, price, in_stock, enabled, tax_percent,
			   cost_price, track_stock)
			VALUES ($1,$2,$3,$4,$5,`+sbAmt("$6")+`,$7,$8,`+sbAmt("$9")+`,`+sbAmt("$10")+`,$11)
			RETURNING id`,
			shopID, b.Name, b.Brand, b.Category, b.Unit, price, inStock, enabled, taxPct,
			cost, track).Scan(&id); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	// A tracked product needs a position to hold; opening stock is recorded
	// separately (and visibly) through /stock/adjust, never implied here.
	if track {
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO shopbook_stock (product_id, shop_id) VALUES ($1,$2)
			 ON CONFLICT (product_id) DO NOTHING`, id, shopID); err != nil {
			log.Printf("[shopbook] stock row create failed (product=%s): %v", id, err)
		}
		if b.ReorderLevel != nil {
			if _, err := db.Pool.Exec(ctx,
				`UPDATE shopbook_stock SET reorder_level=`+sbAmt("$2")+`, updated_at=NOW()
				  WHERE product_id=$1`, id, int64(math.Round(*b.ReorderLevel*100))); err != nil {
				log.Printf("[shopbook] reorder level update failed (product=%s): %v", id, err)
			}
		}
	}
	if b.ID == "" {
		sbAudit(ctx, db.Pool, sbAuditEntry{
			ShopID: shopID, Actor: httpx.UserFrom(r).ID, Action: "product.create",
			Entity: "product", EntityID: id,
			After: map[string]any{"name": b.Name, "price": money(price).Float()},
			IP:    sbClientIP(r),
		})
	} else if beforePrice != price {
		sbAudit(ctx, db.Pool, sbAuditEntry{
			ShopID: shopID, Actor: httpx.UserFrom(r).ID, Action: "product.price_change",
			Entity: "product", EntityID: id,
			Before: map[string]any{"name": beforeName, "price": money(beforePrice).Float()},
			After:  map[string]any{"name": b.Name, "price": money(price).Float()},
			IP:     sbClientIP(r),
		})
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
	limit := sbPageLimit(r, 50, 100)
	sql := `SELECT o.id, o.customer_user_id, COALESCE(u.name,''), o.status,
	               ` + sbCents("o.total") + `, o.created_at
	          FROM shopbook_order o LEFT JOIN users u ON u.id=o.customer_user_id
	         WHERE o.shop_id=$1`
	args := []any{shopID}
	if status != "" && status != "all" {
		sql += " AND o.status=$" + strconv.Itoa(len(args)+1)
		args = append(args, status)
	}
	// Keyset paging: page 40 costs the same as page 1, and a new order
	// arriving mid-scroll cannot make a row repeat or vanish (P2).
	if cur, ok := sbCursor(r); ok {
		sql += " AND o.created_at < $" + strconv.Itoa(len(args)+1)
		args = append(args, cur)
	}
	sql += " ORDER BY o.created_at DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit)
	rows, err := db.Pool.Query(ctx, sql, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	var last time.Time
	for rows.Next() {
		var id, custID, custName, st string
		var total int64
		var created time.Time
		if err := rows.Scan(&id, &custID, &custName, &st, &total, &created); err != nil {
			continue
		}
		last = created
		out = append(out, map[string]any{
			"id": id, "customerId": custID, "customerName": custName, "status": st,
			"total": money(total).Float(), "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{
		"orders": out, "nextCursor": sbNextCursor(len(out), limit, last),
	})
}

// The window in which line items may still be reviewed or substituted. 'new'
// is the pre-069 alias for 'pending' and is accepted for old rows.
var sbReviewableStatuses = map[string]bool{
	"new": true, "pending": true, "accepted": true, "preparing": true, "packing": true,
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
		Availability string  `json:"availability"` // available | unavailable | alternative
		AltName      string  `json:"altName"`
		AltPrice     float64 `json:"altPrice"`
	}
	_ = httpx.Body(r, &b)
	switch b.Availability {
	case "available", "unavailable", "alternative":
	default:
		httpx.Err(w, http.StatusBadRequest, "availability must be available|unavailable|alternative")
		return
	}
	if b.AltPrice < 0 {
		httpx.Err(w, http.StatusBadRequest, "altPrice cannot be negative")
		return
	}
	// Availability review belongs to the window before the order is packed.
	// Changing a line after the customer has been told the order is Ready
	// changes what they owe, after they were told what they owe (bug #11).
	var curStatus string
	if err := db.Pool.QueryRow(ctx,
		`SELECT status FROM shopbook_order WHERE id=$1 AND shop_id=$2`,
		orderID, shopID).Scan(&curStatus); err != nil {
		httpx.Err(w, http.StatusNotFound, "Order not found for your shop")
		return
	}
	if !sbReviewableStatuses[curStatus] {
		httpx.Err(w, http.StatusConflict,
			"This order has moved past review — changes to items are no longer possible")
		return
	}
	// Ensure the order belongs to this owner's shop. The alternative's price is
	// the owner's to set (they are the seller) but still crosses the boundary
	// as minor units — it becomes the line price the moment the customer
	// accepts it.
	tag, err := db.Pool.Exec(ctx, `
		UPDATE shopbook_order_item SET availability=$1, alt_name=$2, alt_price=`+sbAmt("$3")+`
		 WHERE id=$4 AND order_id=$5
		   AND order_id IN (SELECT id FROM shopbook_order WHERE shop_id=$6)`,
		b.Availability, b.AltName, int64(math.Round(b.AltPrice*100)), itemID, orderID, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "Item not found for your shop")
		return
	}
	sbRecomputeOrderTotal(ctx, orderID)
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

// Owner-driven transitions of the order pipeline. "preparing" from "pending"
// is a legacy path (pre-upgrade clients skip the explicit accept) and records
// an implicit 'accepted' event so the timeline stays truthful.
//
// The pipeline is actor-split (spec: order-management, design D5a): the owner
// owns pending→ready, the *customer* owns ready→collected (sbCustomerCollect).
// The owner's only move from 'ready' is 'not_collected'.
var sbOwnerNext = map[string][]string{
	"pending":   {"accepted", "preparing", "rejected", "cancelled"},
	"accepted":  {"preparing", "cancelled"},
	"preparing": {"packing", "cancelled"},
	"packing":   {"ready"},
	"ready":     {"not_collected"},
}

// How long an order must sit in 'ready' before the owner may write it off as
// not collected, and after how long the daily sweep does it for them.
const (
	sbNotCollectedAfter = 24 * time.Hour
	sbSweepUncollected  = 7 * 24 * time.Hour
)

// Rollout grace for the actor split. Until the client update reaches the
// field, the *only* build owners have still completes orders by posting
// 'collected' themselves — refusing that outright would strand every order at
// 'ready' between the backend deploy and the app rollout. So the backend keeps
// accepting it, marks the timeline so the record stays honest about who
// asserted the handover, and logs it. Set SHOPBOOK_OWNER_COLLECT=deny once the
// updated client is out to enforce the spec.
//
// ponytail: temporary rollout knob — delete this and the branch in
// sbOwnerSetStatus once the old clients are gone.
func sbOwnerCollectDenied() bool {
	return os.Getenv("SHOPBOOK_OWNER_COLLECT") == "deny"
}

// The six rejection reason codes (spec: order-management / rejection).
var sbRejectReasons = map[string]string{
	"out_of_stock":  "Out of Stock",
	"shop_closed":   "Shop Closed",
	"quantity":      "Quantity Not Available",
	"outside_hours": "Outside Business Hours",
	"technical":     "Technical Issue",
	"other":         "Other",
}

func sbTransitionAllowed(from, to string) bool {
	for _, s := range sbOwnerNext[from] {
		if s == to {
			return true
		}
	}
	// Grace path only — never part of the table the spec is read from.
	if from == "ready" && (to == "collected" || to == "completed") {
		return !sbOwnerCollectDenied()
	}
	return false
}

// sbSettleOrder posts the khata purchase, stamps loyalty points and issues
// the invoice — exactly once per order.
//
// The amount is read from the order's own finalized snapshot, which since 092
// is tax-INCLUSIVE. Previously the caller passed the tax-exclusive total while
// the invoice added tax on top, so every taxed order left the khata short by
// exactly the tax. Order, invoice and ledger now all carry the same number.
//
// Idempotence is the unique partial index on shopbook_ledger(order_id), not a
// prior SELECT — two concurrent collects could both pass a read.
func sbSettleOrder(ctx context.Context, tx pgx.Tx, shopID, custID, orderID string) error {
	var totalC int64
	if err := tx.QueryRow(ctx,
		`SELECT `+sbCents("total")+` FROM shopbook_order WHERE id=$1`, orderID).Scan(&totalC); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx,
		`INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark, order_id)
		 VALUES ($1,$2,'purchase',`+sbAmt("$3")+`,'Order completed',$4)
		 ON CONFLICT DO NOTHING`,
		shopID, custID, totalC, orderID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		// Loyalty: 1 point per 100 spent, stamped on the order.
		if _, err := tx.Exec(ctx,
			`UPDATE shopbook_order SET points_earned=$1 WHERE id=$2`, totalC/10000, orderID); err != nil {
			return err
		}
	}
	// The goods have left the shop: the reservation becomes a sale (P0-B).
	if err := sbConsumeOrder(ctx, tx, shopID, orderID, custID); err != nil {
		return err
	}
	return sbCreateInvoice(ctx, tx, orderID)
}

// sbReadyFor returns how long an order has been sitting in 'ready', dated
// from its last 'ready' timeline event (falling back to updated_at for rows
// that predate the timeline table).
func sbReadyFor(ctx context.Context, tx pgx.Tx, orderID string) (time.Duration, error) {
	var secs float64
	err := tx.QueryRow(ctx, `
		SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(
		         (SELECT MAX(at) FROM shopbook_order_event
		           WHERE order_id=o.id AND status='ready'), o.updated_at)))
		  FROM shopbook_order o WHERE o.id=$1`, orderID).Scan(&secs)
	return time.Duration(secs) * time.Second, err
}

// Owner advances an order through the pipeline (pending → accepted →
// preparing → packing → ready), rejects it from pending with a reason code,
// or cancels it before packing with a reason. Collection is the customer's
// call (sbCustomerCollect); the owner's only move from 'ready' is writing the
// order off as 'not_collected' once it has waited 24h.
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
		Reason string `json:"reason"` // rejection code or cancellation text
	}
	_ = httpx.Body(r, &b)
	if b.Status == "new" { // legacy client alias
		b.Status = "pending"
	}

	if b.Status == "rejected" {
		if _, okR := sbRejectReasons[b.Reason]; !okR {
			httpx.Err(w, http.StatusBadRequest,
				"reason must be one of out_of_stock|shop_closed|quantity|outside_hours|technical|other")
			return
		}
	}
	if b.Status == "cancelled" && strings.TrimSpace(b.Reason) == "" {
		httpx.Err(w, http.StatusBadRequest, "cancellation reason required")
		return
	}
	// The owner cannot assert that the customer took the goods (design D5a) —
	// except during the client-rollout grace window, see sbOwnerCollectDenied.
	if b.Status == "collected" || b.Status == "completed" {
		if sbOwnerCollectDenied() {
			httpx.Err(w, http.StatusForbidden,
				"Only the customer can mark an order collected — if they never picked it up, mark it Not Collected")
			return
		}
		log.Printf("[shopbook] owner %s completed order %s (pre-split client; SHOPBOOK_OWNER_COLLECT=deny to enforce)",
			user.ID, orderID)
	}
	if b.Status == "not_collected" && strings.TrimSpace(b.Reason) == "" {
		httpx.Err(w, http.StatusBadRequest, "reason required")
		return
	}

	var custID, finalStatus string
	var shortfalls []sbShortfall
	var creditWarning map[string]any
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var cur string
		if err := tx.QueryRow(ctx,
			`SELECT status, customer_user_id FROM shopbook_order
			  WHERE id=$1 AND shop_id=$2 FOR UPDATE`,
			orderID, shopID).Scan(&cur, &custID); err != nil {
			return err
		}
		if cur == "new" { // rows predating migration 064's backfill
			cur = "pending"
		}
		if !sbTransitionAllowed(cur, b.Status) {
			return fmt.Errorf("bad transition %s->%s", cur, b.Status)
		}

		if b.Status == "accepted" || (cur == "pending" && b.Status == "preparing") {
			// Every line item must be reviewed before the order proceeds
			// (spec: order-management / availability review).
			var unreviewed, usable int
			if err := tx.QueryRow(ctx, `
				SELECT COUNT(*) FILTER (WHERE availability IN ('pending','alternative')),
				       COUNT(*) FILTER (WHERE availability <> 'unavailable')
				  FROM shopbook_order_item WHERE order_id=$1`, orderID).Scan(&unreviewed, &usable); err != nil {
				return err
			}
			if unreviewed > 0 {
				return fmt.Errorf("review pending")
			}
			if usable == 0 {
				return fmt.Errorf("all unavailable")
			}
		}

		// Acceptance is where stock stops being a number on a screen and
		// becomes a promise. Reserving here — inside the same transaction that
		// moves the status — is what stops two customers being sold the same
		// last bag (spec: stock reservation).
		if b.Status == "accepted" || (cur == "pending" && b.Status == "preparing") {
			short, err := sbReserveOrder(ctx, tx, shopID, orderID, user.ID)
			if err != nil {
				return err
			}
			if len(short) > 0 {
				shortfalls = short
				return errSBOutOfStock
			}
			// Credit limit WARNS, it does not block: a shopkeeper knows their
			// customers better than a threshold does, and having software
			// refuse a regular at the counter is how the relationship breaks.
			var orderTotal int64
			_ = tx.QueryRow(ctx,
				`SELECT `+sbCents("total")+` FROM shopbook_order WHERE id=$1`, orderID).Scan(&orderTotal)
			if over, pending, limit := sbCreditCheck(ctx, tx, shopID, custID, "", money(orderTotal)); over {
				creditWarning = map[string]any{
					"overLimit": true,
					"pending":   pending.Float(), "limit": limit.Float(),
					"afterOrder": (pending + money(orderTotal)).Float(),
				}
			}
		}
		// Nothing was handed over, so the goods are still the shop's.
		if b.Status == "rejected" || b.Status == "cancelled" || b.Status == "not_collected" {
			if err := sbReleaseOrder(ctx, tx, shopID, orderID, user.ID, b.Status); err != nil {
				return err
			}
		}

		finalStatus = b.Status
		events := []string{b.Status}
		ownerAsserted := false
		switch b.Status {
		case "preparing":
			if cur == "pending" { // legacy path: implicit accept
				events = []string{"accepted", "preparing"}
			}
		case "not_collected":
			// Give the customer a real window to come back for their order.
			waited, err := sbReadyFor(ctx, tx, orderID)
			if err != nil {
				return err
			}
			if waited < sbNotCollectedAfter {
				return fmt.Errorf("too soon:%d", int((sbNotCollectedAfter-waited)/time.Hour)+1)
			}
		case "collected", "completed":
			// Grace window: the shop asserted the handover. Settle as before,
			// but say so on the timeline — the customer never confirmed.
			if err := sbSettleOrder(ctx, tx, shopID, custID, orderID); err != nil {
				return err
			}
			finalStatus = "completed"
			events = []string{"collected", "completed"}
			ownerAsserted = true
		}

		set := `status=$1, updated_at=NOW()`
		args := []any{finalStatus, orderID, shopID}
		switch b.Status {
		case "rejected":
			set = `status=$1, reject_reason=$4, updated_at=NOW()`
			args = append(args, b.Reason)
		case "cancelled":
			set = `status=$1, cancel_reason=$4, cancelled_by='owner', updated_at=NOW()`
			args = append(args, b.Reason)
		case "not_collected":
			set = `status=$1, not_collected_reason=$4, updated_at=NOW()`
			args = append(args, b.Reason)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE shopbook_order SET `+set+` WHERE id=$2 AND shop_id=$3`, args...); err != nil {
			return err
		}
		for _, ev := range events {
			note := ""
			if ev == "rejected" {
				note = sbRejectReasons[b.Reason]
			} else if ev == "cancelled" || ev == "not_collected" {
				note = b.Reason
			} else if ev == "collected" && ownerAsserted {
				note = "marked by the shop"
			}
			if err := sbOrderEvent(ctx, tx, orderID, ev, note); err != nil {
				return err
			}
		}
		return nil
	})
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found for your shop")
		return
	}
	if errors.Is(err, errSBOutOfStock) {
		// Named per item, because "out of stock" alone leaves the owner to
		// guess which one — and their next move is to offer an alternative.
		httpx.Err(w, http.StatusConflict,
			"Not enough stock to accept this order",
			map[string]any{"code": "insufficient_stock", "shortfalls": shortfalls})
		return
	}
	if err != nil {
		switch err.Error() {
		case "review pending":
			httpx.Err(w, http.StatusBadRequest, "Review every item before accepting the order")
		case "all unavailable":
			httpx.Err(w, http.StatusBadRequest,
				"Every item is unavailable — reject the order as Out of Stock instead")
		default:
			if h, cut := strings.CutPrefix(err.Error(), "too soon:"); cut {
				httpx.Err(w, http.StatusConflict,
					"This order has not waited 24h yet — you can mark it Not Collected in "+h+"h")
			} else if strings.HasPrefix(err.Error(), "bad transition") {
				httpx.Err(w, http.StatusConflict, "That status change is not allowed from the order's current state")
			} else {
				httpx.Err(w, http.StatusInternalServerError, "db error")
			}
		}
		return
	}
	if custID != "" {
		msg := map[string]string{
			"accepted":      "Your order was accepted",
			"preparing":     "Your order is being prepared",
			"packing":       "Your order is being packed",
			"ready":         "Your order is ready to collect 🎉",
			"collected":     "Order collected — thank you!",
			"completed":     "Order completed — thank you!",
			"rejected":      "Your order was rejected: " + sbRejectReasons[b.Reason],
			"cancelled":     "Your order was cancelled: " + b.Reason,
			"not_collected": "The shop marked your order as not collected: " + b.Reason,
		}[b.Status]
		sbNotify(ctx, custID, "Order update", msg,
			map[string]any{"event": "order_status", "orderId": orderID, "status": finalStatus})
	}
	out := map[string]any{"ok": true, "status": finalStatus}
	if creditWarning != nil {
		out["creditWarning"] = creditWarning
	}
	httpx.JSON(w, 200, out)
}

// Customer cancels their own order — allowed only before the owner accepts
// it (spec: order-management / cancellation rules). Reason required.
func sbCustomerCancel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	orderID := r.PathValue("id")
	var b struct {
		Reason string `json:"reason"`
	}
	_ = httpx.Body(r, &b)
	if strings.TrimSpace(b.Reason) == "" {
		httpx.Err(w, http.StatusBadRequest, "cancellation reason required")
		return
	}
	var shopID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var cur string
		if err := tx.QueryRow(ctx,
			`SELECT status, shop_id FROM shopbook_order
			  WHERE id=$1 AND customer_user_id=$2 FOR UPDATE`,
			orderID, user.ID).Scan(&cur, &shopID); err != nil {
			return err
		}
		if cur == "new" {
			cur = "pending"
		}
		if cur != "pending" {
			return fmt.Errorf("too late")
		}
		if _, err := tx.Exec(ctx, `
			UPDATE shopbook_order SET status='cancelled', cancel_reason=$2,
			       cancelled_by='customer', updated_at=NOW() WHERE id=$1`,
			orderID, b.Reason); err != nil {
			return err
		}
		// A pending order holds no reservation, but the grace paths and any
		// future widening of the cancellation window do — release is a no-op
		// when nothing is held, and a leak when it is skipped.
		if err := sbReleaseOrder(ctx, tx, shopID, orderID, user.ID, "customer cancelled"); err != nil {
			return err
		}
		return sbOrderEvent(ctx, tx, orderID, "cancelled", b.Reason)
	})
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found")
		return
	}
	if err != nil {
		if err.Error() == "too late" {
			httpx.Err(w, http.StatusConflict,
				"The shop already accepted this order — contact the shop to cancel")
		} else {
			httpx.Err(w, http.StatusInternalServerError, "db error")
		}
		return
	}
	var ownerID string
	if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).Scan(&ownerID) == nil && ownerID != "" {
		sbNotify(ctx, ownerID, "Order cancelled",
			"The customer cancelled an order: "+b.Reason,
			map[string]any{"event": "order_cancelled", "orderId": orderID})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "status": "cancelled"})
}

// Customer confirms they collected a ready order — the only path to
// 'collected' (spec: order-management / collection and completion; D5a).
// Settles the khata, issues the invoice and auto-advances to 'completed'.
func sbCustomerCollect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	orderID := r.PathValue("id")
	var shopID string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		var cur string
		if err := tx.QueryRow(ctx,
			`SELECT status, shop_id FROM shopbook_order
			  WHERE id=$1 AND customer_user_id=$2 FOR UPDATE`,
			orderID, user.ID).Scan(&cur, &shopID); err != nil {
			return err
		}
		if cur == "completed" || cur == "collected" {
			return nil // idempotent: double-tap on a slow connection
		}
		if cur != "ready" {
			return fmt.Errorf("not ready")
		}
		if err := sbSettleOrder(ctx, tx, shopID, user.ID, orderID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE shopbook_order SET status='completed', updated_at=NOW() WHERE id=$1`,
			orderID); err != nil {
			return err
		}
		for _, ev := range []string{"collected", "completed"} {
			if err := sbOrderEvent(ctx, tx, orderID, ev, ""); err != nil {
				return err
			}
		}
		return nil
	})
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Order not found")
		return
	}
	if err != nil {
		if err.Error() == "not ready" {
			httpx.Err(w, http.StatusConflict, "This order is not ready for collection yet")
		} else {
			// Settling touches the ledger and the invoice — never fail silently.
			log.Printf("[shopbook] collect failed (order=%s customer=%s): %v", orderID, user.ID, err)
			httpx.Err(w, http.StatusInternalServerError, "db error")
		}
		return
	}
	var ownerID string
	if db.Pool.QueryRow(ctx, `SELECT owner_user_id FROM shopbook_shop WHERE id=$1`, shopID).Scan(&ownerID) == nil && ownerID != "" {
		sbNotify(ctx, ownerID, "Order collected ✅", "The customer confirmed pickup — the khata is settled.",
			map[string]any{"event": "order_status", "orderId": orderID, "status": "completed"})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "status": "completed"})
}

// ── owner: dashboard ─────────────────────────────────────────────

func sbDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var todayOrders, pendingOrders, lowStock int
	var todaySalesC, totalPendingC int64
	// Today's orders + sales. An order the shop rejected, or the customer
	// cancelled, or nobody collected, is not a sale — counting it inflated
	// today's takings and disagreed with the reports, which already filter on
	// 'completed'. Orders still in flight are counted, revenue is not.
	_ = db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled','rejected','not_collected')),
		        COALESCE(SUM(`+sbCents("total")+`) FILTER (WHERE status='completed'),0)
		   FROM shopbook_order
		  WHERE shop_id=$1 AND created_at::date = NOW()::date`, shopID).Scan(&todayOrders, &todaySalesC)
	// Open orders needing action. 'pending' and 'accepted' were missing here
	// (the list still named the pre-069 'new'), so the owner's action count
	// hid exactly the orders that most needed acting on.
	_ = db.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM shopbook_order
		  WHERE shop_id=$1
		    AND status IN ('pending','accepted','preparing','packing','ready')`, shopID).Scan(&pendingOrders)
	// Products needing attention: a tracked product at or under its reorder
	// level, or an untracked one the owner flagged out of stock by hand.
	_ = db.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM shopbook_product p
		  LEFT JOIN shopbook_stock st ON st.product_id = p.id
		 WHERE p.shop_id=$1 AND p.enabled
		   AND CASE WHEN p.track_stock
		            THEN st.reorder_level > 0 AND st.available <= st.reorder_level
		            ELSE NOT p.in_stock END`, shopID).Scan(&lowStock)
	// Total pending across the khata.
	_ = db.Pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN type='purchase' THEN `+sbCents("amount")+
		` ELSE -`+sbCents("amount")+` END),0)
		  FROM shopbook_ledger WHERE shop_id=$1`, shopID).Scan(&totalPendingC)

	// Cost of goods sold today, from the cost FROZEN ONTO EACH LINE when the
	// goods left the shelf (096) — never from the product's cost as it stands
	// now, or today's delivery would restate yesterday's profit.
	//
	// Lines with no cost basis are excluded rather than counted at zero, which
	// would report their whole sale price as profit. The share of revenue the
	// margin actually covers is reported alongside it, so a partial answer is
	// never mistaken for a complete one.
	var cogsC, coveredRevC, purchasesC int64
	var todayCustomers, todayPurchases int
	_ = db.Pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(`+sbCents("i.cost_at_sale * COALESCE(i.fulfilled_qty, i.qty)")+`),0),
		       COALESCE(SUM(`+sbCents("i.line_total")+`),0)
		  FROM shopbook_order_item i
		  JOIN shopbook_order o ON o.id = i.order_id
		 WHERE o.shop_id=$1 AND o.status='completed'
		   AND o.created_at::date = NOW()::date
		   AND i.cost_at_sale IS NOT NULL
		   AND i.availability <> 'unavailable' AND NOT i.removed`, shopID).Scan(&cogsC, &coveredRevC)
	_ = db.Pool.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(SUM(`+sbCents("total")+`),0)
		  FROM shopbook_purchase WHERE shop_id=$1 AND purchased_on = CURRENT_DATE`,
		shopID).Scan(&todayPurchases, &purchasesC)
	_ = db.Pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT customer_user_id) FROM shopbook_order
		 WHERE shop_id=$1 AND created_at::date = NOW()::date
		   AND status NOT IN ('cancelled','rejected','not_collected')`,
		shopID).Scan(&todayCustomers)

	out := map[string]any{
		"todayOrders":    todayOrders,
		"todaySales":     money(todaySalesC).Float(),
		"todayCustomers": todayCustomers,
		"pendingOrders":  pendingOrders,
		"lowStock":       lowStock,
		"totalPending":   money(totalPendingC).Float(),
		"todayPurchases": todayPurchases,
		"purchaseSpend":  money(purchasesC).Float(),
	}
	// Gross profit is only shown when there is a cost basis to compute it
	// from. An unqualified "profit" derived from a catalog with no purchase
	// history would just be revenue wearing a different label.
	if cogsC > 0 {
		out["costOfGoods"] = money(cogsC).Float()
		out["grossProfit"] = money(coveredRevC - cogsC).Float()
		out["marginCoverage"] = map[string]any{
			"revenueWithCost": money(coveredRevC).Float(),
			"revenueTotal":    money(todaySalesC).Float(),
		}
	}
	httpx.JSON(w, 200, out)
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
		ledgerJSON(ctx, w, shopID, custID, false)
		return
	}
	// A walk-in's history lives in a different column, so it needs its own
	// parameter rather than a flag on the same one — passing a khata id as
	// customerId would silently return an empty ledger instead of an error.
	if kID := r.URL.Query().Get("khataCustomerId"); kID != "" {
		ledgerJSON(ctx, w, shopID, kID, true)
		return
	}
	// No customer selected → summarise pending per customer.
	// staleDays is DAYS SINCE THE LAST PAYMENT — deliberately not invoice
	// aging. Real aging means allocating payments against purchases FIFO and
	// reporting the age of the oldest uncovered one; that is a different
	// (and much bigger) calculation. "No payment in 45 days" is cheap, exact,
	// and the thing an owner actually acts on. Named for what it is so nobody
	// later reads it as aged debt.
	// BOTH kinds of party, in one list.
	//
	// This used to GROUP BY customer_user_id alone, so a walk-in khata customer
	// was invisible here no matter how much they owed — migration 111 gave them
	// a party column and the write path fills it, but the screen the owner
	// actually looks at never read it.
	//
	// The khata arm is a LEFT JOIN so a customer added a moment ago, with no
	// entries yet, still appears. Otherwise "add customer" would look broken:
	// you would create one and the list would not change.
	rows, err := db.Pool.Query(ctx, `
		SELECT l.customer_user_id::text AS party_id, COALESCE(u.name,'') AS party_name,
		       '' AS mobile, false AS is_khata,
		       SUM(CASE WHEN l.type='purchase' THEN l.amount ELSE -l.amount END) AS pending,
		       MAX(l.created_at) FILTER (WHERE l.type='payment') AS last_paid,
		       MIN(l.created_at) AS first_entry,
		       COALESCE(c.credit_limit, 0) AS credit_limit
		  FROM shopbook_ledger l LEFT JOIN users u ON u.id=l.customer_user_id
		  LEFT JOIN shopbook_customer c
		         ON c.shop_id = l.shop_id AND c.customer_user_id = l.customer_user_id
		 WHERE l.shop_id=$1 AND l.customer_user_id IS NOT NULL
		 GROUP BY l.customer_user_id, u.name, c.credit_limit
		UNION ALL
		SELECT k.id::text, k.name, COALESCE(k.mobile,''), true,
		       COALESCE(SUM(CASE WHEN l.type='purchase' THEN l.amount ELSE -l.amount END), 0),
		       MAX(l.created_at) FILTER (WHERE l.type='payment'),
		       MIN(l.created_at),
		       k.credit_limit
		  FROM shopbook_khata_customer k
		  LEFT JOIN shopbook_ledger l
		         ON l.khata_customer_id = k.id AND l.shop_id = k.shop_id
		 WHERE k.shop_id=$1
		 GROUP BY k.id, k.name, k.mobile, k.credit_limit
		 ORDER BY pending DESC`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, mobile string
		var isKhata bool
		var pending, creditLimit float64
		var lastPaid, firstEntry *time.Time
		if err := rows.Scan(&id, &name, &mobile, &isKhata, &pending, &lastPaid, &firstEntry, &creditLimit); err != nil {
			continue
		}
		// Never paid at all → measure from the first entry, so a customer who
		// has owed since day one does not read as "0 days".
		since := lastPaid
		if since == nil {
			since = firstEntry
		}
		staleDays := 0
		if since != nil {
			staleDays = int(time.Since(*since).Hours() / 24)
		}
		out = append(out, map[string]any{
			"customerId": id, "customerName": name,
			"pending":       math.Round(pending*100) / 100,
			"lastPaymentAt": httpx.JST(lastPaid),
			"staleDays":     staleDays,
			// The client must know which party column to post against — an
			// account customer and a walk-in are written to different columns
			// and `shopbook_ledger_party_ck` rejects anything that sets both.
			"isKhata": isKhata,
			"mobile":  mobile,
			// The ceiling this party is held to, so the owner can SEE it before
			// changing it. 0 is the schema default and means no ceiling — the
			// two live in different tables because a walk-in can never satisfy
			// shopbook_customer's users FK.
			"creditLimit": math.Round(creditLimit*100) / 100,
		})
	}
	httpx.JSON(w, 200, map[string]any{"customers": out})
}

// sbLedgerItemIn is one line of a credit entry. Mirrors shopbook_order_item's
// shape so the invoice renderer reads one item structure whether the document
// came from an order or from the khata.
type sbLedgerItemIn struct {
	Name       string  `json:"name"`
	Brand      string  `json:"brand"`
	Unit       string  `json:"unit"`
	Qty        float64 `json:"qty"`
	Price      float64 `json:"price"`
	TaxPercent float64 `json:"taxPercent"`
}

// sbLedgerItemsTotal validates the lines and returns what they add up to, in
// cents. The ONE place a credit entry's worth is decided, so the ledger row,
// the customer's balance and the invoice built from it cannot disagree.
//
// Rounds per line, not on the grand total: 3 × ₹33.335 is three roundable
// prices, and summing floats first then rounding once drifts from what the
// printed lines say. The printed lines are what the customer checks.
//
// Trims Name in place — the caller inserts these same structs.
func sbLedgerItemsTotal(items []sbLedgerItemIn) (money, error) {
	if len(items) > 200 {
		return 0, errors.New("too many item lines (max 200)")
	}
	var sum money
	for i := range items {
		it := &items[i]
		it.Name = strings.TrimSpace(it.Name)
		if it.Name == "" || it.Qty <= 0 || it.Price < 0 {
			return 0, errors.New("every item needs a name, a positive qty and a non-negative price")
		}
		sum += money(math.Round(it.Qty * it.Price * 100))
	}
	return sum, nil
}

func sbAddLedgerEntry(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var b struct {
		CustomerID string `json:"customerId"`
		// A walk-in has no VaultChat account: the shop's own khata customer
		// (migration 111). Exactly one of the two names the party — the ledger's
		// party CHECK enforces the same exclusivity in the database.
		KhataCustomerID string           `json:"khataCustomerId"`
		Type            string           `json:"type"` // purchase | payment
		Amount          float64          `json:"amount"`
		Remark          string           `json:"remark"`
		IdempotencyKey  string           `json:"idempotencyKey"`
		Items           []sbLedgerItemIn `json:"items"`
		// Set by the app only after the owner has seen the over-limit warning
		// and chosen to proceed anyway.
		ConfirmOverLimit bool `json:"confirmOverLimit"`
	}
	if err := httpx.Body(r, &b); err != nil || (b.Type != "purchase" && b.Type != "payment") {
		httpx.Err(w, http.StatusBadRequest, "customerId and type(purchase|payment) required")
		return
	}
	// Rejected rather than resolved by precedence: sending both is the client
	// being wrong about who it is billing, and silently picking one writes debt
	// to a party the caller did not mean.
	if (b.CustomerID == "") == (b.KhataCustomerID == "") {
		httpx.Err(w, http.StatusBadRequest, "exactly one of customerId or khataCustomerId is required")
		return
	}

	// A payment is a number, not a basket. Accepting lines here would produce a
	// receipt itemising goods that were not part of the payment.
	if b.Type == "payment" && len(b.Items) > 0 {
		httpx.Err(w, http.StatusBadRequest, "a payment cannot carry item lines")
		return
	}

	// AMOUNT IS DERIVED WHEN LINES ARE GIVEN. The client's own total is ignored
	// rather than trusted-and-compared, matching sbLineIn on the order path.
	// The alternative — storing both — lets an invoice print lines that do not
	// add up to the total it also prints, which is worse than having no lines.
	amount := money(math.Round(b.Amount * 100))
	if len(b.Items) > 0 {
		sum, err := sbLedgerItemsTotal(b.Items)
		if err != nil {
			httpx.Err(w, http.StatusBadRequest, err.Error())
			return
		}
		amount = sum
	}
	if amount <= 0 {
		httpx.Err(w, http.StatusBadRequest, "positive amount required")
		return
	}

	// AUTHORIZATION. Two parties, two different threats, so two different
	// checks — the account-customer rule is NOT reused for walk-ins and NOT
	// weakened for accounts.
	//
	// ACCOUNT CUSTOMER: a shop may only write to a khata it already has.
	// customerId arrived from the client and was trusted, so any owner could
	// post debt against any VaultChat user id — money on a stranger's account,
	// visible to them in /shopbook/my-ledgers. The relationship must exist
	// first, and it is only ever created by that customer placing an order.
	//
	// WALK-IN: there is no stranger to victimise — the row is the shop's own
	// record and belongs to nobody else, so "must already have transacted"
	// would only mean a walk-in could never receive its first entry. What has
	// to hold instead is ownership: the khata customer must exist AND sit in
	// THIS shop, or an owner could post into another shop's walk-in book by
	// guessing an id.
	if b.KhataCustomerID != "" {
		var owned bool
		if err := db.Pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM shopbook_khata_customer WHERE id=$1 AND shop_id=$2)`,
			b.KhataCustomerID, shopID).Scan(&owned); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
		if !owned {
			httpx.Err(w, http.StatusForbidden, "That walk-in customer is not in your shop")
			return
		}
	} else {
		var related bool
		if err := db.Pool.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM shopbook_order  WHERE shop_id=$1 AND customer_user_id=$2)
			    OR EXISTS(SELECT 1 FROM shopbook_ledger WHERE shop_id=$1 AND customer_user_id=$2)`,
			shopID, b.CustomerID).Scan(&related); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
		if !related {
			httpx.Err(w, http.StatusForbidden,
				"That customer has no account with your shop yet — they appear in your khata after their first order")
			return
		}
	}

	// A manually added customer is a new khata relationship — the Free
	// plan's 200-customer cap applies here exactly as on first order, and a
	// walk-in consumes quota on the same terms.
	if okLimit, err := sbCustomerLimitOK(ctx, shopID, b.CustomerID, b.KhataCustomerID); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	} else if !okLimit {
		httpx.Err(w, http.StatusForbidden,
			"Customer limit reached on the Free plan — upgrade to add more customers",
			map[string]any{"upgrade": true, "limit": "customers"})
		return
	}

	// CREDIT CEILING — the same sbCreditCheck the order path uses, so a shop's
	// limit means one thing regardless of how the debt arrives. Only a purchase
	// can breach it; a payment moves the balance the right way and must never
	// be obstructed.
	//
	// Unlike the order path, which attaches a warning to a write that already
	// happened, this one asks first: here the owner is still typing, so it is
	// a decision they can act on rather than a notice about a fait accompli.
	// Overridable, because the owner knows the customer and the app does not.
	if b.Type == "purchase" && !b.ConfirmOverLimit {
		if over, pending, limit := sbCreditCheck(ctx, db.Pool, shopID, b.CustomerID, b.KhataCustomerID, amount); over {
			httpx.Err(w, http.StatusConflict,
				"This entry puts the customer over their credit limit",
				map[string]any{
					"code":    "over_credit_limit",
					"pending": pending.Float(), "limit": limit.Float(),
					"afterEntry": (pending + amount).Float(),
				})
			return
		}
	}

	// Idempotency: a retried payment must not credit the customer twice.
	idem := sbIdemKey(r.Header.Get("Idempotency-Key"), b.IdempotencyKey)
	if idem != "" {
		var id string
		if db.Pool.QueryRow(ctx,
			`SELECT id FROM shopbook_ledger WHERE shop_id=$1 AND idempotency_key=$2`,
			shopID, idem).Scan(&id) == nil {
			httpx.JSON(w, 200, map[string]any{"id": id, "duplicate": true})
			return
		}
	}

	// Entry, its lines and its audit stamp are one transaction. Split up, a
	// crash between them leaves either an itemless credit entry the customer
	// cannot check, or money moved with nothing recording who moved it.
	// Typed as any so the unused party column goes in as NULL rather than '' —
	// the party CHECK counts an empty string as present and would reject the row.
	var custParty, khataParty any
	if b.KhataCustomerID != "" {
		khataParty = b.KhataCustomerID
	} else {
		custParty = b.CustomerID
	}

	var id string
	err := db.WithUser(ctx, httpx.UserFrom(r).ID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO shopbook_ledger (shop_id, customer_user_id, khata_customer_id, type, amount, remark, idempotency_key)
			 VALUES ($1,$2,$3,$4,`+sbAmt("$5")+`,$6,$7) RETURNING id`,
			shopID, custParty, khataParty, b.Type, int64(amount), b.Remark, idem).Scan(&id); err != nil {
			return err
		}
		for _, it := range b.Items {
			if _, err := tx.Exec(ctx,
				`INSERT INTO shopbook_ledger_item (ledger_id, name, brand, unit, qty, price, tax_percent)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				id, it.Name, it.Brand, it.Unit, it.Qty, it.Price, it.TaxPercent); err != nil {
				return err
			}
		}
		// The gap 095 named and did not close: "ledger adjustments happened
		// silently". A shop can move a customer's balance; that must leave a
		// trace the shop cannot edit.
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: httpx.UserFrom(r).ID,
			Action: "ledger." + b.Type, Entity: "ledger", EntityID: id,
			After: map[string]any{
				"customerId": b.CustomerID, "khataCustomerId": b.KhataCustomerID,
				"type":   b.Type,
				"amount": amount.Float(), "items": len(b.Items),
				// Overriding a credit ceiling is a judgement call the owner is
				// entitled to make, and exactly the kind that needs a record.
				"overLimitOverride": b.ConfirmOverLimit,
			},
			Reason: b.Remark, IP: sbClientIP(r),
		})
		return nil
	})
	if err != nil {
		if idem != "" && sbIsUniqueViolation(err, "idx_shopbook_ledger_idem") {
			if db.Pool.QueryRow(ctx,
				`SELECT id FROM shopbook_ledger WHERE shop_id=$1 AND idempotency_key=$2`,
				shopID, idem).Scan(&id) == nil {
				httpx.JSON(w, 200, map[string]any{"id": id, "duplicate": true})
				return
			}
		}
		log.Printf("[shopbook] ledger entry failed (shop=%s type=%s): %v", shopID, b.Type, err)
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	// Tell the customer their balance moved, either way. A khata the customer
	// only hears about on the weekly reminder is one they can be surprised by;
	// the shop writes debt against them, so the debit needs a receipt too, not
	// just the credit. Balance is re-read rather than derived from `amount`, so
	// the number pushed is the same one the customer will see on screen.
	var pending float64
	_ = db.Pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END),0)
		  FROM shopbook_ledger WHERE shop_id=$1 AND customer_user_id=$2`,
		shopID, b.CustomerID).Scan(&pending)
	if b.Type == "payment" {
		sbNotify(ctx, b.CustomerID, "Payment recorded ✅",
			sbMoney(ctx, shopID, amount.Float())+" payment recorded — "+
				sbMoney(ctx, shopID, pending)+" now pending",
			map[string]any{"event": "payment", "shopId": shopID})
	} else {
		sbNotify(ctx, b.CustomerID, "Added to your khata 🧾",
			sbMoney(ctx, shopID, amount.Float())+" added — "+
				sbMoney(ctx, shopID, pending)+" now pending",
			map[string]any{"event": "khata_purchase", "shopId": shopID})
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
		"approved", "verified", "country", "currency", "tax_config",
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
		fmt.Sprintf("%s pending at %s", sbMoney(ctx, shopID, pending), shopName),
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
	// An owner may CANCEL down to Free — that is their decision to make. They
	// may not grant themselves Pro: entitlement comes from a purchase or an
	// admin, never from a request body (bug #8).
	if b.Plan == "pro" {
		httpx.Err(w, http.StatusForbidden,
			"Pro is activated from your subscription — contact support to upgrade",
			map[string]any{"upgrade": true, "reason": "entitlement_required"})
		return
	}
	if _, err := db.Pool.Exec(ctx, `
		UPDATE shopbook_entitlement SET plan='free', state='cancelled', updated_at=NOW()
		 WHERE shop_id=$1`, shopID); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	// The display column follows the entitlement; nothing is deleted, so a
	// re-subscribe restores every Pro feature over the same data.
	if _, err := db.Pool.Exec(ctx,
		`UPDATE shopbook_shop SET plan='free', updated_at=NOW() WHERE id=$1`, shopID); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "plan": "free"})
}

// sbSalesBuckets groups completed-order sales by a to_char pattern over an
// interval, e.g. daily for 7 days or monthly for 12 months.
func sbSalesBuckets(ctx context.Context, shopID, pattern, interval string) []map[string]any {
	out := []map[string]any{}
	rows, err := db.Pool.Query(ctx, `
		SELECT to_char(created_at, '`+pattern+`') AS d, COUNT(*), COALESCE(SUM(total),0)
		  FROM shopbook_order
		 WHERE shop_id=$1 AND status='completed' AND created_at >= NOW() - INTERVAL '`+interval+`'
		 GROUP BY d ORDER BY d`, shopID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var d string
		var count int
		var sales float64
		if rows.Scan(&d, &count, &sales) == nil {
			out = append(out, map[string]any{"date": d, "orders": count, "sales": sales})
		}
	}
	return out
}

// Reports (spec: reports-analytics). Basic — daily/weekly/monthly sales and
// pending payments — is available on every plan; scope=advanced (yearly, tax
// report, best sellers, top customers, product performance) is Pro-gated.
func sbReports(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	scope := r.URL.Query().Get("scope")
	pro := shopPlan(ctx, shopID) == "pro"
	if scope == "advanced" && !pro {
		httpx.Err(w, http.StatusForbidden, "Advanced reports are a Pro feature", map[string]any{"upgrade": true})
		return
	}

	days := sbSalesBuckets(ctx, shopID, "YYYY-MM-DD", "7 days")
	weeks := sbSalesBuckets(ctx, shopID, `IYYY-"W"IW`, "28 days")
	months := sbSalesBuckets(ctx, shopID, "YYYY-MM", "12 months")

	var pendingTotal float64
	var debtors int
	_ = db.Pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(pending),0), COUNT(*) FILTER (WHERE pending > 0) FROM (
			SELECT SUM(CASE WHEN type='purchase' THEN amount ELSE -amount END) AS pending
			  FROM shopbook_ledger WHERE shop_id=$1 GROUP BY customer_user_id
		) t WHERE pending > 0`, shopID).Scan(&pendingTotal, &debtors)

	out := map[string]any{
		"plan": map[bool]string{true: "pro", false: "free"}[pro],
		"days": days, "weeks": weeks, "months": months,
		"pendingTotal": math.Round(pendingTotal*100) / 100, "pendingCustomers": debtors,
	}

	if scope == "advanced" || (scope == "" && pro) {
		out["years"] = sbSalesBuckets(ctx, shopID, "YYYY", "3 years")

		// Tax report — from invoice snapshots, so config edits never shift it.
		taxRows, err := db.Pool.Query(ctx, `
			SELECT to_char(created_at,'YYYY-MM') AS m,
			       COALESCE(SUM(subtotal),0), COALESCE(SUM(tax_total),0)
			  FROM shopbook_invoice
			 WHERE shop_id=$1 AND created_at >= NOW() - INTERVAL '12 months'
			 GROUP BY m ORDER BY m`, shopID)
		tax := []map[string]any{}
		if err == nil {
			defer taxRows.Close()
			for taxRows.Next() {
				var m string
				var subtotal, taxTotal float64
				if taxRows.Scan(&m, &subtotal, &taxTotal) == nil {
					tax = append(tax, map[string]any{"month": m, "taxableSales": subtotal, "taxCollected": taxTotal})
				}
			}
		}
		out["taxReport"] = tax

		// Best sellers by quantity + revenue.
		prows, err := db.Pool.Query(ctx, `
			SELECT oi.name, SUM(oi.qty) AS q, COALESCE(SUM(oi.qty*oi.price),0) AS rev
			  FROM shopbook_order_item oi JOIN shopbook_order o ON o.id=oi.order_id
			 WHERE o.shop_id=$1 AND o.status='completed'
			 GROUP BY oi.name ORDER BY q DESC LIMIT 10`, shopID)
		top := []map[string]any{}
		if err == nil {
			defer prows.Close()
			for prows.Next() {
				var name string
				var q, rev float64
				if prows.Scan(&name, &q, &rev) == nil {
					top = append(top, map[string]any{"name": name, "qty": q, "revenue": math.Round(rev*100) / 100})
				}
			}
		}
		out["topProducts"] = top

		// Top customers by completed-order spend.
		crows, err := db.Pool.Query(ctx, `
			SELECT o.customer_user_id, COALESCE(u.name,''), COUNT(*), COALESCE(SUM(o.total),0) AS spent
			  FROM shopbook_order o LEFT JOIN users u ON u.id=o.customer_user_id
			 WHERE o.shop_id=$1 AND o.status='completed'
			 GROUP BY o.customer_user_id, u.name ORDER BY spent DESC LIMIT 10`, shopID)
		topCust := []map[string]any{}
		if err == nil {
			defer crows.Close()
			for crows.Next() {
				var id, name string
				var orders int
				var spent float64
				if crows.Scan(&id, &name, &orders, &spent) == nil {
					topCust = append(topCust, map[string]any{
						"customerId": id, "customerName": name, "orders": orders,
						"spent": math.Round(spent*100) / 100,
					})
				}
			}
		}
		out["topCustomers"] = topCust

		// Product performance — last 30 days movement.
		perfRows, err := db.Pool.Query(ctx, `
			SELECT oi.name, SUM(oi.qty) AS q, COALESCE(SUM(oi.qty*oi.price),0) AS rev
			  FROM shopbook_order_item oi JOIN shopbook_order o ON o.id=oi.order_id
			 WHERE o.shop_id=$1 AND o.status='completed' AND o.created_at >= NOW() - INTERVAL '30 days'
			 GROUP BY oi.name ORDER BY rev DESC LIMIT 20`, shopID)
		perf := []map[string]any{}
		if err == nil {
			defer perfRows.Close()
			for perfRows.Next() {
				var name string
				var q, rev float64
				if perfRows.Scan(&name, &q, &rev) == nil {
					perf = append(perf, map[string]any{"name": name, "qty": q, "revenue": math.Round(rev*100) / 100})
				}
			}
		}
		out["productPerformance"] = perf
	}
	httpx.JSON(w, 200, out)
}

// ════════════════════════════════════════════════════════════════
//  Phase 2c — cross-shop product search + bulk catalog add
// ════════════════════════════════════════════════════════════════

// Customer: price comparison — find one product across nearby approved
// shops with price, stock, freshness and enough timing data for the client
// to compute open-now (spec: price-comparison). sort=price|nearest.
func sbSearchProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// The most expensive read in Shop Book: a trigram scan across every
	// approved catalog (P2).
	if !sbRateLimit(w, r, "search", sbRateSearch, 60) {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		httpx.JSON(w, 200, map[string]any{"results": []any{}})
		return
	}
	lat, okLat := qfloat(r, "lat")
	lng, okLng := qfloat(r, "lng")
	args := []any{q}
	sql := `SELECT s.id, s.name, s.category, s.lat, s.lng, s.rating_sum, s.rating_count,
	               s.currency, s.status, s.open_time, s.close_time, s.weekly_holiday,
	               s.lunch_start, s.lunch_end,
	               p.name, p.brand, ` + sbCents("p.price") + `, p.unit,
	               CASE WHEN p.track_stock THEN COALESCE(st.available,0) > 0 ELSE p.in_stock END,
	               p.updated_at
	          FROM shopbook_product p
	          JOIN shopbook_shop s ON s.id=p.shop_id
	          LEFT JOIN shopbook_stock st ON st.product_id = p.id
	         WHERE s.approved AND p.enabled AND p.name ILIKE '%'||$1||'%'`
	if okLat && okLng {
		const boxDeg = 0.25
		sql += ` AND s.lat BETWEEN $2 AND $3 AND s.lng BETWEEN $4 AND $5`
		args = append(args, lat-boxDeg, lat+boxDeg, lng-boxDeg, lng+boxDeg)
	}
	// In-stock first, cheapest first — ordered on the same expression the row
	// reports, so the sort can never disagree with the badge next to it.
	sql += ` ORDER BY (CASE WHEN p.track_stock THEN COALESCE(st.available,0) > 0
	                        ELSE p.in_stock END) DESC, p.price LIMIT 60`
	rows, err := db.Pool.Query(ctx, sql, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var shopID, shopName, category, currency, status string
		var openT, closeT, holiday, lunchS, lunchE string
		var pName, pBrand, pUnit string
		var slat, slng *float64
		var ratingSum, ratingCount int
		var price int64
		var inStock bool
		var updated time.Time
		if err := rows.Scan(&shopID, &shopName, &category, &slat, &slng, &ratingSum, &ratingCount,
			&currency, &status, &openT, &closeT, &holiday, &lunchS, &lunchE,
			&pName, &pBrand, &price, &pUnit, &inStock, &updated); err != nil {
			continue
		}
		var rating float64
		if ratingCount > 0 {
			rating = math.Round(float64(ratingSum)/float64(ratingCount)*10) / 10
		}
		m := map[string]any{
			"shopId": shopID, "shopName": shopName, "category": category,
			"rating": rating, "ratingCount": ratingCount, "currency": currency,
			"shopStatus": status, "openTime": openT, "closeTime": closeT,
			"weeklyHoliday": holiday, "lunchStart": lunchS, "lunchEnd": lunchE,
			"productName": pName, "productBrand": pBrand, "price": money(price).Float(), "unit": pUnit,
			"inStock": inStock, "updatedAt": httpx.JST(&updated),
		}
		if okLat && okLng && slat != nil && slng != nil {
			m["distanceKm"] = math.Round(haversineKm(lat, lng, *slat, *slng)*100) / 100
		}
		out = append(out, m)
	}
	if r.URL.Query().Get("sort") == "nearest" && okLat && okLng {
		sort.SliceStable(out, func(i, j int) bool {
			di, oi := out[i]["distanceKm"].(float64)
			dj, oj := out[j]["distanceKm"].(float64)
			if oi != oj {
				return oi
			}
			return di < dj
		})
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
			Name       string  `json:"name"`
			Brand      string  `json:"brand"`
			Category   string  `json:"category"`
			Unit       string  `json:"unit"`
			Price      float64 `json:"price"`
			TaxPercent float64 `json:"taxPercent"`
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
				`INSERT INTO shopbook_product (shop_id, name, brand, category, unit, price, tax_percent)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				shopID, it.Name, it.Brand, it.Category, it.Unit, it.Price, it.TaxPercent); err != nil {
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
