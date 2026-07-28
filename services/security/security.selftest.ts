/**
 * Node self-test for the threat engine + duress-PIN tracker. Run via esbuild
 * bundle (see services/crypto/README_E2EE.md for the runner pattern). Dev-only.
 */
import { assessThreats, signal, severityFor, DEFAULT_POLICY, type ThreatSignal } from './threatEngine';
import { createDuressPinTracker, type KV } from './duressPin';

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
  console.log('\nVaultChat security self-test\n──────────────────────────────');

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
  check('policy weights sane', DEFAULT_POLICY.weights.critical >= DEFAULT_POLICY.wipeAt);

  // Duress PIN tracker
  console.log('Duress-PIN tracker:');
  const t = createDuressPinTracker(makeKV());
  check('starts at 0, no signal', (await t.getCount()) === 0 && (await t.getSignal()) === null);
  await t.recordFailure(); await t.recordFailure();
  check('2 failures → still no signal', (await t.getCount()) === 2 && (await t.getSignal()) === null);
  await t.recordFailure();
  check('3 failures → high signal (PIN_BRUTEFORCE)', (await t.getSignal())?.severity === 'high');
  await t.recordFailure(); await t.recordFailure();
  check('5 failures → critical signal (DURESS_PIN_REPEATED)', (await t.getSignal())?.severity === 'critical');
  check('5-failure signal would wipe', assessThreats([(await t.getSignal())!]).level === 'wipe');
  await t.recordSuccess();
  check('success resets the counter', (await t.getCount()) === 0 && (await t.getSignal()) === null);

  console.log('──────────────────────────────');
  if (failures === 0) { console.log('ALL SECURITY TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
