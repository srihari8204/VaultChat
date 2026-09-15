/**
 * Node self-test for the device-security risk engine (0–100 score + bands).
 * Discovered and run by scripts/test-all.js (npm test). Pure logic, dev-only.
 *
 * Proves the scoring contract the whole Device Security & Monitoring module
 * rests on: the right band for each severity of signal, that overlapping
 * indicators of ONE condition are capped (not multiply-counted), that
 * heuristic confidence lowers weight, that pending factors carry zero weight,
 * and that scoring is deterministic and clamped to [0,100].
 */
import {
  assessRisk, riskSignal, bandFor, BAND_CUTOFFS, BAND_META, REMEDIATION,
  type SecuritySignal,
} from './riskEngine';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
const band = (sigs: SecuritySignal[]) => assessRisk(sigs).band;
const score = (sigs: SecuritySignal[]) => assessRisk(sigs).score;

(async () => {
  console.log('\ncrazzychat device-security risk engine self-test\n────────────────────────────────────────────────');

  // ── Empty / clean ────────────────────────────────────────────────
  console.log('Baseline:');
  check('no signals → score 0', score([]) === 0);
  check('no signals → low band', band([]) === 'low');
  check('null-safe on garbage input', assessRisk([null as any, undefined as any]).score === 0);

  // ── Single-signal bands ──────────────────────────────────────────
  console.log('Single-signal bands:');
  check('root alone → critical',            band([riskSignal('ROOT_DETECTED')]) === 'critical');
  check('jailbreak alone → critical',       band([riskSignal('JAILBREAK_DETECTED')]) === 'critical');
  check('frida alone → critical',           band([riskSignal('FRIDA_DETECTED')]) === 'critical');
  check('re-signed APK alone → critical',   band([riskSignal('APK_RESIGNED')]) === 'critical');
  check('integrity-fail alone → critical',  band([riskSignal('INTEGRITY_VERDICT_FAILED')]) === 'critical');
  check('su binary alone → high',           band([riskSignal('SU_BINARY_FOUND')]) === 'high');
  check('debugger alone → high',            band([riskSignal('DEBUGGER_ATTACHED')]) === 'high');
  check('accessibility risk alone → high',  band([riskSignal('ACCESSIBILITY_RISK')]) === 'high');
  check('magisk alone → medium (heuristic)',band([riskSignal('MAGISK_DETECTED')]) === 'medium');
  check('hook framework alone → medium',    band([riskSignal('HOOK_FRAMEWORK')]) === 'medium');
  check('overlay alone → medium',           band([riskSignal('OVERLAY_RISK')]) === 'medium');
  check('emulator alone → medium',          band([riskSignal('EMULATOR_DETECTED')]) === 'medium');
  check('usb debugging alone → low',        band([riskSignal('USB_DEBUGGING_ON')]) === 'low');
  check('dev options alone → low',          band([riskSignal('DEV_OPTIONS_ON')]) === 'low');
  check('network MITM alone → critical',    band([riskSignal('NETWORK_MITM')]) === 'critical');
  check('system proxy alone → medium',      band([riskSignal('PROXY_CONFIGURED')]) === 'medium');
  check('open wifi alone → low',            band([riskSignal('OPEN_WIFI')]) === 'low');

  // ── Cluster capping (one condition can't be multiply-counted) ─────
  console.log('Overlap capping:');
  const rootStack = assessRisk([
    riskSignal('ROOT_DETECTED'), riskSignal('SU_BINARY_FOUND'), riskSignal('MAGISK_DETECTED'),
  ]);
  check('root+su+magisk capped at cluster ceiling (≤80)', rootStack.score <= 80);
  check('root stack still critical', rootStack.band === 'critical');
  check('root cluster reported as capped', rootStack.clusters.some(c => c.cluster === 'root' && c.capped));
  const runtimeStack = assessRisk([
    riskSignal('FRIDA_DETECTED'), riskSignal('DEBUGGER_ATTACHED'), riskSignal('HOOK_FRAMEWORK'),
  ]);
  check('frida+debugger+hook capped (≤85) but critical', runtimeStack.score <= 85 && runtimeStack.band === 'critical');
  const netStack = assessRisk([
    riskSignal('NETWORK_MITM'), riskSignal('PROXY_CONFIGURED'), riskSignal('OPEN_WIFI'),
  ]);
  check('mitm+proxy+openwifi capped (≤70) but critical', netStack.score <= 70 && netStack.band === 'critical');

  // ── Combination escalation across clusters (NOT capped together) ──
  console.log('Cross-cluster escalation:');
  check('dev-options alone < usb+dev combination',
    score([riskSignal('DEV_OPTIONS_ON')]) < score([riskSignal('USB_DEBUGGING_ON'), riskSignal('DEV_OPTIONS_ON')]));
  check('emulator + usb + dev options → high (weak signals combine)',
    band([riskSignal('EMULATOR_DETECTED'), riskSignal('USB_DEBUGGING_ON'), riskSignal('DEV_OPTIONS_ON')]) === 'high');

  // ── Confidence weighting ─────────────────────────────────────────
  console.log('Confidence:');
  const full = score([riskSignal('ACCESSIBILITY_RISK', 'svc', 1.0)]);
  const half = score([riskSignal('ACCESSIBILITY_RISK', 'svc', 0.5)]);
  check('lower confidence → lower score', half < full);
  check('confidence clamped (>1 treated as 1)',
    score([riskSignal('ROOT_DETECTED', 'x', 5)]) === score([riskSignal('ROOT_DETECTED')]));
  check('negative confidence clamped to 0', score([riskSignal('ROOT_DETECTED', 'x', -3)]) === 0);

  // ── Pending factors carry zero weight ────────────────────────────
  console.log('Pending (never assumed safe or risky):');
  const withPending = assessRisk([riskSignal('DEV_OPTIONS_ON')], { pending: ['INTEGRITY_VERDICT_FAILED', 'USB_DEBUGGING_ON'] });
  check('pending does not change the score', withPending.score === score([riskSignal('DEV_OPTIONS_ON')]));
  check('pending list echoed for the dashboard', withPending.pending.length === 2);
  check('pending list de-duplicated',
    assessRisk([], { pending: ['USB_DEBUGGING_ON', 'USB_DEBUGGING_ON'] }).pending.length === 1);

  // ── Clamping & determinism ───────────────────────────────────────
  console.log('Clamp & determinism:');
  const kitchenSink = assessRisk([
    riskSignal('ROOT_DETECTED'), riskSignal('FRIDA_DETECTED'), riskSignal('APK_RESIGNED'),
    riskSignal('ACCESSIBILITY_RISK'), riskSignal('OVERLAY_RISK'), riskSignal('EMULATOR_DETECTED'),
    riskSignal('USB_DEBUGGING_ON'), riskSignal('DEV_OPTIONS_ON'),
  ]);
  check('everything at once clamps to ≤100', kitchenSink.score <= 100 && kitchenSink.score >= 65);
  check('everything at once → critical', kitchenSink.band === 'critical');
  const a = assessRisk([riskSignal('ROOT_DETECTED'), riskSignal('EMULATOR_DETECTED')]);
  const b = assessRisk([riskSignal('ROOT_DETECTED'), riskSignal('EMULATOR_DETECTED')]);
  check('deterministic (same input → same score)', a.score === b.score);
  check('reasons sorted by contribution, largest first',
    kitchenSink.reasons[0].startsWith('ROOT_DETECTED') || kitchenSink.reasons[0].startsWith('APK_RESIGNED') || kitchenSink.reasons[0].startsWith('FRIDA_DETECTED'));

  // ── Unknown signal type → conservative default ───────────────────
  console.log('Unknown types & tables:');
  check('unknown type scored, not ignored', score([riskSignal('SOMETHING_BRAND_NEW' as any)]) > 0);
  check('bandFor boundaries', bandFor(BAND_CUTOFFS.critical) === 'critical' && bandFor(BAND_CUTOFFS.high) === 'high' && bandFor(BAND_CUTOFFS.medium) === 'medium' && bandFor(0) === 'low');
  check('every band has presentation metadata', (['low','medium','high','critical'] as const).every(b => !!BAND_META[b]?.color && !!BAND_META[b]?.label));
  check('key signals have remediation copy', !!REMEDIATION.ROOT_DETECTED && !!REMEDIATION.FRIDA_DETECTED && !!REMEDIATION.ACCESSIBILITY_RISK);

  console.log('────────────────────────────────────────────────');
  if (failures === 0) { console.log('ALL DEVICE-SECURITY RISK TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
