// Package groups holds the Groups & Circles permission model.
//
// It is deliberately PURE: no database, no HTTP, no globals. Permission
// resolution is the thing every mutating group endpoint must agree on, so it
// lives in one testable place rather than being re-derived per handler. The
// route layer loads the three JSONB layers (see migration 070) and calls
// Resolve; it never reimplements the precedence rules.
//
// Precedence, most specific wins:
//
//	member grant  (chat_members.permission_grants)  — this one member
//	group override(chats.permission_overrides)      — this group, per role
//	role catalog  (group_type_config.role_catalog)  — this member's role_key
//	type default  (group_type_config.default_permissions)
//
// A present layer REPLACES the layer beneath it rather than merging into it.
// That is a deliberate choice: merge semantics make it impossible to REVOKE a
// permission at a more specific layer, which is exactly what an admin demoting
// someone's rights needs to do. The cost is that a grant must list the full set
// it intends, which is explicit and therefore auditable.
package groups

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

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
	PermCreateTasks      Permission = "create_tasks"
	PermManageCalendar   Permission = "manage_calendar"
	PermManageAlbum      Permission = "manage_album"

	// ── Spaces & Operations (migration 084) ──
	// PermDriveRun is deliberately NOT implied by PermManageRuns: the person who
	// builds the timetable and the person behind the wheel are different jobs,
	// and a dispatcher who could silently mark riders boarded would make the
	// manifest worthless as a record.
	PermManageRuns     Permission = "manage_runs"
	PermDriveRun       Permission = "drive_run"
	PermViewSpaceOps   Permission = "view_space_ops"
	PermManageRoster   Permission = "manage_roster"
	PermReportIncident Permission = "report_incident"
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
	PermCreateTasks,
	PermManageCalendar,
	PermManageAlbum,
	PermManageRuns,
	PermDriveRun,
	PermViewSpaceOps,
	PermManageRoster,
	PermReportIncident,
}

// Roles, ordered least to most privileged.
const (
	RoleGuest  = "guest"
	RoleMember = "member"
	// Moderator sits between member and admin: manages people and content, but
	// not the group itself and not other people's roles.
	RoleModerator = "moderator"
	RoleAdmin     = "admin"
	RoleOwner     = "owner"
)

// Layers carries the three JSONB permission maps as loaded from the database.
// Each maps a role name to the permissions granted at that layer. A nil map
// means "this layer says nothing" and is skipped.
//
// MemberGrant is role-independent — it is already scoped to one member — so it
// is a plain slice rather than a map. A non-nil empty slice is meaningful: it
// revokes everything for that member.
type Layers struct {
	TypeDefault   map[string][]string
	GroupOverride map[string][]string

	// RoleCatalog is the member's display-role entry (migration 084), sitting
	// between the type default and the group override. Set only when the member
	// has a role_key that the type's catalog knows AND that entry lists
	// permissions; an entry with no list means "use the rank default", so it
	// leaves this layer absent rather than granting nothing.
	RoleCatalog      []string
	RoleCatalogIsSet bool

	MemberGrant      []string
	MemberGrantIsSet bool
}

// RoleDef is one entry in a space type's role catalog: a display role mapped
// onto exactly one rank.
//
// Rank is what governs member management — CanRemoveMember and CanManageRole
// never see Key. A "Transport Manager" is an admin wearing a label, so it cannot
// remove a "Principal" for the same reason no admin can remove an owner. Job
// titles are presentation; the ladder is not.
type RoleDef struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Rank  string `json:"rank"`
	// Permissions REPLACES the rank's type default when non-nil, matching every
	// other layer. Nil and empty differ: nil means "inherit the rank default",
	// empty means "this role holds nothing" — which is exactly a Parent, whose
	// access comes from space links rather than from any permission.
	Permissions []string `json:"permissions"`
}

// ParseRoleCatalog decodes a stored role_catalog and rejects the WHOLE catalog
// on any bad entry, rather than skipping the bad one.
//
// All-or-nothing is the point. A catalog with one unknown rank is a catalog
// someone hand-edited or half-migrated, and silently dropping the entry would
// leave those members resolving to their bare rank default — which for a Driver
// (rank member) is *more* than the catalog intended, not less. Failing the whole
// layer falls back to a state the type config already describes, and the loud
// log says why.
func ParseRoleCatalog(raw []byte) ([]RoleDef, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var defs []RoleDef
	if err := json.Unmarshal(raw, &defs); err != nil {
		return nil, fmt.Errorf("role catalog: %w", err)
	}
	seen := make(map[string]bool, len(defs))
	for _, d := range defs {
		if d.Key == "" {
			return nil, errors.New("role catalog: entry with empty key")
		}
		if seen[d.Key] {
			return nil, fmt.Errorf("role catalog: duplicate key %q", d.Key)
		}
		seen[d.Key] = true
		if !IsValidRole(d.Rank) {
			return nil, fmt.Errorf("role catalog: %q has unknown rank %q", d.Key, d.Rank)
		}
		for _, p := range d.Permissions {
			if !IsValidPermission(p) {
				return nil, fmt.Errorf("role catalog: %q lists unknown permission %q", d.Key, p)
			}
		}
	}
	return defs, nil
}

