// shopbook_verify.go — SHOP BOOK verification, documents and controlled
// location changes (P1-D).
//
// Two rules shape this file.
//
// DOCUMENTS ARE NEVER SERVED BY THIS API. A shop licence or tax certificate is
// a private business record; it goes to object storage directly from the
// device via a presigned PUT, and comes back only through a short-lived
// presigned GET issued to someone who has just been checked. The object key is
// an identifier, not an authorisation — anyone holding one still gets nothing
// without passing the ownership check below.
//
// A VERIFIED SHOP'S LOCATION IS PINNED. Customers walk to those coordinates.
// Once a badge has been granted on the strength of an address, moving the pin
// silently is how a verified listing ends up pointing at a different building.
// The owner may still move — they ask, and an admin compares the two positions.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
	"vaultchat/backend-go/internal/storage"
)

func RegisterShopBookVerify(mux *http.ServeMux) {
	mux.HandleFunc("GET /shopbook/my-shop/documents", httpx.RequireAuth(sbListDocuments))
	mux.HandleFunc("POST /shopbook/my-shop/documents/presign", httpx.RequireAuth(sbPresignDocument))
	mux.HandleFunc("POST /shopbook/my-shop/documents", httpx.RequireAuth(sbSaveDocument))
	mux.HandleFunc("DELETE /shopbook/my-shop/documents/{id}", httpx.RequireAuth(sbDeleteDocument))
	mux.HandleFunc("GET /shopbook/my-shop/documents/{id}/url", httpx.RequireAuth(sbDocumentURL))
	mux.HandleFunc("POST /shopbook/my-shop/submit-verification", httpx.RequireAuth(sbSubmitVerification))
	mux.HandleFunc("POST /shopbook/my-shop/location-request", httpx.RequireAuth(sbRequestLocationChange))
	mux.HandleFunc("GET /shopbook/my-shop/location-request", httpx.RequireAuth(sbMyLocationRequest))
}

// How far a shop may drift without asking. A few hundred metres is a corrected
// GPS fix or a unit number; a kilometre is a different neighbourhood.
const sbLocationDriftKm = 0.3

// Documents live under a per-shop prefix so a shop's records can be deleted
// wholesale with DeletePrefix when its account is.
func sbDocKey(shopID, kind string) string {
	return fmt.Sprintf("shopbook/%s/docs/%s-%d", shopID, sanitizeDocKind(kind), time.Now().UnixNano())
}

func sanitizeDocKind(kind string) string {
	out := make([]rune, 0, len(kind))
	for _, r := range strings.ToLower(kind) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out = append(out, r)
		case r == ' ', r == '-', r == '_', r == '/':
			out = append(out, '-')
		}
	}
	if len(out) == 0 {
		return "doc"
	}
	if len(out) > 40 {
		out = out[:40]
	}
	return string(out)
}

// Only formats an admin can actually review. An arbitrary upload endpoint
// attached to a shop account is a file-hosting service waiting to happen.
var sbDocMimes = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/webp": true, "application/pdf": true,
}

const sbDocMaxBytes = 10 << 20 // 10 MB

// POST /shopbook/my-shop/documents/presign — device uploads straight to store.
func sbPresignDocument(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	if !storage.Enabled() {
		httpx.Err(w, http.StatusServiceUnavailable, "Document storage is not configured")
		return
	}
	var b struct {
		Kind string `json:"kind"`
		Mime string `json:"mime"`
		Size int64  `json:"size"`
	}
	if err := httpx.Body(r, &b); err != nil || strings.TrimSpace(b.Kind) == "" {
		httpx.Err(w, http.StatusBadRequest, "kind required")
		return
	}
	if !sbDocMimes[b.Mime] {
		httpx.Err(w, http.StatusBadRequest, "Documents must be a JPEG, PNG, WebP or PDF")
		return
	}
	if b.Size > sbDocMaxBytes {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "Documents must be 10 MB or smaller")
		return
	}
	key := sbDocKey(shopID, b.Kind)
	url, err := storage.PresignPut(ctx, key, b.Mime, 15*time.Minute)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "could not prepare the upload")
		return
	}
	httpx.JSON(w, 200, map[string]any{"uploadUrl": url, "objectKey": key, "expiresIn": 900})
}

