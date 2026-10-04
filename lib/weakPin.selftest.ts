// lib/weakPin.selftest.ts — run: npx tsx lib/weakPin.selftest.ts
import assert from 'node:assert/strict';
import { isWeakPin } from './weakPin';

for (const p of ['111111', '123456', '654321', '234567', '987654', '012345', '121212', '112233'])
  assert.equal(isWeakPin(p), true, `${p} is weak`);
for (const p of ['482915', '730264', '190837'])
  assert.equal(isWeakPin(p), false, `${p} is fine`);
assert.equal(isWeakPin('12345'), true, 'too short');
assert.equal(isWeakPin('12a456'), true, 'not digits');
assert.equal(isWeakPin('419874', 6, '1987'), true, 'contains the birth year');
assert.equal(isWeakPin('419874', 6, undefined), false, 'no DOB known → no year rule');
assert.equal(isWeakPin('419874', 6, ''), false);
// Device PIN at another length uses the same rules.
assert.equal(isWeakPin('7777', 4), true);
assert.equal(isWeakPin('4821', 4), false);
console.log('weakPin.selftest: all checks passed');
