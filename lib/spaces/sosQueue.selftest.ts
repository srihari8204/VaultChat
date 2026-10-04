// Run: npx tsx lib/spaces/sosQueue.selftest.ts
import assert from 'node:assert/strict';
import {
  parseSosQueue, dueSos, afterAttempt, markExpired, sosForRun, retryable,
  SOS_MAX_AGE_MS, EXPIRED_TEXT, type PendingSos,
} from './sosQueue';

const now = Date.parse('2026-10-04T08:00:00Z');
const e = (id: string, over: Partial<PendingSos> = {}): PendingSos =>
  ({ id, spaceId: 's1', runId: 'r1', reporterId: 'u1', at: now - 60_000, ...over });

// parse: well-formed rows only, dead kept
assert.deepEqual(parseSosQueue(null), []);
assert.deepEqual(parseSosQueue('not json'), []);
assert.deepEqual(parseSosQueue('{"a":1}'), []);
assert.deepEqual(
  parseSosQueue(JSON.stringify([e('a'), { id: 'b' }, null, 7, e('c', { dead: 'no' }), { ...e('d'), at: 'x' }])),
  [e('a'), e('c', { dead: 'no' })],
  'malformed rows are dropped, a dead reason survives',
);

// retryable
for (const s of [0, 401, 408, 429, 500, 503]) assert.ok(retryable(s), `${s} is retried`);
for (const s of [400, 403, 404, 409, 413]) assert.ok(!retryable(s), `${s} is final`);

// due: only mine, only live, split by age
const q = [
  e('mine'), e('old', { at: now - SOS_MAX_AGE_MS - 1 }), e('edge', { at: now - SOS_MAX_AGE_MS }),
  e('other', { reporterId: 'u2' }), e('dead', { dead: 'x' }),
];
const d = dueSos(q, 'u1', now);
assert.deepEqual(d.send.map((x) => x.id), ['mine', 'edge'], 'another account and dead entries are never sent');
assert.deepEqual(d.expire.map((x) => x.id), ['old'], 'past the age limit it is not sent');
assert.deepEqual(dueSos(q, '', now), { send: [], expire: [] }, 'no signed-in user sends nothing');

// after an attempt
assert.deepEqual(afterAttempt(q, 'mine', null).map((x) => x.id), ['old', 'edge', 'other', 'dead']);
assert.equal(afterAttempt(q, 'mine', { status: 0 }), q, 'offline: kept as is');
assert.equal(afterAttempt(q, 'mine', { status: 503 }), q, 'server error: kept');
const refused = afterAttempt(q, 'mine', { status: 403, message: 'You cannot report incidents in this space' });
assert.equal(refused.find((x) => x.id === 'mine')?.dead, 'You cannot report incidents in this space', 'a refusal is kept, dead, with the reason');
assert.equal(afterAttempt(q, 'mine', { status: 404 }).find((x) => x.id === 'mine')?.dead, 'The server refused it (404).');

// expiry marks, never deletes
const ex = markExpired(q, new Set(['old', 'dead']));
assert.equal(ex.find((x) => x.id === 'old')?.dead, EXPIRED_TEXT);
assert.equal(ex.find((x) => x.id === 'dead')?.dead, 'x', 'an existing reason is not overwritten');
assert.equal(ex.length, q.length);

// for the driver screen: this run, this driver, oldest first
const r = sosForRun([e('b', { at: now - 10 }), e('a', { at: now - 20 }), e('x', { runId: 'r2' }), e('y', { reporterId: 'u2' })], 's1', 'r1', 'u1');
assert.deepEqual(r.map((x) => x.id), ['a', 'b']);

console.log('spaces/sosQueue self-check OK');
