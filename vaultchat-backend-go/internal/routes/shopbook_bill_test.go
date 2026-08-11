// shopbook_bill_test.go — billing arithmetic and entitlement policy
// (P0-C / P0-E, bug #8).
package routes

import "testing"

// Round-off is the "₹0.40" line at the bottom of an Indian bill. It must be
// exact in both directions and must always leave a whole-unit total, or the
// customer is handed change that does not match the paper.
func TestRoundOff(t *testing.T) {
	cases := []struct {
		total, adj money
	}{
		{69340, -40}, // ₹693.40 → ₹693.00 (nearest whole unit is down)
		{69360, 40},  // ₹693.60 → ₹694.00
		{69310, -10}, // ₹693.10 → ₹693.00
		{69350, 50},  // exactly half rounds up, so the shop never loses it
		{69349, -49}, // just under half rounds down
		{69300, 0},   // already whole
		{0, 0},
		{5, -5}, // ₹0.05 → ₹0.00
		{95, 5}, // ₹0.95 → ₹1.00
	}
	for _, c := range cases {
		got := sbRoundOff(c.total)
		if got != c.adj {
			t.Errorf("sbRoundOff(%s) = %s, want %s", c.total, got, c.adj)
		}
		if (c.total+got)%100 != 0 {
			t.Errorf("sbRoundOff(%s) left %s, which is not a whole unit", c.total, c.total+got)
		}
	}
}

// The billing window. Before acceptance there is no bill; after 'ready' the
// customer has been told what to come and pay, and moving the total under them
// is the behaviour this gate exists to prevent.
func TestBillIsEditableOnlyBeforeReady(t *testing.T) {
	for _, s := range []string{"accepted", "preparing", "packing"} {
		if !sbBillableStatuses[s] {
			t.Errorf("bill should be editable at %q", s)
		}
	}
	for _, s := range []string{"pending", "ready", "collected", "completed",
		"cancelled", "rejected", "not_collected"} {
		if sbBillableStatuses[s] {
			t.Errorf("bill must NOT be editable at %q", s)
		}
	}
}

// Item review closes when the order does. An alternative accepted after Ready
// would change a total the customer was already quoted (bug #11).
func TestItemReviewClosesAfterReady(t *testing.T) {
	for _, s := range []string{"pending", "accepted", "preparing", "packing"} {
		if !sbReviewableStatuses[s] {
			t.Errorf("items should be reviewable at %q", s)
		}
	}
	for _, s := range []string{"ready", "collected", "completed",
		"cancelled", "rejected", "not_collected"} {
		if sbReviewableStatuses[s] {
			t.Errorf("items must NOT be reviewable at %q", s)
		}
	}
}

// Pro must never come from anything but a real entitlement (bug #8), and
// losing it must never be sudden — a failed card should cost a shop its
// billing, not its Saturday trade.
func TestEntitlementDecidesPro(t *testing.T) {
	cases := []struct {
		plan, state string
		expired     bool
		want        string
	}{
		{"pro", "active", false, "pro"},
		{"pro", "trial", false, "pro"},
		{"pro", "past_due", false, "pro"},    // card failed, shop keeps trading
		{"pro", "grace_period", true, "pro"}, // expired but explicitly in grace
		{"pro", "active", true, "free"},      // ran out
		{"pro", "expired", false, "free"},
		{"pro", "cancelled", false, "free"},
		{"free", "active", false, "free"},
		{"free", "grace_period", false, "free"}, // never entitled in the first place
		{"", "", false, "free"},
	}
	for _, c := range cases {
		if got := sbPlanFromEntitlement(c.plan, c.state, c.expired); got != c.want {
			t.Errorf("sbPlanFromEntitlement(%q,%q,expired=%v) = %q, want %q",
				c.plan, c.state, c.expired, got, c.want)
		}
	}
}

func TestPaymentMethodsAreClosedSet(t *testing.T) {
	for _, m := range []string{"cash", "bank", "upi", "card", "other"} {
		if !sbPaymentMethods[m] {
			t.Errorf("%q should be an accepted payment method", m)
		}
	}
	// 'gateway' and 'online' would imply a confirmation the app cannot make.
	for _, m := range []string{"gateway", "online", "paid", ""} {
		if sbPaymentMethods[m] {
			t.Errorf("%q must not be accepted — no gateway confirms payments yet", m)
		}
	}
}

// The weight-based bill from the spec, end to end: 1 kg requested, 1.18 kg
// packed, ₹240/kg. The requested quantity survives; the bill uses the packed
// one.
func TestWeightBasedLineBillsWhatWasPacked(t *testing.T) {
	price := money(24000)
	requested, packed := int64(100), int64(118)

	if got := price.mulQty(requested); got != 24000 {
		t.Errorf("requested line = %s, want ₹240.00", got)
	}
	if got := price.mulQty(packed); got != 28320 {
		t.Errorf("packed line = %s, want ₹283.20", got)
	}
	// 5% tax on the packed amount, not the requested one.
	if got := price.mulQty(packed).pctOf(500); got != 1416 {
		t.Errorf("tax on packed line = %s, want ₹14.16", got)
	}
}
