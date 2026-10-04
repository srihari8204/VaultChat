// lib/onboardDate.selftest.ts — run: npx tsx lib/onboardDate.selftest.ts
// A DOB must round-trip to the same calendar day on both sides of UTC.
import assert from 'node:assert/strict';
import { fromLocalIsoDate, toLocalIsoDate } from './onboardDate';

for (const tz of ['America/Los_Angeles', 'Asia/Kolkata', 'UTC', 'Pacific/Kiritimati']) {
  process.env.TZ = tz;
  const d = fromLocalIsoDate('2000-01-01');
  assert.ok(d, tz);
  assert.equal(d!.getFullYear(), 2000, `${tz}: year`);
  assert.equal(d!.getMonth(), 0, `${tz}: month`);
  assert.equal(d!.getDate(), 1, `${tz}: day — not the evening before`);
  assert.equal(toLocalIsoDate(d!), '2000-01-01', `${tz}: round trip`);
  // What the picker hands back: local midnight.
  assert.equal(toLocalIsoDate(new Date(1999, 11, 31)), '1999-12-31', `${tz}: picker value kept`);
}
assert.equal(fromLocalIsoDate(''), null, 'nothing stored yet');
assert.equal(fromLocalIsoDate(undefined), null);
assert.equal(fromLocalIsoDate('01/01/2000'), null, 'not the stored shape');

console.log('onboardDate.selftest: all checks passed');
