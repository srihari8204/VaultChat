package groups

import (
	"reflect"
	"testing"
)

func famDefaults() map[string][]string {
	return map[string][]string{
		"admin":  {"invite_members", "remove_members", "manage_zones", "edit_settings", "view_history", "start_navigation", "send_announcements"},
		"member": {"view_history", "start_navigation"},
		"guest":  {},
	}
}

func TestOwnerAlwaysHoldsEverything(t *testing.T) {
	// Even a hostile override must not be able to lock the owner out.
	l := Layers{
		TypeDefault:   famDefaults(),
		GroupOverride: map[string][]string{"owner": {}},
	}
	got := Resolve(RoleOwner, l)
	for _, p := range All {
		if !got.Has(p) {
			t.Fatalf("owner missing %s", p)
		}
	}
}

func TestTypeDefaultApplies(t *testing.T) {
	got := Resolve(RoleMember, Layers{TypeDefault: famDefaults()}).List()
	want := []string{"view_history", "start_navigation"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("member perms = %v, want %v", got, want)
	}
}

func TestGroupOverrideBeatsTypeDefault(t *testing.T) {
	l := Layers{
		TypeDefault:   famDefaults(),
		GroupOverride: map[string][]string{"member": {"invite_members"}},
	}
	got := Resolve(RoleMember, l)
	if !got.Has(PermInviteMembers) {
		t.Fatal("override should grant invite_members")
	}
	// Replace, not merge: the type default's view_history must be gone.
	if got.Has(PermViewHistory) {
		t.Fatal("override must REPLACE the type default, not merge into it")
	}
}

func TestMemberGrantBeatsEverything(t *testing.T) {
	l := Layers{
		TypeDefault:      famDefaults(),
		GroupOverride:    map[string][]string{"member": {"invite_members"}},
		MemberGrant:      []string{"view_history"},
		MemberGrantIsSet: true,
	}
	got := Resolve(RoleMember, l)
	if !got.Has(PermViewHistory) || got.Has(PermInviteMembers) {
		t.Fatalf("member grant should win outright, got %v", got.List())
	}
}

func TestMemberGrantCanRevokeEverything(t *testing.T) {
	// The whole reason for replace-not-merge: an empty grant must mean "none".
	l := Layers{
		TypeDefault:      famDefaults(),
		MemberGrant:      []string{},
		MemberGrantIsSet: true,
	}
	if got := Resolve(RoleMember, l); len(got.List()) != 0 {
		t.Fatalf("empty grant should revoke all, got %v", got.List())
	}
}

func TestNilGrantIsNotAnEmptyGrant(t *testing.T) {
	// A member with no row must fall through to the type default, NOT be denied.
	l := Layers{TypeDefault: famDefaults(), MemberGrantIsSet: false}
	if len(Resolve(RoleMember, l).List()) == 0 {
		t.Fatal("absent grant must fall through to the type default")
	}
}

func TestGuestGetsNothingByDefault(t *testing.T) {
	if got := Resolve(RoleGuest, Layers{TypeDefault: famDefaults()}); len(got.List()) != 0 {
		t.Fatalf("guest should hold nothing by default, got %v", got.List())
	}
}

func TestUnknownRoleFailsClosed(t *testing.T) {
	if got := Resolve("superuser", Layers{TypeDefault: famDefaults()}); len(got.List()) != 0 {
		t.Fatalf("unknown role must deny, got %v", got.List())
	}
}

func TestUnknownPermissionInStoredJSONIsIgnored(t *testing.T) {
	l := Layers{TypeDefault: map[string][]string{"member": {"view_history", "delete_everything"}}}
	got := Resolve(RoleMember, l).List()
	if len(got) != 1 || got[0] != "view_history" {
		t.Fatalf("unknown permission must be dropped, got %v", got)
	}
}

func TestMissingLayersDenyRatherThanDefault(t *testing.T) {
	if got := Resolve(RoleMember, Layers{}); len(got.List()) != 0 {
		t.Fatalf("no layers at all must deny, got %v", got.List())
	}
}

