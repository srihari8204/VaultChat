// shopbook_admin2.go — SHOP BOOK admin portal, second half (P1-G):
// verification review, document inspection, location decisions, subscription
// entitlements, and read-only windows onto orders, payments and returns.
//
// Everything here is behind the same adminAuth as shopbook_admin.go, and every
// mutation writes to shopbook_admin_log — the platform's own trail, distinct
// from the shop-scoped one an owner can read.
//
// The one thing this file deliberately does NOT do is let an admin edit a
// shop's money. Approving a verification, granting an entitlement and moving a
// pin are all decisions about a shop's standing; adjusting its ledger is not
// an administrative act, and there is no endpoint for it.
package routes

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/storage"
)

func RegisterShopBookAdmin2(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/shopbook/verifications", adminAuth(sbAdminVerifications))
	mux.HandleFunc("POST /api/admin/shopbook/shops/{id}/verify", adminAuth(sbAdminVerify))
	mux.HandleFunc("GET /api/admin/shopbook/shops/{id}/documents", adminAuth(sbAdminDocuments))
	mux.HandleFunc("POST /api/admin/shopbook/documents/{id}/review", adminAuth(sbAdminReviewDocument))
	mux.HandleFunc("GET /api/admin/shopbook/location-requests", adminAuth(sbAdminLocationRequests))
	mux.HandleFunc("POST /api/admin/shopbook/location-requests/{id}/decide", adminAuth(sbAdminDecideLocation))
	mux.HandleFunc("GET /api/admin/shopbook/subscriptions", adminAuth(sbAdminSubscriptions))
	mux.HandleFunc("POST /api/admin/shopbook/shops/{id}/entitlement", adminAuth(sbAdminSetEntitlement))
	mux.HandleFunc("GET /api/admin/shopbook/orders", adminAuth(sbAdminOrders))
	mux.HandleFunc("GET /api/admin/shopbook/returns", adminAuth(sbAdminReturns))
	mux.HandleFunc("GET /api/admin/shopbook/audit", adminAuth(sbAdminShopAudit))
}

// The five states a shop's standing can be in, and who may follow what.
// suspended is reachable from anywhere — it is the emergency brake.
var sbVerifyNext = map[string][]string{
	"unverified":     {"pending_review", "verified", "rejected", "suspended"},
	"pending_review": {"verified", "rejected", "suspended"},
	"verified":       {"suspended"},
	"rejected":       {"pending_review", "verified", "suspended"},
	"suspended":      {"verified", "unverified", "rejected"},
}

func sbVerifyAllowed(from, to string) bool {
	for _, s := range sbVerifyNext[from] {
		if s == to {
			return true
		}
	}
	return false
}

