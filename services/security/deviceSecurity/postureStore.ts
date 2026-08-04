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
import type { PostureSnapshot } from './posture';

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
    collect: collectJsSignals,
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
