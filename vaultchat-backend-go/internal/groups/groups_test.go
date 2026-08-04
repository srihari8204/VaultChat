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
	want := []string{RoleOwner, RoleAdmin, RoleMember, RoleGuest}
	if got := SortedRoles(); !reflect.DeepEqual(got, want) {
		t.Fatalf("SortedRoles() = %v, want %v", got, want)
	}
}
