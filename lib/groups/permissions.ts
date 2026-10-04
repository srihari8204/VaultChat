// lib/groups/permissions.ts — the client half of the Groups & Circles
// permission model. A DELIBERATE MIRROR of internal/groups/groups.go: the two
// must agree, so the precedence rules live in one shape on each side and are
// tested with the same cases.
//
// SECURITY BOUNDARY: everything here is PRESENTATION. `can()` decides whether to
// draw a button; it never decides whether an action is allowed. The server
// re-resolves the same layers on every mutating endpoint, and that check is the
// real one. Treating a client permission result as authoritative would let any
// modified client do anything.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/permissions.ts

export type Permission =
  | 'invite_members'
  | 'remove_members'
  | 'manage_zones'
  | 'edit_settings'
  | 'view_history'
  | 'start_navigation'
  | 'send_announcements'
  | 'create_tasks'
  | 'manage_calendar'
  | 'manage_album'
  // ── Spaces & Operations (migration 084) ──
  | 'manage_runs'
  | 'drive_run'
  | 'view_space_ops'
  | 'manage_roster'
  | 'report_incident';

/**
 * Complete set, in a stable display order. Mirrors groups.All in Go, and the
 * mirroring is load-bearing in a direction that is easy to miss:
 * resolvePermissions DROPS names this list does not know, so a permission the
 * server grants but this file has not heard of is silently withheld from the
 * UI. Drift here hides features from the people entitled to them.
 */
export const ALL_PERMISSIONS: Permission[] = [
  'invite_members',
  'remove_members',
  'manage_zones',
  'edit_settings',
  'view_history',
  'start_navigation',
  'send_announcements',
  'create_tasks',
  'manage_calendar',
  'manage_album',
  'manage_runs',
  'drive_run',
  'view_space_ops',
  'manage_roster',
  'report_incident',
];

export type GroupRole = 'guest' | 'member' | 'moderator' | 'admin' | 'owner';

/** Most privileged first. Mirrors groups.SortedRoles in Go. */
export const ROLES: GroupRole[] = ['owner', 'admin', 'moderator', 'member', 'guest'];

/** Rank, for "may I act on this person?". Mirrors rank() in Go. */
const RANK: Record<GroupRole, number> = {
  owner: 4, admin: 3, moderator: 2, member: 1, guest: 0,
};

/** Human labels for the permission list in group settings. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  invite_members: 'Invite members',
  remove_members: 'Remove members',
  manage_zones: 'Manage safe zones',
  edit_settings: 'Edit group settings',
  view_history: 'View location history',
  start_navigation: 'Start group navigation',
  send_announcements: 'Send announcements',
  create_tasks: 'Create shared tasks',
  manage_calendar: 'Manage the calendar',
  manage_album: 'Manage the shared album',
  manage_runs: 'Create and assign runs',
  drive_run: 'Drive a run',
  view_space_ops: 'See the whole space',
  manage_roster: 'Manage the roster',
  report_incident: 'Report incidents',
};

export const ROLE_LABELS: Record<GroupRole, string> = {
  owner: 'Owner', admin: 'Admin', moderator: 'Moderator', member: 'Member', guest: 'Guest',
};

export const ROLE_BLURBS: Record<GroupRole, string> = {
  owner: 'Runs the group. One person, and only they can hand it over.',
  admin: 'Everything except giving the group away.',
  moderator: 'Manages people and content, but not the group settings.',
  member: 'Takes part in the group.',
  guest: 'Can see the group, but takes no actions.',
};

/**
 * The three stored layers, as delivered by GET /chats/:id.
 *
 * `memberGrant` distinguishes absent from empty on purpose: `undefined` means
 * "this member has no grant row, fall through", while `[]` means "this member
 * is explicitly granted nothing". Collapsing those two would make it impossible
 * to revoke a permission from one person.
 */
export interface PermissionLayers {
  typeDefault?: Partial<Record<GroupRole, string[]>> | null;
  groupOverride?: Partial<Record<GroupRole, string[]>> | null;
  /** Layer 2 (migration 084) — see catalogLayer. */
  roleCatalog?: string[] | null;
  memberGrant?: string[] | null;
}

