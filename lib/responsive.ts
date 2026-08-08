// lib/responsive.ts — form-factor rules, in one place.
//
// Split view (docs/design/screens 04-06, mobile m04-m06) is the first feature
// whose layout genuinely depends on the device, so the "is this a tablet / can
// this fit two panes" decision lives here rather than being re-derived with
// magic numbers in each screen.
//
// PURE — no react-native import — so the thresholds are Node-tested
// (responsive.selftest.ts). The React hook that feeds real window dimensions in
// is at the bottom of the file and is the only impure part.

/** Below this a window is a phone; at or above it, a tablet. 600dp is the
 *  Android sw600dp breakpoint and roughly the 7" mark — the same line the
 *  platform itself draws. */
export const TABLET_MIN_DP = 600;

/** A pane narrower than this cannot show a usable chat: the bubbles collapse to
 *  a few words per line and the composer controls start overlapping. */
export const MIN_PANE_DP = 320;

/** Divider thickness, subtracted before checking whether two panes fit. */
export const DIVIDER_DP = 12;

export type FormFactor = 'phone' | 'tablet';
/** 'vertical' = panes side by side (a vertical divider), matching the design's
 *  "04-split-vertical". 'horizontal' = stacked, for tall narrow windows. */
export type SplitAxis = 'vertical' | 'horizontal';

export function formFactor(width: number, height: number): FormFactor {
  return Math.min(width, height) >= TABLET_MIN_DP ? 'tablet' : 'phone';
}

/** Can this window show two panes side by side at all? */
export function canSplitVertically(width: number): boolean {
  return width >= MIN_PANE_DP * 2 + DIVIDER_DP;
}

/** Can it stack two panes instead? Needs enough height for two usable chats. */
export function canSplitHorizontally(height: number): boolean {
  return height >= MIN_PANE_DP * 2 + DIVIDER_DP;
}

export function canSplit(width: number, height: number): boolean {
  return canSplitVertically(width) || canSplitHorizontally(height);
}

/**
 * Which way to split. Prefer side-by-side when the window is wide enough —
 * that is the designed layout and it keeps both composers reachable. A tall
 * narrow window (a phone in portrait) can only stack.
 */
export function preferredAxis(width: number, height: number): SplitAxis | null {
  if (canSplitVertically(width)) return 'vertical';
  if (canSplitHorizontally(height)) return 'horizontal';
  return null;
}

/**
 * Clamp a divider position (0..1) so neither pane collapses below MIN_PANE_DP.
 * Returns the ratio to actually use. When the window cannot fit two minimum
 * panes at all, returns 0.5 — the caller should not be splitting in that case.
 */
export function clampRatio(ratio: number, total: number): number {
  const usable = total - DIVIDER_DP;
  if (usable < MIN_PANE_DP * 2) return 0.5;
  const min = MIN_PANE_DP / usable;
  const max = 1 - min;
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(max, Math.max(min, ratio));
}

/** Pixel sizes of the two panes for a given ratio. */
export function paneSizes(ratio: number, total: number): { a: number; b: number } {
  const r = clampRatio(ratio, total);
  const usable = total - DIVIDER_DP;
  const a = Math.round(usable * r);
  return { a, b: usable - a };
}

export default {};
