// lib/videoSeek.ts — pure seek-bar maths for app/video-player.tsx.
//
// PURE (no react-native import) so it is Node-tested (videoSeek.selftest.ts).

/** Touch x on the track → a 0..1 fraction. A zero-width (not yet laid out)
 *  track yields 0 rather than NaN/Infinity. */
export function seekFraction(locationX: number, trackWidth: number): number {
  if (!(trackWidth > 0) || !Number.isFinite(locationX)) return 0;
  return Math.max(0, Math.min(locationX / trackWidth, 1));
}

/** Fraction of the clip → target position in ms, or null when the duration is
 *  not known yet (seeking then would jump to 0). */
export function seekTargetMs(fraction: number, durationMs: number): number | null {
  if (!(durationMs > 0)) return null;
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(fraction, 1)) : 0;
  return Math.round(f * durationMs);
}

/** AsyncStorage key for the resume position. btoa throws on non-Latin-1 input
 *  (e.g. a Devanagari filename in a file:// path); fall back to the UTF-8
 *  percent-encoding so such videos still resume instead of crashing the
 *  effect. Latin-1 URIs keep their original key, so saved positions survive. */
export function resumeKey(uri: string): string {
  let b: string;
  try { b = btoa(uri); } catch { b = btoa(encodeURIComponent(uri)); }
  return `vc_video_pos_${b.substring(0, 40)}`;
}

export default {};
