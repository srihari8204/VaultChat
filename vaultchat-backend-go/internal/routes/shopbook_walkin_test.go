// shopbook_walkin_test.go — the walk-in khata party, and the three gates.
//
// SCOPE, STATED PLAINLY: these are STRUCTURAL tests. They read the source and
// assert the shape of the gate wiring. They prove NOTHING about runtime
// behaviour — no row is written, no gate is actually exercised, no ledger
// balance is computed. Every behavioural case (a walk-in from another shop
// rejected, the 200-customer cap counting walk-ins individually, a derived
// balance) needs a database write to set up, and database mutation is
// forbidden for this phase. Those are recorded as NOT RUN.
//
// # WHY STRUCTURAL IS STILL WORTH RUNNING
//
// The failure modes this change could introduce are all visible in the source:
// the account-customer authorization check being softened or shared with the
// walk-in path, a gate call site missing the new party argument, the INSERT
// writing an empty string instead of NULL into the unused party column, or
// a second credit-limit system beside the existing one. Same technique, and
// the same reason, as TestEveryCallSiteUsesAKnownConstraint.
package routes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func walkinSrc(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	// Strip line comments so prose about a check cannot satisfy an assertion
	// about code — the comments here discuss exactly the things being asserted.
	var out []string
	for _, l := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "//") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

// One function's body, so an assertion about sbAddLedgerEntry cannot be
// satisfied — or broken — by an unrelated handler in the same file. The first
// version of this test failed exactly that way: it matched sbSendReminder,
// which requires customerId for the good reason that a walk-in has no account
// to push a reminder to.
func walkinFunc(t *testing.T, file, fn string) string {
	t.Helper()
	src := walkinSrc(t, file)
	i := strings.Index(src, "func "+fn+"(")
	if i < 0 {
		t.Fatalf("%s not found in %s", fn, file)
	}
	body := src[i:]
	if j := strings.Index(body[1:], "\nfunc "); j >= 0 {
		body = body[:j]
	}
	return body
}

// Case 1: exactly one party. Both-or-neither is a client bug, and resolving it
// by precedence would write debt to a party the caller did not name.
func TestLedgerRequiresExactlyOneParty(t *testing.T) {
	src := walkinFunc(t, "shopbook.go", "sbAddLedgerEntry")
	if !strings.Contains(src, `(b.CustomerID == "") == (b.KhataCustomerID == "")`) {
		t.Error("sbAddLedgerEntry must reject both-or-neither party")
	}
	// The old unconditional `b.CustomerID == ""` guard must be gone, or a
	// walk-in can never be posted at all.
	if regexp.MustCompile(`httpx\.Body\(r, &b\); err != nil \|\| b\.CustomerID == ""`).MatchString(src) {
		t.Error("the body guard still demands customerId, which blocks every walk-in")
	}
}

// Cases 2-4: the walk-in path is authorized by OWNERSHIP, and the existing
// account-customer check is untouched.
func TestWalkinAuthorizationIsOwnershipAndAccountPathIsIntact(t *testing.T) {
	src := walkinFunc(t, "shopbook.go", "sbAddLedgerEntry")

	if !regexp.MustCompile(`FROM shopbook_khata_customer WHERE id=\$1 AND shop_id=\$2`).MatchString(src) {
		t.Error("walk-in authorization must check the khata customer exists AND belongs to this shop")
	}
	// Both halves matter. id-only lets an owner post into another shop's book.
	if regexp.MustCompile(`FROM shopbook_khata_customer WHERE id=\$1\s*\)`).MatchString(src) {
		t.Error("walk-in authorization checks id without shop_id — cross-shop write")
	}
	// The account-customer rule must still be the has-already-transacted one.
	if !regexp.MustCompile(`EXISTS\(SELECT 1 FROM shopbook_order\s+WHERE shop_id=\$1 AND customer_user_id=\$2\)\s*\n\s*OR EXISTS\(SELECT 1 FROM shopbook_ledger WHERE shop_id=\$1 AND customer_user_id=\$2\)`).MatchString(src) {
		t.Error("the account-customer relationship check was altered or removed")
	}
	// And it must not have been made conditional on anything but the party.
	if !strings.Contains(src, `if b.KhataCustomerID != "" {`) {
		t.Error("the two authorization paths must branch on which party was supplied")
	}
}

// Case 5: every gate call site passes the party. A missing argument is a
// compile error, so what is checked here is that the ORDER path passes an
// empty walk-in id — orders have no walk-in column, and passing a real one
// there would silently look up the wrong ledger.
func TestGateCallSitesPassTheRightParty(t *testing.T) {
	src := walkinSrc(t, "shopbook.go")
	for _, want := range []string{
		`sbCustomerLimitOK(ctx, body.ShopID, user.ID, "")`,                // order path
		`sbCustomerLimitOK(ctx, shopID, b.CustomerID, b.KhataCustomerID)`, // ledger path
		`sbCreditCheck(ctx, tx, shopID, custID, "", money(orderTotal))`,   // order path
		`sbCreditCheck(ctx, db.Pool, shopID, b.CustomerID, b.KhataCustomerID, amount)`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("missing gate call site: %s", want)
		}
	}
}

