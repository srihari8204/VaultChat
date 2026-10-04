// lib/outboxSummary.selftest.ts — run: npx tsx lib/outboxSummary.selftest.ts
import assert from 'node:assert/strict';
import { describeRetry, summarizeOutbox, unreadableRows, type OutboxRow } from './outboxSummary';

let n = 0;
const ok = (label: string, fn: () => void) => { fn(); n++; console.log('  ok  ' + label); };

const row = (p: Partial<OutboxRow>): OutboxRow => ({ tempId: 't' + n + Math.random(), chatId: 'c1', createdAt: 100, ...p });

ok('an empty outbox has nothing waiting and no oldest time', () => {
  assert.deepEqual(summarizeOutbox([]), { waiting: 0, failed: 0, failedIds: [], failedChatIds: [], chats: 0, oldestAt: null });
});

ok('queued, waiting-for-keys and mid-send rows all count as waiting', () => {
  const s = summarizeOutbox([row({ state: 'QUEUED' }), row({ state: 'WAITING_KEYS' }), row({ state: 'SENDING' }), row({})]);
  assert.equal(s.waiting, 4);
  assert.equal(s.failed, 0);
});

ok('FAILED rows are counted separately and their ids returned for a retry', () => {
  const s = summarizeOutbox([row({ tempId: 'a', state: 'FAILED' }), row({ tempId: 'b', state: 'QUEUED' })]);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.failedIds, ['a']);
  assert.equal(s.waiting, 1);
});

ok('rows the server already accepted are not reported as unsent', () => {
  const s = summarizeOutbox([row({ state: 'SENT', serverId: 42, createdAt: 1 }), row({ state: 'QUEUED', createdAt: 50 })]);
  assert.equal(s.waiting, 1);
  assert.equal(s.oldestAt, 50, 'the accepted row must not set the oldest time either');
});

ok('edits and deletes in the outbox are counted too', () => {
  const s = summarizeOutbox([row({ op: 'edit' }), row({ op: 'delete' })]);
  assert.equal(s.waiting, 2);
});

ok('chats are counted once each, and the oldest unsent row is found', () => {
  const s = summarizeOutbox([
    row({ chatId: 'a', createdAt: 30 }), row({ chatId: 'a', createdAt: 10 }), row({ chatId: 'b', createdAt: 20, state: 'FAILED' }),
  ]);
  assert.equal(s.chats, 2);
  assert.equal(s.oldestAt, 10);
});

ok('failed rows name their chats once each, in queue order', () => {
  const s = summarizeOutbox([
    row({ chatId: 'b', state: 'FAILED' }), row({ chatId: 'a', state: 'QUEUED' }),
    row({ chatId: 'b', state: 'FAILED' }), row({ chatId: 'c', state: 'FAILED' }),
  ]);
  assert.deepEqual(s.failedChatIds, ['b', 'c']);
});

ok('rows sealed while locked are counted as unreadable, within the read limit', () => {
  assert.equal(unreadableRows(5, 5, 1000), 0);
  assert.equal(unreadableRows(7, 4, 1000), 3);
  assert.equal(unreadableRows(1500, 990, 1000), 10, 'only the rows that were read can be compared');
  assert.equal(unreadableRows(3, 4, 1000), 0, 'a row added between the two reads is not negative');
});

ok('a retry reports what was sent and what is left', () => {
  const sum = (waiting: number, failed: number) => ({ ...summarizeOutbox([]), waiting, failed });
  assert.equal(describeRetry(sum(2, 2), sum(0, 0)), '4 messages sent.');
  assert.equal(describeRetry(sum(0, 1), sum(0, 0)), '1 message sent.');
  assert.equal(describeRetry(sum(1, 3), sum(0, 1)), '3 sent, 1 still failing.');
  assert.equal(describeRetry(sum(0, 2), sum(1, 1)), 'Nothing sent yet: 1 still failing, 1 still waiting.');
  assert.equal(describeRetry(sum(0, 0), sum(0, 0)), 'Nothing was waiting to send.');
});

console.log(`\noutboxSummary.selftest: ${n} passed`);
