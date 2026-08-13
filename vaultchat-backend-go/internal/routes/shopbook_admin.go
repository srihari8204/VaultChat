// shopbook_admin.go — SHOP BOOK admin surface (openspec: shop-book-upgrade).
// Guarded by the existing x-admin-key `adminAuth` (constant-time compare +
// rate limit). Every mutation is recorded to shopbook_admin_log so the audit
// trail exists from day one.
package routes

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"vaultchat/backend-go/internal/db"
	"vaultchat/backend-go/internal/httpx"
)

func RegisterShopBookAdmin(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/shopbook/stats", adminAuth(sbAdminStats))
	mux.HandleFunc("GET /api/admin/shopbook/shops", adminAuth(sbAdminShops))
	mux.HandleFunc("POST /api/admin/shopbook/shops/{id}/approve", adminAuth(sbAdminApproveShop))
	mux.HandleFunc("GET /api/admin/shopbook/countries", adminAuth(sbAdminCountries))
	mux.HandleFunc("POST /api/admin/shopbook/countries", adminAuth(sbAdminSaveCountry))
	mux.HandleFunc("GET /api/admin/shopbook/categories", adminAuth(sbAdminCategories))
	mux.HandleFunc("POST /api/admin/shopbook/categories", adminAuth(sbAdminSaveCategory))
}

