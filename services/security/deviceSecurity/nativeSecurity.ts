// services/security/deviceSecurity/nativeSecurity.ts — VaultShield bridge.
//
// ⚠️ DEVICE-ONLY (imports react-native): not run under the Node self-tests. Calls
// the VaultShield native module's one-shot scan() and maps it via the pure,
// Node-tested nativeMap.ts. Degrades honestly: if the native module is absent
// (Expo Go, or a build before withVaultShield landed), it returns an empty
// result — every native type then stays `pending` on the dashboard, never a
// fake "clear".

import { NativeModules } from 'react-native';
import { mapNativeScan } from './nativeMap';
import type { CollectorResult, Platform } from './orchestrator';

const empty: CollectorResult = { signals: [], evaluatedTypes: [], pendingTypes: [] };

/** True when the native module is linked (i.e. a dev/prod build, not Expo Go). */
export function hasNativeShield(): boolean {
  return !!(NativeModules as any)?.VaultShield?.scan;
}

/**
 * Run the native device-integrity scan and map it to signals. Never throws:
 * a missing module or a native error yields an empty result (types stay pending).
 */
export async function collectNativeSignals(platform: Platform): Promise<CollectorResult> {
  const mod = (NativeModules as any)?.VaultShield;
  if (!mod?.scan) return empty;
  try {
    const raw = await mod.scan();
    return mapNativeScan(raw, platform);
  } catch {
    return empty;
  }
}
