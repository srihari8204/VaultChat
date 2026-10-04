// lib/resumeLockPolicy.selftest.ts — run: npx tsx lib/resumeLockPolicy.selftest.ts
import assert from 'node:assert/strict';
import { DEFAULT_LOCK_TIMER, lockTimerMs, parseLockTimer, shouldRelock } from './resumeLockPolicy';

assert.equal(parseLockTimer(null), DEFAULT_LOCK_TIMER, 'nothing saved → default');
assert.equal(parseLockTimer('{"lockTimer":"15m"}'), '15m');
assert.equal(parseLockTimer('{"lockTimer":"never","screenshotAlert":true}'), 'never', 'old keys in the blob are ignored');
assert.equal(parseLockTimer('{"lockTimer":"2h"}'), DEFAULT_LOCK_TIMER, 'unknown value → default');
assert.equal(parseLockTimer('not json'), DEFAULT_LOCK_TIMER);

assert.equal(lockTimerMs('1m'), 60_000);
assert.equal(lockTimerMs('30m'), 1_800_000);
assert.equal(lockTimerMs('never'), null);

const five = lockTimerMs('5m');
assert.equal(shouldRelock(299_999, five, true), false, 'back before the timeout → stays open');
assert.equal(shouldRelock(300_000, five, true), true, 'away for the timeout → locks');
assert.equal(shouldRelock(3_600_000, five, false), false, 'lock not set up (MFA off / signed out) → never');
assert.equal(shouldRelock(3_600_000, null, true), false, '"Never" → never');
assert.equal(shouldRelock(-5_000, five, true), false, 'clock moved back → no lock from the gap alone');

console.log('resumeLockPolicy.selftest: all checks passed');
