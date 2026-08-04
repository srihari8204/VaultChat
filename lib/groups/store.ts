// lib/groups/store.ts — the device-local registry of the groups this user is in
// (Groups & Circles, G2).
//
// WHY THE MIGRATION IS A RENAME OF ONE KEY AND NOT OF ALL EIGHT
//
// A circle id has always BEEN a chat id, and a group id is the same chat id.
// So every per-entity key already written by Family Space —
//   vc_family_places_<id>, vc_family_hist_<id>, vc_family_inside_<id>
// — is already correctly keyed for the group model. Renaming them to
// vc_groups_* would be pure cosmetics bought with a real risk of losing a
// user's places and location history if the rewrite is interrupted midway.
//
// So we migrate ONLY the registry: the flat list of "which chats are circles"
// becomes a richer list of typed groups. Per-entity keys keep their historical
// names, which is why you will see vc_family_* referenced from group code. That
// is intentional; the comment is the documentation.
//
// The migration is also NON-DESTRUCTIVE: the old key is left in place. If this
// build is rolled back, the previous version still finds its circles.
//
// Pure logic (migrateCircles, upsert) is exported and self-checked:
//   npx tsx lib/groups/store.ts

import type { GroupType } from './catalog';
import type { Permission } from './permissions';

// Lazy-required so the pure half stays free of the react-native graph — same
// pattern as lib/nav/routing.ts and lib/family/history.ts.
let storageImpl: any = null;
const storage = () => {
  if (storageImpl) return storageImpl;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@react-native-async-storage/async-storage').default;
};

/** Test seam: swap in an in-memory store. Self-check only. */
export function __setStorageForTest(impl: any): void { storageImpl = impl; }

export const K_GROUPS = 'vc_groups_v1';
export const K_ACTIVE = 'vc_groups_active';
export const K_SCHEMA = 'vc_groups_schema';
/** The Family Space registry this supersedes. Read once, never deleted. */
export const K_LEGACY_CIRCLES = 'vc_family_circles_v1';

/** Bump when the shape of a stored GroupRef changes. */
export const SCHEMA_VERSION = 1;

/**
 * One group as this device knows it. Server truth (permissions, caps) is cached
 * here so the shell can render before any network call, and refreshed from
 * GET /chats/:id.
 */
export interface GroupRef {
  id: string;
  name: string;
  groupType: GroupType | null;   // null = untyped legacy group
  icon?: string | null;
  color?: string | null;
  privacy?: 'private' | 'invite_only';
  maxMembers?: number | null;
  role?: string;
  permissions?: Permission[];
}

/** What the Family Space registry stored. */
export interface LegacyCircle { id: string; name: string }

/**
 * Fold the old circle list into the group list.
 *
 * Rules, in priority order:
 *  - An existing group entry always wins. Re-running must never overwrite a
 *    group the user has since renamed or retyped.
 *  - A circle becomes a `family` group, because that is what a Family Space
 *    circle was. The SERVER cannot make this call — it has no marker for which
 *    chats were circles — so the client is the only place this can happen.
 *  - Order is preserved: groups first, then circles not already present.
 *
 * Pure: no storage, so it can be tested exhaustively.
 */
export function migrateCircles(existing: GroupRef[], circles: LegacyCircle[]): GroupRef[] {
  const have = new Set(existing.map((g) => g.id));
  const added: GroupRef[] = [];
  for (const c of circles) {
    if (!c || !c.id || have.has(c.id)) continue;
    have.add(c.id);
    added.push({ id: c.id, name: c.name || 'Family', groupType: 'family' });
  }
  return [...existing, ...added];
}

/** Insert or merge one group, newest first, without duplicating. */
export function upsert(list: GroupRef[], g: GroupRef): GroupRef[] {
  const i = list.findIndex((x) => x.id === g.id);
  if (i < 0) return [g, ...list];
  // Merge rather than replace: a partial update (say, just permissions from a
  // GET) must not blank the fields it did not carry.
  const merged = { ...list[i], ...g };
  const next = [...list];
  next[i] = merged;
  return next;
}

// ── persistence ──

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

async function writeJSON(key: string, value: unknown): Promise<void> {
  try { await storage().setItem(key, JSON.stringify(value)); } catch { /* best-effort */ }
}

/**
 * Load the registry, running the one-shot circle migration if it has not run.
 *
 * Ordering matters: the migrated list is WRITTEN before the schema marker. If
 * the process dies between the two, the next launch simply migrates again —
 * which is harmless, because migrateCircles skips ids that are already present.
 * Writing the marker first would risk losing the circles entirely.
 */
export async function listGroups(): Promise<GroupRef[]> {
  const groups = await readJSON<GroupRef[]>(K_GROUPS, []);
  const schema = await readJSON<number>(K_SCHEMA, 0);
  if (schema >= SCHEMA_VERSION) return groups;

  const circles = await readJSON<LegacyCircle[]>(K_LEGACY_CIRCLES, []);
  const merged = migrateCircles(groups, circles);
  await writeJSON(K_GROUPS, merged);
  await writeJSON(K_SCHEMA, SCHEMA_VERSION);
  // K_LEGACY_CIRCLES is deliberately NOT removed — a rollback to the previous
  // build must still find the user's circles.
  return merged;
}

export async function saveGroup(g: GroupRef): Promise<GroupRef[]> {
  const next = upsert(await listGroups(), g);
  await writeJSON(K_GROUPS, next);
  return next;
}

