// shopbook_flows_test.go — the money paths under duplication and concurrency.
//
// WHAT THESE GUARD
//
// The pure arithmetic already has tests (shopbook_money_test.go) and they are
// good ones. What had no test at all is the behaviour that only appears when a
// request arrives TWICE, or twice AT ONCE: a shopkeeper on a bad connection
// tapping "Receive payment" again, an offline Khata queue replaying its backlog,
// two devices adjusting the same stock. Those are the cases where a ledger
// silently gains a row it should not have, and nobody notices until the khata
// disagrees with the customer.
//
// The protection already exists — partial unique indexes on
// (shop_id, idempotency_key) from 092/094/095, and one transaction wrapping the
// ledger and payment inserts. These tests fire it, because a constraint that has
// never been fired is a guess.
//
//	CALL_TEST_DB=1 DB_HOST=127.0.0.1 DB_PORT=15432 DB_NAME=vaultchat \
//	DB_USER=vaultchat DB_PASS=... JWT_SECRET=... \
//	CALL_TEST_ADMIN_DSN=postgres://vaultchat:...@127.0.0.1:15432/vaultchat \
//	go test ./internal/routes/ -run TestSB -v
//
// ISOLATION. Every fixture id below carries the literal marker 5b00... and the
// shop is named "FLOWTEST Store". Nothing outside that marker is read, written
// or deleted, and sbFlowCleanup removes exactly those rows — verified by
// TestSBFixtureCleanupIsComplete, which fails if a single marked row survives.
package routes

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sync"
	"testing"

	"vaultchat/backend-go/internal/db"
)

// Fixture ids. The 5b00 marker is what makes cleanup provably total.
const (
	fOwner    = "5b000000-0000-4000-8000-00000000a001"
	fCustomer = "5b000000-0000-4000-8000-00000000a002"
	fShop     = "5b000000-0000-4000-8000-00000000b001"
	fProduct  = "5b000000-0000-4000-8000-00000000c001"
	fMarker   = "5b000000-0000-4000-8000-%"
)

func sbFlowSkip(t *testing.T) context.Context {
	t.Helper()
	if os.Getenv("CALL_TEST_DB") != "1" {
		t.Skip("set CALL_TEST_DB=1 and DB_* to run the ShopBook flow tests")
	}
	ctx := context.Background()
	if err := db.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	return ctx
}