/**
 * One entry in a space type's role catalog: a display role mapped onto exactly
 * one rank. Mirrors groups.RoleDef in Go.
 *
 * `rank` is what governs member management. A "Transport Manager" is an admin
 * wearing a label — canRemoveMember never sees `key`.
 */
export interface RoleDef {
  key: string;
  label: string;
  rank: GroupRole;
  /** Absent = inherit the rank default. `[]` = holds nothing. The two differ. */
  permissions?: string[];
}

/**
 * Resolve the catalog layer for a member. Mirrors groups.CatalogLayer in Go.
 *
 * Returns null (layer absent) unless the key is known, its rank MATCHES the
 * member's actual rank, and the entry lists permissions. The rank match is a
 * security check: roleKey is stored independently of role, so a stale key
 * naming a higher-ranked entry must not hand over that entry's permissions.
 */
export function catalogLayer(
  defs: RoleDef[] | null | undefined,
  roleKey: string | null | undefined,
  role: string,
): string[] | null {
  if (!roleKey || !defs?.length) return null;
  const d = defs.find((x) => x.key === roleKey);
  if (!d || d.rank !== role || d.permissions == null) return null;
  return d.permissions;
}

/**
 * Validate a catalog before it is stored or trusted. Mirrors
 * groups.ParseRoleCatalog: all-or-nothing, because a catalog with one unknown
 * rank is a hand-edited catalog, and dropping just the bad entry silently
 * resolves those members to their bare rank default — which for a Driver is
 * MORE than the catalog intended, not less.
 */
export function validateRoleCatalog(defs: unknown): string | null {
  if (!Array.isArray(defs)) return 'catalog must be an array';
  const seen = new Set<string>();
  for (const raw of defs) {
    const d = raw as Partial<RoleDef>;
    if (!d || typeof d.key !== 'string' || d.key === '') return 'entry with empty key';
    if (seen.has(d.key)) return `duplicate key ${d.key}`;
    seen.add(d.key);
    if (typeof d.rank !== 'string' || !isRole(d.rank)) return `${d.key} has unknown rank ${String(d.rank)}`;
    if (d.permissions != null) {
      if (!Array.isArray(d.permissions)) return `${d.key} permissions must be an array`;
      for (const p of d.permissions) {
        if (!isPermission(p)) return `${d.key} lists unknown permission ${String(p)}`;
      }
    }
  }
  return null;
}

export function isPermission(name: string): name is Permission {
  return (ALL_PERMISSIONS as string[]).includes(name);
}

export function isRole(name: string): name is GroupRole {
  return (ROLES as string[]).includes(name);
}

/**
 * Resolve a member's effective permissions. A present layer REPLACES the one
 * beneath it — see the Go doc comment for why merge semantics were rejected.
 *
 * Owner always holds everything; an unknown role fails closed.
 */
export function resolvePermissions(role: string, layers: PermissionLayers): Set<Permission> {
  if (role === 'owner') return new Set(ALL_PERMISSIONS);
  if (!isRole(role)) return new Set();

  let chosen: string[] | undefined;
  if (layers.memberGrant != null) {
    chosen = layers.memberGrant;
  } else if (layers.groupOverride && layers.groupOverride[role] != null) {
    chosen = layers.groupOverride[role];
  } else if (layers.roleCatalog != null) {
    chosen = layers.roleCatalog;
  } else if (layers.typeDefault && layers.typeDefault[role] != null) {
    chosen = layers.typeDefault[role];
  }
  if (!chosen) return new Set();

  // Unknown names in stored JSON are dropped, never trusted.
  return new Set(chosen.filter(isPermission));
}

/** Convenience wrapper for call sites: `can(perms, 'invite_members')`. */
export function can(perms: Set<Permission>, p: Permission): boolean {
  return perms.has(p);
}

/** Stable, ALL_PERMISSIONS-ordered list — for display and for tests. */
export function listPermissions(perms: Set<Permission>): Permission[] {
  return ALL_PERMISSIONS.filter((p) => perms.has(p));
}

/** Mirrors groups.CanManageRole in Go. */
export function canManageRole(actorRole: string, targetRole: string, newRole: string): boolean {
  if (!isRole(actorRole) || !isRole(targetRole) || !isRole(newRole)) return false;
  if (newRole === 'owner' || targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') {
    return targetRole === 'moderator' || targetRole === 'member' || targetRole === 'guest';
  }
  if (actorRole === 'moderator') {
    // A moderator who could promote someone to moderator or admin would make
    // the rank meaningless — anyone could grant themselves company.
    if (newRole === 'admin' || newRole === 'moderator') return false;
    return targetRole === 'member' || targetRole === 'guest';
  }
  return false;
}