func sbAdminLog(ctx context.Context, action, target string, detail map[string]any) {
	dj, _ := json.Marshal(detail)
	// An audit trail that fails quietly is worse than none — it reads as "no
	// admin ever did anything". Log the failure so the gap is visible.
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO shopbook_admin_log (action, target, detail) VALUES ($1,$2,$3)`,
		action, target, sbJSON(dj)); err != nil {
		log.Printf("[shopbook-admin] audit log insert failed (action=%s target=%s): %v", action, target, err)
	}
}

// Platform stats: shops by approval, orders, GMV, customers.
func sbAdminStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var shops, pending, orders, customers int
	var gmv float64
	_ = db.Pool.QueryRow(ctx, `SELECT COUNT(*), COUNT(*) FILTER (WHERE NOT approved) FROM shopbook_shop`).Scan(&shops, &pending)
	_ = db.Pool.QueryRow(ctx, `SELECT COUNT(*), COALESCE(SUM(total) FILTER (WHERE status='completed'),0) FROM shopbook_order`).Scan(&orders, &gmv)
	_ = db.Pool.QueryRow(ctx, `SELECT COUNT(DISTINCT customer_user_id) FROM shopbook_order`).Scan(&customers)
	httpx.JSON(w, 200, map[string]any{
		"shops": shops, "pendingApproval": pending,
		"orders": orders, "gmv": gmv, "customers": customers,
	})
}

// GET /api/admin/shopbook/shops?filter=pending|all
func sbAdminShops(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	where := ""
	if r.URL.Query().Get("filter") == "pending" {
		where = ` WHERE NOT s.approved`
	}
	rows, err := db.Pool.Query(ctx, `
		SELECT s.id, s.name, s.category, s.address, s.phone, s.country, s.approved, s.verified,
		       s.created_at, COALESCE(u.name,''), COALESCE(u.phone,'')
		  FROM shopbook_shop s LEFT JOIN users u ON u.id=s.owner_user_id`+where+`
		 ORDER BY s.created_at DESC LIMIT 200`)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, category, address, phone, country, ownerName, ownerPhone string
		var approved, verified bool
		var created time.Time
		if rows.Scan(&id, &name, &category, &address, &phone, &country, &approved, &verified,
			&created, &ownerName, &ownerPhone) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "category": category, "address": address,
			"phone": phone, "country": country, "approved": approved, "verified": verified,
			"createdAt": httpx.JST(&created), "ownerName": ownerName, "ownerPhone": ownerPhone,
		})
	}
	httpx.JSON(w, 200, map[string]any{"shops": out})
}

// POST /api/admin/shopbook/shops/{id}/approve {approved, verified, reason}
// Rejection (approved=false with a reason) notifies the owner so they can
// correct and resubmit (spec: admin-portal / reject with reason).
func sbAdminApproveShop(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shopID := r.PathValue("id")
	var b struct {
		Approved bool   `json:"approved"`
		Verified bool   `json:"verified"`
		Reason   string `json:"reason"`
	}
	if err := httpx.Body(r, &b); err != nil {
		httpx.Err(w, http.StatusBadRequest, "body required")
		return
	}
	if !b.Approved && strings.TrimSpace(b.Reason) == "" {
		httpx.Err(w, http.StatusBadRequest, "rejection reason required")
		return
	}
	var ownerID, shopName string
	err := db.Pool.QueryRow(ctx, `
		UPDATE shopbook_shop SET approved=$1, verified=$2, updated_at=NOW()
		 WHERE id=$3 RETURNING owner_user_id, name`,
		b.Approved, b.Verified, shopID).Scan(&ownerID, &shopName)
	if db.NoRows(err) {
		httpx.Err(w, http.StatusNotFound, "Shop not found")
		return
	}
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbAdminLog(ctx, "shop_approve", shopID, map[string]any{
		"approved": b.Approved, "verified": b.Verified, "reason": b.Reason, "shop": shopName,
	})
	if ownerID != "" {
		if b.Approved {
			sbNotify(ctx, ownerID, "Shop approved 🎉",
				shopName+" is now visible to customers",
				map[string]any{"event": "shop_approved"})
		} else {
			sbNotify(ctx, ownerID, "Shop registration rejected",
				b.Reason+" — update your details and resubmit",
				map[string]any{"event": "shop_rejected"})
		}
	}
	httpx.JSON(w, 200, map[string]any{"ok": true, "approved": b.Approved, "verified": b.Verified})
}

// Countries — the tax engine's admin editor. Upserts by code.
func sbAdminCountries(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Pool.Query(r.Context(), `
		SELECT code, name, currency_symbol, currency_code, tax_type, tax_split,
		       tax_fields, documents, date_format, sort, enabled
		  FROM shopbook_country ORDER BY sort, name`)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var code, name, sym, cc, taxType, dateFormat string
		var split, fields, docs []byte
		var sortN int
		var enabled bool
		if rows.Scan(&code, &name, &sym, &cc, &taxType, &split, &fields, &docs,
			&dateFormat, &sortN, &enabled) != nil {
			continue
		}
		out = append(out, map[string]any{
			"code": code, "name": name, "currencySymbol": sym, "currencyCode": cc,
			"taxType": taxType, "taxSplit": json.RawMessage(split),
			"taxFields": json.RawMessage(fields), "documents": json.RawMessage(docs),
			"dateFormat": dateFormat, "sort": sortN, "enabled": enabled,
		})
	}
	httpx.JSON(w, 200, map[string]any{"countries": out})
}

func sbAdminSaveCountry(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Code           string          `json:"code"`
		Name           string          `json:"name"`
		CurrencySymbol string          `json:"currencySymbol"`
		CurrencyCode   string          `json:"currencyCode"`
		TaxType        string          `json:"taxType"`
		TaxSplit       json.RawMessage `json:"taxSplit"`
		TaxFields      json.RawMessage `json:"taxFields"`
		Documents      json.RawMessage `json:"documents"`
		DateFormat     string          `json:"dateFormat"`
		Sort           int             `json:"sort"`
		Enabled        *bool           `json:"enabled"`
	}
	if err := httpx.Body(r, &b); err != nil || len(b.Code) != 2 || b.Name == "" || b.CurrencySymbol == "" {
		httpx.Err(w, http.StatusBadRequest, "code (2 letters), name and currencySymbol required")
		return
	}
	b.Code = strings.ToUpper(b.Code)
	if b.DateFormat == "" {
		b.DateFormat = "DD/MM/YYYY"
	}
	if len(b.TaxSplit) == 0 {
		b.TaxSplit = json.RawMessage(`[]`)
	}
	if len(b.TaxFields) == 0 {
		b.TaxFields = json.RawMessage(`[]`)
	}
	if len(b.Documents) == 0 {
		b.Documents = json.RawMessage(`[]`)
	}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO shopbook_country
		  (code, name, currency_symbol, currency_code, tax_type, tax_split, tax_fields,
		   documents, date_format, sort, enabled, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
		ON CONFLICT (code) DO UPDATE SET
		  name=$2, currency_symbol=$3, currency_code=$4, tax_type=$5, tax_split=$6,
		  tax_fields=$7, documents=$8, date_format=$9, sort=$10, enabled=$11, updated_at=NOW()`,
		b.Code, b.Name, b.CurrencySymbol, b.CurrencyCode, b.TaxType,
		sbJSON(b.TaxSplit), sbJSON(b.TaxFields), sbJSON(b.Documents), b.DateFormat, b.Sort, enabled)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	sbAdminLog(ctx, "country_save", b.Code, map[string]any{"name": b.Name, "taxType": b.TaxType})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// Categories + starter catalogs — admin editor. Saving a category replaces
