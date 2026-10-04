// lib/bookmarkProtected.selftest.ts — run: npx tsx lib/bookmarkProtected.selftest.ts
import assert from 'node:assert/strict';
import { isProtectedMessage } from './bookmarkBodies';

assert.equal(isProtectedMessage({ viewOnce: true }), true);
assert.equal(isProtectedMessage({ invisibleInk: true }), true);
assert.equal(isProtectedMessage({ viewOnce: false, invisibleInk: false }), false);
assert.equal(isProtectedMessage({ caption: 'x' }), false);
assert.equal(isProtectedMessage(null), false);
assert.equal(isProtectedMessage(undefined), false);
assert.equal(isProtectedMessage('viewOnce'), false, 'a string is not a meta object');

console.log('bookmarkProtected selftest: ok');