func TestListIsStablyOrdered(t *testing.T) {
	l := Layers{TypeDefault: map[string][]string{"member": {"send_announcements", "invite_members", "view_history"}}}
	got := Resolve(RoleMember, l).List()
	want := []string{"invite_members", "view_history", "send_announcements"} // All order
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("List() unstable: got %v want %v", got, want)
	}
}

func TestCanManageRole(t *testing.T) {
	cases := []struct {
		actor, target, next string
		want                bool
		why                 string
	}{
		{RoleOwner, RoleAdmin, RoleMember, true, "owner demotes admin"},
		{RoleAdmin, RoleMember, RoleGuest, true, "admin manages member"},
		{RoleAdmin, RoleAdmin, RoleMember, false, "admins must not demote each other"},
		{RoleAdmin, RoleOwner, RoleMember, false, "nobody demotes the owner"},
		{RoleOwner, RoleMember, RoleOwner, false, "ownership transfer is not a role edit"},
		{RoleMember, RoleMember, RoleAdmin, false, "members cannot promote"},
		{RoleGuest, RoleGuest, RoleMember, false, "guests cannot promote"},
		{"bogus", RoleMember, RoleAdmin, false, "unknown actor role denies"},
	}
	for _, c := range cases {
		if got := CanManageRole(c.actor, c.target, c.next); got != c.want {
			t.Errorf("%s: CanManageRole(%q,%q,%q) = %v, want %v", c.why, c.actor, c.target, c.next, got, c.want)
		}
	}
}

func TestSeatsRemaining(t *testing.T) {
	cases := []struct{ active, max, want int }{
		{2, 3, 1},
		{3, 3, 0},
		{4, 3, 0},  // over-capacity after a cap cut: zero seats, never negative
		{5, 0, -1}, // untyped legacy group: uncapped
	}
	for _, c := range cases {
		if got := SeatsRemaining(c.active, c.max); got != c.want {
			t.Errorf("SeatsRemaining(%d,%d) = %d, want %d", c.active, c.max, got, c.want)
		}
	}
}

func TestRolesSortedMostPrivilegedFirst(t *testing.T) {
	// Moderator was inserted between admin and member in membership v2.
	want := []string{RoleOwner, RoleAdmin, RoleModerator, RoleMember, RoleGuest}
	if got := SortedRoles(); !reflect.DeepEqual(got, want) {
		t.Fatalf("SortedRoles() = %v, want %v", got, want)
	}
}

// ── membership v2: moderator and ownership transfer ──

func TestModeratorSitsBetweenMemberAndAdmin(t *testing.T) {
	if !IsValidRole(RoleModerator) {
		t.Fatal("moderator must be a known role")
	}
	// Rank, not just membership of the set: a moderator outranks a member and
	// is outranked by an admin. TestRolesSortedMostPrivilegedFirst pins the
	// exact order; this pins the relationships that order is meant to encode.
	if !CanManageRole(RoleAdmin, RoleModerator, RoleMember) {
		t.Error("an admin must be able to demote a moderator")
	}
	if CanManageRole(RoleModerator, RoleAdmin, RoleMember) {
		t.Error("a moderator must not be able to demote an admin")
	}
}

func TestModeratorCannotMintPeers(t *testing.T) {
	// A moderator who could promote someone to moderator or admin would make
	// the rank meaningless — anyone could grant themselves company.
	if CanManageRole(RoleModerator, RoleMember, RoleModerator) {
		t.Fatal("a moderator must not promote into its own rank")
	}
	if CanManageRole(RoleModerator, RoleMember, RoleAdmin) {
		t.Fatal("a moderator must not mint admins")
	}
	// …but may manage the ranks below it.
	if !CanManageRole(RoleModerator, RoleMember, RoleGuest) {
		t.Fatal("a moderator should manage members")
	}
	if !CanManageRole(RoleModerator, RoleGuest, RoleMember) {
		t.Fatal("a moderator should promote a guest to member")
	}
	// …and not touch its peers or superiors.
	if CanManageRole(RoleModerator, RoleModerator, RoleMember) {
		t.Fatal("moderators must not demote each other")
	}
	if CanManageRole(RoleModerator, RoleAdmin, RoleMember) {
		t.Fatal("a moderator must not demote an admin")
	}
}

