// lib/call/screenCapture.ts — what geometry to capture a phone screen at.
//
// WHY THIS IS NOT JUST "USE THE SCREEN SIZE"
//
// Two constraints pull against each other, and the previous fix satisfied one
// by sacrificing the other.
//
//   1. ENCODERS REFUSE ODD GEOMETRY. Hardware H.264/VP8 encoders routinely
//      reject dimensions that are not a multiple of 16, and they do it by
//      producing NO OUTPUT rather than an error. Symptom: the track publishes,
//      the peer subscribes, the server logs the track and zero sender reports,
//      and the sharer sees a confident "sharing" banner over a screen nobody
//      receives. Unbounded capture at a panel's native 1080x2400 hit this.
//
//   2. A PHONE SCREEN IS PORTRAIT. Pinning capture to 1280x720 fixed (1) by
//      forcing a landscape 16:9 box onto a ~9:20 portrait screen. Frames flow,
//      but the receiver gets the screen letterboxed into a sliver with black
//      bars either side — or stretched, depending on the renderer.
//
// This module satisfies BOTH: keep the real aspect ratio, bound the longest
// edge so the encoder is not asked for a 2400px dimension, and snap both sides
// to a multiple of 16 so the encoder actually emits frames.
//
// SCOPE, MEASURED ON DEVICE 2026-08-20: on React Native this geometry is a HINT
// THAT NOTHING READS. @livekit/react-native-webrtc declares `getDisplayMedia()`
// with no parameters, so capture constraints never reach the capturer and
// Android grabs the panel at its native size — the SFU logged a 1200x2664 phone
// sharing at exactly 1200x2664. The fixed 1280x720 this replaced was inert for
// the same reason and never letterboxed anyone.
//
// It is kept because it costs nothing, becomes correct the day RN honours
// constraints, and because screenCaptureBitrate IS applied. Do not cite this
// module as the reason a share looks right — the reason is the renderer's
// objectFit, in app/live-view.tsx.
//
// PURE — takes numbers, returns numbers. No react-native import, so it runs
// under `npx tsx` and the callers supply Dimensions/PixelRatio themselves.

/** Longest edge we will ask an encoder for. 1280 is the proven-safe ceiling. */
export const MAX_EDGE = 1280;
/** Encoders reject non-multiples of this and emit nothing. Non-negotiable. */
export const BLOCK = 16;
/** Below this a shared screen is unreadable; also keeps rounding sane. */
export const MIN_EDGE = 160;

export interface CaptureSize {
  width: number;
  height: number;
  frameRate: number;
}

/** Round to the nearest multiple of BLOCK, never below MIN_EDGE. */
function snap(px: number): number {
  const n = Math.round(px / BLOCK) * BLOCK;
  return Math.max(MIN_EDGE, n);
}

/**
 * Capture geometry for a screen of `screenW` x `screenH` PHYSICAL pixels.
 *
 * Orientation is preserved: a portrait screen yields a portrait capture, so the
 * receiver renders it upright and full-bleed instead of boxed inside a
 * landscape frame.
 *
 * @param screenW physical pixel width  (Dimensions.get('screen').width * PixelRatio.get())
 * @param screenH physical pixel height
 * @param frameRate frames per second; 15 is what a screen needs and what the
 *                  bitrate budget below assumes.
 */
export function screenCaptureSize(screenW: number, screenH: number, frameRate = 15): CaptureSize {
  // Anything unusable (0, NaN, negative — a screen we could not measure) falls
  // back to the previously shipped fixed box. Failing to a KNOWN-WORKING size
  // is better than asking an encoder for something nonsensical.
  if (!Number.isFinite(screenW) || !Number.isFinite(screenH) || screenW <= 0 || screenH <= 0) {
    return { width: 1280, height: 720, frameRate };
  }

  let w = screenW;
  let h = screenH;

  // Scale the LONGEST edge down to MAX_EDGE, preserving ratio. A 1080x2400
  // phone becomes 576x1280 — portrait, legible, and inside what the encoder
  // will accept.
  const longest = Math.max(w, h);
  if (longest > MAX_EDGE) {
    const f = MAX_EDGE / longest;
    w *= f;
    h *= f;
  }

  return { width: snap(w), height: snap(h), frameRate };
}

