/**
 * Node self-test for the threat engine + PIN-attempt tracker. Run via esbuild
 * bundle (see services/crypto/README_E2EE.md for the runner pattern). Dev-only.
 */
import { assessThreats, signal, severityFor, DEFAULT_POLICY, type ThreatSignal } from './threatEngine';
import { createPinAttemptTracker, type KV } from './pinAttempts';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
function makeKV(): KV {
  const m = new Map<string, string>();
  return {
    async get(k) { return m.has(k) ? (m.get(k) as string) : null; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
  };
}
const lvl = (sigs: ThreatSignal[]) => assessThreats(sigs).level;

(async () => {
  console.log('\ncrazzychat security self-test\n──────────────────────────────');

  // Threat engine — graded response
  console.log('Threat engine:');
  check('no signals → clean', lvl([]) === 'clean');
  check('root alone → wipe (critical)', lvl([signal('ROOT_DETECTED')]) === 'wipe');
  check('frida alone → wipe (critical)', lvl([signal('FRIDA_PORT_27042')]) === 'wipe');
  check('emulator alone → restrict (graded, not wipe)', lvl([signal('EMULATOR_DETECTED')]) === 'restrict');
  check('adb alone → monitor (weak)', lvl([signal('ADB_ENABLED')]) === 'monitor');
  check('emulator + test-keys (two high) → wipe (combination)', lvl([signal('EMULATOR_DETECTED'), signal('TEST_KEYS_BUILD')]) === 'wipe');
  check('emulator + adb → restrict (escalated but not wipe)', lvl([signal('EMULATOR_DETECTED'), signal('ADB_ENABLED')]) === 'restrict');
  check('any critical present → wipe regardless', assessThreats([signal('ADB_ENABLED'), signal('ROOT_DETECTED')]).level === 'wipe');
  check('score is summed', assessThreats([signal('ADB_ENABLED'), signal('ADB_ENABLED')]).score === 6);
  check('hasCritical flag set', assessThreats([signal('ROOT_DETECTED')]).hasCritical === true);
  check('reasons include type+severity', assessThreats([signal('EMULATOR_DETECTED', 'sdk_gphone')]).reasons[0].includes('EMULATOR_DETECTED(high)'));

  // Severity mapping
  console.log('Severity mapping:');
  check('known type → mapped severity', severityFor('ROOT_DETECTED') === 'critical' && severityFor('ADB_ENABLED') === 'medium');
  check('unknown type → defaults high', severityFor('SOMETHING_NEW') === 'high');
  // The enforcement path now grades the NATIVE VaultShield signal names. If one
  // of these falls through to the 'high' default, a phone with developer
  // options on gets hard-blocked — which is exactly the bug this fixed.
  check('native compromise signals are critical',
    severityFor('FRIDA_DETECTED') === 'critical' &&
    severityFor('JAILBREAK_DETECTED') === 'critical' &&
    severityFor('APK_RESIGNED') === 'critical');
  check('native config signals stay below restrict',
    lvl([signal('DEV_OPTIONS_ON'), signal('USB_DEBUGGING_ON'), signal('ACCESSIBILITY_RISK')]) === 'monitor');
  check('policy weights sane', DEFAULT_POLICY.weights.critical >= DEFAULT_POLICY.wipeAt);

  // PIN attempt tracker
  console.log('PIN-attempt tracker:');
  const t = createPinAttemptTracker(makeKV());
  check('starts at 0, no signal', (await t.getCount()) === 0 && (await t.getSignal()) === null);
  await t.recordFailure(); await t.recordFailure();
  check('2 failures → still no signal', (await t.getCount()) === 2 && (await t.getSignal()) === null);
  await t.recordFailure();
  // SEVERITY IS medium AND THAT IS THE POINT (2026-09-17). This tracker was
  // unreachable until the record calls moved into pinStore.verifyPin. On the
  // day it became reachable, 'high' (weight 7) cleared restrictAt (5) BY
  // ITSELF, so three mistyped PINs sent the launch scan to /blocked - back
  // button disabled - for 15 minutes. The signal must inform a score built
  // from independent indicators, never reach a verdict alone.
  check('3 failures → signals PIN_BRUTEFORCE', (await t.getSignal())?.type === 'PIN_BRUTEFORCE');
  check('...at medium, so it cannot restrict the app on its own',
    (await t.getSignal())?.severity === 'medium'
    // 'monitor' is the honest verdict for one medium signal, and
    // securityService.ts:292 counts monitor as clean - so the launch scan
    // does NOT send the user to /blocked. That is the invariant worth
    // pinning: not the exact level, but that a fumbled PIN alone can never
    // restrict or wipe.
    && !['restrict', 'wipe'].includes(assessThreats([(await t.getSignal())!]).level));
  await t.recordFailure(); await t.recordFailure();
  // DELIBERATE: repeated wrong PINs must NEVER wipe on their own. The old
  // tracker escalated to `critical` at 5, which handed any passer-by a
  // denial-of-service (guess until the phone erases itself) and destroyed data
  // on a pocket-dial. Guessing restricts; a wipe needs a second, independent
  // indicator such as root or a hooking framework.
  check('5 failures → still only medium, never critical', (await t.getSignal())?.severity === 'medium');
  check('5 failures alone do NOT wipe', assessThreats([(await t.getSignal())!]).level !== 'wipe');
  check('guessing + root DOES wipe', assessThreats([
    (await t.getSignal())!, signal('ROOT_DETECTED', 'su found'),
  ]).level === 'wipe');
  check('backoff grows with the streak', (await t.getBackoffMs()) > 0);
  await t.recordSuccess();
  check('success resets the counter', (await t.getCount()) === 0 && (await t.getSignal()) === null);
  check('a reset streak owes no backoff', (await t.getBackoffMs()) === 0);

  // Failures decay: a streak that went quiet is not a streak. Three wrong
  // entries on Monday and two on Friday must not look like five in a row.
  let clock = 1_000_000;
  const aged = createPinAttemptTracker(makeKV(), () => clock);
  await aged.recordFailure(); await aged.recordFailure(); await aged.recordFailure();
  check('3 recent failures signal', (await aged.getSignal())?.severity === 'medium');
  clock += 16 * 60_000;   // longer than DECAY_MS
  check('the same failures go quiet after the decay window', (await aged.getSignal()) === null);
  check('and the count is back to 0', (await aged.getCount()) === 0);

  console.log('──────────────────────────────');
  if (failures === 0) { console.log('ALL SECURITY TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