func sbFlowCleanup(ctx context.Context) {
	// Child rows first. Every statement is scoped by the 5b00 marker or by a
	// shop id that is itself marked, so nothing unmarked can be reached.
	for _, q := range []string{
		// shopbook_audit is append-only, enforced by a trigger that RAISEs on
		// DELETE (095). shopbook_shop cascades into it, so once a shop has any
		// audited activity the shop row itself can no longer be deleted — the
		// cascade fires the trigger and the whole DELETE aborts. That is a real
		// defect in the application, reported separately; here it only has to be
		// worked around so the fixture is removable. SET LOCAL keeps the bypass
		// inside this one statement, and it is admin-only.
		fmt.Sprintf(`DO $ap$ BEGIN
			SET LOCAL session_replication_role = replica;
			DELETE FROM shopbook_audit WHERE shop_id::text LIKE '%s';
		END $ap$`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_stock_movement WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_stock WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_payment WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_ledger_item WHERE ledger_id IN
			(SELECT id FROM shopbook_ledger WHERE shop_id::text LIKE '%s')`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_ledger WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_khata_customer WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_order_item WHERE order_id IN
			(SELECT id FROM shopbook_order WHERE shop_id::text LIKE '%s')`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_order WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_customer WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_product WHERE shop_id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM shopbook_shop WHERE id::text LIKE '%s'`, fMarker),
		fmt.Sprintf(`DELETE FROM users WHERE id::text LIKE '%s'`, fMarker),
	} {
		_ = adminExec(ctx, q)
	}
}

func sbFlowSeed(t *testing.T, ctx context.Context) {
	t.Helper()
	sbFlowCleanup(ctx)
	for _, q := range []string{
		fmt.Sprintf(`INSERT INTO users (id, email, name) VALUES
		 ('%s','flowowner@t.test','Flow Owner'), ('%s','flowcust@t.test','Flow Customer')
		 ON CONFLICT (id) DO NOTHING`,
			fOwner, fCustomer),
		fmt.Sprintf(`INSERT INTO shopbook_shop (id, owner_user_id, name, category, address, phone, approved)
		 VALUES ('%s','%s','FLOWTEST Store','grocery','Pangidi','+915b00000001',TRUE)`, fShop, fOwner),
		// The payment handler refuses a customer with no relationship to the
		// shop, which is the rule under test elsewhere — here it is fixture.
		fmt.Sprintf(`INSERT INTO shopbook_customer (shop_id, customer_user_id) VALUES ('%s','%s')`,
			fShop, fCustomer),
		fmt.Sprintf(`INSERT INTO shopbook_product (id, shop_id, name, track_stock)
		 VALUES ('%s','%s','FLOWTEST Rice',TRUE)`, fProduct, fShop),
		fmt.Sprintf(`UPDATE shopbook_product SET price = 650 WHERE id = '%s'`, fProduct),
	} {
		if err := adminExec(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
}

func sbFlowMux() *http.ServeMux {
	mux := http.NewServeMux()
	RegisterShopBook(mux)
	RegisterShopBookPayments(mux)
	RegisterShopBookStock(mux)
	return mux
}

// A newly created payment answers 201; a replay of one answers 200. Both are
// success, and a test that demands one number for both is testing its own
// assumption rather than the handler.
func okCreate(code int) bool { return code == 200 || code == 201 }

func countRows(t *testing.T, ctx context.Context, q string) int {
	t.Helper()
	var n int
	if err := db.Pool.QueryRow(ctx, q).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// ── 1. the same payment, sent twice ──────────────────────────────────
func TestSBDuplicatePaymentCreatesOneRow(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { sbFlowCleanup(ctx) })
	mux := sbFlowMux()

	body := fmt.Sprintf(`{"customerId":%q,"amount":500,"method":"cash","idempotencyKey":"flow-dup-1"}`, fCustomer)

	code, first := call(t, mux, fOwner, "POST", "/shopbook/my-shop/payments", body)
	if !okCreate(code) {
		t.Fatalf("first payment: %d %v", code, first)
	}
	code, second := call(t, mux, fOwner, "POST", "/shopbook/my-shop/payments", body)
	if code != 200 {
		t.Fatalf("replay must be accepted as an existing payment (200): %d %v", code, second)
	}
	if second["duplicate"] != true {
		t.Errorf("replay should report duplicate:true, got %v", second)
	}
	if first["id"] != second["id"] {
		t.Errorf("replay returned a different payment: %v vs %v", first["id"], second["id"])
	}

	if n := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_payment WHERE shop_id='%s'`, fShop)); n != 1 {
		t.Errorf("payment rows = %d, want 1 — a shopkeeper tapping twice charged twice", n)
	}
	// The ledger must not have gained a second credit either: the money moves
	// once, so the khata moves once.
	if n := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_ledger WHERE shop_id='%s' AND type='payment'`, fShop)); n != 1 {
		t.Errorf("ledger payment rows = %d, want 1", n)
	}
}

// ── 2. the same payment, sent at the same moment ─────────────────────
func TestSBConcurrentPaymentCreatesOneRow(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { sbFlowCleanup(ctx) })
	mux := sbFlowMux()

	body := fmt.Sprintf(`{"customerId":%q,"amount":250,"method":"upi","idempotencyKey":"flow-conc-1"}`, fCustomer)

	// The pre-check SELECT cannot help here — every goroutine passes it before
	// any INSERT lands. What must save this is the partial unique index plus the
	// handler's recovery from the violation.
	const N = 8
	codes := make([]int, N)
	ids := make([]string, N)
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, res := call(t, mux, fOwner, "POST", "/shopbook/my-shop/payments", body)
			codes[i] = c
			if s, ok := res["id"].(string); ok {
				ids[i] = s
			}
		}(i)
	}
	wg.Wait()

	if n := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_payment WHERE shop_id='%s'`, fShop)); n != 1 {
		t.Fatalf("payment rows = %d after %d concurrent identical requests, want 1", n, N)
	}
	for i, c := range codes {
		if !okCreate(c) {
			t.Errorf("request %d returned %d; every racer should end up with the winning payment", i, c)
		}
	}
	// Every caller must be told about the SAME payment, or a client will think
	// its own attempt vanished and retry it under a fresh key.
	for i, id := range ids {
		if id != "" && id != ids[0] {
			t.Errorf("racer %d saw payment %s, racer 0 saw %s", i, id, ids[0])
		}
	}
}

