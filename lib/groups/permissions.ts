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
  | 'send_announcements';

/** Complete set, in a stable display order. Mirrors groups.All in Go. */
export const ALL_PERMISSIONS: Permission[] = [
  'invite_members',
  'remove_members',
  'manage_zones',
  'edit_settings',
  'view_history',
  'start_navigation',
  'send_announcements',
];

export type GroupRole = 'guest' | 'member' | 'admin' | 'owner';

export const ROLES: GroupRole[] = ['owner', 'admin', 'member', 'guest'];

/** Human labels for the permission list in group settings. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  invite_members: 'Invite members',
  remove_members: 'Remove members',
  manage_zones: 'Manage safe zones',
  edit_settings: 'Edit group settings',
  view_history: 'View location history',
  start_navigation: 'Start group navigation',
  send_announcements: 'Send announcements',
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
  memberGrant?: string[] | null;
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
  if (actorRole === 'admin') return targetRole === 'member' || targetRole === 'guest';
  return false;
}

/**
 * Seats left, or -1 when uncapped. ADVISORY ONLY — the authoritative check is
 * the database trigger in migration 066, which serialises on the group row.
 * A client-side check alone is racy by construction.
 */
export function seatsRemaining(activeMembers: number, maxMembers: number): number {
  if (maxMembers <= 0) return -1;
  return activeMembers >= maxMembers ? 0 : maxMembers - activeMembers;
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

  // seats
  const seats: [number, number, number][] = [[2, 3, 1], [3, 3, 0], [4, 3, 0], [5, 0, -1]];
  for (const [act, max, want] of seats) {
    if (seatsRemaining(act, max) !== want) throw new Error(`seatsRemaining(${act},${max}) !== ${want}`);
  }

  console.log('groups/permissions self-check OK');
}