func TestAdminManagesModerators(t *testing.T) {
	if !CanManageRole(RoleAdmin, RoleModerator, RoleMember) {
		t.Fatal("an admin should be able to demote a moderator")
	}
	if !CanManageRole(RoleAdmin, RoleMember, RoleModerator) {
		t.Fatal("an admin should be able to promote a member to moderator")
	}
	if CanManageRole(RoleAdmin, RoleAdmin, RoleMember) {
		t.Fatal("admins still must not demote each other")
	}
}

func TestOwnershipTransferIsItsOwnDoor(t *testing.T) {
	// Modelling transfer as a role edit would let one side complete it alone.
	// CanManageRole must keep refusing anything touching owner...
	if CanManageRole(RoleOwner, RoleAdmin, RoleOwner) {
		t.Fatal("promotion to owner must not be a role edit")
	}
	if CanManageRole(RoleOwner, RoleOwner, RoleAdmin) {
		t.Fatal("demoting the owner must not be a role edit")
	}
	// ...and the dedicated door must be owner-only.
	if !CanTransferOwnership(RoleOwner, RoleAdmin) {
		t.Fatal("an owner should be able to offer ownership to an admin")
	}
	if !CanTransferOwnership(RoleOwner, RoleMember) {
		t.Fatal("an owner should be able to offer ownership to a member")
	}
	for _, actor := range []string{RoleAdmin, RoleModerator, RoleMember, RoleGuest, "bogus"} {
		if CanTransferOwnership(actor, RoleMember) {
			t.Errorf("%s must not be able to transfer ownership", actor)
		}
	}
	// A guest cannot receive it: handing the group to someone who cannot even
	// see it would orphan it.
	if CanTransferOwnership(RoleOwner, RoleGuest) {
		t.Fatal("a guest must not receive ownership")
	}
	if CanTransferOwnership(RoleOwner, RoleOwner) {
		t.Fatal("transferring to the existing owner is a no-op, not a transfer")
	}
}

func TestNewPermissionsAreKnown(t *testing.T) {
	for _, p := range []string{
		"create_tasks", "manage_calendar", "manage_album",
		// migration 084
		"manage_runs", "drive_run", "view_space_ops", "manage_roster", "report_incident",
	} {
		if !IsValidPermission(p) {
			t.Errorf("%s should be a known permission", p)
		}
	}
	// The count is asserted so that adding a permission forces a look at the
	// TypeScript mirror — that is the whole reason this line exists.
	if len(All) != 15 {
		t.Fatalf("expected 15 permissions, got %d", len(All))
	}
	// The owner still holds every one of them, including the new ones.
	owner := Resolve(RoleOwner, Layers{})
	for _, p := range All {
		if !owner.Has(p) {
			t.Errorf("owner missing %s", p)
		}
	}
}

func TestModeratorResolvesFromItsOwnPreset(t *testing.T) {
	l := Layers{TypeDefault: map[string][]string{
		"admin":     {"edit_settings", "create_tasks"},
		"moderator": {"create_tasks", "manage_album"},
		"member":    {"view_history"},
	}}
	got := Resolve(RoleModerator, l).List()
	want := []string{"create_tasks", "manage_album"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("moderator perms = %v, want %v", got, want)
	}
	// A type with no moderator preset denies rather than inheriting admin's.
	bare := Resolve(RoleModerator, Layers{TypeDefault: map[string][]string{"admin": {"edit_settings"}}})
	if len(bare.List()) != 0 {
		t.Fatalf("an absent moderator preset must deny, got %v", bare.List())
	}
}

