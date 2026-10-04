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

// What the last setSecure call on Android confirmed it applied: true = FLAG_SECURE
// set, false = cleared, null = never confirmed (or the last call failed).
let lastApplied: boolean | null = null;

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
 * Resolves to whether blocking is now confirmed in force: false on iOS always,
 * false when clearing, and false when neither path confirmed the call.
 */
export async function setSecure(enabled: boolean): Promise<boolean> {
  // A DEV BUILD NEVER BLOCKS CAPTURE.
  //
  // FLAG_SECURE blanks `adb screencap`, screen recording and the recents
  // thumbnail, so with it on nobody can capture the screen they are working on
  // — every screenshot of a layout bug comes back solid black. Gating it at the
  // one call site in the root layout was not enough: the chat screen re-arms it
  // per conversation from the screenshot policy, and once ANY caller sets the
  // window flag it stays set for the whole activity. So the guard lives here,
  // in the one function every caller already routes through.
  //
  // __DEV__ is false in every release build, so shipped builds are unchanged.
  if (__DEV__) return false;
  const run = applySecure(enabled);
  inFlight = run;
  try { return await run; } finally { if (inFlight === run) inFlight = null; }
}

// The setSecure call still running, so a read can wait for its outcome.
let inFlight: Promise<boolean> | null = null;

async function applySecure(enabled: boolean): Promise<boolean> {
  let native = false;
  if (Native?.setSecure) {
    try { native = !!(await Native.setSecure(enabled)); } catch { native = false; }
  }
  // expo-screen-capture is the portable path and is already a dependency; on
  // Android it sets the same window flag, so running both is harmless and keeps
  // protection working in builds without the native module.
  let expo = false;
  try {
    if (enabled) await ScreenCapture.preventScreenCaptureAsync();
    else await ScreenCapture.allowScreenCaptureAsync();
    expo = true;
  } catch { /* best-effort */ }
  // Only a call that one of the two paths confirmed counts. When both failed
  // the window flag is whatever it was before, which this module cannot see.
  const confirmed = Platform.OS === 'android' && (native || expo);
  lastApplied = confirmed ? enabled : null;
  return confirmed && enabled;
}

/**
 * Is screen capture blocked right now? A READ: unlike setSecure(true) it never
 * touches the window flag, so asking does not change the answer.
 *
 * false in a dev build (setSecure never blocks there) and on every platform but
 * Android (nothing can block there); otherwise what the last confirmed
 * setSecure call applied, or 'unknown' when none was confirmed.
 *
 * ponytail: this is the flag as last applied — by setSecure, or reported via
 * noteWindowSecure by the VaultCalls.setWindowSecure paths (lib/call/engine.ts,
 * lib/golive/native.ts) — not a read of the window itself. Replace with a
 * native read of the window flag (a VaultViewGuard.isSecure method) once one
 * ships.
 */
export function readSecureState(): boolean | 'unknown' {
  if (__DEV__ || Platform.OS !== 'android') return false;
  return lastApplied ?? 'unknown';
}

/** readSecureState, after any setSecure call still running has settled — so a
 *  screen that loads while the root layout is applying the flag does not read
 *  'unknown' just because the call had not finished. */
export async function readSecureStateSettled(): Promise<boolean | 'unknown'> {
  if (inFlight) await inFlight.catch(() => false);
  return readSecureState();
}

/** For code that sets FLAG_SECURE without setSecure (VaultCalls.setWindowSecure),
 *  so readSecureState stays true to the window. `null` = outcome unknown. */
export function noteWindowSecure(secure: boolean | null): void {
  if (Platform.OS === 'android') lastApplied = secure;
}

// iOS cannot block capture, but it can blur the app-switcher snapshot and the
// screen while the app is inactive (Control Center, notification shade).
// Refcounted so two screens holding it do not switch it off for each other.
// Android needs nothing: FLAG_SECURE already blanks the recents thumbnail.
let blurHolds = 0;
/** Blur this app while it is not in front (iOS). Returns the release function. */
export function holdAppSwitcherBlur(): () => void {
  if (Platform.OS !== 'ios') return () => {};
  if (blurHolds++ === 0) ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--blurHolds === 0) ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => {});
  };
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
