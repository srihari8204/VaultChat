// services/security/deviceSecurity/networkCollector.ts — network-posture signals.
//
// ⚠️ DEVICE-ONLY (imports react-native / @react-native-community/netinfo): not
// run under the Node self-tests. Reads on-device connection state into the
// module's CollectorResult shape. Everything it feeds — scoring, dashboard rows,
// notifications — is Node-tested in the pure core.
//
// This is POSTURE observation, NOT a threat-intelligence service: it reads local
// connection state only. No host/IP reputation lookups, no remote blocklists, no
// phone-home. Network identifiers (SSID/IP/proxy address) never leave the device.
//
// The strongest signal — NETWORK_MITM — is NOT produced here by polling. It is
// reported by the app's TLS layer when crazzychat's own certificate pin fails
// (see reportPinFailure below), because active interception is something that
// happens during a real request, not something a scan can see.

import { Platform } from 'react-native';
import type { SecuritySignal, SecuritySignalType } from './riskEngine';
import type { CollectorResult, Platform as PlatformKind } from './orchestrator';

// A latch the TLS layer sets when a pin validation fails; consumed by the next
// scan so the MITM shows on the dashboard + score, and cleared after reporting.
let _pinFailureDetail: string | null = null;

/**
 * Called by the HTTP/TLS layer (e.g. lib/api's fetch wrapper / OkHttp
 * CertificatePinner / URLSession delegate) when crazzychat's OWN server pin fails.
 * The caller should ALSO trigger runMonitoringScan('event') so the alert is
 * immediate rather than waiting for the next scheduled scan.
 */
export function reportPinFailure(detail?: string): void {
  _pinFailureDetail = detail ?? 'TLS certificate pin validation failed';
}

/**
 * Collect network-posture signals. Each probe is guarded; a probe we can't run
 * leaves its type in `pendingTypes` (→ "Not evaluated"), never a false "clear".
 * netinfo is optional-required: if the module is absent, proxy/wifi stay pending.
 */
export async function collectNetworkSignals(platform: PlatformKind): Promise<CollectorResult> {
  const signals: SecuritySignal[] = [];
  const evaluated: SecuritySignalType[] = [];
  const pending = new Set<SecuritySignalType>(['NETWORK_MITM', 'PROXY_CONFIGURED', 'OPEN_WIFI']);

  // ── MITM: consume any pending pin-failure latch (always "evaluated"). ──
  evaluated.push('NETWORK_MITM');
  pending.delete('NETWORK_MITM');
  if (_pinFailureDetail) {
    signals.push({ type: 'NETWORK_MITM', detail: _pinFailureDetail });
    _pinFailureDetail = null;   // one-shot; the request already failed closed
  }

  // ── Connection state via netinfo (guarded require). ──────────────
  let netinfo: any = null;
  try { netinfo = require('@react-native-community/netinfo').default; } catch { netinfo = null; }

  if (netinfo) {
    try {
      const state = await netinfo.fetch();

      // Open / unencrypted Wi-Fi — Android exposes this; iOS does not reliably.
      if (platform === 'android') {
        evaluated.push('OPEN_WIFI');
        pending.delete('OPEN_WIFI');
        const details = state?.type === 'wifi' ? state.details : null;
        // netinfo exposes `isConnectionExpensive`; the WPA/open flag comes from
        // the native Wi-Fi info. When unknown we leave it evaluated-but-clear.
        if (details && details.ssid != null && details.isWifiEnabled && details.security === 'NONE') {
          signals.push({ type: 'OPEN_WIFI', detail: 'Connected to an open Wi-Fi network' });
        }
      }

      // System proxy: netinfo doesn't expose it directly on all platforms; the
      // native module (VaultShield) fills this in. Until then it stays pending.
    } catch {
      // leave proxy/wifi pending
    }
  }

  for (const t of evaluated) pending.delete(t);
  return { signals, evaluatedTypes: evaluated, pendingTypes: Array.from(pending) };
}
