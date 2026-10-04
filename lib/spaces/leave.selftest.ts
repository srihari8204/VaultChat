// Run: npx tsx lib/spaces/leave.selftest.ts
import assert from 'node:assert/strict';
import { ymd, dayOffset, allowanceBody } from './leave';

// Local calendar day, not the UTC one.
assert.equal(ymd(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
assert.equal(ymd(new Date(2026, 11, 31, 0, 5)), '2026-12-31');
assert.equal(dayOffset(1, new Date(2026, 1, 28, 22, 0)), '2026-03-01', 'crosses the month locally');
assert.equal(dayOffset(0, new Date(2026, 9, 4, 23, 59)), '2026-10-04');

const blank = { casual: '', sick: '', privilege: '', unpaid: '' };
assert.deepEqual(allowanceBody({ ...blank, casual: '12', sick: ' 6 ' }), { ok: true, body: { casual: 12, sick: 6 } });
assert.deepEqual(allowanceBody({ ...blank, unpaid: '0' }), { ok: true, body: { unpaid: 0 } }, 'zero is a real allowance');
assert.equal(allowanceBody(blank).ok, false, 'nothing given is refused, as the server does');
assert.equal(allowanceBody({ ...blank, casual: '366' }).ok, false);
assert.equal(allowanceBody({ ...blank, casual: '1.5' }).ok, false);
assert.equal(allowanceBody({ ...blank, casual: '-1' }).ok, false);

console.log('spaces/leave self-check OK');
