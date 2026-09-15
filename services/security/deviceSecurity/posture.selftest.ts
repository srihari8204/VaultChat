/**
 * Node self-test for the posture model + snapshot diff.
 * Discovered and run by scripts/test-all.js (npm test). Pure logic, dev-only.
 *
 * Proves the dashboard sees the right factor statuses (clear/warning/critical/
 * pending/not_applicable), that unevaluated and platform-inapplicable factors
 * are never shown as "clear", that rollup rows take the worst member, and that
 * diffSnapshots only reports real security transitions (edge-triggered, no
 * clear↔pending noise).
 */
import { assessRisk, riskSignal, type SecuritySignalType } from './riskEngine';
import { buildSnapshot, diffSnapshots, factorKeys, type BuildOptions, type PostureSnapshot } from './posture';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}

const ALL_TYPES: SecuritySignalType[] = [
  'ROOT_DETECTED', 'JAILBREAK_DETECTED', 'SU_BINARY_FOUND', 'MAGISK_DETECTED',
  'FRIDA_DETECTED', 'DEBUGGER_ATTACHED', 'HOOK_FRAMEWORK', 'EMULATOR_DETECTED',
  'APK_RESIGNED', 'APK_UNOFFICIAL', 'INTEGRITY_VERDICT_FAILED',
  'ACCESSIBILITY_RISK', 'OVERLAY_RISK', 'USB_DEBUGGING_ON', 'DEV_OPTIONS_ON', 'HIGH_POWER_APP',
  'NETWORK_MITM', 'PROXY_CONFIGURED', 'OPEN_WIFI',
];

function snap(signals: ReturnType<typeof riskSignal>[], opts?: Partial<BuildOptions>): PostureSnapshot {
  const base: BuildOptions = {
    evaluatedTypes: ALL_TYPES, pendingTypes: [], platform: 'android', scannedAt: 1_000,
  };
  return buildSnapshot(assessRisk(signals, { pending: opts?.pendingTypes }), { ...base, ...opts });
}
const factor = (s: PostureSnapshot, key: string) => s.factors.find((f) => f.key === key)!;

(async () => {
  console.log('\ncrazzychat posture-model self-test\n──────────────────────────────────────');

  // ── Clean device ─────────────────────────────────────────────────
  console.log('Clean device (all evaluated):');
  const clean = snap([]);
  check('score 0, low band', clean.score === 0 && clean.band === 'low');
  check('root factor clear', factor(clean, 'root').status === 'clear');
  check('every catalog factor present', factorKeys().every((k) => clean.factors.some((f) => f.key === k)));

  // ── Detected signals → factor status ─────────────────────────────
  console.log('Detected → status:');
  const rooted = snap([riskSignal('ROOT_DETECTED')]);
  check('root → critical', factor(rooted, 'root').status === 'critical');
  check('device-integrity rollup → critical', factor(rooted, 'deviceIntegrity').status === 'critical');
  check('root factor carries signalType', factor(rooted, 'root').signalType === 'ROOT_DETECTED');
  const overlay = snap([riskSignal('OVERLAY_RISK')]);
  check('overlay (medium pts) → warning not critical', factor(overlay, 'permissionRisk').status === 'warning');
  const acc = snap([riskSignal('ACCESSIBILITY_RISK')]);
  check('accessibility (≥high pts) → critical', factor(acc, 'accessibility').status === 'critical');
  const mitm = snap([riskSignal('NETWORK_MITM')]);
  check('MITM → connection integrity critical', factor(mitm, 'connectionIntegrity').status === 'critical');
  check('MITM → network rollup critical', factor(mitm, 'network').status === 'critical');
  const proxy = snap([riskSignal('PROXY_CONFIGURED')]);
  check('proxy → proxy row warning', factor(proxy, 'proxy').status === 'warning');
  const owifi = snap([riskSignal('OPEN_WIFI')], { platform: 'ios' });
  check('open-wifi row is androidOnly → N/A on iOS', factor(owifi, 'wifiSecurity').status === 'not_applicable');

  // ── Rollup takes the worst member ────────────────────────────────
  console.log('Rollups:');
  const mixed = snap([riskSignal('EMULATOR_DETECTED')]);
  check('emulator alone → deviceIntegrity warning (not critical)', factor(mixed, 'deviceIntegrity').status === 'warning');
  const emuPlusRoot = snap([riskSignal('EMULATOR_DETECTED'), riskSignal('ROOT_DETECTED')]);
  check('emulator+root → deviceIntegrity critical (worst wins)', factor(emuPlusRoot, 'deviceIntegrity').status === 'critical');

  // ── Pending & platform ───────────────────────────────────────────
  console.log('Pending / not-applicable (never "clear"):');
  const partial = snap([], { evaluatedTypes: ['DEV_OPTIONS_ON'], pendingTypes: ['FRIDA_DETECTED'] });
  check('unevaluated frida factor → pending', factor(partial, 'frida').status === 'pending');
  check('root (not evaluated) → pending, not clear', factor(partial, 'root').status === 'pending');
  check('evaluated dev-options → clear', factor(partial, 'devOptions').status === 'clear');
  const ios = snap([], { platform: 'ios' });
  check('usb debugging on iOS → not_applicable', factor(ios, 'usbDebugging').status === 'not_applicable');
  check('accessibility on iOS → not_applicable', factor(ios, 'accessibility').status === 'not_applicable');
  check('root on iOS still evaluated (clear)', factor(ios, 'root').status === 'clear');

  // ── Diff: edge-triggered transitions ─────────────────────────────
  console.log('Diff:');
  check('null prev → no deltas, baseline score', diffSnapshots(null, rooted).factorDeltas.length === 0);
  const cleanToRoot = diffSnapshots(clean, rooted);
  check('clean→rooted: root worsened', cleanToRoot.factorDeltas.some((d) => d.key === 'root' && d.direction === 'worsened'));
  check('clean→rooted: worsened + band worsened', cleanToRoot.worsened && cleanToRoot.bandWorsened);
  check('clean→rooted: positive score delta', cleanToRoot.scoreDelta > 0);
  const rootToClean = diffSnapshots(rooted, clean);
  check('rooted→clean: root improved', rootToClean.factorDeltas.some((d) => d.key === 'root' && d.direction === 'improved'));
  check('rooted→clean: not worsened', rootToClean.worsened === false && rootToClean.bandWorsened === false);
  check('identical snapshots → no deltas', diffSnapshots(rooted, rooted).factorDeltas.length === 0);

  // clear↔pending churn must NOT count as a transition
  const allPending = snap([], { evaluatedTypes: [], pendingTypes: ALL_TYPES });
  check('clear→pending churn produces no deltas', diffSnapshots(clean, allPending).factorDeltas.length === 0);

  console.log('──────────────────────────────────────');
  if (failures === 0) { console.log('ALL POSTURE TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
