// lib/resumeLockPolicy.selftest.ts — run: npx tsx lib/resumeLockPolicy.selftest.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LOCK_TIMER, lockAppliesTo, lockTimerMs, parseLockTimer, shouldRelock, unlockMode,
} from './resumeLockPolicy';

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

// Who the lock applies to: device MFA OR a Device PIN, and signed in.
assert.equal(lockAppliesTo({ signedIn: true, mfaOn: true, hasDevicePin: false }), true, 'MFA user');
assert.equal(lockAppliesTo({ signedIn: true, mfaOn: false, hasDevicePin: true }), true, 'Device-PIN user is relocked too');
assert.equal(lockAppliesTo({ signedIn: true, mfaOn: false, hasDevicePin: false }), false, 'neither set → no lock');
assert.equal(lockAppliesTo({ signedIn: false, mfaOn: true, hasDevicePin: true }), false, 'signed out → nothing to lock');

// Which unlock the lock screen opens with.
assert.equal(unlockMode({ sealedLocked: true, mfaOn: true, hasDevicePin: true }), 'seal', 'sealed session: only the PIN opens it');
assert.equal(unlockMode({ sealedLocked: false, mfaOn: true, hasDevicePin: true }), 'bio', 'MFA starts with biometrics');
assert.equal(unlockMode({ sealedLocked: false, mfaOn: false, hasDevicePin: true }), 'pin', 'PIN-only user is asked for the Device PIN');
assert.equal(unlockMode({ sealedLocked: false, mfaOn: false, hasDevicePin: false }), 'bio', 'nothing set: unchanged default');

// The wiring: ResumeLock must use the shared rule, not an MFA-only check.
const resume = fs.readFileSync(path.join(__dirname, '..', 'components', 'ResumeLock.tsx'), 'utf8');
assert.ok(/lockAppliesTo\(/.test(resume) && /hasPin\(\)/.test(resume), 'ResumeLock asks lockAppliesTo with the Device PIN');
const appLock = fs.readFileSync(path.join(__dirname, '..', 'app', 'app-lock.tsx'), 'utf8');
assert.ok(/unlockMode\(/.test(appLock) && /verifyPin\(/.test(appLock), 'app-lock accepts the Device PIN');

console.log('resumeLockPolicy.selftest: all checks passed');
