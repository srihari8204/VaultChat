// services/security/deviceSecurity/monitorTriggers.ts — passive trigger wiring.
//
// ⚠️ DEVICE-ONLY (react-native AppState + netinfo): not Node-tested. Registers
// the runtime triggers that drive passive monitoring while the app is alive:
//   • foreground return  → runMonitoringScan('foreground')  (scheduler-throttled)
//   • network change     → runMonitoringScan('event')       (debounced here)
//   • TLS pin failure     → onPinFailure() → immediate 'event' scan
//
// The scheduler already throttles 'foreground' (15 min), so AppState can fire
// freely. 'event' always scans, so network changes are debounced here to avoid a
// scan storm on a flapping handover. A true periodic scan while the app is KILLED
// still needs a native WorkManager/BGTask job (separate) — this covers the
// while-running case, which is most of it.

import { AppState } from 'react-native';
import { runMonitoringScan } from './monitorService';
import { reportPinFailure } from './networkCollector';

const NETWORK_DEBOUNCE_MS = 30_000;

let started = false;
let lastNetworkScan = 0;

/** Idempotent: wire AppState + network listeners once, at app boot. */
export function startSecurityMonitoring(): void {
  if (started) return;
  started = true;

  AppState.addEventListener('change', (state) => {
    if (state === 'active') runMonitoringScan('foreground').catch(() => {});
  });

  try {
    const NetInfo = require('@react-native-community/netinfo').default;
    NetInfo.addEventListener(() => {
      const now = Date.now();
      if (now - lastNetworkScan < NETWORK_DEBOUNCE_MS) return;   // debounce flaps
      lastNetworkScan = now;
      runMonitoringScan('event').catch(() => {});
    });
  } catch { /* netinfo absent → foreground trigger still active */ }
}

/**
 * Call from the HTTP/TLS layer when VaultChat's OWN certificate pin fails
 * (OkHttp CertificatePinner / URLSession delegate / a fetch error that looks
 * like a trust failure). Latches the signal and scans immediately so the alert
 * is instant rather than waiting for the next scheduled scan.
 */
export function onPinFailure(detail?: string): void {
  reportPinFailure(detail);
  runMonitoringScan('event').catch(() => {});
}
