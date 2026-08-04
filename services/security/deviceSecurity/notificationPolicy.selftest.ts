/**
 * Node self-test for the notification policy (edge-trigger + cooldown + floor).
 * Discovered and run by scripts/test-all.js (npm test). Pure logic, dev-only.
 *
 * Proves the restraint contract: only worsened transitions push, improvements
 * stay silent, the same event is suppressed inside its cooldown window, critical
 * cools down faster than a warning, and a significant band-worsening score jump
 * fires exactly one "score changed" event. `now` and `lastSent` are injected so
 * there are no real timers.
 */
import { assessRisk, riskSignal, type SecuritySignalType } from './riskEngine';
import { buildSnapshot, diffSnapshots, type BuildOptions, type PostureSnapshot } from './posture';
import { decideNotifications, COOLDOWN_MS } from './notificationPolicy';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}
const ALL: SecuritySignalType[] = [
  'ROOT_DETECTED', 'FRIDA_DETECTED', 'DEBUGGER_ATTACHED', 'HOOK_FRAMEWORK', 'EMULATOR_DETECTED',
  'APK_RESIGNED', 'ACCESSIBILITY_RISK', 'OVERLAY_RISK', 'USB_DEBUGGING_ON', 'DEV_OPTIONS_ON',
  'MAGISK_DETECTED', 'SU_BINARY_FOUND', 'JAILBREAK_DETECTED', 'APK_UNOFFICIAL', 'INTEGRITY_VERDICT_FAILED', 'HIGH_POWER_APP',
];
function snap(signals: ReturnType<typeof riskSignal>[], scannedAt = 0): PostureSnapshot {
  const opts: BuildOptions = { evaluatedTypes: ALL, pendingTypes: [], platform: 'android', scannedAt };
  return buildSnapshot(assessRisk(signals), opts);
}

(async () => {
  console.log('\nVaultChat notification-policy self-test\n────────────────────────────────────────────');

  const clean = snap([]);
  const rooted = snap([riskSignal('ROOT_DETECTED')]);
  const devOn = snap([riskSignal('DEV_OPTIONS_ON')]);

  // ── Edge-trigger + floor ─────────────────────────────────────────
  console.log('Edge-trigger & floor:');
  const r1 = decideNotifications(diffSnapshots(clean, rooted), rooted, { now: 1_000_000, lastSent: {} });
  check('worsening to critical → one notification', r1.notifications.length >= 1 && r1.notifications.some((n) => n.factorKey === 'root'));
  check('root notification is critical severity', r1.notifications.find((n) => n.factorKey === 'root')?.severity === 'critical');
  check('improvement (rooted→clean) → no push', decideNotifications(diffSnapshots(rooted, clean), clean, { now: 2_000_000, lastSent: {} }).notifications.length === 0);
  check('no change → no push', decideNotifications(diffSnapshots(rooted, rooted), rooted, { now: 3_000_000, lastSent: {} }).notifications.length === 0);
  check('warning-floor: dev options ON → a notification', decideNotifications(diffSnapshots(clean, devOn), devOn, { now: 4_000_000, lastSent: {} }).notifications.some((n) => n.factorKey === 'devOptions'));

  // ── Cooldown ─────────────────────────────────────────────────────
  console.log('Cooldown:');
  const t0 = 10_000_000;
  const first = decideNotifications(diffSnapshots(clean, rooted), rooted, { now: t0, lastSent: {} });
  const rootKey = 'root';
  check('first fire records lastSent', typeof first.lastSent[rootKey] === 'number');
  const soon = decideNotifications(diffSnapshots(clean, rooted), rooted, { now: t0 + 60_000, lastSent: first.lastSent });
  check('same event within cooldown → suppressed', !soon.notifications.some((n) => n.factorKey === rootKey));
  const later = decideNotifications(diffSnapshots(clean, rooted), rooted, { now: t0 + COOLDOWN_MS.critical + 1, lastSent: first.lastSent });
  check('same event after cooldown → fires again', later.notifications.some((n) => n.factorKey === rootKey));
  check('critical cooldown shorter than warning', COOLDOWN_MS.critical < COOLDOWN_MS.warning);

  // warning cooldown is long — dev options shouldn't re-nag after 30 min
  const d0 = 20_000_000;
  const dv1 = decideNotifications(diffSnapshots(clean, devOn), devOn, { now: d0, lastSent: {} });
  const dvSoon = decideNotifications(diffSnapshots(clean, devOn), devOn, { now: d0 + COOLDOWN_MS.critical + 1, lastSent: dv1.lastSent });
  check('warning still cooling after 30 min', !dvSoon.notifications.some((n) => n.factorKey === 'devOptions'));

  // ── Significant score change ─────────────────────────────────────
  console.log('Score-change event:');
  const big = decideNotifications(diffSnapshots(clean, rooted), rooted, { now: 30_000_000, lastSent: {} });
  check('band-worsening jump → a SECURITY_SCORE_CHANGED event', big.notifications.some((n) => n.event === 'SECURITY_SCORE_CHANGED'));
  const tinyPrev = snap([riskSignal('DEV_OPTIONS_ON')]);
  const tinyNext = snap([riskSignal('DEV_OPTIONS_ON'), riskSignal('USB_DEBUGGING_ON')]);
  const tiny = decideNotifications(diffSnapshots(tinyPrev, tinyNext), tinyNext, { now: 31_000_000, lastSent: {} });
  check('small same-band change → no score-change event', !tiny.notifications.some((n) => n.event === 'SECURITY_SCORE_CHANGED'));

  console.log('────────────────────────────────────────────');
  if (failures === 0) { console.log('ALL NOTIFICATION-POLICY TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
