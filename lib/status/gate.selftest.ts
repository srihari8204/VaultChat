/**
 * lib/status/gate.selftest.ts — npx tsx lib/status/gate.selftest.ts
 *
 * Two failures here are unrecoverable for a user, so they get the most cases:
 * an answer nobody can ever match, and a puzzle nobody can ever solve.
 */
import assert from 'node:assert/strict';
import {
  isValidGrid, pieceCount, normalizeAnswer, isAcceptableAnswer, isSolved,
  shuffle, isCryptographic, GRID_MIN, GRID_MAX, ANSWER_MIN_LEN,
} from './gate';

console.log('\nGrid sizes the poster may choose (3x3 .. 9x9):');
assert.equal(isValidGrid(3), true);
assert.equal(isValidGrid(9), true);
console.log(`  ✓ ${GRID_MIN}x${GRID_MIN} and ${GRID_MAX}x${GRID_MAX} accepted`);
assert.equal(isValidGrid(2), false);
assert.equal(isValidGrid(10), false);
console.log('  ✓ outside the range refused');
assert.equal(isValidGrid(4.5), false);
assert.equal(isValidGrid(NaN), false);
console.log('  ✓ non-integers refused (a 4.5x4.5 grid has no meaning)');
assert.equal(pieceCount(9), 81);
console.log('  ✓ 9x9 = 81 pieces');
assert.equal(pieceCount(2), 0);
console.log('  ✓ an invalid grid yields no pieces, not a wrong count');

console.log('\nAnswer normalising — the thing that silently locks people out:');
assert.equal(normalizeAnswer('  Mumbai  '), 'mumbai');
console.log('  ✓ trimmed and case-folded');
assert.equal(normalizeAnswer('New   Delhi'), 'new delhi');
console.log('  ✓ internal whitespace collapsed');
assert.equal(normalizeAnswer('MUMBAI'), normalizeAnswer('mumbai'));
console.log('  ✓ poster and viewer agree across case');

// The poster types on one keyboard, the viewer on another. Without NFKC these
// are different bytes and the answer can NEVER match.
assert.equal(normalizeAnswer('ﬁre'), normalizeAnswer('fire'));
console.log('  ✓ NFKC folds compatibility forms (different keyboards agree)');

// Punctuation is KEPT on purpose — dropping it shrinks an already small keyspace.
assert.notEqual(normalizeAnswer('st. mary'), normalizeAnswer('st mary'));
console.log('  ✓ punctuation preserved (deliberate: keyspace, not convenience)');

assert.equal(isAcceptableAnswer('   '), false);
console.log('  ✓ whitespace-only is not an answer');
assert.equal(isAcceptableAnswer('a'), ANSWER_MIN_LEN <= 1);
assert.equal(isAcceptableAnswer('ok'), true);
console.log(`  ✓ minimum length ${ANSWER_MIN_LEN} enforced after normalising`);

console.log('\nSolving:');
assert.equal(isSolved([0, 1, 2, 3]), true);
console.log('  ✓ pieces in order = solved');
assert.equal(isSolved([1, 0, 2, 3]), false);
console.log('  ✓ one swap = not solved');

console.log('\nShuffles must never be born solved, and never be unsolvable:');
// Rigged rand that always picks 0 — Fisher-Yates then returns the identity,
// which is exactly the "handed a solved puzzle" bug.
const rigged = shuffle(9, () => 0);
assert.equal(isSolved(rigged), false, 'a shuffle must never come out already solved');
console.log('  ✓ a degenerate RNG still yields an unsolved board');
assert.deepEqual([...rigged].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
console.log('  ✓ every piece present exactly once (no piece lost or duplicated)');

// This is a swap-jigsaw, not a sliding puzzle: EVERY permutation is reachable,
// so a poster can never publish a status nobody can open. Half of random
// 15-puzzle shuffles are unsolvable — that bug would be invisible until a real
// viewer was stuck forever.
let seed = 42;
const lcg = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let n = GRID_MIN; n <= GRID_MAX; n++) {
  const a = shuffle(pieceCount(n), lcg);
  assert.equal(a.length, n * n);
  assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: n * n }, (_, i) => i));
  assert.equal(isSolved(a), false);
}
console.log(`  ✓ every grid ${GRID_MIN}..${GRID_MAX} shuffles complete and unsolved`);

assert.deepEqual(shuffle(0, Math.random), []);
assert.deepEqual(shuffle(1, Math.random), [0]);
console.log('  ✓ degenerate counts do not throw');

console.log('\nThe honest labelling — a puzzle must never claim to be a lock:');
assert.equal(isCryptographic('question'), true);
console.log('  ✓ question gate withholds the KEY');
assert.equal(isCryptographic('puzzle'), false);
console.log('  ✓ puzzle gate withholds only the UI');
assert.equal(isCryptographic('none'), false);
console.log('  ✓ no gate is not cryptographic either');

console.log('\nAll status gate checks passed.\n');