// GET /api/admin/shopbook/verifications?state=pending_review
func sbAdminVerifications(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "pending_review"
	}
	args := []any{}
	where := ""
	if state != "all" {
		where = " WHERE s.verify_state=$1"
		args = append(args, state)
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT s.id, s.name, s.category, s.address, s.phone, s.email, s.country,
		       s.verify_state, s.verify_note, s.approved, s.lat, s.lng,
		       s.front_photo_key <> '' AS has_front_photo,
		       COALESCE(u.name,''), COALESCE(u.phone,''), s.created_at,
		       (SELECT COUNT(*) FROM shopbook_document d WHERE d.shop_id=s.id)
		  FROM shopbook_shop s
		  LEFT JOIN users u ON u.id = s.owner_user_id`+where+`
		 ORDER BY s.created_at DESC LIMIT 200`, args...)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, cat, addr, phone, email, country, vstate, vnote string
		var ownerName, ownerPhone string
		var approved, hasPhoto bool
		var lat, lng *float64
		var created time.Time
		var docs int
		if rows.Scan(&id, &name, &cat, &addr, &phone, &email, &country, &vstate, &vnote,
			&approved, &lat, &lng, &hasPhoto, &ownerName, &ownerPhone, &created, &docs) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "category": cat, "address": addr,
			"phone": phone, "email": email, "country": country,
			"verifyState": vstate, "verifyNote": vnote, "approved": approved,
			"lat": lat, "lng": lng, "hasFrontPhoto": hasPhoto,
			"ownerName": ownerName, "ownerPhone": ownerPhone,
			"documentCount": docs, "createdAt": httpx.JST(&created),
		})
	}
	httpx.JSON(w, 200, map[string]any{"shops": out})
}

// POST /api/admin/shopbook/shops/{id}/verify {state, note}
func sbAdminVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID := r.PathValue("id")
	var b struct {
		State string `json:"state"`
		Note  string `json:"note"`
	}
	_ = httpx.Body(r, &b)

	var cur string
	var ownerID string
	if err := db.Pool.QueryRow(ctx,
		`SELECT verify_state, owner_user_id FROM shopbook_shop WHERE id=$1`,
		shopID).Scan(&cur, &ownerID); err != nil {
		httpx.Err(w, http.StatusNotFound, "Shop not found")
		return
	}
	if !sbVerifyAllowed(cur, b.State) {
		httpx.Err(w, http.StatusConflict,
			"Cannot move a shop from "+cur+" to "+b.State,
			map[string]any{"allowed": sbVerifyNext[cur]})
		return
	}
	// Telling a shop it is rejected or suspended without saying why leaves
	// them with nothing to fix and support with nothing to explain.
	if (b.State == "rejected" || b.State == "suspended") && strings.TrimSpace(b.Note) == "" {
		httpx.Err(w, http.StatusBadRequest, "a note is required when rejecting or suspending")
		return
	}

	// Verifying pins the location; un-verifying releases it.
	verified := b.State == "verified"
	if _, err := db.Pool.Exec(ctx, `
		UPDATE shopbook_shop
		   SET verify_state=$2, verify_note=$3, verified=$4,
		       location_locked = ($4 OR location_locked),
		       verified_at = CASE WHEN $4 THEN NOW() ELSE verified_at END,
		       -- Verification implies listing; suspension removes it.
		       approved = CASE WHEN $2='suspended' THEN FALSE
		                       WHEN $4 THEN TRUE ELSE approved END,
		       updated_at=NOW()
		 WHERE id=$1`, shopID, b.State, strings.TrimSpace(b.Note), verified); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbAdminLog(ctx, "shopbook.verify", shopID, map[string]any{
		"from": cur, "to": b.State, "note": b.Note,
	})
	// The owner learns the outcome from the app, not by noticing their
	// listing vanished.
	if ownerID != "" {
		msg := map[string]string{
			"verified":       "Your shop is verified ✅",
			"rejected":       "Verification was not approved",
			"suspended":      "Your shop has been suspended",
			"pending_review": "Your shop is under review",
			"unverified":     "Your shop's verification was reset",
		}[b.State]
		sbNotify(ctx, ownerID, msg, b.Note,
			map[string]any{"event": "verification", "state": b.State, "shopId": shopID})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "verifyState": b.State})
}

// GET /api/admin/shopbook/shops/{id}/documents — with short-lived view links.
func sbAdminDocuments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := db.Pool.Query(ctx, `
		SELECT id, kind, object_key, filename, mime, size_bytes, status, review_note, uploaded_at
		  FROM shopbook_document WHERE shop_id=$1 ORDER BY uploaded_at DESC`, r.PathValue("id"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, kind, key, filename, mime, status, note string
		var size int64
		var at time.Time
		if rows.Scan(&id, &kind, &key, &filename, &mime, &size, &status, &note, &at) != nil {
			continue
		}
		// A link, not the key: the reviewer gets fifteen minutes of access,
		// and nothing that outlives the review session.
		url := ""
		if storage.Enabled() {
			if u, err := storage.PresignGet(ctx, key, 15*time.Minute); err == nil {
				url = u
			}
		}
		out = append(out, map[string]any{
			"id": id, "kind": kind, "filename": filename, "mime": mime,
			"sizeBytes": size, "status": status, "reviewNote": note,
			"uploadedAt": httpx.JST(&at), "viewUrl": url,
		})
	}
	httpx.JSON(w, 200, map[string]any{"documents": out})
}

// POST /api/admin/shopbook/documents/{id}/review {status, note}
func sbAdminReviewDocument(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	_ = httpx.Body(r, &b)
	if b.Status != "accepted" && b.Status != "rejected" {
		httpx.Err(w, http.StatusBadRequest, "status must be accepted|rejected")
		return
	}
	if b.Status == "rejected" && strings.TrimSpace(b.Note) == "" {
		httpx.Err(w, http.StatusBadRequest, "a note is required when rejecting a document")
		return
	}
	tag, err := db.Pool.Exec(ctx, `
		UPDATE shopbook_document SET status=$2, review_note=$3, reviewed_at=NOW()
		 WHERE id=$1`, r.PathValue("id"), b.Status, strings.TrimSpace(b.Note))
	if err != nil || tag.RowsAffected() == 0 {
		httpx.Err(w, http.StatusNotFound, "Document not found")
		return
	}
	sbAdminLog(ctx, "shopbook.document_review", r.PathValue("id"), map[string]any{
		"status": b.Status, "note": b.Note,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// GET /api/admin/shopbook/location-requests?status=pending
func sbAdminLocationRequests(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT lr.id, lr.shop_id, s.name, lr.from_lat, lr.from_lng, lr.from_address,
		       lr.to_lat, lr.to_lng, lr.to_address, lr.distance_km, lr.reason,
		       lr.status, lr.review_note, lr.requested_at
		  FROM shopbook_location_request lr
		  JOIN shopbook_shop s ON s.id = lr.shop_id
		 WHERE ($1='all' OR lr.status=$1)
		 ORDER BY lr.requested_at DESC LIMIT 200`, status)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, shopID, shopName, fromAddr, toAddr, reason, st, note string
		var fromLat, fromLng *float64
		var toLat, toLng, dist float64
		var at time.Time
		if rows.Scan(&id, &shopID, &shopName, &fromLat, &fromLng, &fromAddr,
			&toLat, &toLng, &toAddr, &dist, &reason, &st, &note, &at) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "shopId": shopID, "shopName": shopName,
			"from":       map[string]any{"lat": fromLat, "lng": fromLng, "address": fromAddr},
			"to":         map[string]any{"lat": toLat, "lng": toLng, "address": toAddr},
			"distanceKm": dist, "reason": reason, "status": st,
			"reviewNote": note, "requestedAt": httpx.JST(&at),
		})
	}
	httpx.JSON(w, 200, map[string]any{"requests": out})
}