// ── removal is gated by RANK, not just by the permission ──

func TestCanRemoveMember(t *testing.T) {
	cases := []struct {
		actor, target string
		want          bool
		why           string
	}{
		{RoleOwner, RoleAdmin, true, "an owner may remove an admin"},
		{RoleAdmin, RoleModerator, true, "an admin outranks a moderator"},
		{RoleModerator, RoleMember, true, "a moderator may remove a member"},
		{RoleMember, RoleGuest, true, "rank is what decides, not the role name"},

		// The whole reason this function exists: migration 073 grants
		// moderators remove_members, so the permission check alone would let
		// one remove the owner and orphan the group.
		{RoleModerator, RoleOwner, false, "a moderator must not remove the owner"},
		{RoleAdmin, RoleOwner, false, "an admin must not remove the owner"},
		{RoleOwner, RoleOwner, false, "nothing outranks an owner, including an owner"},

		{RoleAdmin, RoleAdmin, false, "two admins removing each other is a race, not a policy"},
		{RoleModerator, RoleModerator, false, "peers cannot remove peers"},
		{RoleMember, RoleAdmin, false, "you cannot remove upwards"},
		{"bogus", RoleMember, false, "an unknown actor role denies"},
		{RoleAdmin, "bogus", false, "an unknown target role denies"},
	}
	for _, c := range cases {
		if got := CanRemoveMember(c.actor, c.target); got != c.want {
			t.Errorf("%s: CanRemoveMember(%q,%q) = %v, want %v", c.why, c.actor, c.target, got, c.want)
		}
	}
}

// Every role that holds remove_members by default must still be unable to
// remove an owner. This is the pairing the route depends on: permission AND
// rank, never permission alone.
func TestRemovePermissionNeverReachesTheOwner(t *testing.T) {
	for _, r := range SortedRoles() {
		if CanRemoveMember(r, RoleOwner) {
			t.Errorf("%s must not be able to remove the owner", r)
		}
	}
}

// ── role catalog (migration 084) ──

var testCatalog = []RoleDef{
	{Key: "principal", Label: "Principal", Rank: RoleOwner},
	{Key: "transport_manager", Label: "Transport Manager", Rank: RoleAdmin,
		Permissions: []string{"manage_runs", "view_space_ops"}},
	{Key: "driver", Label: "Bus Driver", Rank: RoleMember,
		Permissions: []string{"drive_run", "report_incident"}},
	{Key: "parent", Label: "Parent", Rank: RoleMember, Permissions: []string{}},
	{Key: "teacher", Label: "Teacher", Rank: RoleMember},
}

var testTypeDefaults = map[string][]string{
	"admin":  {"invite_members", "view_history"},
	"member": {"view_history", "start_navigation"},
	"guest":  {},
}

func resolveWithKey(roleKey, role string) []string {
	cat, set := CatalogLayer(testCatalog, roleKey, role)
	return Resolve(role, Layers{
		TypeDefault:      testTypeDefaults,
		RoleCatalog:      cat,
		RoleCatalogIsSet: set,
	}).List()
}

func TestCatalogLayerReplacesRankDefault(t *testing.T) {
	// A driver holding start_navigation would mean the bus can be re-routed by
	// the person driving it. The layer replaces, it does not merge.
	got := resolveWithKey("driver", RoleMember)
	want := []string{"drive_run", "report_incident"}
	if !eqStrings(got, want) {
		t.Errorf("driver = %v, want %v", got, want)
	}
}

func TestCatalogAbsentPermissionsInheritRank(t *testing.T) {
	// nil Permissions means "this role is just a label" — inherit the rank.
	if got := resolveWithKey("teacher", RoleMember); !eqStrings(got, testTypeDefaults["member"]) {
		t.Errorf("teacher = %v, want the member default", got)
	}
	// An EMPTY list is different: it grants nothing. A parent's access comes
	// from space links, never from a permission.
	if got := resolveWithKey("parent", RoleMember); len(got) != 0 {
		t.Errorf("parent = %v, want nothing", got)
	}
}

