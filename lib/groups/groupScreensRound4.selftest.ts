// lib/groups/groupScreensRound4.selftest.ts — run: npx tsx lib/groups/groupScreensRound4.selftest.ts
//
// Round-4 group fixes:
//   1. joinRefusal — group-join reads the server's 409 `code` (R4 backend C7),
//      falling back to today's prose, and never treats another 409 as a state.
//   2. routeMissing — a not-deployed route (405, or the gateway's catch-all 404)
//      is told apart from the route's own documented 404s.
//   3. approval queue rows — link rows are keyed and routed by user id.
//   4. eventWriter / eventActions.writerKnown — calendar decrypts with the last
//      writer and opens edit to edit_settings only when the server records it.
//   5. pageBack — stops once a page reaches past what the caller needs.

import assert from 'node:assert/strict';
import {
  joinRefusal, routeMissing, isLinkRow, queueKey, eventWriter, writerRecorded, type QueueRow,
} from './serverContracts';
import { eventActions } from './calendar';
import { pageBack, OP_PAGE } from './opThread';
import type { Message } from '../chatService';

async function main() {
  // ── 1. joinRefusal ──
  assert.equal(joinRefusal({ status: 409, message: 'x', body: { code: 'already_member' } }), 'member');
  assert.equal(joinRefusal({ status: 409, message: 'x', body: { code: 'already_requested' } }), 'asked');
  assert.equal(joinRefusal({ status: 409, message: 'This group is invite-only', body: { code: 'invite_only' } }), null,
    'invite-only is a refusal to show, not a state');
  assert.equal(joinRefusal({ status: 409, message: 'You already have a request or invitation', body: { code: 'cooldown' } }), null,
    'a code wins over prose that happens to match');
  // today's server: prose only
  assert.equal(joinRefusal({ status: 409, message: 'You are already in this group' }), 'member');
  assert.equal(joinRefusal({ status: 409, message: 'You already have a request or invitation for this group' }), 'asked');
  assert.equal(joinRefusal({ status: 500, message: 'You are already in this group' }), null, 'only a 409 is a state');
  assert.equal(joinRefusal(null), null);

  // ── 2. routeMissing ──
  const own = ['Community not found'];
  assert.equal(routeMissing({ status: 405, message: 'Method Not Allowed' }, own), true);
  assert.equal(routeMissing({ status: 404, message: 'route not migrated to go backend' }, own), true);
  assert.equal(routeMissing({ status: 404, message: 'Community not found' }, own), false, 'a real 404 is an answer');
  assert.equal(routeMissing({ status: 403, message: 'Only the community owner can edit it' }, own), false);
  assert.equal(routeMissing({ status: 409, message: 'x' }, own), false);

  // ── 3. queue rows ──
  const row = (o: Partial<QueueRow>): QueueRow => ({
    id: 7, userId: 'u1', name: 'A', photoURL: null, status: 'accepted', requested: false,
    inviterName: null, createdAt: '', acceptedAt: null, canApprove: true, canReject: true, ...o,
  });
  assert.equal(isLinkRow(row({})), false, "today's rows have no source: invitations");
  assert.equal(isLinkRow(row({ source: 'invitation' })), false);
  assert.equal(isLinkRow(row({ source: 'link', id: null })), true);
  assert.equal(queueKey(row({})), 'inv:7');
  assert.equal(queueKey(row({ source: 'link', id: null, userId: 'u9' })), 'link:u9');
  assert.notEqual(queueKey(row({ source: 'link', id: null, userId: '7' })), queueKey(row({ id: 7 })),
    'a link row cannot collide with an invitation');

  // ── 4. calendar writer ──
  assert.equal(eventWriter({ createdBy: 'a' }), 'a');
  assert.equal(eventWriter({ createdBy: 'a', updatedBy: 'b' }), 'b');
  assert.equal(eventWriter({ createdBy: null }), '');
  assert.equal(writerRecorded([{}, {}]), false);
  assert.equal(writerRecorded([{ updatedBy: 'a' }]), true);
  const base = { me: 'me', typed: true, myRole: 'admin', permissions: ['edit_settings'] };
  assert.deepEqual(eventActions({ ...base, createdBy: 'other' }), { canEdit: false, canDelete: true },
    'without updatedBy an admin still may not edit another member\'s event');
  assert.deepEqual(eventActions({ ...base, createdBy: 'other', writerKnown: true }), { canEdit: true, canDelete: true });
  assert.deepEqual(eventActions({ ...base, permissions: [], createdBy: 'other', writerKnown: true }), { canEdit: false, canDelete: false });
  assert.equal(eventActions({ ...base, me: null, createdBy: 'other', writerKnown: true }).canEdit, false);

  // ── 5. pageBack ──
  const msgs = (from: number, n: number): Message[] =>
    Array.from({ length: n }, (_, i) => ({ id: from - i } as Message));
  let calls = 0;
  const thread = async (before?: number) => {
    calls++;
    const top = before == null ? 1000 : before - 1;
    return msgs(top, Math.min(OP_PAGE, top));
  };
  const all = await pageBack(thread, 10);
  assert.equal(all.complete, true);
  assert.equal(all.messages.length, 1000);
  calls = 0;
  const some = await pageBack(thread, 10, (p) => p.some((m) => m.id < 700));
  assert.equal(some.complete, true, 'enough counts as complete');
  assert.equal(calls, 2, 'stops at the first page that reaches past the range');
  calls = 0;
  const capped = await pageBack(thread, 2);
  assert.equal(capped.complete, false);
  assert.equal(calls, 2);
  await assert.rejects(pageBack(async () => { throw new Error('offline'); }));

  console.log('groupScreensRound4 selftest: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