/**
 * Mirrors groups.CanRemoveMember in Go. Holding `remove_members` is NOT enough:
 * moderators hold it by default, so without the rank comparison the UI would
 * offer a Remove button against the owner that the server then refuses.
 */
export function canRemoveMember(actorRole: string, targetRole: string): boolean {
  if (!isRole(actorRole) || !isRole(targetRole)) return false;
  return RANK[actorRole] > RANK[targetRole];
}

/**
 * Mirrors groups.CanTransferOwnership in Go. Its own door, not a role edit:
 * handing the group away demotes you irreversibly, and an admin who may
 * promote and demote must not be able to do it as a side effect.
 */
export function canTransferOwnership(actorRole: string, targetRole: string): boolean {
  if (actorRole !== 'owner') return false;
  return targetRole === 'admin' || targetRole === 'moderator' || targetRole === 'member';
}

/**
 * Seats left, or -1 when uncapped. ADVISORY ONLY — the authoritative check is
 * the database trigger in migration 070, which serialises on the group row.
 * A client-side check alone is racy by construction.
 */
export function seatsRemaining(activeMembers: number, maxMembers: number): number {
  if (maxMembers <= 0) return -1;
  return activeMembers >= maxMembers ? 0 : maxMembers - activeMembers;
}

/** Roles the role endpoint accepts. Untyped legacy groups keep their two-role world. */
const TYPED_ASSIGNABLE: GroupRole[] = ['admin', 'moderator', 'member', 'guest'];
const UNTYPED_ASSIGNABLE: GroupRole[] = ['admin', 'member'];

export interface MemberActions {
  /** Roles the actor may set on this member (may include the current one). */
  roles: GroupRole[];
  canRemove: boolean;
  canTransfer: boolean;
}

/**
 * The ONE client check for "what may I do to this member row", shared by
 * app/group-admin.tsx and app/group-members.tsx. Mirrors the server's member
 * role PATCH and member DELETE handlers: the actor needs remove_members (for
 * an untyped group the server reads that as "is admin or owner", chatsMem.can),
 * then the rank rules above decide whether THIS member is theirs to touch.
 * Presentation only — the server re-checks every call.
 */
export function memberActions(a: {
  actorRole: string;
  targetRole: string;
  isMe: boolean;
  /** true for a typed group (chat.groupType set). */
  typed: boolean;
  /** The caller's resolved permissions from GET /chats/:id. */
  permissions: readonly string[] | null | undefined;
}): MemberActions {
  const mayManage = a.typed
    ? (a.permissions ?? []).includes('remove_members')
    : a.actorRole === 'owner' || a.actorRole === 'admin';
  if (a.isMe) return { roles: [], canRemove: false, canTransfer: false };
  return {
    roles: mayManage
      ? (a.typed ? TYPED_ASSIGNABLE : UNTYPED_ASSIGNABLE).filter((r) => canManageRole(a.actorRole, a.targetRole, r))
      : [],
    canRemove: mayManage && canRemoveMember(a.actorRole, a.targetRole),
    canTransfer: canTransferOwnership(a.actorRole, a.targetRole),
  };
}

