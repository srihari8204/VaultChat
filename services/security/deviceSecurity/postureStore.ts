// services/security/deviceSecurity/postureStore.ts — on-device wiring.
//
// ⚠️ DEVICE-ONLY (imports expo-secure-store + react-native): not run under the
// Node self-tests. A thin adapter that supplies the real SecureStore-backed
// StorageKV and the app-facing scan entry point, wiring the Node-tested pure
// core (orchestrator + collectors) to the device. All logic of consequence
// lives in the tested modules; this file only injects the real dependencies.
//
// The scan result is returned to the caller (dashboard / background job), which
// is responsible for the two side effects this module deliberately does NOT own:
//   1. recording each returned notification into the tamper-evident audit chain
//      (services/security/auditChain.appendSecurityEvent), and
//   2. presenting it via the notifee "Security" channel.
// Keeping those in the caller preserves this module's no-RN-side-effects contract
// and lets the audit chain stay the single event source the Alerts tab renders.

import * as SecureStore from 'expo-secure-store';
import {
  runDeviceScan, getCurrentSnapshot as getSnap, clearPostureState as clearState,
  type ScanOutcome, type StorageKV,
} from './orchestrator';
import { collectJsSignals, currentPlatform } from './collectors';
import { collectNetworkSignals } from './networkCollector';
import { collectNativeSignals } from './nativeSecurity';
import type { CollectorResult } from './orchestrator';
import type { Platform } from './posture';
import type { PostureSnapshot } from './posture';

// Merge the device-integrity collector and the network-posture collector into
// one CollectorResult: union the evaluated/pending type sets (evaluated wins),
// concatenate signals. Adding the native VaultShield collector later is one more
// entry in this merge — nothing downstream changes.
async function collectAll(platform: Platform): Promise<CollectorResult> {
  const parts = await Promise.all([
    collectJsSignals(platform).catch(() => emptyResult()),
    collectNetworkSignals(platform).catch(() => emptyResult()),
    collectNativeSignals(platform).catch(() => emptyResult()),
  ]);
  const evaluated = new Set<CollectorResult['evaluatedTypes'][number]>();
  const pending = new Set<CollectorResult['pendingTypes'][number]>();
  const signals = parts.flatMap((p) => p.signals);
  for (const p of parts) for (const t of p.evaluatedTypes) evaluated.add(t);
  for (const p of parts) for (const t of p.pendingTypes) pending.add(t);
  for (const t of evaluated) pending.delete(t);   // evaluated wins over pending
  return { signals, evaluatedTypes: Array.from(evaluated), pendingTypes: Array.from(pending) };
}

function emptyResult(): CollectorResult {
  return { signals: [], evaluatedTypes: [], pendingTypes: [] };
}

/** Real SecureStore-backed key/value store (OS-keystore encrypted at rest). */
export const secureKV: StorageKV = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  del: (k) => SecureStore.deleteItemAsync(k).then(() => undefined),
};

/**
 * Run a device-security scan on this device and persist the result. Uses the
 * JS collector (native VaultShield signals merge in here once that slice lands)
 * and the real clock/platform. Returns the outcome so the caller can record
 * notifications to the audit chain and fire the "Security" notification channel.
 */
export async function scanDevice(): Promise<ScanOutcome> {
  return runDeviceScan({
    collect: collectAll,
    store: secureKV,
    now: () => Date.now(),
    platform: currentPlatform(),
  });
}

/** The last persisted snapshot, for the dashboard to render without re-scanning. */
export function getCurrentSnapshot(): Promise<PostureSnapshot | null> {
  return getSnap(secureKV);
}

/** Clear persisted posture state (logout / account switch). */
export function clearPostureState(): Promise<void> {
  return clearState(secureKV);
}
