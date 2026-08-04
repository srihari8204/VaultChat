package routes

import (
	"testing"

	"vaultchat/backend-go/internal/groups"
)

// The route layer's job is to load the three layers and delegate. These tests
// pin the two things the route itself decides: the legacy fallback, and that a
// malformed permission column can never grant anything.

func typedMem(role string, defaults map[string][]string) *chatsMem {
	gt := "family"
	return &chatsMem{Role: role, ChatType: "group", GroupType: &gt, typeDefaults: defaults}
}

func legacyMem(role string) *chatsMem {
	return &chatsMem{Role: role, ChatType: "group"} // GroupType nil = pre-066 group
}

func TestLegacyGroupKeepsAdminOnlyRule(t *testing.T) {
	// The whole backward-compatibility promise: a group with no type must
	// behave exactly as it did before migration 066.
	for _, p := range groups.All {
		if !legacyMem("admin").can(p) {
			t.Errorf("legacy admin should hold %s", p)
		}
		if !legacyMem("owner").can(p) {
			t.Errorf("legacy owner should hold %s", p)
		}
		if legacyMem("member").can(p) {
			t.Errorf("legacy member should NOT hold %s", p)
		}
	}
}

func TestTypedGroupUsesTheMatrixNotTheRole(t *testing.T) {
	defaults := map[string][]string{"member": {"view_history"}}
	m := typedMem("member", defaults)
	if !m.can(groups.PermViewHistory) {
		t.Fatal("typed member should hold the granted permission")
	}
	if m.can(groups.PermRemoveMembers) {
		t.Fatal("typed member must not hold an ungranted permission")
	}
}

func TestTypedAdminIsNotAutomaticallyOmnipotent(t *testing.T) {
	// A typed group's admin holds exactly what its matrix says — unlike the
	// legacy rule, where admin implied everything.
	m := typedMem("admin", map[string][]string{"admin": {"view_history"}})
	if !m.can(groups.PermViewHistory) {
		t.Fatal("admin should hold view_history")
	}
	if m.can(groups.PermEditSettings) {
		t.Fatal("typed admin must not hold what the matrix withholds")
	}
}

func TestOwnerAlwaysActsEvenInATypedGroup(t *testing.T) {
	m := typedMem("owner", map[string][]string{"owner": {}})
	for _, p := range groups.All {
		if !m.can(p) {
			t.Fatalf("owner must always hold %s", p)
		}
	}
}

func TestMalformedPermissionColumnGrantsNothing(t *testing.T) {
	// A corrupt or hand-edited JSONB column must fail closed, never open.
	if got := chatsPermMap([]byte("{not json")); got != nil {
		t.Fatalf("malformed map should be nil, got %v", got)
	}
	list, set := chatsPermList([]byte("[nope"))
	if set || list != nil {
		t.Fatalf("malformed grant should be absent, got %v set=%v", list, set)
	}
	gt := "family"
	m := &chatsMem{Role: "member", GroupType: &gt, typeDefaults: chatsPermMap([]byte("{oops"))}
	for _, p := range groups.All {
		if m.can(p) {
			t.Fatalf("corrupt layer must grant nothing, granted %s", p)
		}
	}
}

func TestEmptyGrantIsDistinctFromAbsentGrant(t *testing.T) {
	// "[]" revokes; absent falls through. Collapsing them would make it
	// impossible to strip one member's rights.
	list, set := chatsPermList([]byte("[]"))
	if !set || len(list) != 0 {
		t.Fatalf(`"[]" should be an explicit empty grant, got %v set=%v`, list, set)
	}
	if _, set := chatsPermList(nil); set {
		t.Fatal("nil column must read as absent, not empty")
	}

	defaults := map[string][]string{"member": {"view_history"}}
	gt := "family"
	revoked := &chatsMem{Role: "member", GroupType: &gt, typeDefaults: defaults,
		memberGrants: []string{}, memberGrantSet: true}
	if revoked.can(groups.PermViewHistory) {
		t.Fatal("explicit empty grant must revoke")
	}
	fallthru := &chatsMem{Role: "member", GroupType: &gt, typeDefaults: defaults}
	if !fallthru.can(groups.PermViewHistory) {
		t.Fatal("absent grant must fall through to the type default")
	}
}

func TestGuestHoldsNothingByDefault(t *testing.T) {
	m := typedMem("guest", map[string][]string{"guest": {}})
	for _, p := range groups.All {
		if m.can(p) {
			t.Fatalf("guest should not hold %s", p)
		}
	}
}

func TestGroupMetaReportsLegacyAdminAsFullyPermitted(t *testing.T) {
	// The client gates its UI on `permissions`; for a legacy group that list
	// must match what the server will actually honour, or buttons lie.
	gm := chatsBuildGroupMeta(legacyMem("admin"), nil, nil, "")
	if len(gm.Permissions) != len(groups.All) {
		t.Fatalf("legacy admin should report every permission, got %v", gm.Permissions)
	}
	if gm.Privacy != "private" {
		t.Fatalf("privacy should default to private, got %q", gm.Privacy)
	}
	if got := chatsBuildGroupMeta(legacyMem("member"), nil, nil, ""); len(got.Permissions) != 0 {
		t.Fatalf("legacy member should report none, got %v", got.Permissions)
	}
}

func TestPrivacyValidation(t *testing.T) {
	for _, ok := range []string{"private", "invite_only"} {
		if !chatsValidPrivacy(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "public", "Private", "open"} {
		if chatsValidPrivacy(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestCapExceededDetection(t *testing.T) {
	if !chatsCapExceeded(errString("ERROR: group_member_cap_exceeded: 3 of 3 seats used")) {
		t.Fatal("should recognise the trigger's error")
	}
	if chatsCapExceeded(errString("connection refused")) {
		t.Fatal("must not misread an unrelated error as a cap rejection")
	}
	if chatsCapExceeded(nil) {
		t.Fatal("nil is not a cap error")
	}
}

func TestNilIfEmpty(t *testing.T) {
	if chatsNilIfEmpty("") != nil {
		t.Fatal(`"" should store as NULL`)
	}
	if got := chatsNilIfEmpty("home"); got == nil || *got != "home" {
		t.Fatal("non-empty should pass through")
	}
}

type errString string

func (e errString) Error() string { return string(e) }
