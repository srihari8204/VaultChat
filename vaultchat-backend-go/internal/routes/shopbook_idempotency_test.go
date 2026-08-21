// shopbook_idempotency_test.go — structured detection of a Postgres duplicate.
//
// PURE. Touches no database: every case constructs the error pgx would have
// returned. That is the point — the behaviour under test is "did we correctly
// classify this error", and classifying it must not require the condition that
// produced it.
//
// WHAT THIS REPLACED, AND WHY IT MATTERS
//
// Eight duplicate-recovery branches used to match the index name inside the
// driver's formatted message. Money was never at risk from that — the unique
// index refuses the second row regardless — but the CALLER was: a missed match
// returns 500 instead of the existing row, and a client told its payment failed
// retries under a fresh idempotency key, which is a legitimately new payment.
package routes

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func pgErr(code, constraint string) error {
	return &pgconn.PgError{
		Code:           code,
		ConstraintName: constraint,
		Message:        "duplicate key value violates unique constraint \"" + constraint + "\"",
	}
}

// Every constraint a recovery branch depends on. Kept here as one list so a
// name can be checked against the call sites below.
var idempotencyConstraints = []string{
	"idx_shopbook_payment_idem",
	"idx_shopbook_order_idem",
	"idx_shopbook_ledger_idem",
	"idx_shopbook_purchase_idem",
	"idx_shopbook_return_one_open",
	"idx_shopbook_invoice_ledger_once",
	"idx_shopbook_location_request_one_open",
	"idx_shopbook_purchase_supplier_invoice",
	// Added with the walk-in creation endpoint: one khata per phone per shop.
	"idx_shopbook_khata_customer_mobile",
}

// Cases 1-7 and 11: a real unique violation on the expected index matches.
func TestSbIsUniqueViolationMatchesEachConstraint(t *testing.T) {
	for _, c := range idempotencyConstraints {
		if !sbIsUniqueViolation(pgErr("23505", c), c) {
			t.Errorf("23505 on %s should match", c)
		}
		// pgx wraps. A bare type assertion would miss this and fail closed —
		// silently, in exactly the way this change exists to prevent.
		wrapped := fmt.Errorf("exec failed: %w", pgErr("23505", c))
		if !sbIsUniqueViolation(wrapped, c) {
			t.Errorf("wrapped 23505 on %s should still match", c)
		}
		// And doubly wrapped, because the real call stack nests more than once.
		if !sbIsUniqueViolation(fmt.Errorf("tx: %w", wrapped), c) {
			t.Errorf("doubly wrapped 23505 on %s should still match", c)
		}
	}
}

// Cases 8-10, 12: everything that is NOT this duplicate must not match.
func TestSbIsUniqueViolationRejectsEverythingElse(t *testing.T) {
	const want = "idx_shopbook_payment_idem"
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"nil error", nil},
		{"ordinary error", errors.New("connection reset by peer")},
		{"foreign key violation (23503)", pgErr("23503", want)},
		{"check violation (23514)", pgErr("23514", want)},
		{"not-null violation (23502)", pgErr("23502", want)},
		{"unique violation on a DIFFERENT index", pgErr("23505", "idx_shopbook_order_idem")},
		{"unique violation with no constraint name", pgErr("23505", "")},
		{"serialization failure (40001)", pgErr("40001", want)},
	} {
		if sbIsUniqueViolation(tc.err, want) {
			t.Errorf("%s must NOT match %s", tc.name, want)
		}
	}
}

// The old implementation matched a substring, so a constraint whose name merely
// CONTAINS another would have matched both. The structured comparison is exact,
// and that difference is worth pinning: idx_shopbook_purchase_idem is a prefix
// of nothing today, but names change.
func TestSbIsUniqueViolationIsExactNotSubstring(t *testing.T) {
	if sbIsUniqueViolation(pgErr("23505", "idx_shopbook_payment_idem_v2"), "idx_shopbook_payment_idem") {
		t.Error("a longer constraint name must not satisfy a shorter expectation")
	}
	if sbIsUniqueViolation(pgErr("23505", "idx_shopbook_payment"), "idx_shopbook_payment_idem") {
		t.Error("a shorter constraint name must not satisfy a longer expectation")
	}
}

// A typo in a constraint string is invisible: the branch simply never fires and
// duplicates start returning 500. Nothing else checks these literals, so this
// asserts every name passed at a call site is one we know about.
//
// Reads source, not Postgres — no database is touched.
func TestEveryCallSiteUsesAKnownConstraint(t *testing.T) {
	known := map[string]bool{}
	for _, c := range idempotencyConstraints {
		known[c] = true
	}
	files, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	seen, sites := map[string]bool{}, 0
	for _, f := range files {
		n := f.Name()
		if !strings.HasPrefix(n, "shopbook") || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		src, err := os.ReadFile(n)
		if err != nil {
			t.Fatalf("read %s: %v", n, err)
		}
		for _, line := range strings.Split(string(src), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			i := strings.Index(line, "sbIsUniqueViolation(err, \"")
			if i < 0 {
				continue
			}
			rest := line[i+len("sbIsUniqueViolation(err, \""):]
			name := rest[:strings.Index(rest, "\"")]
			sites++
			seen[name] = true
			if !known[name] {
				t.Errorf("%s passes unknown constraint %q — a typo here fails silently", n, name)
			}
		}
	}
	if sites != 9 {
		t.Errorf("found %d sbIsUniqueViolation call sites, expected 9 (the audited branches)", sites)
	}
	for _, c := range idempotencyConstraints {
		if !seen[c] {
			t.Errorf("constraint %s is declared but no call site uses it", c)
		}
	}
}

// The old string-matching form must not come back.
func TestNoStringMatchedDuplicateDetectionRemains(t *testing.T) {
	files, _ := os.ReadDir(".")
	for _, f := range files {
		n := f.Name()
		if !strings.HasPrefix(n, "shopbook") || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		src, _ := os.ReadFile(n)
		for i, line := range strings.Split(string(src), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") {
				continue // the helper's own comment explains the old form
			}
			if strings.Contains(line, "strings.Contains(err.Error()") {
				t.Errorf("%s:%d still detects a duplicate by error text: %s", n, i+1, trimmed)
			}
		}
	}
}