// POST /shopbook/my-shop/documents — record what was uploaded.
func sbSaveDocument(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var b struct {
		Kind      string `json:"kind"`
		ObjectKey string `json:"objectKey"`
		Filename  string `json:"filename"`
		Mime      string `json:"mime"`
		Size      int64  `json:"size"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Kind == "" || b.ObjectKey == "" {
		httpx.Err(w, http.StatusBadRequest, "kind and objectKey required")
		return
	}
	// The key must be one WE minted for THIS shop. Without this a shop could
	// claim any object in the bucket as its own document.
	if !strings.HasPrefix(b.ObjectKey, "shopbook/"+shopID+"/docs/") {
		httpx.Err(w, http.StatusForbidden, "That object does not belong to your shop")
		return
	}
	if !storage.ObjectExists(ctx, b.ObjectKey) {
		httpx.Err(w, http.StatusBadRequest, "The upload did not complete — try again")
		return
	}

	var id string
	err := db.WithUser(ctx, user.ID, func(tx pgx.Tx) error {
		// Replacing a document supersedes the previous one rather than piling
		// up copies for an admin to sift through.
		var oldKey string
		_ = tx.QueryRow(ctx,
			`SELECT object_key FROM shopbook_document
			  WHERE shop_id=$1 AND kind=$2 AND status <> 'rejected'`, shopID, b.Kind).Scan(&oldKey)
		if _, err := tx.Exec(ctx,
			`DELETE FROM shopbook_document WHERE shop_id=$1 AND kind=$2 AND status <> 'rejected'`,
			shopID, b.Kind); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO shopbook_document
			  (shop_id, kind, object_key, filename, mime, size_bytes, uploaded_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
			shopID, b.Kind, b.ObjectKey, b.Filename, b.Mime, b.Size, user.ID).Scan(&id); err != nil {
			return err
		}
		if oldKey != "" && oldKey != b.ObjectKey {
			storage.DeleteObject(ctx, oldKey)
		}
		sbAudit(ctx, tx, sbAuditEntry{
			ShopID: shopID, Actor: user.ID, Action: "document.upload",
			Entity: "document", EntityID: id,
			After: map[string]any{"kind": b.Kind, "filename": b.Filename},
			IP:    sbClientIP(r),
		})
		return nil
	})
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "could not save the document")
		return
	}
	httpx.JSON(w, 201, map[string]any{"id": id, "status": "pending"})
}

// GET /shopbook/my-shop/documents
func sbListDocuments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT id, kind, filename, mime, size_bytes, status, review_note, uploaded_at
		  FROM shopbook_document WHERE shop_id=$1 ORDER BY uploaded_at DESC`, shopID)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, kind, filename, mime, status, note string
		var size int64
		var at time.Time
		if rows.Scan(&id, &kind, &filename, &mime, &size, &status, &note, &at) != nil {
			continue
		}
		// The object key is deliberately absent. Downloading goes through
		// /documents/{id}/url, which re-checks ownership every time.
		out = append(out, map[string]any{
			"id": id, "kind": kind, "filename": filename, "mime": mime,
			"sizeBytes": size, "status": status, "reviewNote": note,
			"uploadedAt": httpx.JST(&at),
		})
	}

	// What this country asks for, so the client can show the checklist without
	// hardcoding any country's paperwork.
	var country string
	_ = db.Pool.QueryRow(ctx, `SELECT country FROM shopbook_shop WHERE id=$1`, shopID).Scan(&country)
	required := json.RawMessage("[]")
	if cc, okC := sbLoadCountry(ctx, country); okC {
		required = cc.Documents
	}
	var state, note string
	_ = db.Pool.QueryRow(ctx,
		`SELECT verify_state, verify_note FROM shopbook_shop WHERE id=$1`, shopID).Scan(&state, &note)
	httpx.JSON(w, 200, map[string]any{
		"documents": out, "accepted": required,
		"verifyState": state, "verifyNote": note,
	})
}

