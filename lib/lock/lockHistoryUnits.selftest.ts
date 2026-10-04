// lib/lock/lockHistoryUnits.selftest.ts — run: npx tsx lib/lock/lockHistoryUnits.selftest.ts
//
// Lock history printed event distances as `${Math.round(d)} m` whatever the
// user's units (spec: imperial applies in history too). It now goes through
// fmtDistance like every other lock readout; this pins the outputs it shows.
import assert from 'node:assert/strict';
import { fmtDistance } from './format';

// Metric: whole metres below 1 km, then km.
assert.equal(fmtDistance(42.4, 'metric'), '42 m');
assert.equal(fmtDistance(42.4), '42 m', 'metric is the default');
assert.equal(fmtDistance(1250, 'metric'), '1.25 km');

// Imperial: feet below 1000 ft, then miles — never metres.
assert.equal(fmtDistance(42.4, 'imperial'), '139 ft');
assert.equal(fmtDistance(300, 'imperial'), '984 ft');
assert.equal(fmtDistance(1609.344, 'imperial'), '1.00 mi');
for (const m of [0, 5, 120, 900, 5000]) {
  assert.ok(!/\bm$|km$/.test(fmtDistance(m, 'imperial')), `imperial ${m} m must not print metric`);
}

console.log('lock/lockHistoryUnits selftest: OK');
