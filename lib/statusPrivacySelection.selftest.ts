// Run: npx tsx lib/statusPrivacySelection.selftest.ts
import assert from 'node:assert/strict';
import { modeSwitchClearsList, privacyUserIds, selectionAfterModeSwitch } from './statusPrivacySelection';

const excluded = new Set(['ex1', 'ex2']);

// An "except" list must never become an "only" list, nor the other way round.
assert.deepEqual([...selectionAfterModeSwitch('except', 'only', excluded)], []);
assert.deepEqual([...selectionAfterModeSwitch('only', 'except', excluded)], []);
// Through "My contacts" and back: still empty, nothing stale resurfaces.
assert.deepEqual([...selectionAfterModeSwitch('except', 'contacts', excluded)], []);
assert.deepEqual([...selectionAfterModeSwitch('contacts', 'only', excluded)], []);
// Same mode keeps the list, as a copy.
const same = selectionAfterModeSwitch('except', 'except', excluded);
assert.deepEqual([...same].sort(), ['ex1', 'ex2']);
assert.notEqual(same, excluded);

assert.deepEqual(privacyUserIds('contacts', excluded), []);
assert.deepEqual(privacyUserIds('only', new Set(['a'])), ['a']);

// Leaving a mode that holds a list is confirmed; nothing to lose, no prompt.
assert.equal(modeSwitchClearsList('except', 'only', excluded), true);
assert.equal(modeSwitchClearsList('only', 'contacts', excluded), true);
assert.equal(modeSwitchClearsList('except', 'only', new Set()), false);
assert.equal(modeSwitchClearsList('contacts', 'except', excluded), false);
assert.equal(modeSwitchClearsList('except', 'except', excluded), false);

console.log('statusPrivacySelection selftest passed');
