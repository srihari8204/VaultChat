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
    // THE SIGNING CHECK IS SKIPPED IN A DEV BUILD, AND ONLY IN A DEV BUILD.
    //
    // A locally-built debug APK is signed with the Android debug key, so its
    // certificate can never match the release baseline. That raises
    // APK_RESIGNED, which carries weight 70 — on its own above the `critical`
    // cutoff of 65 (riskEngine.ts). The result: every debug build launches
    // straight into the "Security Alert / crazzychat Blocked" screen AND wipes
    // session keys, ratchet state and the Vault PIN before anyone can use it.
    // Local on-device debugging was impossible, and the wipe made it costly.
    //
    // `__DEV__` is false in every production bundle — Metro defines it true
    // only for a dev server build — so this cannot weaken a shipped app. Every
    // other signal still runs here: root, Frida, hooks, debugger, emulator,
    // overlays and USB debugging are all still collected and still scored. This
    // silences exactly one check, the one that is meaningless for a binary that
    // was never distributed.
    //
    // Passing '' is the documented way to leave it unevaluated (nativeMap.ts),
    // so it is reported as `pending` on the security dashboard rather than as a
    // false "clear" — the honest-degradation rule that file is built around.
    return mapNativeScan(raw, platform, __DEV__ ? { expectedSigning: '' } : undefined);
  } catch {
    return empty;
  }
}