// Cases 6-8: the Free-plan cap counts walk-ins as individuals.
//
// The bug this pins: the original count UNION'd customer_user_id from two
// tables and COUNT(*)'d the result. Every walk-in row contributes NULL, UNION
// collapses them to one, so a thousand walk-ins counted as a single customer —
// the cap was avoidable just by using walk-in khata.
func TestCustomerLimitCountsWalkinsIndividually(t *testing.T) {
	body := walkinFunc(t, "shopbook.go", "sbCustomerLimitOK")
	if strings.Count(body, "customer_user_id IS NOT NULL") != 2 {
		t.Error("both UNION arms must exclude NULL, or walk-in NULLs count as a phantom customer")
	}
	if !strings.Contains(body, "COUNT(DISTINCT khata_customer_id)") {
		t.Error("walk-ins must be counted on their own identity, not collapsed")
	}
	if !strings.Contains(body, "count < 200") {
		t.Error("the 200-customer Free cap must be unchanged")
	}
	if !strings.Contains(body, `shopPlan(ctx, shopID) == "pro"`) {
		t.Error("the Pro bypass must be unchanged")
	}
	// An existing walk-in's second entry must not consume quota again.
	if !strings.Contains(body, "shopbook_ledger WHERE shop_id=$1 AND khata_customer_id=$2") {
		t.Error("an existing walk-in must be recognised so it does not re-consume quota")
	}
}

// Cases 9-11: one credit ceiling, one balance model.
func TestCreditCheckHasOneBalanceModel(t *testing.T) {
	body := walkinFunc(t, "shopbook_payment.go", "sbCreditCheck")
	// The derived balance, both paths: SUM over the ledger, never a stored one.
	if strings.Count(body, "FROM shopbook_ledger WHERE shop_id=$1") != 2 {
		t.Error("both parties must derive pending from the ledger")
	}
	if regexp.MustCompile(`\bbalance\b|running_balance|stored_balance`).MatchString(body) {
		t.Error("a second stored balance must not be introduced")
	}
	// credit_limit is now read from TWO places, and that is the point: an
	// account customer's lives on shopbook_customer (a users FK a walk-in can
	// never satisfy), a walk-in's on shopbook_khata_customer (migration 112).
	// Both are NUMERIC rupees through sbCents, compared against the same
	// derived balance. A third would mean a third money representation.
	if strings.Count(body, "credit_limit") != 2 {
		t.Errorf("credit_limit must be read from exactly 2 places, found %d", strings.Count(body, "credit_limit"))
	}
	if !strings.Contains(body, "FROM shopbook_khata_customer") {
		t.Error("the walk-in ceiling must come from shopbook_khata_customer")
	}
	// Cross-shop: reading another shop's khata limit must be impossible.
	if !strings.Contains(body, "WHERE id=$2 AND shop_id=$1") {
		t.Error("the walk-in limit lookup must be scoped to the shop")
	}
	if !strings.Contains(body, "limit <= 0") {
		t.Error("the unconfigured-limit escape must be unchanged")
	}
	// 0 still means "no ceiling configured" for BOTH parties — that shared
	// escape is what keeps every walk-in created before 112 behaving exactly
	// as it did, since the new column defaults to 0 and nothing was backfilled.
	if strings.Count(body, "limit <= 0") != 1 {
		t.Error("both parties must share the one unconfigured-limit escape")
	}
}

// Case 12: the unused party column goes in as NULL. Postgres' party CHECK
// counts an empty string as present, so writing one rejects every row.
func TestLedgerInsertWritesNullForTheUnusedParty(t *testing.T) {
	src := walkinFunc(t, "shopbook.go", "sbAddLedgerEntry")
	if !strings.Contains(src, "INSERT INTO shopbook_ledger (shop_id, customer_user_id, khata_customer_id, type, amount, remark, idempotency_key)") {
		t.Error("the ledger INSERT must name both party columns")
	}
	if !strings.Contains(src, "var custParty, khataParty any") {
		t.Error("the party values must be typed any so the unused one is NULL, not \"\"")
	}
	// Placeholders shifted by one when khata_customer_id was added; a stale
	// sbAmt("$4") would write the type string into the amount column.
	if !strings.Contains(src, `sbAmt("$5")`) {
		t.Error("the amount placeholder must be $5 after the new party column")
	}
}

// Case 13: no second system. The whole point of extending the existing gates
// rather than adding walk-in equivalents beside them.
func TestNoParallelWalkinSystemWasAdded(t *testing.T) {
	for _, f := range []string{"shopbook.go", "shopbook_payment.go"} {
		src := walkinSrc(t, f)
		for _, banned := range []string{
			"sbWalkinCreditCheck", "sbKhataCreditCheck",
			"sbWalkinCustomerLimitOK", "sbKhataCustomerLimitOK",
			"walkinCreditLimit", "khataCreditLimit",
		} {
			if strings.Contains(src, banned) {
				t.Errorf("%s defines a parallel walk-in system: %s", f, banned)
			}
		}
	}
}
