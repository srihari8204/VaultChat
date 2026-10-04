// components/comfort/eyeCheckField.ts — the fixed colours of the Eye Check test field.
//
// The charts are drawn on a white field in BOTH themes: a black-on-white C,
// line chart and grid, and the dot plates' figure/background pairs, are the
// test stimulus, so they must not follow the dark theme. Kept here as one named
// field palette (like constants/theme.ts) instead of literals scattered through
// the screen. Marks the screen draws ON this field (answer feedback) use the
// light palette, which is tuned for white — see ON_WHITE_FIELD in
// components/comfort/EyeCheckPhases.tsx.

export const EYE_FIELD = {
  /** The chart card behind every test. */
  paper: '#FFFFFF',
  /** C symbol, astigmatism lines and the grid's centre dot. */
  ink: '#111111',
  /** Amsler grid lines (a touch lighter than the ink, as on the printed grid). */
  grid: '#222222',
  /** The dot plate's round backing. */
  plate: '#F8F5ED',
} as const;

/** Dot-plate [figure, background] pairs; each is close in lightness and differs in hue. */
export const PLATE_COLORS = [
  ['#B86C60', '#93A66E'],
  ['#A56377', '#82A99B'],
  ['#B57553', '#9BAA76'],
] as const;
