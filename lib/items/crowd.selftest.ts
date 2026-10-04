// lib/items/crowd.selftest.ts — run: npx tsx lib/items/crowd.selftest.ts
import assert from 'node:assert/strict';
import { familyTags, dueSightings } from './crowd';

const shared = [
  { bleId: 'mine-paired', ownerId: 'me' },
  { bleId: 'mine-unpaired', ownerId: 'me' },     // my tag, phone reinstalled
  { bleId: 'moms-keys', ownerId: 'mom' },
  { bleId: 'dads-bag', ownerId: 'dad' },
  { bleId: 'paired-here', ownerId: 'dad' },       // dad's tag I also paired
];
const paired = new Set(['mine-paired', 'paired-here']);

// Other members' tags, not paired here — exactly the ones only crowd-find covers.
assert.deepEqual(familyTags(shared, paired, 'me').map((t) => t.bleId), ['moms-keys', 'dads-bag']);
// Identity unknown: my own unpaired tag cannot be told apart, so it is listed
// (reporting a sighting of your own tag is harmless).
assert.deepEqual(familyTags(shared, paired, null).map((t) => t.bleId), ['mine-unpaired', 'moms-keys', 'dads-bag']);

const now = 1_000_000;
const heard = (id: string) => id !== 'silent';
const last = new Map([['recent', now - 30_000], ['old', now - 61_000]]);
assert.deepEqual(
  dueSightings(['a', 'silent', 'recent', 'old', 'a'], heard, last, now),
  ['a', 'old'],
  'heard, not reported in the last minute, each id once',
);
assert.deepEqual(dueSightings([], heard, last, now), []);

console.log('items/crowd selftest: OK');
