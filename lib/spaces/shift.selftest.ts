// Run: npx tsx lib/spaces/shift.selftest.ts
import assert from 'node:assert/strict';
import { shiftBody } from './shift';

const ok = (r: ReturnType<typeof shiftBody>) => { assert.ok(r.ok, JSON.stringify(r)); return (r as any).body; };

assert.deepEqual(ok(shiftBody({ start: '9:00', end: '17:30', grace: '', delay: '' })),
  { shiftStart: '09:00', shiftEnd: '17:30', shiftGraceMinutes: 10 }, 'blank grace is the server default, times normalised');
assert.deepEqual(ok(shiftBody({ start: '', end: '', grace: '5', delay: '15' })),
  { shiftStart: '', shiftEnd: '', shiftGraceMinutes: 5, runDelayThresholdMinutes: 15 }, 'blank times clear the shift');
assert.equal(shiftBody({ start: '09:00', end: '', grace: '', delay: '' }).ok, false, 'half a shift is refused');
assert.equal(shiftBody({ start: '25:00', end: '17:00', grace: '', delay: '' }).ok, false);
assert.equal(shiftBody({ start: 'nine', end: '17:00', grace: '', delay: '' }).ok, false);
assert.equal(shiftBody({ start: '', end: '', grace: '241', delay: '' }).ok, false, 'grace bound matches the server');
assert.equal(shiftBody({ start: '', end: '', grace: '1.5', delay: '' }).ok, false);
assert.equal(shiftBody({ start: '', end: '', grace: '', delay: '0' }).ok, false, 'delay bound matches the server (1–240)');
assert.equal('runDelayThresholdMinutes' in ok(shiftBody({ start: '', end: '', grace: '', delay: '' })), false,
  'blank delay is omitted so the server keeps its current value');

console.log('spaces/shift self-check OK');