/**
 * Bitrate for a given capture size.
 *
 * The old fixed 1.5 Mbps was chosen for 1280x720 = 921,600 px. Scaling by pixel
 * count keeps quality-per-pixel roughly constant instead of starving a large
 * capture or wasting bandwidth on a small one. Bounded at both ends: text on a
 * shared screen is unreadable below ~600kbps, and nothing here justifies more
 * than 2.5Mbps on a phone.
 */
export function screenCaptureBitrate(size: CaptureSize): number {
  const REFERENCE_PX = 1280 * 720;
  const REFERENCE_BPS = 1_500_000;
  const bps = Math.round(REFERENCE_BPS * ((size.width * size.height) / REFERENCE_PX));
  return Math.min(2_500_000, Math.max(600_000, bps));
}

export default { screenCaptureSize, screenCaptureBitrate, MAX_EDGE, BLOCK, MIN_EDGE };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string) => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };
  const div16 = (n: number) => n % BLOCK === 0;

  console.log('\nScreen-share capture geometry\n');

  // THE CASE THIS EXISTS FOR: a real portrait phone.
  const p = screenCaptureSize(1080, 2400);
  A(p.height > p.width, '1. a portrait screen yields a PORTRAIT capture');
  A(div16(p.width) && div16(p.height), `2. both edges are multiples of 16 (${p.width}x${p.height})`);
  A(Math.max(p.width, p.height) <= MAX_EDGE, '3. longest edge is bounded');
  // Aspect preserved within one rounding block.
  A(Math.abs((p.width / p.height) - (1080 / 2400)) < 0.03, '4. aspect ratio is preserved');

  // Landscape (tablet, or a rotated phone) must stay landscape.
  const l = screenCaptureSize(2400, 1080);
  A(l.width > l.height, '5. a landscape screen yields a LANDSCAPE capture');
  A(div16(l.width) && div16(l.height), '6. landscape edges are multiples of 16');

  // A screen already small enough is not upscaled.
  const s = screenCaptureSize(720, 1280);
  A(Math.max(s.width, s.height) <= MAX_EDGE, '7. an already-small screen is not enlarged');
  A(div16(s.width) && div16(s.height), '8. small-screen edges are multiples of 16');

  // Odd geometry — the exact class that produced zero frames.
  for (const [w, h] of [[1080, 2340], [1440, 3088], [828, 1792], [1179, 2556]]) {
    const c = screenCaptureSize(w, h);
    A(div16(c.width) && div16(c.height), `9. ${w}x${h} snaps to ${c.width}x${c.height}`);
  }

  // Never degenerate.
  for (const [w, h] of [[0, 0], [-1, 100], [NaN, 100]]) {
    const c = screenCaptureSize(w as number, h as number);
    A(c.width === 1280 && c.height === 720, `10. unusable input ${w}x${h} falls back to the known-good box`);
  }
  const tiny = screenCaptureSize(10, 20);
  A(tiny.width >= MIN_EDGE && tiny.height >= MIN_EDGE, '11. a tiny screen is floored, never zero');

  // Bitrate scales with area, bounded both ways.
  A(screenCaptureBitrate({ width: 1280, height: 720, frameRate: 15 }) === 1_500_000,
    '12. the reference size keeps the previously shipped 1.5Mbps');
  A(screenCaptureBitrate({ width: 576, height: 1280, frameRate: 15 }) < 1_500_000,
    '13. a smaller capture asks for less bandwidth');
  A(screenCaptureBitrate({ width: 160, height: 160, frameRate: 15 }) === 600_000,
    '14. bitrate floors so text stays readable');
  A(screenCaptureBitrate({ width: 4000, height: 4000, frameRate: 15 }) === 2_500_000,
    '15. bitrate ceilings so a phone is never asked for absurd upload');

  // Deterministic.
  A(JSON.stringify(screenCaptureSize(1080, 2400)) === JSON.stringify(p), '16. pure and deterministic');

  console.log(failures === 0
    ? `\nALL SCREEN-CAPTURE CHECKS PASSED ✓  (1080x2400 -> ${p.width}x${p.height})\n`
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
