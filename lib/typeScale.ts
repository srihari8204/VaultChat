// lib/typeScale.ts — how type sizes respond to the SCREEN.
//
// Measured before writing this, on the two test phones:
//   Honor ELI-NX9      1200x2664 px @ 520dpi -> 369 x 819 dp
//   Redmi Note 8 Pro   1080x2340 px @ 440dpi -> 392 x 850 dp
//
// Six percent apart in dp. Any width-driven scale would move type by ~3% between
// them, which nobody can see. So THE ENTIRE ORDINARY PHONE RANGE IS DELIBERATELY
// LEFT AT 1.0 — this module changes nothing on any normal phone, by design, and
// that is what makes it safe to drop into a 193-screen app.
//
// The real gap is the other end. The app already has a tablet story
// (lib/responsive.ts splits into panes at TABLET_MIN_DP), and 15pt body text
// sized for a 390dp phone is thin and far away on a 800dp tablet held at arm's
// length. That is what this corrects, plus a small floor for the genuinely
// narrow devices (320dp) where a fixed scale overflows rows.
//
// IT COMPOSES WITH THE OS FONT SETTING, IT DOES NOT REPLACE IT. React Native
// already multiplies fontSize by the user's accessibility font scale, and the
// app never passes allowFontScaling={false} anywhere (verified: 0 occurrences).
// Someone who has asked their phone for bigger text still gets it, on top of
// this. Verified on device at font_scale 1.5: every screen reflows and all
// content stays reachable by scrolling.
//
// The multiplier is CLAMPED at both ends. Unbounded scaling is how a design
// survives review and then clips its own row heights on a device nobody tested.

import { TABLET_MIN_DP } from './responsive';

/** Below this, a phone is narrow enough that fixed type starts to overflow rows. */
export const NARROW_DP = 360;

/** Never shrink past this — smaller stops being legible, which is worse than tight. */
export const MIN_SCALE = 0.94;

/** Never grow past this — beyond it, fixed-height rows in existing screens clip. */
export const MAX_SCALE = 1.18;

/** dp of extra width that buys 1% of type growth on a tablet. Gentle on purpose. */
const DP_PER_PERCENT = 22;

/**
 * Type multiplier for a screen `widthDp` wide.
 *
 * Returns exactly 1 across the normal phone range, so adopting this changes
 * nothing for existing users on existing devices.
 */
export function typeScale(widthDp: number): number {
  if (!Number.isFinite(widthDp) || widthDp <= 0) return 1;   // Dimensions can report 0 mid-rotation

  if (widthDp >= TABLET_MIN_DP) {
    const grown = 1 + (widthDp - TABLET_MIN_DP) / (DP_PER_PERCENT * 100);
    return Math.min(MAX_SCALE, grown);
  }
  if (widthDp < NARROW_DP) {
    return Math.max(MIN_SCALE, widthDp / NARROW_DP);
  }
  return 1;
}

/**
 * Apply the scale to a size/lineHeight pair.
 *
 * lineHeight is scaled by the SAME factor rather than recomputed, so the
 * carefully-set ratios in TYPOGRAPHY survive. Rounded to whole pixels: a
 * fractional lineHeight makes Android nudge baselines inconsistently between
 * rows, which reads as jitter in a list.
 */
export function scaleType(
  t: { fontSize: number; lineHeight: number },
  widthDp: number,
): { fontSize: number; lineHeight: number } {
  const k = typeScale(widthDp);
  if (k === 1) return { fontSize: t.fontSize, lineHeight: t.lineHeight };
  return {
    fontSize: Math.round(t.fontSize * k * 10) / 10,   // 0.1pt is visible in type; 1pt steps are chunky
    lineHeight: Math.round(t.lineHeight * k),
  };
}

export default {};
