// Run: npx tsx lib/spaces/sosQueue.selftest.ts
import assert from 'node:assert/strict';
import {
  parseSosQueue, dueSos, afterAttempt, markExpired, sosForRun, retryable, liveFor, pruneOthers, clockOf, ageText,
  sosBody, runEnded, sentText, deliveredText, undeliveredText,
  SOS_MAX_AGE_MS, SOS_PRUNE_MS, EXPIRED_TEXT, type PendingSos,
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

// a repeat press finds the waiting alert for this run and driver, never a dead one
assert.equal(liveFor([e('d', { dead: 'x' }), e('w')], 's1', 'r1', 'u1', now)?.id, 'w');
assert.equal(liveFor([e('d', { dead: 'x' })], 's1', 'r1', 'u1', now), undefined);
assert.equal(liveFor([e('w')], 's1', 'r2', 'u1', now), undefined);
assert.equal(liveFor([e('w')], 's1', 'r1', 'u2', now), undefined);
assert.equal(liveFor([e('w', { at: now - SOS_MAX_AGE_MS - 1 })], 's1', 'r1', 'u1', now), undefined, 'too old to send: a new alert instead');

// prune: only another account's entries past a day, and only with a known me
const old = now - SOS_PRUNE_MS - 1;
const pq = [e('m', { at: old }), e('o', { reporterId: 'u2', at: old }), e('n', { reporterId: 'u2' })];
assert.deepEqual(pruneOthers(pq, 'u1', now).map((x) => x.id), ['m', 'n']);
assert.equal(pruneOthers(pq, '', now), pq, 'unknown account: nothing pruned');
assert.equal(pruneOthers([e('m')], 'u1', now).length, 1);

// press time and age
const local = new Date(2026, 9, 4, 8, 5).getTime();
assert.equal(clockOf(local), '08:05');
assert.equal(ageText(now - 30_000, now), 'just now');
assert.equal(ageText(now - 12 * 60_000, now), '12 min ago');
assert.equal(ageText(now - 125 * 60_000, now), '2 h 5 min ago');
assert.equal(ageText(now - 120 * 60_000, now), '2 h ago');
assert.equal(ageText(now + 5_000, now), 'just now', 'a clock that moved back is not negative');

// the request: key, press time, empty note
const b = sosBody(e('k', { at: local }));
assert.deepEqual(b, {
  category: 'sos', runId: 'r1', note: '', clientKey: 'k', pressedAt: new Date(local).toISOString(), pressedClock: '08:05',
});

assert.ok(runEnded('completed') && runEnded('cancelled') && !runEnded('started') && !runEnded('scheduled') && !runEnded(undefined));

// copy
assert.equal(sentText(), 'The office has your emergency alert.');
assert.match(sentText(true), /families on it were not alerted/);
assert.equal(
  deliveredText(e('a', { at: local }), local + 26 * 60_000),
  'Your emergency alert from 08:05 reached the office at 08:31.',
);
assert.match(undeliveredText([e('a', { at: local, dead: 'Refused.' })]), /^Your emergency alert from 08:05 was not delivered: Refused\. Call/);
assert.match(undeliveredText([e('a', { at: local, dead: 'x' }), e('b', { at: local + 60_000, dead: 'y' })]), /^2 emergency alerts \(from 08:05, 08:06\)/);

console.log('spaces/sosQueue self-check OK');
