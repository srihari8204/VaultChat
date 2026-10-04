// lib/safetyQr.selftest.ts — run: npx tsx lib/safetyQr.selftest.ts
import assert from 'node:assert/strict';
import { compareSafetyQr, safetyQrPayload } from './safetyQr';

const n = '12345'.repeat(12);
const other = '54321'.repeat(12);

assert.equal(safetyQrPayload(n), 'vcsafety:1:' + n);
// The displayed (grouped) form encodes to the same payload.
assert.equal(safetyQrPayload(n.replace(/(\d{5})/g, '$1 ').trim()), 'vcsafety:1:' + n);

assert.equal(compareSafetyQr(safetyQrPayload(n), n), 'match');
assert.equal(compareSafetyQr('  ' + safetyQrPayload(n) + '\n', n), 'match', 'scanner whitespace is ignored');
assert.equal(compareSafetyQr(safetyQrPayload(other), n), 'mismatch');
// Not ours / damaged: never reported as a mismatch (that would cry wolf).
assert.equal(compareSafetyQr('vaultchat://add/v123abc', n), 'invalid');
assert.equal(compareSafetyQr('vcsafety:1:' + n.slice(0, 59), n), 'invalid');
assert.equal(compareSafetyQr('vcsafety:1:' + n + '0', n), 'invalid');
assert.equal(compareSafetyQr('vcsafety:2:' + n, n), 'invalid', 'an unknown version is not compared');
assert.equal(compareSafetyQr('', n), 'invalid');

console.log('safetyQr: all checks passed');