// The escalation case. role_key lives on chat_members independently of role, so
// a stale or tampered key naming a higher-ranked entry must not hand over that
// entry's permissions.
func TestCatalogRankMismatchDoesNotEscalate(t *testing.T) {
	got := resolveWithKey("transport_manager", RoleMember)
	if !eqStrings(got, testTypeDefaults["member"]) {
		t.Errorf("rank mismatch = %v, want the member default", got)
	}
	for _, p := range []Permission{PermManageRuns, PermViewSpaceOps} {
		for _, g := range got {
			if g == string(p) {
				t.Fatalf("rank mismatch leaked %s", p)
			}
		}
	}
}

func TestCatalogFallsThroughWhenAbsent(t *testing.T) {
	cases := []struct {
		defs []RoleDef
		key  string
		role string
		why  string
	}{
		{testCatalog, "astronaut", RoleMember, "unknown key"},
		{testCatalog, "", RoleMember, "no key"},
		{nil, "driver", RoleMember, "no catalog"},
		{[]RoleDef{}, "driver", RoleMember, "empty catalog"},
	}
	for _, c := range cases {
		if _, set := CatalogLayer(c.defs, c.key, c.role); set {
			t.Errorf("%s: layer should be absent", c.why)
		}
	}
}

func TestCatalogSitsBelowGroupOverride(t *testing.T) {
	cat, set := CatalogLayer(testCatalog, "driver", RoleMember)
	got := Resolve(RoleMember, Layers{
		TypeDefault:      testTypeDefaults,
		RoleCatalog:      cat,
		RoleCatalogIsSet: set,
		GroupOverride:    map[string][]string{"member": {"view_history"}},
	})
	if !got.Has(PermViewHistory) || got.Has(PermDriveRun) {
		t.Errorf("group override must beat the catalog, got %v", got.List())
	}
}

func TestCatalogCannotReduceTheOwner(t *testing.T) {
	got := Resolve(RoleOwner, Layers{RoleCatalog: []string{}, RoleCatalogIsSet: true})
	if len(got.List()) != len(All) {
		t.Errorf("owner must hold everything, got %v", got.List())
	}
}

// All-or-nothing: one bad entry rejects the whole catalog, because dropping just
// the bad entry resolves those members to their bare rank default, which for a
// Driver is MORE than the catalog intended.
func TestParseRoleCatalogRejectsWholeCatalog(t *testing.T) {
	bad := []struct {
		raw string
		why string
	}{
		{`[{"key":"x","rank":"superuser"}]`, "unknown rank"},
		{`[{"key":"x","rank":"member","permissions":["delete_everything"]}]`, "unknown permission"},
		{`[{"key":"","rank":"member"}]`, "empty key"},
		{`[{"key":"x","rank":"member"},{"key":"x","rank":"guest"}]`, "duplicate key"},
		{`{"not":"an array"}`, "wrong shape"},
		{`[`, "malformed json"},
	}
	for _, c := range bad {
		if _, err := ParseRoleCatalog([]byte(c.raw)); err == nil {
			t.Errorf("%s: expected rejection", c.why)
		}
		if err := ValidateRoleCatalog([]byte(c.raw)); err == nil {
			t.Errorf("%s: validate must agree with parse", c.why)
		}
	}
	good := `[{"key":"driver","label":"Bus Driver","rank":"member","permissions":["drive_run"]}]`
	defs, err := ParseRoleCatalog([]byte(good))
	if err != nil {
		t.Fatalf("valid catalog rejected: %v", err)
	}
	if len(defs) != 1 || FindRole(defs, "driver") == nil {
		t.Errorf("parsed catalog wrong: %+v", defs)
	}
	if empty, err := ParseRoleCatalog(nil); err != nil || empty != nil {
		t.Errorf("no catalog must parse to nothing, got %v %v", empty, err)
	}
}

func eqStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
