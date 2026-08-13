// lib/spaces/rolepicker.ts — which display roles may be offered, and what each
// one actually grants.
//
// The catalog is DATA from the server (group_type_config.role_catalog), reached
// through chatsGet's roleCatalog. Nothing here invents a role, a label or a
// permission: this module only decides what to OFFER and how to DESCRIBE it.
//
// ── THE RULE THAT SHAPES THIS FILE ──
//
// The server refuses a role whose rank does not match the member's current rank
// ("That role needs the admin rank; change the member's rank first"). Rank and
// display role are stored independently, and catalogLayer() deliberately ignores
// a key whose rank has drifted — so a stale key can never hand over a higher
// entry's permissions.
//
// The picker therefore offers ONLY same-rank entries. Offering the rest and
// letting the server say no would teach people that the app guesses; and a
// "Change role" list that mostly errors is worse than a short honest one.
//
// OWNERSHIP IS NOT A ROLE HERE. Transferring a space has its own workflow
// (POST /membership/transfer) with its own confirmation, because it is
// irreversible for the person doing it. It must never be reachable by picking
// a label from a list.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/spaces/rolepicker.ts

import {
  type RoleDef, ROLE_LABELS, PERMISSION_LABELS, ALL_PERMISSIONS,
} from '../groups/permissions';

export interface RoleOption {
  key: string;
  label: string;
  rank: string;
  /**
   * Exactly what the catalog grants this role, or null when the entry omits
   * its permissions list and therefore inherits its rank default.
   *
   * null is NOT an empty list. The type default lives server-side, so the app
   * cannot enumerate it — and guessing would be inventing permissions. The UI
   * says "inherits the standard permissions" instead of showing a wrong list.
   */
  grants: string[] | null;
  /** What it explicitly does NOT hold. Empty when grants is null (unknowable). */
  withholds: string[];
  /** True when this is the member's current display role. */
  current: boolean;
}

/**
 * Can the viewer change this member's display role at all?
 *
 * Mirrors the server's gate rather than inventing one: managing members is an
 * owner/admin act, nobody edits their own role, and the owner is untouchable
 * through this path. The PATCH re-checks all of it — this only decides whether
 * to DRAW the action, because an action that always 403s is a broken button.
 */
export function canChangeRole(
  viewerRole: string,
  viewerId: string,
  targetRole: string,
  targetId: string,
): boolean {
  if (viewerId === targetId) return false;           // not your own label
  if (targetRole === 'owner') return false;          // owner is not re-labelled
  return viewerRole === 'owner' || viewerRole === 'admin';
}

/**
 * The roles that may be offered for a member, with what each grants.
 *
 * Same-rank only — see the header. Returns [] when the space has no catalog,
 * which is the correct answer for a family space: it has ranks, not job titles.
 */
export function roleOptions(
  catalog: RoleDef[] | null | undefined,
  memberRank: string,
  currentKey: string | null | undefined,
): RoleOption[] {
  if (!catalog?.length) return [];
  return catalog
    .filter((d) => d.rank === memberRank)
    .map((d) => {
      // Straight from the catalog. No resolution, no inference: the server owns
      // the type default, and a preview that guesses it would be a second
      // permission model competing with the real one.
      const grants = d.permissions ?? null;
      return {
        key: d.key,
        label: d.label,
        rank: d.rank,
        grants,
        withholds: grants ? ALL_PERMISSIONS.filter((p) => !grants.includes(p)).map(String) : [],
        current: d.key === currentKey,
      };
    });
}

/** Human label for a permission. Never shows a raw enum to a user. */
export function permissionLabel(p: string): string {
  return (PERMISSION_LABELS as Record<string, string>)[p] ?? p;
}

/** Human label for a rank, for the "wearing a label" line under a role. */
export function rankLabel(rank: string): string {
  return (ROLE_LABELS as Record<string, string>)[rank] ?? rank;
}

/**
 * What to tell the user when the server refuses.
 *
 * An authorisation failure must never be dressed up as a generic error: if
 * someone is not allowed to do this, saying "something went wrong" sends them
 * to retry forever. Each status says what actually happened.
 */
export function roleErrorText(status: number, fallback?: string): string {
  switch (status) {
    case 403: return 'You do not have permission to change this member’s role.';
    case 404: return 'That person is no longer in this space.';
    case 409: return 'That role needs a different rank. Change the member’s rank first.';
    case 400:
    case 422: return 'That role is not valid for this type of space.';
    case 0:   return 'You appear to be offline. Their role has not been changed.';
    default:
      return fallback || 'Their role could not be changed. Nothing has been saved.';
  }
}

