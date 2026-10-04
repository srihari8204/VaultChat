// lib/dialCodeOf.selftest.ts — run: npx tsx lib/dialCodeOf.selftest.ts
import assert from 'node:assert/strict';
import { dialCodeOf } from './dialCodeOf';

assert.equal(dialCodeOf('+919876543210'), '+91');
assert.equal(dialCodeOf('+14155550123'), '+1');
assert.equal(dialCodeOf('+44 7700 900123'), '+44', 'spacing ignored');
assert.equal(dialCodeOf('+971501234567'), '+971', 'longest prefix wins over +97x lookalikes');
assert.equal(dialCodeOf('+9779812345678'), '+977', 'Nepal, not +97');
assert.equal(dialCodeOf('+2348012345678'), '+234');
assert.equal(dialCodeOf('9876543210'), '+91', 'no + → fallback');
assert.equal(dialCodeOf(null, '+1'), '+1', 'missing → given fallback');
assert.equal(dialCodeOf('+999123'), '+91', 'unknown code → fallback');
console.log('dialCodeOf selftest: ok');