// POST /api/admin/shopbook/location-requests/{id}/decide {approve, note}
func sbAdminDecideLocation(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Approve bool   `json:"approve"`
		Note    string `json:"note"`
	}
	_ = httpx.Body(r, &b)
	if !b.Approve && strings.TrimSpace(b.Note) == "" {
		httpx.Err(w, http.StatusBadRequest, "a note is required when refusing a move")
		return
	}
	reqID := r.PathValue("id")

	var shopID, ownerID string
	var toLat, toLng float64
	var toAddr, status string
	if err := db.Pool.QueryRow(ctx, `
		SELECT lr.shop_id, lr.to_lat, lr.to_lng, lr.to_address, lr.status, s.owner_user_id
		  FROM shopbook_location_request lr
		  JOIN shopbook_shop s ON s.id = lr.shop_id
		 WHERE lr.id=$1`, reqID).
		Scan(&shopID, &toLat, &toLng, &toAddr, &status, &ownerID); err != nil {
		httpx.Err(w, http.StatusNotFound, "Request not found")
		return
	}
	if status != "pending" {
		httpx.Err(w, http.StatusConflict, "This request has already been decided")
		return
	}

	newStatus := "rejected"
	if b.Approve {
		newStatus = "approved"
		if _, err := db.Pool.Exec(ctx, `
			UPDATE shopbook_shop
			   SET lat=$2, lng=$3, address = CASE WHEN $4 <> '' THEN $4 ELSE address END,
			       updated_at=NOW()
			 WHERE id=$1`, shopID, toLat, toLng, toAddr); err != nil {
			httpx.Err(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	if _, err := db.Pool.Exec(ctx, `
		UPDATE shopbook_location_request
		   SET status=$2, review_note=$3, decided_at=NOW(), decided_by='admin'
		 WHERE id=$1`, reqID, newStatus, strings.TrimSpace(b.Note)); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbAdminLog(ctx, "shopbook.location_decide", reqID, map[string]any{
		"shopId": shopID, "approved": b.Approve, "note": b.Note,
	})
	if ownerID != "" {
		msg := "Your location change was approved"
		if !b.Approve {
			msg = "Your location change was not approved"
		}
		sbNotify(ctx, ownerID, msg, b.Note,
			map[string]any{"event": "location_decision", "approved": b.Approve})
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "status": newStatus})
}

// GET /api/admin/shopbook/subscriptions
func sbAdminSubscriptions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := db.Pool.Query(ctx, `
		SELECT s.id, s.name, s.plan,
		       COALESCE(e.plan,'free'), COALESCE(e.state,'—'), COALESCE(e.source,''),
		       COALESCE(e.reference,''), e.expires_at,
		       (SELECT COUNT(DISTINCT customer_user_id) FROM shopbook_order o WHERE o.shop_id=s.id),
		       (SELECT COUNT(*) FROM shopbook_product p WHERE p.shop_id=s.id)
		  FROM shopbook_shop s
		  LEFT JOIN shopbook_entitlement e ON e.shop_id = s.id
		 ORDER BY s.created_at DESC LIMIT 500`)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, displayPlan, plan, state, source, ref string
		var expires *time.Time
		var customers, products int
		if rows.Scan(&id, &name, &displayPlan, &plan, &state, &source, &ref,
			&expires, &customers, &products) != nil {
			continue
		}
		out = append(out, map[string]any{
			"shopId": id, "shopName": name,
			// displayPlan is the column the app shows; plan/state are what
			// actually gates features. Surfacing both makes a drift obvious.
			"displayPlan": displayPlan, "entitledPlan": plan, "state": state,
			"source": source, "reference": ref, "expiresAt": httpx.JST(expires),
			"customers": customers, "products": products,
		})
	}
	httpx.JSON(w, 200, map[string]any{"subscriptions": out})
}