// ── self-check ──
if (require.main === module) {
  const famDefaults = {
    admin: ['invite_members', 'remove_members', 'manage_zones', 'edit_settings', 'view_history', 'start_navigation', 'send_announcements'],
    member: ['view_history', 'start_navigation'],
    guest: [] as string[],
  };
  const eq = (a: unknown[], b: unknown[]) => JSON.stringify(a) === JSON.stringify(b);

  // owner cannot be locked out, even by a hostile override
  const owner = resolvePermissions('owner', { typeDefault: famDefaults, groupOverride: { owner: [] } });
  if (listPermissions(owner).length !== ALL_PERMISSIONS.length) throw new Error('owner must hold everything');

  // type default applies
  if (!eq(listPermissions(resolvePermissions('member', { typeDefault: famDefaults })), ['view_history', 'start_navigation'])) {
    throw new Error('type default not applied');
  }

  // group override REPLACES the type default
  const ov = resolvePermissions('member', { typeDefault: famDefaults, groupOverride: { member: ['invite_members'] } });
  if (!ov.has('invite_members') || ov.has('view_history')) throw new Error('override must replace, not merge');

  // member grant beats everything
  const mg = resolvePermissions('member', {
    typeDefault: famDefaults, groupOverride: { member: ['invite_members'] }, memberGrant: ['view_history'],
  });
  if (!mg.has('view_history') || mg.has('invite_members')) throw new Error('member grant must win');

  // empty grant revokes; absent grant falls through — these must differ
  if (listPermissions(resolvePermissions('member', { typeDefault: famDefaults, memberGrant: [] })).length !== 0) {
    throw new Error('empty grant must revoke everything');
  }
  if (listPermissions(resolvePermissions('member', { typeDefault: famDefaults })).length === 0) {
    throw new Error('absent grant must fall through to the type default');
  }

  // fail closed
  if (listPermissions(resolvePermissions('superuser', { typeDefault: famDefaults })).length !== 0) throw new Error('unknown role must deny');
  if (listPermissions(resolvePermissions('member', {})).length !== 0) throw new Error('no layers must deny');
  if (listPermissions(resolvePermissions('guest', { typeDefault: famDefaults })).length !== 0) throw new Error('guest holds nothing by default');

  // unknown stored permission is dropped
  const junk = resolvePermissions('member', { typeDefault: { member: ['view_history', 'delete_everything'] } });
  if (!eq(listPermissions(junk), ['view_history'])) throw new Error('unknown permission must be dropped');

  // stable ordering regardless of stored order
  const unordered = resolvePermissions('member', { typeDefault: { member: ['send_announcements', 'invite_members', 'view_history'] } });
  if (!eq(listPermissions(unordered), ['invite_members', 'view_history', 'send_announcements'])) throw new Error('ordering unstable');

  // role management, same cases as the Go test
  const rm: [string, string, string, boolean][] = [
    ['owner', 'admin', 'member', true],
    ['admin', 'member', 'guest', true],
    ['admin', 'admin', 'member', false],
    ['admin', 'owner', 'member', false],
    ['owner', 'member', 'owner', false],
    ['member', 'member', 'admin', false],
    ['bogus', 'member', 'admin', false],
  ];
  for (const [a, t, n, want] of rm) {
    if (canManageRole(a, t, n) !== want) throw new Error(`canManageRole(${a},${t},${n}) !== ${want}`);
  }

  // moderator, same cases as the Go test
  const mod: [string, string, string, boolean][] = [
    ['admin', 'moderator', 'member', true],
    ['admin', 'member', 'moderator', true],
    ['moderator', 'member', 'guest', true],
    ['moderator', 'guest', 'member', true],
    ['moderator', 'member', 'moderator', false],
    ['moderator', 'member', 'admin', false],
    ['moderator', 'moderator', 'member', false],
    ['moderator', 'admin', 'member', false],
  ];
  for (const [a, t, n, want] of mod) {
    if (canManageRole(a, t, n) !== want) throw new Error(`canManageRole(${a},${t},${n}) !== ${want}`);
  }

  // removal is gated by RANK, not by the permission alone
  const rem: [string, string, boolean][] = [
    ['owner', 'admin', true],
    ['admin', 'moderator', true],
    ['moderator', 'member', true],
    ['moderator', 'owner', false],
    ['admin', 'owner', false],
    ['owner', 'owner', false],
    ['admin', 'admin', false],
    ['member', 'admin', false],
    ['bogus', 'member', false],
  ];
  for (const [a, t, want] of rem) {
    if (canRemoveMember(a, t) !== want) throw new Error(`canRemoveMember(${a},${t}) !== ${want}`);
  }
  for (const r of ROLES) {
    if (canRemoveMember(r, 'owner')) throw new Error(`${r} must not be able to remove the owner`);
  }

  // ownership transfer is owner-only, and never to a guest
  if (!canTransferOwnership('owner', 'admin')) throw new Error('owner should transfer to an admin');
  if (!canTransferOwnership('owner', 'member')) throw new Error('owner should transfer to a member');
  if (canTransferOwnership('owner', 'guest')) throw new Error('a guest cannot be handed the group');
  if (canTransferOwnership('admin', 'member')) throw new Error('only the owner may transfer');

  // every role and permission has display text — a missing label renders blank
  for (const r of ROLES) {
    if (!ROLE_LABELS[r] || !ROLE_BLURBS[r]) throw new Error(`role ${r} has no display text`);
  }
  for (const p of ALL_PERMISSIONS) {
    if (!PERMISSION_LABELS[p]) throw new Error(`permission ${p} has no label`);
  }

  // ── role catalog (migration 084) ──
  const catalog: RoleDef[] = [
    { key: 'principal', label: 'Principal', rank: 'owner' },
    { key: 'transport_manager', label: 'Transport Manager', rank: 'admin', permissions: ['manage_runs', 'view_space_ops'] },
    { key: 'driver', label: 'Bus Driver', rank: 'member', permissions: ['drive_run', 'report_incident'] },
    { key: 'parent', label: 'Parent', rank: 'member', permissions: [] },
    { key: 'teacher', label: 'Teacher', rank: 'member' },
  ];
  const withCatalog = (roleKey: string, role: string) =>
    resolvePermissions(role, { typeDefault: famDefaults, roleCatalog: catalogLayer(catalog, roleKey, role) });

  // the catalog REPLACES the rank default — a driver does not inherit
  // start_navigation, which is the entire point of the layer
  if (!eq(listPermissions(withCatalog('driver', 'member')), ['drive_run', 'report_incident'])) {
    throw new Error('catalog must replace the rank default');
  }
  // an entry with no permissions list inherits the rank default; an empty list revokes
  if (!eq(listPermissions(withCatalog('teacher', 'member')), ['view_history', 'start_navigation'])) {
    throw new Error('absent catalog permissions must inherit the rank default');
  }
  if (listPermissions(withCatalog('parent', 'member')).length !== 0) {
    throw new Error('an empty catalog list must grant nothing');
  }
  // a key whose rank does not match the member's rank must NOT apply — this is
  // the privilege-escalation case, not a tidiness one
  if (!eq(listPermissions(withCatalog('transport_manager', 'member')), ['view_history', 'start_navigation'])) {
    throw new Error('rank mismatch must fall through to the rank default');
  }
  // unknown key, absent key, empty catalog: all fall through
  if (!eq(listPermissions(withCatalog('astronaut', 'member')), ['view_history', 'start_navigation'])) {
    throw new Error('unknown role key must fall through');
  }
  if (catalogLayer(catalog, '', 'member') !== null) throw new Error('no key means no layer');
  if (catalogLayer([], 'driver', 'member') !== null) throw new Error('empty catalog means no layer');
  // group override still outranks the catalog
  const cov = resolvePermissions('member', {
    typeDefault: famDefaults,
    roleCatalog: catalogLayer(catalog, 'driver', 'member'),
    groupOverride: { member: ['view_history'] },
  });
  if (!cov.has('view_history') || cov.has('drive_run')) throw new Error('group override must beat the catalog');
  // owner is still untouchable by a catalog entry
  if (resolvePermissions('owner', { roleCatalog: [] }).size !== ALL_PERMISSIONS.length) {
    throw new Error('owner must hold everything regardless of catalog');
  }

  // catalog validation is all-or-nothing
  if (validateRoleCatalog(catalog) !== null) throw new Error('valid catalog rejected');
  const bad: unknown[][] = [
    [{ key: 'x', label: 'X', rank: 'superuser' }],
    [{ key: 'x', label: 'X', rank: 'member', permissions: ['delete_everything'] }],
    [{ key: '', label: 'X', rank: 'member' }],
    [{ key: 'x', label: 'X', rank: 'member' }, { key: 'x', label: 'Y', rank: 'guest' }],
  ];
  for (const b of bad) {
    if (validateRoleCatalog(b) === null) throw new Error(`invalid catalog accepted: ${JSON.stringify(b)}`);
  }

  // seats
  const seats: [number, number, number][] = [[2, 3, 1], [3, 3, 0], [4, 3, 0], [5, 0, -1]];
  for (const [act, max, want] of seats) {
    if (seatsRemaining(act, max) !== want) throw new Error(`seatsRemaining(${act},${max}) !== ${want}`);
  }

  console.log('groups/permissions self-check OK');
}