// its starter items when `items` is provided.
func sbAdminCategories(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := db.Pool.Query(ctx,
		`SELECT id, label, icon, sort, enabled FROM shopbook_category ORDER BY sort, label`)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()
	cats := []map[string]any{}
	for rows.Next() {
		var id, label, icon string
		var sortN int
		var enabled bool
		if rows.Scan(&id, &label, &icon, &sortN, &enabled) != nil {
			continue
		}
		cats = append(cats, map[string]any{
			"id": id, "label": label, "icon": icon, "sort": sortN, "enabled": enabled,
			"items": []map[string]any{},
		})
	}
	rows.Close()
	irows, err := db.Pool.Query(ctx,
		`SELECT category_id, name, unit FROM shopbook_starter_item ORDER BY sort, name`)
	if err == nil {
		defer irows.Close()
		byCat := map[string][]map[string]any{}
		for irows.Next() {
			var cat, name, unit string
			if irows.Scan(&cat, &name, &unit) == nil {
				byCat[cat] = append(byCat[cat], map[string]any{"name": name, "unit": unit})
			}
		}
		for _, c := range cats {
			if items, okI := byCat[c["id"].(string)]; okI {
				c["items"] = items
			}
		}
	}
	httpx.JSON(w, 200, map[string]any{"categories": cats})
}

func sbAdminSaveCategory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		ID      string `json:"id"`
		Label   string `json:"label"`
		Icon    string `json:"icon"`
		Sort    int    `json:"sort"`
		Enabled *bool  `json:"enabled"`
		Items   []struct {
			Name string `json:"name"`
			Unit string `json:"unit"`
		} `json:"items"`
	}
	if err := httpx.Body(r, &b); err != nil || b.ID == "" || b.Label == "" {
		httpx.Err(w, http.StatusBadRequest, "id and label required")
		return
	}
	if b.Icon == "" {
		b.Icon = "🏬"
	}
	enabled := true
	if b.Enabled != nil {
		enabled = *b.Enabled
	}
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO shopbook_category (id, label, icon, sort, enabled)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (id) DO UPDATE SET label=$2, icon=$3, sort=$4, enabled=$5`,
		b.ID, b.Label, b.Icon, b.Sort, enabled)
	if err != nil {
		httpx.Err(w, http.StatusInternalServerError, "db error")
		return
	}
	if b.Items != nil {
		if _, err := db.Pool.Exec(ctx,
			`DELETE FROM shopbook_starter_item WHERE category_id=$1`, b.ID); err == nil {
			for i, it := range b.Items {
				if strings.TrimSpace(it.Name) == "" {
					continue
				}
				_, _ = db.Pool.Exec(ctx, `
					INSERT INTO shopbook_starter_item (category_id, name, unit, sort)
					VALUES ($1,$2,$3,$4) ON CONFLICT (category_id, name) DO UPDATE SET unit=$3, sort=$4`,
					b.ID, it.Name, it.Unit, i+1)
			}
		}
	}
	sbAdminLog(ctx, "category_save", b.ID, map[string]any{"label": b.Label, "items": len(b.Items)})
	httpx.JSON(w, 200, map[string]any{"ok": true})
}
