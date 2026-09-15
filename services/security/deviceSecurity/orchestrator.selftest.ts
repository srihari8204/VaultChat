/**
 * Node self-test for the scan orchestrator (collect→score→diff→notify→persist).
 * Discovered and run by scripts/test-all.js (npm test). Pure via injected deps:
 * an in-memory store, a fake collector, and a controllable clock — no RN, no
 * timers, no SecureStore.
 *
 * Proves the full pipeline: the first scan sets a baseline with no alerts;
 * a later worsening scan alerts AND persists; a repeat scan of the same state
 * is quiet (edge-triggered); cooldown carries across scans through the persisted
 * last-sent map; and the snapshot round-trips through the store.
 */
import { riskSignal, type SecuritySignal, type SecuritySignalType } from './riskEngine';
import type { Platform } from './posture';
import {
  runDeviceScan, getCurrentSnapshot, clearPostureState,
  type CollectorResult, type StorageKV, type ScanDeps,
} from './orchestrator';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? '  ✓ PASS' : '  ✗ FAIL') + '  ' + name);
  if (!cond) failures++;
}

function memStore(): StorageKV & { dump: Record<string, string> } {
  const m: Record<string, string> = {};
  return {
    dump: m,
    async get(k) { return k in m ? m[k] : null; },
    async set(k, v) { m[k] = v; },
    async del(k) { delete m[k]; },
  };
}

const EVAL_ALL: SecuritySignalType[] = [
  'ROOT_DETECTED', 'FRIDA_DETECTED', 'DEBUGGER_ATTACHED', 'HOOK_FRAMEWORK', 'EMULATOR_DETECTED',
  'APK_RESIGNED', 'ACCESSIBILITY_RISK', 'OVERLAY_RISK', 'USB_DEBUGGING_ON', 'DEV_OPTIONS_ON',
  'MAGISK_DETECTED', 'SU_BINARY_FOUND', 'JAILBREAK_DETECTED', 'APK_UNOFFICIAL', 'INTEGRITY_VERDICT_FAILED', 'HIGH_POWER_APP',
  'NETWORK_MITM', 'PROXY_CONFIGURED', 'OPEN_WIFI',
];
// A collector that reports a fixed signal set, evaluating everything.
const collectorOf = (signals: SecuritySignal[]) =>
  async (_p: Platform): Promise<CollectorResult> => ({ signals, evaluatedTypes: EVAL_ALL, pendingTypes: [] });

function deps(store: StorageKV, signals: SecuritySignal[], now: number): ScanDeps {
  return { collect: collectorOf(signals), store, now: () => now, platform: 'android' };
}

(async () => {
  console.log('\ncrazzychat scan-orchestrator self-test\n──────────────────────────────────────────');

  // ── First scan: baseline, no alerts ──────────────────────────────
  console.log('First scan (baseline):');
  const store = memStore();
  const first = await runDeviceScan(deps(store, [], 1_700_000_000_000));
  check('first scan has no previous', first.previous === null);
  check('clean baseline → low band, score 0', first.snapshot.band === 'low' && first.snapshot.score === 0);
  check('first scan emits no notifications', first.notifications.length === 0);
  check('snapshot persisted', !!store.dump['vc_devsec_snapshot']);

  // ── Worsening scan: alert + persist ──────────────────────────────
  console.log('Worsening scan:');
  const t2 = 1_700_000_100_000;
  const worse = await runDeviceScan(deps(store, [riskSignal('ROOT_DETECTED')], t2));
  check('previous is the clean baseline', worse.previous?.band === 'low');
  check('now critical', worse.snapshot.band === 'critical');
  check('root worsened in diff', worse.diff.factorDeltas.some((d) => d.key === 'root' && d.direction === 'worsened'));
  check('a notification fired', worse.notifications.some((n) => n.factorKey === 'root'));
  check('lastSent persisted', !!store.dump['vc_devsec_lastsent']);

  // ── Repeat same state: quiet (edge-triggered) ────────────────────
  console.log('Repeat same state:');
  const t3 = t2 + 60_000;
  const repeat = await runDeviceScan(deps(store, [riskSignal('ROOT_DETECTED')], t3));
  check('no new deltas for unchanged state', repeat.diff.factorDeltas.length === 0);
  check('no notification on repeat', repeat.notifications.length === 0);
  check('still critical', repeat.snapshot.band === 'critical');

  // ── Cooldown carries across scans via persisted lastSent ─────────
  console.log('Cooldown across scans:');
  // Improve then worsen again within the cooldown window → still suppressed.
  const t4 = t3 + 60_000;
  await runDeviceScan(deps(store, [], t4));                              // back to clean
  const t5 = t4 + 60_000;                                               // re-root quickly
  const reRoot = await runDeviceScan(deps(store, [riskSignal('ROOT_DETECTED')], t5));
  check('re-root worsens again in diff', reRoot.diff.factorDeltas.some((d) => d.key === 'root' && d.direction === 'worsened'));
  check('but root alert suppressed by cooldown', !reRoot.notifications.some((n) => n.factorKey === 'root'));

  // ── Persistence round-trip ───────────────────────────────────────
  console.log('Persistence:');
  const current = await getCurrentSnapshot(store);
  check('getCurrentSnapshot returns the last snapshot', current?.band === 'critical');
  check('snapshot factors survived JSON round-trip', (current?.factors.length ?? 0) > 0);
  await clearPostureState(store);
  check('clearPostureState wipes stored state', (await getCurrentSnapshot(store)) === null);

  // ── Pending honesty through the pipeline ─────────────────────────
  console.log('Pending honesty:');
  const store2 = memStore();
  const partialCollector = async (_p: Platform): Promise<CollectorResult> => ({
    signals: [], evaluatedTypes: ['DEV_OPTIONS_ON'], pendingTypes: ['FRIDA_DETECTED', 'ROOT_DETECTED'],
  });
  const partial = await runDeviceScan({ collect: partialCollector, store: store2, now: () => 1_700_000_200_000, platform: 'android' });
  const frida = partial.snapshot.factors.find((f) => f.key === 'frida');
  check('unevaluated frida → pending (not clear)', frida?.status === 'pending');
  check('score ignores pending (stays 0)', partial.snapshot.score === 0);

  console.log('──────────────────────────────────────────');
  if (failures === 0) { console.log('ALL ORCHESTRATOR TESTS PASSED ✓\n'); process.exit(0); }
  else { console.log(`${failures} TEST(S) FAILED ✗\n`); process.exit(1); }
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
