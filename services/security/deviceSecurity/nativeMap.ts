// services/security/deviceSecurity/nativeMap.ts — native scan → signals (pure).
//
// Maps the raw booleans the VaultShield native module returns into the module's
// CollectorResult (signals + evaluatedTypes). PURE — no React-Native import — so
// it is Node-tested (nativeMap.selftest.ts). The device-only bridge
// (nativeSecurity.ts) calls VaultShield.scan() and hands the result here.
//
// Honesty rule preserved: the platform's native-evaluable type set is reported
// in `evaluatedTypes` whether or not a threat was found, so "checked & clean"
// is distinct from "couldn't check". APK_RESIGNED is only evaluated when an
// expected signing digest is configured (otherwise it stays pending).

import type { CollectorResult } from './orchestrator';
import type { Platform } from './posture';
import type { SecuritySignal, SecuritySignalType } from './riskEngine';

// Fill from your release keystore's signing cert (SHA-256, lowercase hex, no
// colons). Empty string = skip the re-sign check (APK_RESIGNED stays pending).
export const EXPECTED_SIGNING_SHA256 = '';

// Accessibility services considered legitimate (prefix match on the flattened
// "pkg/.Service" component name). Extend for OEM assistive tools you trust.
export const A11Y_ALLOWLIST = [
  'com.google.android.marvin.talkback',
  'com.google.android.',
  'com.samsung.accessibility',
  'com.android.',
];

const ANDROID_EVALUABLE: SecuritySignalType[] = [
  'ROOT_DETECTED', 'SU_BINARY_FOUND', 'MAGISK_DETECTED', 'DEBUGGER_ATTACHED',
  'FRIDA_DETECTED', 'HOOK_FRAMEWORK', 'EMULATOR_DETECTED', 'DEV_OPTIONS_ON',
  'USB_DEBUGGING_ON', 'ACCESSIBILITY_RISK',
];
const IOS_EVALUABLE: SecuritySignalType[] = [
  'JAILBREAK_DETECTED', 'DEBUGGER_ATTACHED', 'FRIDA_DETECTED', 'HOOK_FRAMEWORK', 'EMULATOR_DETECTED',
];

export interface NativeMapOptions {
  expectedSigning?: string;
  a11yAllowlist?: string[];
}

function unknownA11yServices(services: string[], allow: string[]): string[] {
  return services.filter((s) => {
    const comp = (s || '').toLowerCase();
    return comp.length > 0 && !allow.some((a) => comp.startsWith(a.toLowerCase()));
  });
}

/**
 * Map a VaultShield scan result to a CollectorResult. `raw` is whatever the
 * native `scan()` resolved (a loosely-typed object); missing fields are treated
 * as "not present". Pure + deterministic.
 */
export function mapNativeScan(raw: any, platform: Platform, opts: NativeMapOptions = {}): CollectorResult {
  const r = raw ?? {};
  const signals: SecuritySignal[] = [];
  const expected = (opts.expectedSigning ?? EXPECTED_SIGNING_SHA256).trim();
  const allow = opts.a11yAllowlist ?? A11Y_ALLOWLIST;

  if (platform === 'android') {
    const evaluated = [...ANDROID_EVALUABLE];

    if (r.rooted) signals.push({ type: 'ROOT_DETECTED', detail: r.rootApp ? `root app: ${r.rootApp}` : 'root indicators present' });
    if (r.suBinary) signals.push({ type: 'SU_BINARY_FOUND', detail: r.suDetail ?? 'su binary present' });
    if (r.magisk) signals.push({ type: 'MAGISK_DETECTED', detail: 'Magisk artifacts present' });
    if (r.debugger) signals.push({ type: 'DEBUGGER_ATTACHED', detail: r.tracerPid ? `TracerPid ${r.tracerPid}` : 'debugger connected' });
    if (r.frida) signals.push({ type: 'FRIDA_DETECTED', detail: r.fridaDetail ?? 'instrumentation detected' });
    if (r.hookFramework) signals.push({ type: 'HOOK_FRAMEWORK', detail: r.hookDetail ?? 'hooking framework present' });
    if (r.emulator) signals.push({ type: 'EMULATOR_DETECTED', detail: 'emulator build' });
    if (r.devOptions) signals.push({ type: 'DEV_OPTIONS_ON', detail: 'developer options enabled' });
    if (r.adb) signals.push({ type: 'USB_DEBUGGING_ON', detail: 'ADB enabled' });

    const services: string[] = Array.isArray(r.accessibilityServices) ? r.accessibilityServices : [];
    const unknown = unknownA11yServices(services, allow);
    if (unknown.length > 0) signals.push({ type: 'ACCESSIBILITY_RISK', detail: `${unknown.length} unrecognised service(s)` });

    // Re-sign check only when a baseline is configured.
    if (expected.length > 0 && typeof r.signingSha256 === 'string' && r.signingSha256.length > 0) {
      evaluated.push('APK_RESIGNED');
      if (r.signingSha256.toLowerCase() !== expected.toLowerCase()) {
        signals.push({ type: 'APK_RESIGNED', detail: 'signing certificate does not match the official build' });
      }
    }

    return { signals, evaluatedTypes: evaluated, pendingTypes: [] };
  }

  if (platform === 'ios') {
    if (r.jailbroken) signals.push({ type: 'JAILBREAK_DETECTED', detail: r.jailbreakDetail ?? 'jailbreak indicators present' });
    if (r.debugger) signals.push({ type: 'DEBUGGER_ATTACHED', detail: 'debugger attached' });
    if (r.frida) signals.push({ type: 'FRIDA_DETECTED', detail: r.fridaDetail ?? 'instrumentation dylib' });
    if (r.hookFramework) signals.push({ type: 'HOOK_FRAMEWORK', detail: r.fridaDetail ?? 'hook dylib' });
    if (r.emulator) signals.push({ type: 'EMULATOR_DETECTED', detail: 'simulator' });
    return { signals, evaluatedTypes: [...IOS_EVALUABLE], pendingTypes: [] };
  }

  return { signals: [], evaluatedTypes: [], pendingTypes: [] };
}
