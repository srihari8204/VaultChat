// lib/screenGuard.ts — VaultView capture guard.
//
// One cross-platform API over two genuinely different platform capabilities.
// The asymmetry is the whole design, so it is stated here rather than hidden:
//
//   Android — blocking works. FLAG_SECURE makes the window render black in
//             screenshots AND screen recordings, enforced by the OS. There is
//             no way to ask "am I being recorded", and none is needed.
//
//   iOS     — blocking is impossible; Apple provides no FLAG_SECURE. What IS
//             available is `UIScreen.isCaptured`, true while recording or
//             AirPlay mirroring is live, with a notification on every change.
//             So iOS refuses to DECRYPT while capture is active, and detects
//             screenshots after the fact.
//
// `capabilities()` reports which posture is in force so the UI can tell the user
// the truth instead of promising protection the platform will not deliver.
//
// When the native module is absent (Expo Go, or a build predating
// plugins/withVaultView.js) everything degrades to `available: false`. Callers
// MUST treat that as "unprotected" and say so — never as "protected". A silent
// no-op here would be the most dangerous failure mode in the whole feature.

import { NativeModules, NativeEventEmitter, Platform, type EmitterSubscription } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

const Native: any = (NativeModules as any)?.VaultViewGuard ?? null;

export interface GuardState {
  /** Screen is being recorded or mirrored right now (iOS only — see header). */
  captured: boolean;
  /** An external / mirrored display is attached. */
  external: boolean;
  /** Platform can actually BLOCK capture (Android FLAG_SECURE). */
  blockingSupported: boolean;
  /** The native guard module is present in this build. */
  available: boolean;
}

const UNAVAILABLE: GuardState = {
  captured: false,
  external: false,
  // expo-screen-capture still gives us FLAG_SECURE on Android even with no
  // native VaultView module, so blocking is genuinely supported there.
  blockingSupported: Platform.OS === 'android',
  available: false,
};

let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (!Native) return null;
  if (!emitter) emitter = new NativeEventEmitter(Native);
  return emitter;
}

// Native start/stop is refcounted. Without this, two concurrent watchers (say a
// protected viewer and a screenshot listener) would share one native
// subscription and the FIRST to unmount would call stopWatch(), silently
// blinding the one still on screen.
let watchers = 0;
function nativeStart(): void {
  if (!Native?.startWatch) return;
  if (watchers++ === 0) { try { Native.startWatch(); } catch {} }
}
function nativeStop(): void {
  if (!Native?.stopWatch) return;
  if (watchers > 0 && --watchers === 0) { try { Native.stopWatch(); } catch {} }
}

/** True when the build carries the native guard (capture detection works). */
export function isGuardAvailable(): boolean { return !!Native; }

/**
 * What protection this device can actually apply. Drives user-facing copy: on
 * Android the honest promise is "screenshots are blocked"; on iOS it is "we
 * detect and tell the sender". Never render the Android promise on iOS.
 */
export function capabilities(): { canBlock: boolean; canDetectCapture: boolean; canDetectExternal: boolean } {
  return {
    canBlock: Platform.OS === 'android',
    canDetectCapture: !!Native && Platform.OS === 'ios',
    canDetectExternal: !!Native,
  };
}

/** Current capture/display state. Falls back to UNAVAILABLE without native. */
export async function getState(): Promise<GuardState> {
  if (!Native) return { ...UNAVAILABLE };
  try {
    const s = await Native.getState();
    return {
      captured: !!s?.captured,
      external: !!s?.external,
      blockingSupported: !!s?.blockingSupported,
      available: true,
    };
  } catch {
    return { ...UNAVAILABLE };
  }
}

/**
 * Turn capture blocking on/off. Uses the native module when present and falls
 * back to expo-screen-capture (which is the same FLAG_SECURE on Android).
 * Resolves to whether blocking is actually in force — false on iOS, always.
 */
export async function setSecure(enabled: boolean): Promise<boolean> {
  let native = false;
  if (Native?.setSecure) {
    try { native = !!(await Native.setSecure(enabled)); } catch { native = false; }
  }
  // expo-screen-capture is the portable path and is already a dependency; on
  // Android it sets the same window flag, so running both is harmless and keeps
  // protection working in builds without the native module.
  try {
    if (enabled) await ScreenCapture.preventScreenCaptureAsync();
    else await ScreenCapture.allowScreenCaptureAsync();
  } catch { /* best-effort */ }
  return native || Platform.OS === 'android';
}

/**
 * Subscribe to capture/display transitions. Fires immediately with the current
 * state so callers never render a frame before knowing whether it is safe.
 * Returns an unsubscribe function.
 */
export function watch(onChange: (s: GuardState) => void): () => void {
  let disposed = false;
  const subs: EmitterSubscription[] = [];

  getState().then(s => { if (!disposed) onChange(s); }).catch(() => {});

  const em = getEmitter();
  if (em && Native?.startWatch) {
    nativeStart();
    subs.push(em.addListener('vaultview_state', (s: any) => {
      if (disposed) return;
      onChange({
        captured: !!s?.captured,
        external: !!s?.external,
        blockingSupported: !!s?.blockingSupported,
        available: true,
      });
    }));
  }

  return () => {
    if (disposed) return;          // double-cleanup must not decrement twice
    disposed = true;
    for (const s of subs) { try { s.remove(); } catch {} }
    if (em && Native?.startWatch) nativeStop();
  };
}

/**
 * Subscribe to "a screenshot just happened". Uses the native callback when
 * present (iOS always; Android 14+) and otherwise expo-screen-capture's
 * listener, which is the path the chat screen already relies on.
 */
export function onScreenshot(cb: () => void): () => void {
  const subs: { remove: () => void }[] = [];
  const em = getEmitter();
  if (em) {
    try { subs.push(em.addListener('vaultview_screenshot', cb)); } catch {}
  }
  try { subs.push(ScreenCapture.addScreenshotListener(cb) as any); } catch {}
  return () => { for (const s of subs) { try { s.remove(); } catch {} } };
}

/**
 * Should protected media be rendered right now?
 *
 * Refuses while a recording/mirror is live or an external display is attached.
 * On Android, blocking is already total, so an external display is the only
 * case that matters there.
 */
export function isSafeToRender(s: GuardState): { safe: boolean; reason: 'captured' | 'external' | null } {
  if (s.captured) return { safe: false, reason: 'captured' };
  if (s.external) return { safe: false, reason: 'external' };
  return { safe: true, reason: null };
}

export default {};