// GET /shopbook/my-shop/documents/{id}/url — a short-lived read link.
func sbDocumentURL(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var key string
	if err := db.Pool.QueryRow(ctx,
		`SELECT object_key FROM shopbook_document WHERE id=$1 AND shop_id=$2`,
		r.PathValue("id"), shopID).Scan(&key); err != nil {
		httpx.Err(w, http.StatusNotFound, "Document not found for your shop")
		return
	}
	// Five minutes: long enough to open, short enough that a leaked link is
	// not a standing grant.
	url, err := storage.PresignGet(ctx, key, 5*time.Minute)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "could not prepare the link")
		return
	}
	httpx.JSON(w, 200, map[string]any{"url": url, "expiresIn": 300})
}

func sbDeleteDocument(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var key, status string
	if err := db.Pool.QueryRow(ctx,
		`SELECT object_key, status FROM shopbook_document WHERE id=$1 AND shop_id=$2`,
		r.PathValue("id"), shopID).Scan(&key, &status); err != nil {
		httpx.Err(w, http.StatusNotFound, "Document not found for your shop")
		return
	}
	// An accepted document is evidence the badge was granted on. Withdrawing
	// it is a verification matter, not a delete button.
	if status == "accepted" {
		httpx.Err(w, http.StatusConflict,
			"This document was accepted during verification — contact support to replace it")
		return
	}
	if _, err := db.Pool.Exec(ctx,
		`DELETE FROM shopbook_document WHERE id=$1 AND shop_id=$2`,
		r.PathValue("id"), shopID); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	storage.DeleteObject(ctx, key)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// POST /shopbook/my-shop/submit-verification — owner asks to be reviewed.
func sbSubmitVerification(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var state, name, address, frontPhoto string
	var lat, lng *float64
	if err := db.Pool.QueryRow(ctx, `
		SELECT verify_state, name, address, front_photo_key, lat, lng
		  FROM shopbook_shop WHERE id=$1`, shopID).
		Scan(&state, &name, &address, &frontPhoto, &lat, &lng); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	switch state {
	case "verified":
		httpx.Err(w, http.StatusConflict, "This shop is already verified")
		return
	case "pending_review":
		httpx.Err(w, http.StatusConflict, "Your verification is already being reviewed")
		return
	case "suspended":
		httpx.Err(w, http.StatusForbidden, "This shop is suspended — contact support")
		return
	}

	// The minimum an admin needs to make a decision at all. Listing what is
	// missing beats a flat refusal the owner has to guess their way out of.
	missing := []string{}
	if strings.TrimSpace(address) == "" {
		missing = append(missing, "shop address")
	}
	if lat == nil || lng == nil {
		missing = append(missing, "GPS location")
	}
	if frontPhoto == "" {
		missing = append(missing, "shop-front photo")
	}
	if len(missing) > 0 {
		httpx.Err(w, http.StatusBadRequest,
			"Add your "+strings.Join(missing, ", ")+" before submitting for verification",
			map[string]any{"code": "incomplete", "missing": missing})
		return
	}

	if _, err := db.Pool.Exec(ctx,
		`UPDATE shopbook_shop SET verify_state='pending_review', verify_note='', updated_at=NOW()
		  WHERE id=$1`, shopID); err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbAudit(ctx, db.Pool, sbAuditEntry{
		ShopID: shopID, Actor: user.ID, Action: "verification.submit",
		Entity: "shop", EntityID: shopID,
		Before: map[string]any{"verifyState": state},
		After:  map[string]any{"verifyState": "pending_review"},
		IP:     sbClientIP(r),
	})
	httpx.JSON(w, 200, map[string]any{"ok": true, "verifyState": "pending_review"})
}

// ── controlled location change ────────────────────────────────────

// sbLocationGate decides what happens to a location edit on shop upsert.
// Returns ("", true) to let it through, or a message and false to refuse.
func sbLocationGate(ctx context.Context, shopID string, newLat, newLng *float64) (string, bool) {
	if newLat == nil || newLng == nil {
		return "", true // not moving
	}
	var locked bool
	var curLat, curLng *float64
	if err := db.Pool.QueryRow(ctx,
		`SELECT location_locked, lat, lng FROM shopbook_shop WHERE id=$1`, shopID).
		Scan(&locked, &curLat, &curLng); err != nil {
		return "", true // unknown shop: the upsert itself will fail
	}
	if !locked || curLat == nil || curLng == nil {
		return "", true
	}
	drift := haversineKm(*curLat, *curLng, *newLat, *newLng)
	if drift <= sbLocationDriftKm {
		return "", true // a corrected GPS fix, not a move
	}
	return fmt.Sprintf(
		"Your shop is verified at its current address. Moving it %.1f km needs approval — "+
			"submit a location change request.", drift), false
}

// POST /shopbook/my-shop/location-request
func sbRequestLocationChange(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	user := httpx.UserFrom(r)
	shopID, ok := ownerShopID(ctx, w, user.ID)
	if !ok {
		return
	}
	var b struct {
		Lat     *float64 `json:"lat"`
		Lng     *float64 `json:"lng"`
		Address string   `json:"address"`
		Reason  string   `json:"reason"`
	}
	if err := httpx.Body(r, &b); err != nil || b.Lat == nil || b.Lng == nil {
		httpx.Err(w, http.StatusBadRequest, "lat and lng required")
		return
	}
	if *b.Lat < -90 || *b.Lat > 90 || *b.Lng < -180 || *b.Lng > 180 {
		httpx.Err(w, http.StatusBadRequest, "That is not a valid coordinate")
		return
	}
	if strings.TrimSpace(b.Reason) == "" {
		httpx.Err(w, http.StatusBadRequest, "a reason is required")
		return
	}
	var curLat, curLng *float64
	var curAddr string
	_ = db.Pool.QueryRow(ctx, `SELECT lat, lng, address FROM shopbook_shop WHERE id=$1`, shopID).
		Scan(&curLat, &curLng, &curAddr)
	drift := 0.0
	if curLat != nil && curLng != nil {
		drift = math.Round(haversineKm(*curLat, *curLng, *b.Lat, *b.Lng)*100) / 100
	}

	var id string
	err := db.Pool.QueryRow(ctx, `
		INSERT INTO shopbook_location_request
		  (shop_id, from_lat, from_lng, from_address, to_lat, to_lng, to_address,
		   distance_km, reason, requested_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
		shopID, curLat, curLng, curAddr, *b.Lat, *b.Lng, b.Address,
		drift, strings.TrimSpace(b.Reason), user.ID).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "idx_shopbook_location_request_one_open") {
			httpx.Err(w, http.StatusConflict, "You already have a location change awaiting review")
			return
		}
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbAudit(ctx, db.Pool, sbAuditEntry{
		ShopID: shopID, Actor: user.ID, Action: "location.request",
		Entity: "shop", EntityID: shopID,
		Before: map[string]any{"lat": curLat, "lng": curLng, "address": curAddr},
		After:  map[string]any{"lat": *b.Lat, "lng": *b.Lng, "address": b.Address},
		Reason: b.Reason, IP: sbClientIP(r),
	})
	httpx.JSON(w, 201, map[string]any{"id": id, "status": "pending", "distanceKm": drift})
}

// GET /shopbook/my-shop/location-request — the owner's latest.
func sbMyLocationRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID, ok := ownerShopID(ctx, w, httpx.UserFrom(r).ID)
	if !ok {
		return
	}
	var id, status, note, addr, reason string
	var lat, lng, dist float64
	var at time.Time
	err := db.Pool.QueryRow(ctx, `
		SELECT id, status, review_note, to_address, reason, to_lat, to_lng, distance_km, requested_at
		  FROM shopbook_location_request WHERE shop_id=$1
		 ORDER BY requested_at DESC LIMIT 1`, shopID).
		Scan(&id, &status, &note, &addr, &reason, &lat, &lng, &dist, &at)
	if db.NoRows(err) {
		httpx.JSON(w, 200, map[string]any{"request": nil})
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"request": map[string]any{
		"id": id, "status": status, "reviewNote": note, "address": addr,
		"reason": reason, "lat": lat, "lng": lng, "distanceKm": dist,
		"requestedAt": httpx.JST(&at),
	}})
}
