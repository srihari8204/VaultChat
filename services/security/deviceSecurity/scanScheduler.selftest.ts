/**
 * Node self-test for the scan scheduler (when + how deep to scan).
 * Discovered and run by scripts/test-all.js (npm test). Pure logic, dev-only.
 *
 * Proves the battery contract: manual/event always scan deeply; launch and
 * foreground do throttled light scans; the periodic job is deep on a long
 * cadence; a never-scanned device always scans; and a backwards clock jump is
 * treated as due rather than wedging scanning off.
 */
import { decideScan, DEFAULT_SCAN_POLICY as P } from './scanScheduler';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
const NOW = 1_700_000_000_000;

(async () => {
  console.log('\ncrazzychat scan-scheduler self-test\n──────────────────────────────────────');

  // ── Always-scan triggers ─────────────────────────────────────────
  console.log('Manual / event:');
  const m = decideScan('manual', NOW - 1000, NOW);
  check('manual → scan, deep', m.shouldScan && m.depth === 'deep');
  const e = decideScan('event', NOW - 1000, NOW);
  check('event → scan, deep', e.shouldScan && e.depth === 'deep');
  check('manual scans even right after a scan', decideScan('manual', NOW - 1, NOW).shouldScan);

  // ── Never scanned ────────────────────────────────────────────────
  console.log('First scan:');
  check('launch, never scanned → scan light', decideScan('launch', null, NOW).shouldScan === true && decideScan('launch', null, NOW).depth === 'light');
  check('periodic, never scanned → scan deep', decideScan('periodic', null, NOW).depth === 'deep');

  // ── Launch throttle ──────────────────────────────────────────────
  console.log('Launch throttle:');
  check('launch within 5 min → no scan', decideScan('launch', NOW - 60_000, NOW).shouldScan === false);
  check('launch after 5 min → scan light', (() => { const d = decideScan('launch', NOW - P.launchMinIntervalMs - 1, NOW); return d.shouldScan && d.depth === 'light'; })());

  // ── Foreground throttle ──────────────────────────────────────────
  console.log('Foreground throttle:');
  check('foreground within 15 min → no scan', decideScan('foreground', NOW - 5 * 60_000, NOW).shouldScan === false);
  check('foreground after 15 min → scan light', decideScan('foreground', NOW - P.foregroundMinIntervalMs - 1, NOW).shouldScan === true);
  check('foreground gap longer than launch gap', P.foregroundMinIntervalMs > P.launchMinIntervalMs);

  // ── Periodic cadence ─────────────────────────────────────────────
  console.log('Periodic cadence:');
  check('periodic within 12 h → no scan', decideScan('periodic', NOW - 6 * 3_600_000, NOW).shouldScan === false);
  check('periodic after 12 h → scan deep', (() => { const d = decideScan('periodic', NOW - P.periodicIntervalMs - 1, NOW); return d.shouldScan && d.depth === 'deep'; })());
  check('periodic cadence is the longest gap', P.periodicIntervalMs > P.foregroundMinIntervalMs);

  // ── Clock skew safety ────────────────────────────────────────────
  console.log('Clock skew:');
  check('last scan in the future (launch) → scan', decideScan('launch', NOW + 3_600_000, NOW).shouldScan === true);
  check('last scan in the future (periodic) → scan', decideScan('periodic', NOW + 3_600_000, NOW).shouldScan === true);

  console.log('──────────────────────────────────────');
  if (failures === 0) { console.log('ALL SCAN-SCHEDULER TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