// ── self-check ────────────────────────────────────────────────────────
if (require.main === module) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };

  const CAT: RoleDef[] = [
    { key: 'company_owner', label: 'Company Owner', rank: 'owner' },
    { key: 'super_admin', label: 'Super Admin', rank: 'admin' },
    { key: 'hr_manager', label: 'HR Manager', rank: 'admin',
      permissions: ['view_history', 'view_space_ops', 'manage_roster'] },
    { key: 'dept_manager', label: 'Department Manager', rank: 'moderator',
      permissions: ['view_history', 'view_space_ops'] },
    { key: 'employee', label: 'Employee', rank: 'member', permissions: [] },
  ];

  // SAME RANK ONLY — the server rejects anything else, so it is never offered.
  const forAdmin = roleOptions(CAT, 'admin', 'super_admin');
  eq(forAdmin.map((o) => o.key), ['super_admin', 'hr_manager'], 'admin sees only admin-rank roles');
  if (!forAdmin.find((o) => o.key === 'super_admin')!.current) throw new Error('current role must be marked');
  if (forAdmin.some((o) => o.rank !== 'admin')) throw new Error('a cross-rank role must never be offered');

  // An entry with permissions: [] holds NOTHING, and that is different from
  // "inherit the default" — the parent case the whole model turns on.
  const emp = roleOptions(CAT, 'member', null);
  eq(emp.length, 1, 'one member-rank role');
  eq(emp[0].grants, [], 'employee with [] holds nothing');
  if (emp[0].grants === null) throw new Error('[] and null must stay distinguishable');
  if (emp[0].withholds.length !== ALL_PERMISSIONS.length) throw new Error('withholds must list everything it lacks');

  // A role that omits `permissions` inherits its rank default rather than
  // showing an empty list.
  const admins = roleOptions(CAT, 'admin', null);
  const superAdmin = admins.find((o) => o.key === 'super_admin')!;
  if (superAdmin.grants !== null) throw new Error('an inheriting entry must report null, never a guessed list');
  eq(superAdmin.withholds, [], 'nothing can be claimed withheld when the grant set is unknown');
  const hr = admins.find((o) => o.key === 'hr_manager')!;
  eq(hr.grants, ['view_history', 'view_space_ops', 'manage_roster'], 'a restricted entry shows exactly its catalog list');
  if (!hr.withholds.length) throw new Error('a restricted role must show what it cannot do');
  if (hr.withholds.includes('view_space_ops')) throw new Error('a granted permission must not appear as withheld');

  // No catalog = no job titles. A family space is ranks only.
  eq(roleOptions(null, 'member', null), [], 'no catalog, no options');
  eq(roleOptions([], 'admin', null), [], 'empty catalog, no options');

  // ── who may change a role ──
  eq(canChangeRole('owner', 'u1', 'member', 'u2'), true, 'owner may');
  eq(canChangeRole('admin', 'u1', 'member', 'u2'), true, 'admin may');
  eq(canChangeRole('moderator', 'u1', 'member', 'u2'), false, 'a moderator may not');
  eq(canChangeRole('member', 'u1', 'member', 'u2'), false, 'a plain member may not');
  eq(canChangeRole('owner', 'u1', 'member', 'u1'), false, 'nobody edits their own role');
  eq(canChangeRole('admin', 'u1', 'owner', 'u2'), false, 'the owner is not re-labelled here');
  eq(canChangeRole('owner', 'u1', 'owner', 'u2'), false, 'ownership transfer is a separate workflow');

  // ── errors must never be generic ──
  if (roleErrorText(403).toLowerCase().includes('something went wrong')) {
    throw new Error('403 must say it is a permission problem');
  }
  if (!roleErrorText(403).toLowerCase().includes('permission')) throw new Error('403 must name permission');
  if (!roleErrorText(409).toLowerCase().includes('rank')) throw new Error('409 must explain the rank rule');
  if (!roleErrorText(0).toLowerCase().includes('offline')) throw new Error('offline must say so');
  for (const st of [400, 403, 404, 409, 422, 500, 0]) {
    const t = roleErrorText(st);
    if (t.length < 20) throw new Error(`${st} needs a real explanation`);
    // Every failure must make clear nothing was persisted, or say what to fix.
  }

  if (permissionLabel('view_space_ops') === 'view_space_ops') {
    throw new Error('permissions must be shown in human words');
  }
  if (permissionLabel('not_a_real_permission') !== 'not_a_real_permission') {
    throw new Error('an unknown permission must degrade to its key, not crash');
  }

  console.log('spaces/rolepicker self-check OK');
}
