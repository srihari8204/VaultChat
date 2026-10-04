// lib/groups/groupScreensRound3.selftest.ts — run: npx tsx lib/groups/groupScreensRound3.selftest.ts
//
// Pure logic behind the round-3 group-screen fixes (2026-10-04):
//   1. collectOps — the shared notes/tasks op reader: pages past the server's
//      200-message cap, keeps forgeries out, counts what it could not decrypt.
//   2. eventActions — calendar edit/delete gate (mirrors calMayEdit; edit is
//      author-only because readers decrypt with createdBy's sender key).
//   3. composer quick picks — day/hour chips edit one start time.
//   4. revealingReminders — what a tray-privacy tightening must rewrite.
//   5. hexColorOr — colours from a shared card's params.
import assert from 'node:assert/strict';
import type { Message } from '../chatService';
import { collectOps, OP_PAGE, UNREADABLE_BODY } from './opThread';
import {
  eventActions, withDayOffset, withHour, isDayOffset,
  revealingReminders, GENERIC_EVENT_REMINDER,
} from './calendar';
import { hexColorOr } from './catalog';

type Op = { k: string; by: string; n: number };

const msg = (id: number, senderId: string, content: string | null, deletedAt: string | null = null) =>
  ({ id, senderId, content, deletedAt } as unknown as Message);

async function main() {
  // ── 1. collectOps ──
  // A thread of 450 messages, ids 1..450, newest first per page like the server.
  const thread = Array.from({ length: 450 }, (_, i) => i + 1).map((id) =>
    msg(id, id % 2 ? 'u1' : 'u2', JSON.stringify({ k: 'add', by: id % 2 ? 'u1' : 'u2', n: id })));
  const asked: (number | undefined)[] = [];
  const io = (pages = thread) => ({
    page: async (before?: number) => {
      asked.push(before);
      return pages.filter((m) => before == null || m.id < before).sort((a, b) => b.id - a.id).slice(0, OP_PAGE);
    },
    withLocal: async (server: Message[]) => [...server].sort((a, b) => a.id - b.id),
    decrypt: async (m: Message) => String(m.content),
  });
  const decode = (b: string): Op | null => { try { return JSON.parse(b) as Op; } catch { return null; } };

  const all = await collectOps<Op>(io(), decode);
  assert.equal(all.ops.length, 450, 'reads past the 200-message page cap');
  assert.equal(all.complete, true);
  assert.deepEqual(asked, [undefined, 251, 51], 'pages back with before=oldest id');
  assert.equal(all.ops[0].n, 1, 'oldest first, the order the fold expects');

  asked.length = 0;
  const capped = await collectOps<Op>(io(), decode, 2);
  assert.equal(capped.ops.length, 400);
  assert.equal(capped.complete, false, 'stopping at the page limit is reported');

  // Forged author, unreadable bodies, deleted rows.
  const mixed = [
    msg(1, 'u1', JSON.stringify({ k: 'add', by: 'u1', n: 1 })),
    msg(2, 'u2', JSON.stringify({ k: 'add', by: 'u1', n: 2 })),   // u2 claiming to be u1
    msg(3, 'u1', UNREADABLE_BODY),
    msg(4, 'u1', 'THROW'),
    msg(5, 'u1', JSON.stringify({ k: 'add', by: 'u1', n: 5 }), '2026-01-01'),
    msg(6, 'u1', null),
  ];
  const r = await collectOps<Op>({
    page: async () => mixed,
    withLocal: async (s) => s,
    decrypt: async (m) => { if (m.content === 'THROW') throw new Error('no key'); return String(m.content); },
  }, decode);
  assert.deepEqual(r.ops.map((o) => o.n), [1], 'forgery, deleted and empty rows are dropped');
  assert.equal(r.unreadable, 2, 'both the placeholder and a thrown decrypt count as unreadable');

  // First page failing is the load failing; a later one keeps what was read.
  await assert.rejects(collectOps<Op>({ page: async () => { throw new Error('offline'); }, withLocal: async (s) => s, decrypt: async () => '' }, decode));
  let n = 0;
  const partial = await collectOps<Op>({
    page: async (before) => { if (n++ > 0) throw new Error('offline'); return io().page(before); },
    withLocal: async (s) => s, decrypt: async (m) => String(m.content),
  }, decode);
  assert.equal(partial.ops.length, OP_PAGE);
  assert.equal(partial.complete, false);

  // ── 2. eventActions ──
  const base = { me: 'me', typed: false, myRole: 'member', permissions: [] as string[] };
  assert.deepEqual(eventActions({ ...base, createdBy: 'me' }), { canEdit: true, canDelete: true });
  assert.deepEqual(eventActions({ ...base, createdBy: 'other' }), { canEdit: false, canDelete: false });
  assert.deepEqual(eventActions({ ...base, createdBy: 'other', myRole: 'admin' }), { canEdit: false, canDelete: true },
    'an untyped-group admin may delete (server: edit_settings) but not edit (sender key)');
  assert.deepEqual(eventActions({ ...base, createdBy: 'other', typed: true, myRole: 'admin' }), { canEdit: false, canDelete: false },
    'in a typed group the permission decides, not the role name');
  assert.equal(eventActions({ ...base, createdBy: 'other', typed: true, permissions: ['edit_settings'] }).canDelete, true);
  assert.deepEqual(eventActions({ ...base, me: null, createdBy: null }), { canEdit: false, canDelete: false });

  // ── 3. composer quick picks ──
  const now = new Date(2026, 9, 4, 13, 7).getTime();                 // Sun 4 Oct 13:07
  const start = new Date(2026, 9, 4, 18, 30).getTime();              // today 18:30
  const tomorrow = withDayOffset(start, 1, now);
  assert.equal(new Date(tomorrow).getDate(), 5);
  assert.equal(new Date(tomorrow).getHours(), 18, 'a day chip keeps the time');
  assert.equal(new Date(tomorrow).getMinutes(), 30);
  assert.ok(isDayOffset(tomorrow, 1, now) && !isDayOffset(tomorrow, 0, now));
  const at9 = withHour(tomorrow, 9);
  assert.equal(new Date(at9).getDate(), 5, 'an hour chip keeps the day');
  assert.equal(new Date(at9).getHours(), 9);
  assert.equal(new Date(at9).getMinutes(), 0);
  const nextWeek = withDayOffset(new Date(2026, 11, 28, 18).getTime(), 7, new Date(2026, 11, 28, 9).getTime());
  assert.equal(new Date(nextWeek).getFullYear(), 2027, 'crosses the year');

  // ── 4. revealingReminders ──
  const booked = [{ title: 'Dentist' }, { title: GENERIC_EVENT_REMINDER }];
  assert.deepEqual(revealingReminders(booked), [{ title: 'Dentist' }]);

  // ── 5. hexColorOr ──
  assert.equal(hexColorOr('#12abEF', '#000000'), '#12abEF');
  for (const bad of ['#abc', 'red', '#12345678', '', null, undefined, '#12abEF; x']) {
    assert.equal(hexColorOr(bad as any, '#000000'), '#000000', `rejects ${String(bad)}`);
  }

  console.log('groupScreensRound3 selftest: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
