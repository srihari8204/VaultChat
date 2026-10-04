// shopbook_r4_test.go — round-4 Shop Book handoffs: GET /shopbook/my-shop
// carries the owner's entitledPlan and pending proRequestedAt, and the
// customer's return-decision notifications carry the orderId.
//
// Reuses the 5b00 FLOWTEST fixture (shopbook_flows_test.go). Needs migration 141.
//
//	CALL_TEST_DB=1 DB_* JWT_SECRET=... CALL_TEST_ADMIN_DSN=... \
//	go test ./internal/routes/ -run TestSBR4 -v
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"vaultchat/backend-go/internal/db"
)

func TestSBR4MyShopAccount(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { rnCleanup(t) })
	mux := sbFlowMux()

	code, out := call(t, mux, fOwner, "GET", "/shopbook/my-shop", "")
	if code != 200 || out["shop"] == nil || out["entitledPlan"] != "free" {
		t.Fatalf("fresh shop: %d %v", code, out)
	}
	if v, present := out["proRequestedAt"]; !present || v != nil {
		t.Fatalf("proRequestedAt should be present and null: %v", out)
	}
	_, req := call(t, mux, fOwner, "POST", "/shopbook/my-shop/plan/request-pro", "")
	if _, out = call(t, mux, fOwner, "GET", "/shopbook/my-shop", ""); out["proRequestedAt"] != req["requestedAt"] {
		t.Fatalf("after request: %v, want %v", out["proRequestedAt"], req["requestedAt"])
	}
	// The plan is the ENTITLEMENT, not the shop row's plan column.
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO shopbook_entitlement (shop_id, plan, state) VALUES ('%s','pro','active')`, fShop)); err != nil {
		t.Fatal(err)
	}
	if _, out = call(t, mux, fOwner, "GET", "/shopbook/my-shop", ""); out["entitledPlan"] != "pro" {
		t.Fatalf("entitled pro: %v", out["entitledPlan"])
	}
	// No shop: unchanged shape.
	if code, out = call(t, mux, fCustomer, "GET", "/shopbook/my-shop", ""); code != 200 || out["shop"] != nil || len(out) != 1 {
		t.Fatalf("no shop: %d %v", code, out)
	}
}

func TestSBR4ReturnDecisionNotificationHasOrderID(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { rnCleanup(t) })
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO shopbook_order (id, shop_id, customer_user_id, status) VALUES ('%s','%s','%s','completed')`,
			rnOrderA, fShop, fCustomer),
		fmt.Sprintf(`INSERT INTO shopbook_return (id, shop_id, order_id, customer_user_id) VALUES ('%s','%s','%s','%s')`,
			rnReturn1, fShop, rnOrderA, fCustomer),
		fmt.Sprintf(`DELETE FROM shopbook_notification WHERE user_id = '%s'`, fCustomer),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	mux := sbFlowMux()
	RegisterShopBookReturns(mux)
	if code, out := call(t, mux, fOwner, "POST", "/shopbook/my-shop/returns/"+rnReturn1+"/decide",
		`{"approve":false,"note":"Seal broken"}`); code != 200 {
		t.Fatalf("reject: %d %v", code, out)
	}
	var raw []byte
	if err := db.Pool.QueryRow(context.Background(),
		`SELECT data::text FROM shopbook_notification WHERE user_id = $1 AND event = 'return_rejected'
		  ORDER BY created_at DESC LIMIT 1`, fCustomer).Scan(&raw); err != nil {
		t.Fatalf("notification: %v", err)
	}
	var data map[string]any
	_ = json.Unmarshal(raw, &data)
	if data["orderId"] != rnOrderA || data["returnId"] != rnReturn1 {
		t.Fatalf("return_rejected data = %v, want orderId %s", data, rnOrderA)
	}
	_ = adminExec(ctx, fmt.Sprintf(`DELETE FROM shopbook_notification WHERE user_id = '%s'`, fCustomer))
}
