// lib/storyDuration.ts — how long a story's progress bar runs.
//
// A video story's bar used to run a fixed 15 s whatever the clip's length: a
// 6 s clip sat frozen on its last frame, a 40 s one was cut off at 15. The bar
// now follows the clip's real duration (from expo-av's load status), clamped,
// with the old 15 s only as the fallback before a duration is known.
// PURE: Node-tested in storyDuration.selftest.ts.

export const IMAGE_DURATION_MS = 5_000;
export const VIDEO_FALLBACK_MS = 15_000;
export const VIDEO_MIN_MS = 1_000;
export const VIDEO_MAX_MS = 60_000;

export function storyDurationMs(mediaType: string, videoDurationMs?: number | null): number {
  if (mediaType !== 'video') return IMAGE_DURATION_MS;
  const d = Number(videoDurationMs);
  if (!Number.isFinite(d) || d <= 0) return VIDEO_FALLBACK_MS;
  return Math.max(VIDEO_MIN_MS, Math.min(VIDEO_MAX_MS, Math.round(d)));
}

export default {};