// ValidateRoleCatalog reports whether a catalog is storable. Same rules as
// ParseRoleCatalog — this is the write-side name for the same check, so a future
// admin endpoint and the read path cannot disagree about what is valid.
func ValidateRoleCatalog(raw []byte) error {
	_, err := ParseRoleCatalog(raw)
	return err
}

// FindRole returns the catalog entry for key, or nil.
func FindRole(defs []RoleDef, key string) *RoleDef {
	for i := range defs {
		if defs[i].Key == key {
			return &defs[i]
		}
	}
	return nil
}

// CatalogLayer builds the role-catalog layer for a member.
//
// It returns "absent" (false) unless the key is known, its rank MATCHES the
// member's actual rank, and the entry lists permissions. The rank match is a
// security check, not a tidiness one: role_key is stored on chat_members
// independently of role, so a stale or tampered key naming a higher-ranked
// entry would otherwise hand a member that entry's permissions. Mismatch falls
// through to the rank default.
func CatalogLayer(defs []RoleDef, roleKey, role string) ([]string, bool) {
	if roleKey == "" || len(defs) == 0 {
		return nil, false
	}
	d := FindRole(defs, roleKey)
	if d == nil || d.Rank != role || d.Permissions == nil {
		return nil, false
	}
	return d.Permissions, true
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
	case RoleGuest, RoleMember, RoleModerator, RoleAdmin, RoleOwner:
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
	case l.RoleCatalogIsSet:
		chosen = l.RoleCatalog
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
		// An admin may manage everyone below admin, but not another admin —
		// otherwise two admins can demote each other in a loop.
		return targetRole == RoleModerator || targetRole == RoleMember || targetRole == RoleGuest
	case RoleModerator:
		// A moderator manages the ranks below it and cannot promote anyone into
		// or above its own rank — a moderator who could mint admins would make
		// the distinction meaningless.
		if newRole == RoleAdmin || newRole == RoleModerator {
			return false
		}
		return targetRole == RoleMember || targetRole == RoleGuest
	}
	return false
}

// CanTransferOwnership reports whether actor may hand the group to target.
//
// Deliberately NOT part of CanManageRole. Ownership transfer is a two-party
// operation — the current owner offers, the new owner accepts — and modelling
// it as a role edit would let one side complete it alone. CanManageRole
// therefore refuses anything touching owner, and this is the only door.
func CanTransferOwnership(actorRole, targetRole string) bool {
	if actorRole != RoleOwner {
		return false
	}
	// The target must be an existing member, and cannot already be the owner.
	switch targetRole {
	case RoleAdmin, RoleModerator, RoleMember:
		return true
	}
	// Guests are excluded: handing a group to someone who cannot even see it
	// would orphan it.
	return false
}

// CanRemoveMember reports whether actor may remove target from the group.
//
// Holding remove_members is NOT sufficient on its own. The 069 presets give a
// moderator that permission, so without a rank check a moderator could remove
// the owner and orphan the group — and two admins could remove each other in a
// race. Rank must strictly exceed the target's, which also makes the owner
// unremovable by anyone: nothing outranks an owner.
//
// Leaving is not covered here. Walking out is always your own right, and no
// rank can take it away — the route handles self-removal before ever asking.
func CanRemoveMember(actorRole, targetRole string) bool {
	if !IsValidRole(actorRole) || !IsValidRole(targetRole) {
		return false
	}
	return rank(actorRole) > rank(targetRole)
}

// SeatsRemaining reports how many seats a group has left. It is advisory only:
// the authoritative check is the database trigger in migration 070, which
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
	r := []string{RoleOwner, RoleAdmin, RoleModerator, RoleMember, RoleGuest}
	sort.SliceStable(r, func(i, j int) bool { return rank(r[i]) > rank(r[j]) })
	return r
}

func rank(role string) int {
	switch role {
	case RoleOwner:
		return 4
	case RoleAdmin:
		return 3
	case RoleModerator:
		return 2
	case RoleMember:
		return 1
	case RoleGuest:
		return 0
	}
	return -1
}
