package routes

import (
	"testing"
	"time"
)

// The location-visibility decision table, exhaustively. Every row is one
// directed "viewer → target" relationship the platform must answer; the SQL
// in locVisibleWhere is the enforcement and locCanSee is its specification —
// a grant here without the matching predicate there is the bug this file
// exists to catch in review.

type locPolicyCase struct {
	id     string
	fam    string
	v      locViewer
	expect bool
}

func locPolicyMatrix() []locPolicyCase {
	return []locPolicyCase{
		// ── Family: mutual, always, members only ──
		{"FAM-001", "family", locViewer{IsMember: true}, true},                      // member → member
		{"FAM-002", "family", locViewer{IsMember: true, IsSelf: true}, true},        // self
		{"FAM-003", "family", locViewer{IsMember: false}, false},                    // non-member
		{"FAM-004", "family", locViewer{IsMember: false, IsSelf: true}, false},      // REMOVED member, even for own rows via this space
		{"FAM-005", "family", locViewer{IsMember: false, Linked: true}, false},      // links never override membership
		{"FAM-006", "family", locViewer{IsMember: false, IsOps: true}, false},       // rank never overrides membership

		// ── Generic space: same mutual rule ──
		{"GEN-001", "generic", locViewer{IsMember: true}, true},
		{"GEN-002", "generic", locViewer{IsMember: false}, false},

		// ── School: parent sees via links or the child's running bus ──
		{"SCH-001", "school", locViewer{IsMember: true, IsSelf: true}, true},        // own position
		{"SCH-002", "school", locViewer{IsMember: true, Linked: true}, true},        // guardian → linked child
		{"SCH-003", "school", locViewer{IsMember: true, RunLink: true}, true},       // parent → driver of child's started run
		{"SCH-004", "school", locViewer{IsMember: true, IsOps: true}, true},         // school admin → all
		{"SCH-005", "school", locViewer{IsMember: true}, false},                     // plain member → unrelated member
		{"SCH-006", "school", locViewer{IsMember: false, Linked: true}, false},      // ex-member parent
		{"SCH-007", "school", locViewer{IsMember: false, IsOps: true}, false},       // ex-admin

		// ── Business/office: employee self-only; supervisor via links; ops all ──
		{"BUS-001", "office", locViewer{IsMember: true, IsSelf: true}, true},        // employee → self
		{"BUS-002", "office", locViewer{IsMember: true}, false},                     // employee → colleague DENIED
		{"BUS-003", "office", locViewer{IsMember: true, Linked: true}, true},        // supervisor → assigned employee
		{"BUS-004", "office", locViewer{IsMember: true, IsOps: true}, true},         // admin/super-admin → all
		{"BUS-005", "office", locViewer{IsMember: true, RunLink: true}, true},       // employee → their cab's driver on a run
		{"BUS-006", "office", locViewer{IsMember: false, IsOps: true}, false},       // removed admin

		// ── Transport/cab fleet ──
		{"TRN-001", "transport", locViewer{IsMember: true, IsSelf: true}, true},
		{"TRN-002", "transport", locViewer{IsMember: true, RunLink: true}, true},    // rider → driver of their active run
		{"TRN-003", "transport", locViewer{IsMember: true}, false},                  // rider → unrelated driver
		{"TRN-004", "transport", locViewer{IsMember: true, IsOps: true}, true},      // transport officer → fleet
		{"TRN-005", "transport", locViewer{IsMember: false, RunLink: true}, false},  // removed rider

		// ── Unknown space family fails closed beyond self ──
		{"UNK-001", "mystery", locViewer{IsMember: true, IsSelf: true}, true},
		{"UNK-002", "mystery", locViewer{IsMember: true, IsOps: true}, false},
		{"UNK-003", "mystery", locViewer{IsMember: true, Linked: true}, false},
	}
}

