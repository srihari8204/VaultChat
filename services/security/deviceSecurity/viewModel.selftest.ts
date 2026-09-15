/**
 * Node self-test for the dashboard view-model.
 * Discovered and run by scripts/test-all.js (npm test). Pure logic, dev-only.
 *
 * Proves the screen shows an honest empty state before any scan, the right
 * per-status colour/label for each factor row, a score→band header, ranked and
 * de-duplicated recommended actions (most-severe first), and deterministic
 * relative-time text.
 */
import { assessRisk, riskSignal, type SecuritySignalType } from './riskEngine';
import { buildSnapshot, type BuildOptions } from './posture';
import { buildDashboardViewModel, relativeTime, STATUS_META } from './viewModel';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
const ALL: SecuritySignalType[] = [
  'ROOT_DETECTED', 'FRIDA_DETECTED', 'DEBUGGER_ATTACHED', 'HOOK_FRAMEWORK', 'EMULATOR_DETECTED',
  'APK_RESIGNED', 'ACCESSIBILITY_RISK', 'OVERLAY_RISK', 'USB_DEBUGGING_ON', 'DEV_OPTIONS_ON',
  'MAGISK_DETECTED', 'SU_BINARY_FOUND', 'JAILBREAK_DETECTED', 'APK_UNOFFICIAL', 'INTEGRITY_VERDICT_FAILED', 'HIGH_POWER_APP',
  'NETWORK_MITM', 'PROXY_CONFIGURED', 'OPEN_WIFI',
];
function snap(signals: ReturnType<typeof riskSignal>[], scannedAt: number) {
  const opts: BuildOptions = { evaluatedTypes: ALL, pendingTypes: [], platform: 'android', scannedAt };
  return buildSnapshot(assessRisk(signals), opts);
}

(async () => {
  console.log('\ncrazzychat dashboard view-model self-test\n────────────────────────────────────────────');

  // ── Empty state (never scanned) ──────────────────────────────────
  console.log('Empty state:');
  const empty = buildDashboardViewModel(null, 1_700_000_000_000);
  check('hasScanned false', empty.hasScanned === false);
  check('score is null (not a fabricated number)', empty.score === null);
  check('band is null, honest label', empty.band === null && empty.bandLabel === 'Not scanned');
  check('no factors / no actions', empty.factors.length === 0 && empty.actions.length === 0);
  check('last-scan text is honest', empty.lastScanText === 'Not scanned yet');

  // ── Clean device ─────────────────────────────────────────────────
  console.log('Clean device:');
  const now = 1_700_000_600_000;
  const clean = buildDashboardViewModel(snap([], now - 30_000), now);
  check('hasScanned true', clean.hasScanned === true);
  check('score 0, ring empty', clean.score === 0 && clean.ringPct === 0);
  check('low band label', clean.band === 'low' && clean.bandLabel === 'Low risk');
  check('all factor rows present', clean.factors.length > 0);
  check('root row clear w/ green', clean.factors.find((f) => f.key === 'root')?.statusColor === STATUS_META.clear.color);
  check('no actions when clean', clean.actions.length === 0);
  check('relative time "just now"', clean.lastScanText === 'just now');

  // ── Compromised device ───────────────────────────────────────────
  console.log('Compromised device:');
  const bad = buildDashboardViewModel(snap([
    riskSignal('ROOT_DETECTED'), riskSignal('OVERLAY_RISK'), riskSignal('DEV_OPTIONS_ON'),
  ], now - 3_600_000), now);
  check('critical band', bad.band === 'critical' && bad.bandColor === '#EF4444');
  check('ring fill = score/100', Math.abs(bad.ringPct - bad.score! / 100) < 1e-9);
  check('root row critical (red)', bad.factors.find((f) => f.key === 'root')?.status === 'critical');
  check('overlay row warning (amber)', bad.factors.find((f) => f.key === 'permissionRisk')?.status === 'warning');
  check('has recommended actions', bad.actions.length > 0);
  check('actions ranked: critical before warning',
    RANKok(bad.actions.map((a) => a.severity)));
  check('root remediation present', bad.actions.some((a) => a.text.toLowerCase().includes('rooted')));
  check('relative time "1h ago"', bad.lastScanText === '1h ago');

  // ── De-dup: rollup + leaf don't double an action ─────────────────
  console.log('Action de-dup:');
  const rootOnly = buildDashboardViewModel(snap([riskSignal('ROOT_DETECTED')], now), now);
  const rootedTexts = rootOnly.actions.map((a) => a.text);
  check('root advice not duplicated across rollup+leaf', new Set(rootedTexts).size === rootedTexts.length);

  // ── Pending never shown as clear ─────────────────────────────────
  console.log('Pending honesty:');
  const partial = buildDashboardViewModel(
    buildSnapshot(assessRisk([]), { evaluatedTypes: ['DEV_OPTIONS_ON'], pendingTypes: ['FRIDA_DETECTED'], platform: 'android', scannedAt: now }),
    now,
  );
  const fridaRow = partial.factors.find((f) => f.key === 'frida');
  check('frida row = "Not evaluated" grey', fridaRow?.statusLabel === 'Not evaluated' && fridaRow?.statusColor === STATUS_META.pending.color);

  // ── relativeTime buckets ─────────────────────────────────────────
  console.log('relativeTime:');
  check('seconds → just now', relativeTime(now - 10_000, now) === 'just now');
  check('minutes → Nm ago', relativeTime(now - 5 * 60_000, now) === '5m ago');
  check('days → Nd ago', relativeTime(now - 3 * 86_400_000, now) === '3d ago');

  console.log('────────────────────────────────────────────');
  if (failures === 0) { console.log('ALL VIEW-MODEL TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });

function RANKok(sevs: string[]): boolean {
  // no 'warning' may appear before a 'critical'
  let seenWarning = false;
  for (const s of sevs) {
    if (s === 'warning') seenWarning = true;
    if (s === 'critical' && seenWarning) return false;
  }
  return true;
}
