// lib/family/historyOwners.selftest.ts — run: npx tsx lib/family/historyOwners.selftest.ts
//
// The circle-wide history view used to merge every member's samples into one
// time-ordered track. trackOwners is what lets it show one member at a time.
import assert from 'node:assert/strict';
import { trackOwners, summarize, type TrackSample } from './history';

const s = (u: string, ts: number, lat = 12.97): TrackSample => ({ u, ts, lat, lng: 77.59 });

// Most recent fix first; each member exactly once.
assert.deepEqual(trackOwners([s('a', 1), s('b', 5), s('a', 3), s('c', 4)]), ['b', 'c', 'a']);

// The viewer comes first when they have a track, whatever its age.
assert.deepEqual(trackOwners([s('a', 1), s('b', 5), s('me', 0)], 'me'), ['me', 'b', 'a']);

// A preferred id with no samples is not invented.
assert.deepEqual(trackOwners([s('a', 1)], 'me'), ['a']);

// Empty and malformed input.
assert.deepEqual(trackOwners([]), []);
assert.deepEqual(trackOwners([{ ...s('', 9) }, s('a', 2)]), ['a']);

// Ties break by id, so the picker order is stable across renders.
assert.deepEqual(trackOwners([s('z', 7), s('m', 7)]), ['m', 'z']);

// WHY: two people 1 km apart, interleaved, "travel" ~1 km per fix when merged;
// split per member, each one is stationary.
const merged = [s('a', 1, 12.97), s('b', 2, 12.98), s('a', 3, 12.97), s('b', 4, 12.98)];
assert.ok(summarize(merged).distanceM > 2000, 'merged track invents distance');
for (const id of trackOwners(merged)) {
  assert.equal(summarize(merged.filter((x) => x.u === id)).distanceM, 0, `member ${id} did not move`);
}

console.log('family/historyOwners selftest: OK');
