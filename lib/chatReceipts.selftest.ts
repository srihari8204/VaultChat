// lib/chatReceipts.selftest.ts — run: npx tsx lib/chatReceipts.selftest.ts
//
// Message Info's per-member sections from GET .../receipts (R4BE C3): every
// member lands in exactly one section, read implies delivered, and a chat with
// read receipts off never shows a Read section. Plus the time label.

import assert from 'node:assert/strict';
import { receiptSections, receiptTime, type MemberReceipt } from './chatReceipts';

const m = (userId: string, delivered: boolean, read: boolean): MemberReceipt =>
  ({ userId, delivered, read, deliveredAt: delivered ? '2026-10-04T10:00:00Z' : null, readAt: read ? '2026-10-04T10:05:00Z' : null });

const ids = (xs: MemberReceipt[]) => xs.map(x => x.userId).join(',');

// 1. Normal group: read / delivered-not-read / not delivered.
const s = receiptSections({ messageId: '9', readReceiptsHidden: false,
  members: [m('a', true, true), m('b', true, false), m('c', false, false)] });
assert.equal(ids(s.read), 'a');
assert.equal(ids(s.delivered), 'b');
assert.equal(ids(s.sent), 'c');

// 2. Read implies delivered even if a row says otherwise: never "sent" and "read" at once.
const odd = receiptSections({ messageId: '9', readReceiptsHidden: false, members: [m('a', false, true)] });
assert.equal(ids(odd.read), 'a');
assert.equal(ids(odd.sent), '');

// 3. Receipts hidden: no Read section, read members count as delivered, nobody twice.
const h = receiptSections({ messageId: '9', readReceiptsHidden: true,
  members: [m('a', true, false), m('b', false, false)] });
assert.equal(h.readReceiptsHidden, true);
assert.equal(ids(h.read), '');
assert.equal(ids(h.delivered), 'a');
assert.equal(ids(h.sent), 'b');

// 4. Every member is in exactly one section.
for (const r of [s, odd, h]) {
  const all = [...r.read, ...r.delivered, ...r.sent].map(x => x.userId);
  assert.equal(new Set(all).size, all.length, 'a member appears in two sections');
}

// 5. Time label: '' for unknown, time-only today, "Yesterday" prefix, date otherwise.
const now = new Date(2026, 9, 4, 18, 0);
assert.equal(receiptTime(null, now), '');
assert.equal(receiptTime('not a date', now), '');
const today = receiptTime(new Date(2026, 9, 4, 9, 30).toISOString(), now);
assert.ok(today.length > 0 && !/Yesterday/.test(today) && /30/.test(today), today);
assert.ok(receiptTime(new Date(2026, 9, 3, 9, 30).toISOString(), now).startsWith('Yesterday '));
const older = receiptTime(new Date(2026, 8, 20, 9, 30).toISOString(), now);
assert.ok(!older.startsWith('Yesterday') && /20/.test(older), older);

console.log('chatReceipts: all passed');
