// lib/finance/grid.ts — how Vault Finance lays out on the screen it is actually on.
//
// PURE — no react-native import — so every rule is Node-tested (grid.selftest.ts).
//
// These are the same numbers the Figma artboards were built from
// (file N5Y6KcMUPA3LgtWjfHPctz, page "Screens"): 320dp, 390dp and 744dp boards
// were laid out by running these functions, so a discrepancy between design and
// device is a bug in one of them, not a matter of taste.
//
// The old dashboard hardcoded a 4-across tile row and a `width: '22%'`
// quick-action grid. Both are device assumptions wearing percentage clothing:
// four tiles across 328dp of usable width gives each one 76dp, which is not
// enough for "Lucky Draw groups", and 22% stays four-across on an 800dp tablet
// where it should be six. Everything here derives from the measured window
// instead.

/** Screen edge padding. One value, used by every finance screen. */
export const FIN_GUTTER = 16;

/** Gap between grid cells. */
export const FIN_GAP = 10;

/** Narrowest a quick-action tile can be before its label stops fitting on two
 *  lines. Measured against the longest label in the hub ("Lucky Draw"). */
export const QA_MIN_DP = 78;

/** Below this the balance hero stacks instead of splitting side by side.
 *  Found on the 320dp artboard: a side-by-side hero breaks "₹4,52,000" across
 *  two lines mid-number, which is the one thing a financial UI may never do. */
export const HERO_STACK_BELOW_DP = 360;

/** At or above this, tiles go four-across instead of two. */
export const TILE_WIDE_AT_DP = 480;

/** A balance is read, not scanned across a metre of glass. Past this the
 *  content column stops growing and centres, the way every serious finance app
 *  on a tablet does. */
export const FIN_CONTENT_MAX_DP = 600;

/** Fewest / most quick actions per row, whatever the arithmetic says. */
export const QA_MIN_COLS = 3;
export const QA_MAX_COLS = 6;

/** Usable width inside the gutters, capped for the reading column. */
export function contentWidth(windowWidth: number): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return 0; // mid-rotation Dimensions can report 0
  return Math.min(windowWidth, FIN_CONTENT_MAX_DP) - FIN_GUTTER * 2;
}

/** Health tiles: two-up on a phone, four-up once there is room. */
export function tileColumns(windowWidth: number): number {
  return windowWidth >= TILE_WIDE_AT_DP ? 4 : 2;
}

/** Quick actions: as many as fit at QA_MIN_DP, clamped so the grid never
 *  degenerates into one-per-row or a row of postage stamps. */
export function quickActionColumns(windowWidth: number): number {
  const inner = contentWidth(windowWidth);
  if (inner <= 0) return QA_MIN_COLS;
  const fits = Math.floor((inner + FIN_GAP) / (QA_MIN_DP + FIN_GAP));
  return Math.max(QA_MIN_COLS, Math.min(QA_MAX_COLS, fits));
}

/** Does the balance hero stack its two figures? */
export function heroStacks(windowWidth: number): boolean {
  return windowWidth < HERO_STACK_BELOW_DP;
}

/**
 * Width of one cell in a `cols`-column grid across `inner` points.
 *
 * Floored to a whole point: a fractional cell width makes Android round
 * different cells differently, so the last column in a row lands a pixel wide
 * of its neighbours and the grid visibly frays down the right edge.
 */
export function columnWidth(inner: number, cols: number, gap: number = FIN_GAP): number {
  if (!Number.isFinite(inner) || inner <= 0 || cols < 1) return 0;
  return Math.floor((inner - gap * (cols - 1)) / cols);
}

export default {};
