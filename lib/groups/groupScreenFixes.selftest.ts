// lib/groups/groupScreenFixes.selftest.ts — run: npx tsx lib/groups/groupScreenFixes.selftest.ts
//
// Pure logic behind the 2026-10-04 group-screen fixes:
//   1. memberActions — the ONE member role/remove check shared by
//      app/group-admin.tsx, app/group-members.tsx and app/group-info.tsx.
//   2. eventReminderItems — shared-calendar reminders fed to the task
//      reminder reconciler (they were never scheduled before).
//   3. setGroupPrivacy — a failed write must throw, not report success.
//   4. listCommunities — must throw on failure (an empty list wiped the cache).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { memberActions } from './permissions';
import { eventReminderItems, occurrencesInRange, type GroupEvent } from './calendar';
import { planReminders } from './reminders';
import { __setStorageForTest, getGroupPrivacy, setGroupPrivacy } from './store';

async function main() {
  // ── 1. memberActions ──
  const untyped = (actorRole: string, targetRole: string, isMe = false) =>
    memberActions({ actorRole, targetRole, isMe, typed: false, permissions: [] });
  const typed = (actorRole: string, targetRole: string, permissions: string[], isMe = false) =>
    memberActions({ actorRole, targetRole, isMe, typed: true, permissions });

  // Untyped group: admin/owner manage, two-role world, rank still applies.
  assert.deepEqual(untyped('admin', 'member').roles, ['admin', 'member']);
  assert.equal(untyped('admin', 'member').canRemove, true);
  assert.deepEqual(untyped('admin', 'admin').roles, [], 'an admin cannot demote a peer admin');
  assert.equal(untyped('admin', 'admin').canRemove, false, 'an admin cannot remove a peer admin');
  assert.deepEqual(untyped('owner', 'admin').roles, ['admin', 'member']);
  assert.equal(untyped('member', 'member').canRemove, false);
  assert.deepEqual(untyped('member', 'member').roles, []);
  // Nobody acts on the owner or on themselves.
  assert.deepEqual(untyped('admin', 'owner'), { roles: [], canRemove: false, canTransfer: false });
  assert.deepEqual(untyped('owner', 'admin', true), { roles: [], canRemove: false, canTransfer: false });
  // Transfer is the owner's alone.
  assert.equal(untyped('owner', 'member').canTransfer, true);
  assert.equal(untyped('admin', 'member').canTransfer, false);

  // Typed group: the remove_members permission gates, then rank.
  assert.deepEqual(typed('owner', 'member', ['remove_members']).roles, ['admin', 'moderator', 'member', 'guest']);
  assert.deepEqual(typed('admin', 'member', []), { roles: [], canRemove: false, canTransfer: false },
    'without remove_members an admin manages nobody in a typed group');
  assert.deepEqual(typed('moderator', 'member', ['remove_members']).roles, ['member', 'guest'],
    'a moderator cannot hand out moderator or admin');
  assert.equal(typed('moderator', 'moderator', ['remove_members']).canRemove, false);
  assert.equal(typed('moderator', 'guest', ['remove_members']).canRemove, true);

  // ── 2. calendar reminders ──
  const t0 = new Date(2026, 9, 5, 9, 0, 0, 0).getTime();   // 5 Oct 2026 09:00 local
  const ev = (o: Partial<GroupEvent>): GroupEvent => ({
    id: '7', title: 'Dentist', startsAt: t0 + 86_400_000, durationMin: 60, allDay: false,
    recurrence: 'none', repeatUntil: null, createdBy: 'u2', remindMin: 30, ...o,
  });
  const horizon = t0 + 30 * 86_400_000;
  const one = eventReminderItems(occurrencesInRange([ev({})], t0, horizon), 'me');
  assert.equal(one.length, 1);
  assert.equal(one[0].dueAt, t0 + 86_400_000 - 30 * 60_000, 'fires remindMin before the start');
  assert.equal(one[0].assignee, 'me', 'a shared event reminds every member, i.e. this device');
  assert.equal(one[0].id, `7@${t0 + 86_400_000}`, 'keyed per occurrence');
  assert.equal(eventReminderItems(occurrencesInRange([ev({ remindMin: null })], t0, horizon), 'me').length, 0);
  const weekly = eventReminderItems(occurrencesInRange([ev({ recurrence: 'weekly' })], t0, horizon), 'me');
  assert.ok(weekly.length >= 4, 'each repeat gets its own reminder: ' + weekly.length);
  assert.equal(new Set(weekly.map((w) => w.id)).size, weekly.length, 'occurrence ids are unique');

  // Fed through the existing reconciler: books future ones, then is idempotent.
  const plan = planReminders(one, [], 'me', t0);
  assert.equal(plan.schedule.length, 1);
  const booked = plan.schedule.map((r) => ({ ...r, notifId: 'n1' }));
  const again = planReminders(one, booked, 'me', t0);
  assert.equal(again.schedule.length + again.cancel.length, 0, 'unchanged list books nothing');
  const moved = eventReminderItems(occurrencesInRange([ev({ startsAt: t0 + 2 * 86_400_000 })], t0, horizon), 'me');
  assert.deepEqual(planReminders(moved, booked, 'me', t0).cancel, ['n1'], 'a moved event cancels its old reminder');
  assert.equal(planReminders(one, [], 'me', t0 + 2 * 86_400_000).schedule.length, 0, 'past reminders are not booked');

  // ── 3. setGroupPrivacy reports a failed write ──
  const mem = new Map<string, string>();
  let failWrites = false;
  __setStorageForTest({
    getItem: async (k: string) => mem.get(k) ?? null,
    setItem: async (k: string, v: string) => { if (failWrites) throw new Error('disk full'); mem.set(k, v); },
    removeItem: async (k: string) => { mem.delete(k); },
  });
  const saved = await setGroupPrivacy('g1', { hideBattery: true });
  assert.equal(saved.hideBattery, true);
  failWrites = true;
  await assert.rejects(setGroupPrivacy('g1', { hideBattery: false }), /disk full/, 'a failed save must throw');
  assert.equal((await getGroupPrivacy('g1')).hideBattery, true, 'and the stored value is unchanged');

  // ── 4. listCommunities throws instead of returning [] ──
  // chatService imports react-native, so this is a source check of the one function.
  const src = fs.readFileSync(path.join(__dirname, '..', 'chatService.ts'), 'utf8');
  const body = src.match(/export async function listCommunities\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(body, 'listCommunities found');
  assert.ok(!/catch/.test(body), 'listCommunities must not swallow errors into []');

  console.log('groupScreenFixes selftest: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