export async function removeGroup(id: string): Promise<GroupRef[]> {
  const next = (await listGroups()).filter((g) => g.id !== id);
  await writeJSON(K_GROUPS, next);
  if (await getActiveGroupId() === id) await setActiveGroupId(next[0]?.id ?? null);
  return next;
}

export async function getGroup(id: string): Promise<GroupRef | null> {
  return (await listGroups()).find((g) => g.id === id) ?? null;
}

/** The group the shell should open on. */
export async function getActiveGroupId(): Promise<string | null> {
  try { return (await storage().getItem(K_ACTIVE)) || null; } catch { return null; }
}

export async function setActiveGroupId(id: string | null): Promise<void> {
  try {
    if (id) await storage().setItem(K_ACTIVE, id);
    else await storage().removeItem(K_ACTIVE);
  } catch { /* best-effort */ }
}

/**
 * Resolve which group to show: the remembered one if it still exists, else the
 * first. Returns null only when the user is in no groups at all.
 */
export async function resolveActiveGroup(): Promise<GroupRef | null> {
  const groups = await listGroups();
  if (!groups.length) return null;
  const wanted = await getActiveGroupId();
  return groups.find((g) => g.id === wanted) ?? groups[0];
}

// ── self-check ──
if (require.main === module) {
  const eqIds = (l: GroupRef[]) => l.map((g) => g.id).join(',');

  // 1. a fresh install with circles adopts them as family groups
  let out = migrateCircles([], [{ id: 'a', name: 'Balla' }, { id: 'b', name: 'Cousins' }]);
  if (eqIds(out) !== 'a,b') throw new Error('circles should be adopted: ' + eqIds(out));
  if (out[0].groupType !== 'family') throw new Error('a circle must become a family group');
  if (out[0].name !== 'Balla') throw new Error('circle name must survive');

  // 2. idempotent — the load-bearing property, since the marker is written second
  const twice = migrateCircles(out, [{ id: 'a', name: 'Balla' }, { id: 'b', name: 'Cousins' }]);
  if (eqIds(twice) !== 'a,b') throw new Error('re-running must not duplicate: ' + eqIds(twice));

  // 3. an existing group WINS — a user who retyped/renamed must not be reverted
  const kept = migrateCircles(
    [{ id: 'a', name: 'Renamed', groupType: 'friends' }],
    [{ id: 'a', name: 'Balla' }],
  );
  if (kept.length !== 1 || kept[0].name !== 'Renamed' || kept[0].groupType !== 'friends') {
    throw new Error('existing group must win over the legacy circle');
  }

  // 4. junk in the legacy list cannot break the migration
  const junk = migrateCircles([], [null as any, { id: '', name: 'x' } as any, { id: 'c', name: 'O' }]);
  if (eqIds(junk) !== 'c') throw new Error('malformed circles must be skipped: ' + eqIds(junk));

  // 5. upsert merges rather than replaces
  const base: GroupRef[] = [{ id: 'a', name: 'A', groupType: 'family', color: '#111111' }];
  const patched = upsert(base, { id: 'a', name: 'A', groupType: 'family', permissions: ['view_history'] });
  if (patched[0].color !== '#111111') throw new Error('partial update must not blank existing fields');
  if (patched[0].permissions?.[0] !== 'view_history') throw new Error('update should apply');
  if (patched.length !== 1) throw new Error('upsert must not duplicate');
  const added = upsert(base, { id: 'z', name: 'Z', groupType: 'office' });
  if (eqIds(added) !== 'z,a') throw new Error('new group goes first: ' + eqIds(added));

  // 6. end-to-end against an in-memory store, proving nothing is lost
  const mem = new Map<string, string>();
  __setStorageForTest({
    getItem: async (k: string) => mem.get(k) ?? null,
    setItem: async (k: string, v: string) => { mem.set(k, v); },
    removeItem: async (k: string) => { mem.delete(k); },
  });
  mem.set(K_LEGACY_CIRCLES, JSON.stringify([{ id: 'x', name: 'Home' }]));
  // Simulate real Family Space data hanging off that id.
  mem.set(`vc_family_places_x`, JSON.stringify([{ id: 'p1', name: 'School' }]));

  (async () => {
    const first = await listGroups();
    if (eqIds(first) !== 'x' || first[0].groupType !== 'family') throw new Error('migration did not run');
    if (mem.get(K_SCHEMA) !== String(SCHEMA_VERSION)) throw new Error('schema marker not written');
    if (!mem.has(K_LEGACY_CIRCLES)) throw new Error('legacy key must NOT be deleted (rollback safety)');
    if (!mem.has('vc_family_places_x')) throw new Error('per-group data must be untouched');

    // second load must not re-migrate or duplicate
    await saveGroup({ id: 'x', name: 'Home', groupType: 'family', permissions: ['view_history'] });
    const second = await listGroups();
    if (second.length !== 1) throw new Error('duplicate after reload: ' + eqIds(second));
    if (second[0].permissions?.[0] !== 'view_history') throw new Error('saved fields lost');

    // active-group resolution
    await setActiveGroupId('nope');            // stale id
    if ((await resolveActiveGroup())?.id !== 'x') throw new Error('stale active id should fall back to first');
    await setActiveGroupId('x');
    if ((await resolveActiveGroup())?.id !== 'x') throw new Error('active id should be honoured');
    await removeGroup('x');
    if ((await resolveActiveGroup()) !== null) throw new Error('no groups should resolve to null');

    console.log('groups/store self-check OK');
  })();
}
