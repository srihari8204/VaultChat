// lib/nav/hapticPlayer.ts — the ONE impure module: turns a resolved HapticPattern
// into an actual buzz. Android honours the ms pattern via RN's Vibration; iOS
// falls back to the expo-haptics impact accent (iOS ignores custom patterns).
// Everything upstream (language, timing, timeline, missed-turn) is pure + tested;
// this is the last thin hop to the motor.

import { Vibration, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { resolveHaptic, type HapticEvent, type HapticPattern, type NavProfile } from './hapticLanguage';

// Display modes from the spec — haptics only fire in the ones that include vibration.
export type DisplayMode =
  | 'everything' | 'voiceVibration' | 'vibrationOnly'   // vibration ON
  | 'voiceOnly' | 'bannerOnly' | 'voiceBanner' | 'mapOnly'; // vibration OFF

export function hapticsAllowed(mode: DisplayMode): boolean {
  return mode === 'everything' || mode === 'voiceVibration' || mode === 'vibrationOnly';
}

const accentFor = (p: HapticPattern) =>
  p.intensity === 'heavy' ? Haptics.ImpactFeedbackStyle.Heavy
  : p.intensity === 'medium' ? Haptics.ImpactFeedbackStyle.Medium
  : Haptics.ImpactFeedbackStyle.Light;

let looping = false;

/** Play a resolved pattern now. Cancels any looping "missed turn" buzz first. */
export function playPattern(p: HapticPattern): void {
  if (Platform.OS === 'web') return;
  Haptics.impactAsync(accentFor(p)).catch(() => {});   // leading accent (the only cue on iOS)
  if (Platform.OS !== 'android') return;               // iOS: accent only, no custom pattern

  if (looping) { try { Vibration.cancel(); } catch {} looping = false; }
  if (p.loopUntilCleared) {
    Vibration.vibrate(p.pattern, true);                // loop until stopHaptics()
    looping = true;
  } else {
    // Finite repeats: concatenate — each copy's leading wait becomes the gap.
    const n = Math.max(0, p.repeat ?? 0);
    const arr = n ? Array.from({ length: n + 1 }).flatMap(() => p.pattern) : p.pattern;
    Vibration.vibrate(arr, false);
  }
}

/**
 * Resolve + play an event for the active profile, gated by the display mode.
 * No-op if the profile is silent for this event or the mode has vibration off.
 */
export function playHaptic(
  event: HapticEvent, profile: NavProfile,
  opts: { mode?: DisplayMode; custom?: Partial<Record<HapticEvent, HapticPattern>> } = {},
): void {
  if (opts.mode && !hapticsAllowed(opts.mode)) return;
  const p = resolveHaptic(profile, event, opts.custom);
  if (p) playPattern(p);
}

/** Stop any ongoing (looping) buzz — e.g. once a reroute completes. */
export function stopHaptics(): void {
  try { Vibration.cancel(); } catch {}
  looping = false;
}

export default {};