func TestLocationVisibilityMatrix(t *testing.T) {
	for _, c := range locPolicyMatrix() {
		got := locCanSee(c.fam, c.v)
		status := "PASS"
		if got != c.expect {
			status = "FAIL"
			t.Errorf("%s: fam=%s viewer=%+v expected=%v actual=%v", c.id, c.fam, c.v, c.expect, got)
		}
		t.Logf("%s | %s | expected=%v actual=%v | %s", c.id, c.fam, c.expect, got, status)
	}
}

// Cross-space isolation is structural — the read SQL always constrains
// sl.chat_id = $1 AND the viewer's membership in THAT chat is checked first —
// but the policy must still never grant a non-member anything, which is what
// an IDOR against another space's id reduces to after chatsRequireMem 403s.
func TestNonMembersNeverSeeAnything(t *testing.T) {
	fams := []string{"family", "generic", "school", "office", "transport", "mystery"}
	for _, fam := range fams {
		for _, v := range []locViewer{
			{IsMember: false},
			{IsMember: false, IsSelf: true},
			{IsMember: false, IsOps: true},
			{IsMember: false, Linked: true},
			{IsMember: false, RunLink: true},
			{IsMember: false, IsOps: true, Linked: true, RunLink: true, IsSelf: true},
		} {
			if locCanSee(fam, v) {
				t.Errorf("fam=%s viewer=%+v: a non-member was granted visibility", fam, v)
			}
		}
	}
}

// The family mutual rule is what the client's N=2..10 matrix
// (lib/family/visibility.selftest.ts) assumes of the server: every ACTIVE
// member sees every other ACTIVE member — 90 directed grants at N=10.
func TestFamilyMutualVisibilityN10(t *testing.T) {
	granted := 0
	for viewer := 0; viewer < 10; viewer++ {
		for target := 0; target < 10; target++ {
			if viewer == target {
				continue
			}
			if !locCanSee("family", locViewer{IsMember: true}) {
				t.Fatalf("family member %d → %d must be visible", viewer, target)
			}
			granted++
		}
	}
	if granted != 90 {
		t.Fatalf("expected 90 directed grants at N=10, got %d", granted)
	}
}

// locSpaceFamily must agree with the client's familyOf() — same inputs, same
// buckets. These are the exact cases pinned in lib/spaces/layout.ts.
func TestLocSpaceFamilyMirrorsClient(t *testing.T) {
	cases := map[string]string{
		"family":           "family",
		"school":           "school",
		"school_transport": "school",
		"office_transport": "transport",
		"business":         "office",
		"office":           "office",
		"colleagues":       "office",
		"friends":          "generic",
		"":                 "generic",
		"something_new":    "generic",
	}
	for in, want := range cases {
		if got := locSpaceFamily(in); got != want {
			t.Errorf("locSpaceFamily(%q) = %q, want %q (drifted from lib/spaces/layout.ts)", in, got, want)
		}
	}
}

// Ingest validation: reject the garbage a real fleet of phones will send.
func TestLocValidPoint(t *testing.T) {
	now := time.Now()
	ok := func(p locPoint) bool { return locValidPoint(p, now) }
	base := locPoint{Lat: 12.9, Lng: 77.5, Ts: now.UnixMilli()}
	if !ok(base) {
		t.Fatal("a sane point must pass")
	}
	bad := []locPoint{
		{Lat: 91, Lng: 0, Ts: base.Ts},                       // out of range
		{Lat: 0, Lng: 0, Ts: base.Ts},                        // null island
		{Lat: 12.9, Lng: 181, Ts: base.Ts},                   // out of range
		{Lat: 12.9, Lng: 77.5, Ts: now.Add(10 * 60e9).UnixMilli()},  // future
		{Lat: 12.9, Lng: 77.5, Ts: now.Add(-8 * 24 * 3600e9).UnixMilli()}, // ancient replay
	}
	for i, p := range bad {
		if ok(p) {
			t.Errorf("bad point %d accepted: %+v", i, p)
		}
	}
	spd := 200.0
	if ok(locPoint{Lat: 12.9, Lng: 77.5, Ts: base.Ts, Spd: &spd}) {
		t.Error("supersonic speed accepted")
	}
}
