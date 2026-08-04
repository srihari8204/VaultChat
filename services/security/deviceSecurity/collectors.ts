// services/security/deviceSecurity/collectors.ts — the JS signal collector.
//
// ⚠️ DEVICE-ONLY (imports react-native + react-native-device-info): this file
// does NOT run under the Node self-tests. It is a thin adapter that reuses the
// exact DeviceInfo probes already proven in services/securityService.ts, mapped
// into the module's CollectorResult shape. The decision logic it feeds
// (riskEngine/posture/notificationPolicy/orchestrator) IS Node-tested.
//
// HONEST DEGRADATION: without the native VaultShield module (roadmap slice 3),
// pure JS can only see a subset of signals. Everything it CAN'T see this run is
// reported in `pendingTypes`, so the dashboard shows those factors as "Not
// evaluated" — never as "clear". When VaultShield lands, its collector output is
// merged in and those types move from pending → evaluated.

import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import type { SecuritySignal, SecuritySignalType } from './riskEngine';
import type { CollectorResult, Platform as PlatformKind } from './orchestrator';

// Signals a native module (VaultShield) is required to evaluate. Until it ships
// these are always pending on both platforms.
const NATIVE_ONLY: SecuritySignalType[] = [
  'FRIDA_DETECTED', 'DEBUGGER_ATTACHED', 'HOOK_FRAMEWORK',
  'SU_BINARY_FOUND', 'MAGISK_DETECTED', 'APK_RESIGNED', 'APK_UNOFFICIAL',
  'INTEGRITY_VERDICT_FAILED', 'ACCESSIBILITY_RISK', 'OVERLAY_RISK',
  'DEV_OPTIONS_ON', 'HIGH_POWER_APP',
];

/**
 * Collect the signals pure JS can read today. Each probe is individually guarded
 * (a throwing probe becomes "not evaluated for that type", never a crash), and
 * every type is classified into exactly one of evaluated / pending so the
 * posture layer can tell "checked and clean" from "couldn't check".
 */
export async function collectJsSignals(platform: PlatformKind): Promise<CollectorResult> {
  const signals: SecuritySignal[] = [];
  const evaluated: SecuritySignalType[] = [];
  const pending = new Set<SecuritySignalType>(NATIVE_ONLY);

  // Jailbreak (iOS) requires the native module; on Android it's not applicable.
  pending.add('JAILBREAK_DETECTED');

  // ── Root (Android first pass via DeviceInfo) ─────────────────────
  if (platform === 'android') {
    try {
      const rooted = await (DeviceInfo as any).isRooted();
      evaluated.push('ROOT_DETECTED');
      if (rooted) signals.push({ type: 'ROOT_DETECTED', detail: 'DeviceInfo reported root indicators' });
    } catch { /* leave ROOT_DETECTED unlisted → stays pending */ }

    // ── USB debugging (ADB enabled) ────────────────────────────────
    try {
      const adb = await (DeviceInfo as any).isAdbEnabled();
      evaluated.push('USB_DEBUGGING_ON');
      if (adb) signals.push({ type: 'USB_DEBUGGING_ON', detail: 'ADB debugging is enabled' });
    } catch { /* stays pending */ }
  } else {
    // Root/USB are Android concepts; on iOS they're handled by jailbreak/native.
    pending.add('ROOT_DETECTED');
    pending.add('USB_DEBUGGING_ON');
  }

  // ── Emulator (both platforms) ────────────────────────────────────
  try {
    const emu = await DeviceInfo.isEmulator();
    evaluated.push('EMULATOR_DETECTED');
    if (emu) signals.push({ type: 'EMULATOR_DETECTED', detail: 'Running on an emulator/simulator' });
  } catch { /* stays pending */ }

  // Anything we actually evaluated must not also be listed as pending.
  for (const t of evaluated) pending.delete(t);

  return {
    signals,
    evaluatedTypes: evaluated,
    pendingTypes: Array.from(pending),
  };
}

/** Convenience for the app: the current OS as the module's Platform union. */
export function currentPlatform(): PlatformKind {
  return Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web';
}