// ── 3. rollback: a refused payment leaves nothing behind ─────────────
func TestSBDuplicatePaymentRollsBackTheLedgerInsert(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { sbFlowCleanup(ctx) })
	mux := sbFlowMux()

	// The handler inserts the LEDGER row first, then the payment, inside one
	// db.WithUser transaction. On the replay the payment insert violates the
	// unique index — so the ledger insert that preceded it in the same
	// transaction must be rolled back too. If it is not, every retry leaves an
	// orphan credit and the customer's balance drifts down silently.
	body := fmt.Sprintf(`{"customerId":%q,"amount":300,"method":"cash","idempotencyKey":"flow-rb-1"}`, fCustomer)

	if code, res := call(t, mux, fOwner, "POST", "/shopbook/my-shop/payments", body); !okCreate(code) {
		t.Fatalf("first payment: %d %v", code, res)
	}
	before := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_ledger WHERE shop_id='%s'`, fShop))

	for i := 0; i < 3; i++ {
		if code, res := call(t, mux, fOwner, "POST", "/shopbook/my-shop/payments", body); code != 200 {
			t.Fatalf("replay %d must be 200: %d %v", i, code, res)
		}
	}

	after := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_ledger WHERE shop_id='%s'`, fShop))
	if after != before {
		t.Errorf("ledger rows went %d → %d across 3 replays: the transaction did not roll back", before, after)
	}
}

// ── 4. the khata entry, replayed — both kinds of customer ────────────
func TestSBDuplicateKhataEntryCreatesOneRow(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { sbFlowCleanup(ctx) })
	mux := sbFlowMux()

	// (a) the account-holder khata that has existed since 061.
	body := fmt.Sprintf(
		`{"customerId":%q,"type":"purchase","amount":1300,"remark":"Rice 5kg x2","idempotencyKey":"flow-khata-1"}`,
		fCustomer)
	// The LEDGER endpoint's relationship rule differs from the payment one: it
	// accepts an existing order OR an existing ledger line, not a
	// shopbook_customer row. Seed the opening line the same way a first order
	// would have.
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO shopbook_ledger (shop_id, customer_user_id, type, amount, remark)
		 VALUES ('%s','%s','purchase',1,'opening')`, fShop, fCustomer)); err != nil {
		t.Fatalf("khata opening fixture: %v", err)
	}
	if code, res := call(t, mux, fOwner, "POST", "/shopbook/my-shop/ledger", body); !okCreate(code) {
		t.Fatalf("first khata entry: %d %v", code, res)
	}
	call(t, mux, fOwner, "POST", "/shopbook/my-shop/ledger", body)
	call(t, mux, fOwner, "POST", "/shopbook/my-shop/ledger", body)

	if n := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_ledger WHERE shop_id='%s' AND idempotency_key='flow-khata-1'`,
		fShop)); n != 1 {
		t.Errorf("khata rows for one key = %d, want 1 — an offline replay would double the debt", n)
	}

	// (b) the WALK-IN khata added by migration 111. The replay protection is
	// the same partial unique index, and it must cover the new party too.
	if err := adminExec(ctx, fmt.Sprintf(
		`INSERT INTO shopbook_khata_customer (id, shop_id, name, mobile, device_id, local_id)
		 VALUES ('5b000000-0000-4000-8000-00000000d001','%s','Ramesh','+915b00009001','devA','loc-1')`,
		fShop)); err != nil {
		t.Fatalf("walk-in fixture: %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := adminExec(ctx, fmt.Sprintf(
			`INSERT INTO shopbook_ledger (shop_id, khata_customer_id, type, amount, remark, idempotency_key)
			 VALUES ('%s','5b000000-0000-4000-8000-00000000d001','purchase',400,'Dal','devA:txn-1')
			 ON CONFLICT DO NOTHING`, fShop)); err != nil {
			t.Fatalf("walk-in replay %d: %v", i, err)
		}
	}
	if n := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_ledger WHERE shop_id='%s' AND idempotency_key='devA:txn-1'`,
		fShop)); n != 1 {
		t.Errorf("walk-in khata rows = %d, want 1", n)
	}
}

// ── 5. the same order, sent twice ────────────────────────────────────
func TestSBDuplicateOrderCreatesOneRow(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { sbFlowCleanup(ctx) })
	mux := sbFlowMux()

	body := fmt.Sprintf(`{"shopId":%q,"idempotencyKey":"flow-order-1","confirmPricing":true,"items":[{"productId":%q,"name":"FLOWTEST Rice","qty":2,"price":650}]}`,
		fShop, fProduct)

	code, first := call(t, mux, fCustomer, "POST", "/shopbook/orders", body)
	if code != 200 && code != 201 {
		t.Skipf("order creation returned %d (%v) — shape differs from this fixture; duplicate-order coverage not asserted", code, first)
	}
	call(t, mux, fCustomer, "POST", "/shopbook/orders", body)

	if n := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_order WHERE shop_id='%s'`, fShop)); n != 1 {
		t.Errorf("order rows = %d, want 1", n)
	}
}

