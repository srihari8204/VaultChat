// Package groups holds the Groups & Circles permission model.
//
// It is deliberately PURE: no database, no HTTP, no globals. Permission
// resolution is the thing every mutating group endpoint must agree on, so it
// lives in one testable place rather than being re-derived per handler. The
// route layer loads the three JSONB layers (see migration 066) and calls
// Resolve; it never reimplements the precedence rules.
//
// Precedence, most specific wins:
//
//	member grant  (chat_members.permission_grants)  — this one member
//	group override(chats.permission_overrides)      — this group, per role
//	type default  (group_type_config.default_permissions)
//
// A present layer REPLACES the layer beneath it rather than merging into it.
// That is a deliberate choice: merge semantics make it impossible to REVOKE a
// permission at a more specific layer, which is exactly what an admin demoting
// someone's rights needs to do. The cost is that a grant must list the full set
// it intends, which is explicit and therefore auditable.
package groups

import "sort"

// Permission is one capability inside a group.
type Permission string

const (
	PermInviteMembers    Permission = "invite_members"
	PermRemoveMembers    Permission = "remove_members"
	PermManageZones      Permission = "manage_zones"
	PermEditSettings     Permission = "edit_settings"
	PermViewHistory      Permission = "view_history"
	PermStartNavigation  Permission = "start_navigation"
	PermSendAnnouncement Permission = "send_announcements"
)

// All is the complete permission set, in a stable order for display and tests.
var All = []Permission{
	PermInviteMembers,
	PermRemoveMembers,
	PermManageZones,
	PermEditSettings,
	PermViewHistory,
	PermStartNavigation,
	PermSendAnnouncement,
}

// Roles, ordered least to most privileged.
const (
	RoleGuest  = "guest"
	RoleMember = "member"
	RoleAdmin  = "admin"
	RoleOwner  = "owner"
)

// Layers carries the three JSONB permission maps as loaded from the database.
// Each maps a role name to the permissions granted at that layer. A nil map
// means "this layer says nothing" and is skipped.
//
// MemberGrant is role-independent — it is already scoped to one member — so it
// is a plain slice rather than a map. A non-nil empty slice is meaningful: it
// revokes everything for that member.
type Layers struct {
	TypeDefault      map[string][]string
	GroupOverride    map[string][]string
	MemberGrant      []string
	MemberGrantIsSet bool
}

// Set is a resolved permission set.
type Set map[Permission]bool

// Has reports whether the set contains p.
func (s Set) Has(p Permission) bool { return s[p] }

// List returns the granted permissions in All order — stable for JSON output.
func (s Set) List() []string {
	out := make([]string, 0, len(s))
	for _, p := range All {
		if s[p] {
			out = append(out, string(p))
		}
	}
	return out
}

// IsValidPermission reports whether name is a permission this build knows.
// Unknown names in stored JSON are ignored rather than trusted, so a stale or
// hand-edited row cannot invent a capability.
func IsValidPermission(name string) bool {
	for _, p := range All {
		if string(p) == name {
			return true
		}
	}
	return false
}

// IsValidRole reports whether name is a role this build knows.
func IsValidRole(name string) bool {
	switch name {
	case RoleGuest, RoleMember, RoleAdmin, RoleOwner:
		return true
	}
	return false
}

// Resolve computes the effective permission set for a member.
//
// The owner always holds every permission and cannot be reduced by any layer —
// otherwise a group could be permanently orphaned by an override that locks its
// own owner out of settings.
//
// An unknown role resolves to the empty set (deny), never to a default, so a
// corrupted role column fails closed.
func Resolve(role string, l Layers) Set {
	if role == RoleOwner {
		s := make(Set, len(All))
		for _, p := range All {
			s[p] = true
		}
		return s
	}
	if !IsValidRole(role) {
		return Set{}
	}

	// Most specific layer that is present wins outright.
	var chosen []string
	switch {
	case l.MemberGrantIsSet:
		chosen = l.MemberGrant
	case l.GroupOverride != nil && hasRole(l.GroupOverride, role):
		chosen = l.GroupOverride[role]
	case l.TypeDefault != nil && hasRole(l.TypeDefault, role):
		chosen = l.TypeDefault[role]
	default:
		return Set{}
	}

	s := make(Set, len(chosen))
	for _, name := range chosen {
		if IsValidPermission(name) {
			s[Permission(name)] = true
		}
	}
	return s
}

func hasRole(m map[string][]string, role string) bool {
	_, ok := m[role]
	return ok
}

// CanManageRole reports whether an actor with actorRole may change a target's
// role to/from targetRole. Only the owner may touch an owner, and nobody may
// promote anyone to owner through this path (ownership transfer is a separate,
// deliberate operation).
func CanManageRole(actorRole, targetRole, newRole string) bool {
	if !IsValidRole(actorRole) || !IsValidRole(targetRole) || !IsValidRole(newRole) {
		return false
	}
	if newRole == RoleOwner || targetRole == RoleOwner {
		return false // ownership transfer is not a role edit
	}
	switch actorRole {
	case RoleOwner:
		return true
	case RoleAdmin:
		// An admin may manage members and guests, but not other admins —
		// otherwise two admins can demote each other in a loop.
		return targetRole == RoleMember || targetRole == RoleGuest
	}
	return false
}

// SeatsRemaining reports how many seats a group has left. It is advisory only:
// the authoritative check is the database trigger in migration 066, which
// serialises on the chat row. Use this for UI and early rejection, never as the
// sole gate — an application-level check alone is racy by construction.
func SeatsRemaining(activeMembers, maxMembers int) int {
	if maxMembers <= 0 {
		return -1 // uncapped (untyped legacy group)
	}
	if activeMembers >= maxMembers {
		return 0
	}
	return maxMembers - activeMembers
}

// SortedRoles returns known roles most privileged first, for display.
func SortedRoles() []string {
	r := []string{RoleOwner, RoleAdmin, RoleMember, RoleGuest}
	sort.SliceStable(r, func(i, j int) bool { return rank(r[i]) > rank(r[j]) })
	return r
}

func rank(role string) int {
	switch role {
	case RoleOwner:
		return 3
	case RoleAdmin:
		return 2
	case RoleMember:
		return 1
	case RoleGuest:
		return 0
	}
	return -1
}
