// shopbook_reject_note_test.go — the owner's note on an "other" rejection, and
// the admin returns window's shop filter.
//
// Reuses the 5b00-marked FLOWTEST fixture from shopbook_flows_test.go, so the
// same cleanup provably removes everything. Needs migration 140.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run 'TestSBRejectNote|TestSBAdminReturns' -v
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	rnOrderA  = "5b000000-0000-4000-8000-00000000d001"
	rnOrderB  = "5b000000-0000-4000-8000-00000000d002"
	rnShop2   = "5b000000-0000-4000-8000-00000000b002"
	rnOwner2  = "5b000000-0000-4000-8000-00000000a003"
	rnOrder2  = "5b000000-0000-4000-8000-00000000d003"
	rnReturn1 = "5b000000-0000-4000-8000-00000000e001"
	rnReturn2 = "5b000000-0000-4000-8000-00000000e002"
)

func rnCleanup(t *testing.T) {
	ctx := context.Background() // t.Context() is already cancelled when Cleanup runs
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM shopbook_return WHERE shop_id::text LIKE '%s'`, fMarker))
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM shopbook_admin_log WHERE target LIKE '%s'`, fMarker))
	sbFlowCleanup(ctx)
}

func TestSBRejectNote(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { rnCleanup(t) })
	for _, id := range []string{rnOrderA, rnOrderB} {
		if err := adminExec(ctx, fmt.Sprintf(
			`INSERT INTO shopbook_order (id, shop_id, customer_user_id, status) VALUES ('%s','%s','%s','pending')`,
			id, fShop, fCustomer)); err != nil {
			t.Fatalf("seed order: %v", err)
		}
	}
	mux := sbFlowMux()
	path := "/shopbook/my-shop/orders/" + rnOrderA + "/status"

	// A note with any reason but "other" is refused, not silently dropped.
	code, out := call(t, mux, fOwner, "POST", path, `{"status":"rejected","reason":"out_of_stock","note":"x"}`)
	if code != 400 || out["code"] != "note_not_allowed" {
		t.Fatalf("note with out_of_stock: %d %v, want 400 note_not_allowed", code, out)
	}
	// Over the limit (counted in characters, not bytes).
	long, _ := json.Marshal(strings.Repeat("é", sbRejectNoteMax+1))
	code, out = call(t, mux, fOwner, "POST", path, `{"status":"rejected","reason":"other","note":`+string(long)+`}`)
	if code != 400 || out["code"] != "note_too_long" {
		t.Fatalf("long note: %d %v, want 400 note_too_long", code, out)
	}
	// Exactly at the limit is fine; whitespace is trimmed.
	note := strings.Repeat("é", sbRejectNoteMax-10) + " we moved"
	noteJSON, _ := json.Marshal("  " + note + "  ")
	code, out = call(t, mux, fOwner, "POST", path, `{"status":"rejected","reason":"other","note":`+string(noteJSON)+`}`)
	if code != 200 || out["status"] != "rejected" {
		t.Fatalf("reject other+note: %d %v", code, out)
	}

	// The customer sees it in the order view.
	code, out = call(t, mux, fCustomer, "GET", "/shopbook/orders/"+rnOrderA, "")
	if code != 200 {
		t.Fatalf("order view: %d %v", code, out)
	}
	if out["rejectReason"] != "other" || out["rejectNote"] != note {
		t.Errorf("order view rejectReason=%v rejectNote=%q, want other / %q", out["rejectReason"], out["rejectNote"], note)
	}

	// No note stays valid and reads back as "".
	code, out = call(t, mux, fOwner, "POST", "/shopbook/my-shop/orders/"+rnOrderB+"/status",
		`{"status":"rejected","reason":"other"}`)
	if code != 200 {
		t.Fatalf("reject other without note: %d %v", code, out)
	}
	_, out = call(t, mux, fCustomer, "GET", "/shopbook/orders/"+rnOrderB, "")
	if out["rejectNote"] != "" {
		t.Errorf("rejectNote without a note = %v, want \"\"", out["rejectNote"])
	}
}