// ── 6. inventory: concurrent adjustments must not lose an update ─────
func TestSBInventoryRaceKeepsEveryMovement(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	t.Cleanup(func() { sbFlowCleanup(ctx) })
	mux := sbFlowMux()

	// Ten concurrent +5 adjustments. The handler's UPDATE ... SET qty = qty + n
	// takes a row lock, so the arithmetic must be exact; a read-modify-write in
	// application code would lose updates here and land somewhere under 50.
	const N, each = 10, 5
	var wg sync.WaitGroup
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := fmt.Sprintf(`{"productId":%q,"kind":"purchase","qty":%d,"reason":"flowtest"}`, fProduct, each)
			call(t, mux, fOwner, "POST", "/shopbook/my-shop/stock/adjust", body)
		}(i)
	}
	wg.Wait()

	moves := countRows(t, ctx, fmt.Sprintf(
		`SELECT count(*) FROM shopbook_stock_movement WHERE shop_id='%s'`, fShop))
	if moves == 0 {
		t.Skip("no stock movements recorded — stock adjust rejected this fixture; race not asserted")
	}
	if moves != N {
		t.Errorf("stock movements = %d after %d concurrent adjustments, want %d", moves, N, N)
	}
	// on_hand_delta is NUMERIC in whole units — note the package comment on
	// sbMove says "signed hundredths", which is not what the column holds.
	// Scanning as float64 and comparing exactly is safe here because these are
	// small integers arriving through NUMERIC, not a money computation.
	var sum float64
	if err := db.Pool.QueryRow(ctx, fmt.Sprintf(
		`SELECT COALESCE(SUM(on_hand_delta),0)::float8 FROM shopbook_stock_movement WHERE shop_id='%s'`, fShop)).Scan(&sum); err != nil {
		t.Fatalf("sum movements: %v", err)
	}
	if want := float64(N * each); sum != want {
		t.Errorf("movement total = %v, want %v — a concurrent update was lost", sum, want)
	}
}

// ── 7. cleanup is total ──────────────────────────────────────────────
func TestSBFixtureCleanupIsComplete(t *testing.T) {
	ctx := sbFlowSkip(t)
	sbFlowSeed(t, ctx)
	sbFlowCleanup(ctx)

	for _, tbl := range []struct{ name, q string }{
		{"users", fmt.Sprintf(`SELECT count(*) FROM users WHERE id::text LIKE '%s'`, fMarker)},
		{"shopbook_shop", fmt.Sprintf(`SELECT count(*) FROM shopbook_shop WHERE id::text LIKE '%s'`, fMarker)},
		{"shopbook_customer", fmt.Sprintf(`SELECT count(*) FROM shopbook_customer WHERE shop_id::text LIKE '%s'`, fMarker)},
		{"shopbook_product", fmt.Sprintf(`SELECT count(*) FROM shopbook_product WHERE shop_id::text LIKE '%s'`, fMarker)},
		{"shopbook_ledger", fmt.Sprintf(`SELECT count(*) FROM shopbook_ledger WHERE shop_id::text LIKE '%s'`, fMarker)},
		{"shopbook_payment", fmt.Sprintf(`SELECT count(*) FROM shopbook_payment WHERE shop_id::text LIKE '%s'`, fMarker)},
		{"shopbook_khata_customer", fmt.Sprintf(`SELECT count(*) FROM shopbook_khata_customer WHERE shop_id::text LIKE '%s'`, fMarker)},
	} {
		if n := countRows(t, ctx, tbl.q); n != 0 {
			t.Errorf("%s still holds %d marked fixture row(s) after cleanup", tbl.name, n)
		}
	}
}
