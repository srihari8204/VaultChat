// services/security/deviceSecurity/orchestrator.ts — the scan pipeline.
//
// Ties the three pure decision modules together into one run: collect signals →
// score (riskEngine) → build the dashboard snapshot (posture) → diff against the
// last snapshot → decide notifications (notificationPolicy) → persist. This is
// what the dashboard's "Scan now", the app-launch deferred scan, and the
// periodic background job all call.
//
// PURE by dependency injection — every side-effecting dependency (the signal
// collector, the key/value store, the clock, the platform) is passed IN, so the
// entire pipeline is Node-testable end-to-end with an in-memory store and a fake
// collector (orchestrator.selftest.ts). The real RN implementations live in the
// thin adapters collectors.ts (react-native-device-info / Settings) and
// postureStore.ts (expo-secure-store), which this module never imports.
//
// The orchestrator RETURNS the notifications and the recorded delta; it does not
// itself fire notifee or write the audit chain. The caller does that with the
// result — keeping this module free of React-Native and of the destructive
// concerns (no wipe, ever) that live in the separate boot-time securityService.

import { assessRisk, type SecuritySignal, type SecuritySignalType } from './riskEngine';
import {
  buildSnapshot, diffSnapshots, type Platform, type PostureDiff, type PostureSnapshot,
} from './posture';
export type { Platform } from './posture';
import {
  decideNotifications, type SecurityNotification,
} from './notificationPolicy';

/** Minimal async key/value store (SecureStore-shaped; same idiom as duressPin.KV). */
export interface StorageKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/** What a signal collector returns for one scan. */
export interface CollectorResult {
  signals: SecuritySignal[];
  /** Types the collector actually checked this run (→ "clear" when not detected). */
  evaluatedTypes: SecuritySignalType[];
  /** Types the collector could not check this run (→ "pending" on the dashboard). */
  pendingTypes: SecuritySignalType[];
}

export interface ScanDeps {
  collect: (platform: Platform) => Promise<CollectorResult>;
  store: StorageKV;
  now: () => number;
  platform: Platform;
  /** Min band-worsening score jump that fires a "score changed" alert (default 15). */
  scoreJump?: number;
}

export interface ScanOutcome {
  snapshot: PostureSnapshot;
  previous: PostureSnapshot | null;
  diff: PostureDiff;
  notifications: SecurityNotification[];
}

const SNAPSHOT_KEY = 'vc_devsec_snapshot';
const LASTSENT_KEY = 'vc_devsec_lastsent';

/**
 * Run one full scan and persist the result. Safe to call concurrently-ish: the
 * last-write-wins on the store is acceptable here because a scan is idempotent
 * given the same device state, and the audit chain (written by the caller from
 * the returned notifications) is the durable record.
 */
export async function runDeviceScan(deps: ScanDeps): Promise<ScanOutcome> {
  const previous = await loadSnapshot(deps.store);
  const lastSent = await loadLastSent(deps.store);

  const collected = await deps.collect(deps.platform);
  const scannedAt = deps.now();

  const assessment = assessRisk(collected.signals, { pending: collected.pendingTypes });
  const snapshot = buildSnapshot(assessment, {
    evaluatedTypes: collected.evaluatedTypes,
    pendingTypes: collected.pendingTypes,
    platform: deps.platform,
    scannedAt,
  });

  const diff = diffSnapshots(previous, snapshot);
  const decided = decideNotifications(diff, snapshot, {
    now: scannedAt, lastSent, scoreJump: deps.scoreJump,
  });

  await saveSnapshot(deps.store, snapshot);
  await saveLastSent(deps.store, decided.lastSent);

  return { snapshot, previous, diff, notifications: decided.notifications };
}

/** Last persisted snapshot for the dashboard to render without re-scanning. */
export async function getCurrentSnapshot(store: StorageKV): Promise<PostureSnapshot | null> {
  return loadSnapshot(store);
}

/** Clear persisted posture state (e.g. on logout / account switch). */
export async function clearPostureState(store: StorageKV): Promise<void> {
  await store.del(SNAPSHOT_KEY).catch(() => {});
  await store.del(LASTSENT_KEY).catch(() => {});
}

// ─── persistence helpers (JSON in the injected store) ────────────────────────

async function loadSnapshot(store: StorageKV): Promise<PostureSnapshot | null> {
  try {
    const raw = await store.get(SNAPSHOT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && Array.isArray(o.factors) ? (o as PostureSnapshot) : null;
  } catch { return null; }
}

async function saveSnapshot(store: StorageKV, snap: PostureSnapshot): Promise<void> {
  try { await store.set(SNAPSHOT_KEY, JSON.stringify(snap)); } catch { /* best-effort */ }
}

async function loadLastSent(store: StorageKV): Promise<Record<string, number>> {
  try {
    const raw = await store.get(LASTSENT_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Record<string, number>) : {};
  } catch { return {}; }
}

async function saveLastSent(store: StorageKV, map: Record<string, number>): Promise<void> {
  try { await store.set(LASTSENT_KEY, JSON.stringify(map)); } catch { /* best-effort */ }
}