// POST /api/admin/shopbook/shops/{id}/entitlement {plan, state, expiresAt, reference}
func sbAdminSetEntitlement(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID := r.PathValue("id")
	var b struct {
		Plan      string `json:"plan"`
		State     string `json:"state"`
		ExpiresAt string `json:"expiresAt"` // RFC3339 or empty for none
		Reference string `json:"reference"`
	}
	_ = httpx.Body(r, &b)
	if b.Plan != "free" && b.Plan != "pro" {
		httpx.Err(w, http.StatusBadRequest, "plan must be free|pro")
		return
	}
	if b.State == "" {
		b.State = "active"
	}
	switch b.State {
	case "trial", "active", "past_due", "grace_period", "expired", "cancelled":
	default:
		httpx.Err(w, http.StatusBadRequest,
			"state must be trial|active|past_due|grace_period|expired|cancelled")
		return
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO shopbook_entitlement (shop_id, plan, state, source, reference, expires_at)
		VALUES ($1,$2,$3,'admin',$4, NULLIF($5,'')::timestamptz)
		ON CONFLICT (shop_id) DO UPDATE SET
		  plan=$2, state=$3, source='admin', reference=$4,
		  expires_at=NULLIF($5,'')::timestamptz, updated_at=NOW()`,
		shopID, b.Plan, b.State, b.Reference, b.ExpiresAt); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	// Keep the display column in step so the owner's app does not claim a
	// plan the entitlement no longer backs.
	if _, err := db.Pool.Exec(ctx,
		`UPDATE shopbook_shop SET plan=$2, updated_at=NOW() WHERE id=$1`,
		shopID, sbPlanFromEntitlement(b.Plan, b.State, false)); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbAdminLog(ctx, "shopbook.entitlement", shopID, map[string]any{
		"plan": b.Plan, "state": b.State, "reference": b.Reference, "expiresAt": b.ExpiresAt,
	})
	httpx.JSON(w, 200, map[string]any{"ok": true, "plan": b.Plan, "state": b.State})
}

// GET /api/admin/shopbook/orders?status=&shopId=
func sbAdminOrders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := db.Pool.Query(ctx, `
		SELECT o.id, s.name, COALESCE(u.name,''), o.status,
		       `+sbCents("o.total")+`, s.currency, o.created_at,
		       COALESCE((SELECT SUM(`+sbCents("p.amount")+`) FROM shopbook_payment p
		                  WHERE p.order_id=o.id AND p.status='captured'),0)
		  FROM shopbook_order o
		  JOIN shopbook_shop s ON s.id=o.shop_id
		  LEFT JOIN users u ON u.id=o.customer_user_id
		 WHERE ($1='' OR o.status=$1) AND ($2='' OR o.shop_id::text=$2)
		 ORDER BY o.created_at DESC LIMIT 200`,
		r.URL.Query().Get("status"), r.URL.Query().Get("shopId"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, shop, cust, status, currency string
		var total, paid int64
		var at time.Time
		if rows.Scan(&id, &shop, &cust, &status, &total, &currency, &at, &paid) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "shopName": shop, "customerName": cust, "status": status,
			"total": money(total).Float(), "paid": money(paid).Float(),
			"currency": currency, "createdAt": httpx.JST(&at),
		})
	}
	httpx.JSON(w, 200, map[string]any{"orders": out})
}

// GET /api/admin/shopbook/returns
func sbAdminReturns(w http.ResponseWriter, r *http.Request) {
	out, err := sbReturnRows(r.Context(), `($1='' OR rt.status=$1)`, r.URL.Query().Get("status"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"returns": out})
}

// GET /api/admin/shopbook/audit?shopId= — the shop-scoped trail, for support.
func sbAdminShopAudit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := db.Pool.Query(ctx, `
		SELECT a.id, s.name, COALESCE(u.name,''), a.actor_role, a.action, a.entity,
		       a.entity_id, a.before, a.after, a.reason, a.created_at
		  FROM shopbook_audit a
		  JOIN shopbook_shop s ON s.id = a.shop_id
		  LEFT JOIN users u ON u.id = a.actor_user_id
		 WHERE ($1='' OR a.shop_id::text=$1)
		 ORDER BY a.id DESC LIMIT 300`, r.URL.Query().Get("shopId"))
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var shop, actor, role, action, entity, entityID, reason string
		var before, after []byte
		var at time.Time
		if rows.Scan(&id, &shop, &actor, &role, &action, &entity, &entityID,
			&before, &after, &reason, &at) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "shopName": shop, "actor": actor, "role": role,
			"action": action, "entity": entity, "entityId": entityID,
			"before": json.RawMessage(sbJSON(before)), "after": json.RawMessage(sbJSON(after)),
			"reason": reason, "at": httpx.JST(&at),
		})
	}
	httpx.JSON(w, 200, map[string]any{"entries": out})
}
