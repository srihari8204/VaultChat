// lib/recoveryKeyCheck.selftest.ts — run: npx tsx lib/recoveryKeyCheck.selftest.ts
import assert from 'node:assert/strict';
import { keyGroupMatches, pickCheckGroups } from './recoveryKeyCheck';

const key = '0123456789abcdef'.repeat(4);   // 64 hex chars, 16 groups

assert.equal(keyGroupMatches(key, 0, '0123'), true);
assert.equal(keyGroupMatches(key, 3, 'CDEF'), true, 'case is ignored');
assert.equal(keyGroupMatches(key, 3, ' cd ef '), true, 'spacing is ignored');
assert.equal(keyGroupMatches(key, 3, 'cde'), false, 'a partial group is not a match');
assert.equal(keyGroupMatches(key, 3, 'cdef0'), false);
assert.equal(keyGroupMatches(key, 2, 'cdef'), false, 'the wrong group is not a match');
assert.equal(keyGroupMatches(key, 16, ''), false, 'past the end never matches, even when empty');

for (let i = 0; i < 200; i++) {
  const g = pickCheckGroups(16);
  assert.equal(g.length, 2);
  assert.ok(g[0] < g[1], 'distinct and ascending');
  assert.ok(g[0] >= 0 && g[1] < 16);
}
// A repeated pick is skipped, not returned twice.
const seq = [0.5, 0.5, 0.5, 0.1];
assert.deepEqual(pickCheckGroups(16, 2, () => seq.shift() ?? 0), [1, 8]);
assert.deepEqual(pickCheckGroups(1, 2), [0], 'never asks for more groups than exist');
assert.deepEqual(pickCheckGroups(0), []);

console.log('recoveryKeyCheck selftest: ok');