func TestSBAdminReturnsShopFilter(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { rnCleanup(t) })
	t.Setenv("ADMIN_KEY", "zbe-admin-test-key")
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES ('%s','flowowner2@t.test','Flow Owner 2')`, rnOwner2),
		fmt.Sprintf(`INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
		 VALUES ('%s','%s','FLOWTEST Store 2','grocery','Pangidi','+915b00000002',TRUE)`, rnShop2, rnOwner2),
		fmt.Sprintf(`INSERT INTO shopbook_order (id, shop_id, customer_user_id, status) VALUES
		 ('%s','%s','%s','completed'), ('%s','%s','%s','completed')`,
			rnOrderA, fShop, fCustomer, rnOrder2, rnShop2, fCustomer),
		fmt.Sprintf(`INSERT INTO shopbook_return (id, shop_id, order_id, customer_user_id) VALUES
		 ('%s','%s','%s','%s'), ('%s','%s','%s','%s')`,
			rnReturn1, fShop, rnOrderA, fCustomer, rnReturn2, rnShop2, rnOrder2, fCustomer),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	mux := http.NewServeMux()
	RegisterShopBookAdmin2(mux)
	get := func(query string) []map[string]any {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/admin/shopbook/returns"+query, nil)
		req.Header.Set("x-admin-key", "zbe-admin-test-key")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("GET %s: %d %s", query, rec.Code, rec.Body.String())
		}
		var out struct {
			Returns []map[string]any `json:"returns"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		mine := []map[string]any{} // the scratch DB may hold other rows; look at ours
		for _, r := range out.Returns {
			if id, _ := r["id"].(string); strings.HasPrefix(id, "5b000000-") {
				mine = append(mine, r)
			}
		}
		return mine
	}

	if rows := get(""); len(rows) != 2 {
		t.Fatalf("unfiltered: %d marked rows, want 2", len(rows))
	}
	rows := get("?shopId=" + rnShop2)
	if len(rows) != 1 || rows[0]["id"] != rnReturn2 || rows[0]["shopId"] != rnShop2 {
		t.Fatalf("?shopId=shop2: %v, want only %s with shopId %s", rows, rnReturn2, rnShop2)
	}
	if rows := get("?shopId=" + fShop + "&status=rejected"); len(rows) != 0 {
		t.Fatalf("shopId+status filter: %v, want none", rows)
	}
}

// "Request Pro" records a request and grants nothing; an admin decision clears it.
func TestSBRequestPro(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { rnCleanup(t) })
	t.Setenv("ADMIN_KEY", "zbe-admin-test-key")
	mux := sbFlowMux()
	RegisterShopBookAdmin2(mux)

	code, first := call(t, mux, fOwner, "POST", "/shopbook/my-shop/plan/request-pro", "")
	if code != 200 || first["ok"] != true || first["requestedAt"] == nil {
		t.Fatalf("request: %d %v", code, first)
	}
	_, again := call(t, mux, fOwner, "POST", "/shopbook/my-shop/plan/request-pro", "")
	if again["requestedAt"] != first["requestedAt"] {
		t.Errorf("repeat request moved the time: %v -> %v", first["requestedAt"], again["requestedAt"])
	}
	var plan string
	var entitled int
	_ = adminQueryRow(ctx, fmt.Sprintf(`SELECT plan, (SELECT COUNT(*) FROM shopbook_entitlement
	  WHERE shop_id = s.id AND plan = 'pro') FROM shopbook_shop s WHERE id = '%s'`, fShop), &plan, &entitled)
	if plan != "free" || entitled != 0 {
		t.Fatalf("request granted something: plan=%s pro entitlements=%d", plan, entitled)
	}
	// A customer (no shop) cannot request.
	if code, _ = call(t, mux, fCustomer, "POST", "/shopbook/my-shop/plan/request-pro", ""); code == 200 {
		t.Errorf("non-owner request: %d, want refusal", code)
	}

	admin := func(method, path, body string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("x-admin-key", "zbe-admin-test-key")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		if rec.Code != 200 {
			t.Fatalf("%s %s: %d %v", method, path, rec.Code, out)
		}
		return out
	}
	subFor := func() map[string]any {
		for _, s := range admin("GET", "/api/admin/shopbook/subscriptions", "")["subscriptions"].([]any) {
			if m := s.(map[string]any); m["shopId"] == fShop {
				return m
			}
		}
		t.Fatal("fixture shop missing from subscriptions")
		return nil
	}
	if s := subFor(); s["proRequestedAt"] != first["requestedAt"] {
		t.Errorf("admin sees proRequestedAt=%v, want %v", s["proRequestedAt"], first["requestedAt"])
	}
	admin("POST", "/api/admin/shopbook/shops/"+fShop+"/entitlement", `{"plan":"pro","state":"active"}`)
	if s := subFor(); s["proRequestedAt"] != nil || s["entitledPlan"] != "pro" {
		t.Errorf("after grant: %v, want proRequestedAt cleared and pro entitled", s)
	}
}
