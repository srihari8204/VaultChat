// lib/call/sharePolicy.ts — how a screen share should degrade, decided from
// what the encoder actually reports rather than from a guess made up front.
//
// The share starts tuned for TEXT: contentHint 'detail' and
// degradationPreference 'maintain-resolution', so shared code and slides keep
// their sharp edges and a mostly-static screen spends almost no frames. That
// reasoning is sound, and it is about BANDWIDTH.
//
// Measured on device (Redmi Note 8 Pro, 2026-08-26) the binding constraint was
// not bandwidth:
//
//   SCREEN_SHARE_STATS encoded=376 sent=376 size=540x1170 fps=3 limit=cpu
//
// `limit=cpu` means the encoder WANTED to send more and could not. Under CPU
// pressure 'maintain-resolution' is a much worse trade than under bandwidth
// pressure, because encoder cost scales with pixels x frames: holding every
// pixel spends the entire budget and the frame rate collapses — 2-3 fps against
// an allowed 15. Fine for a slide. Unusable for the screen-shared game that is
// this feature's other half.
//
// So: keep the text tuning, and relax it only when the device proves it cannot
// afford it. Nothing here fires on a share that is merely static — a static
// screen reports 'none', not 'cpu'.

/** Consecutive CPU-limited samples before relaxing. */
export const CPU_STRIKES = 2;

/** Encoder-side downscale: the starting point, and the floor we may relax to. */
export const SCALE_SHARP = 2;
export const SCALE_RELAXED = 3;

/**
 * Has the encoder proven it cannot hold resolution?
 *
 * Requires CPU_STRIKES CONSECUTIVE cpu samples. One is not enough: the first
 * seconds of a share include the FLAG_SECURE window and the app switch, where a
 * transient spike says nothing about the content being shared. Any non-cpu
 * reason breaks the streak, so a share that recovers is never relaxed on the
 * strength of an old spike.
 */
export function shouldRelax(recentReasons: readonly string[]): boolean {
  if (recentReasons.length < CPU_STRIKES) return false;
  return recentReasons.slice(-CPU_STRIKES).every((r) => r === 'cpu');
}

/**
 * The relaxed encoder settings.
 *
 * 'balanced' lets WebRTC give up SOME resolution to recover frames, instead of
 * defending every pixel to the last one. Scaling down by 3 rather than 2 cuts
 * the pixel count to roughly 44% of what CPU-saturated the encoder, which is
 * the change that actually buys the frames back — the preference alone only
 * grants permission.
 *
 * 360x780 from a 1080x2340 panel is still more than the receiving phone shows.
 */
export function relaxedEncoding(): {
  degradationPreference: 'balanced';
  scaleResolutionDownBy: number;
} {
  return { degradationPreference: 'balanced', scaleResolutionDownBy: SCALE_RELAXED };
}

export default {};
