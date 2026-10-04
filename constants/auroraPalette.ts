// constants/auroraPalette.ts — the brand blooms behind components/ui/AuroraBackground.
//
// WHY THESE ARE FIXED, NOT THEME TOKENS
// The Aurora Glass ground (U6) puts the brand's personality in soft colour
// blooms drifting behind each tab. The hues are the logo's own sweep (cyan and
// violet from constants/theme) plus a green and an amber, and they are the same
// in both schemes so the composition stays recognisably the same picture. What
// changes with the scheme is how strongly they are painted: on a light ground
// the same opacities read as stains, so AURORA_LIGHT_OPACITY_SCALE damps them.
//
// Each composition is a one-off arrangement for that screen, the way a
// photograph is not a colour; they are kept here, as plain data, so
// constants/paletteContrast.selftest.ts can prove that the palette's text inks
// (text, textDim, textFaint) stay AA-readable (4.5:1) over the PEAK of every
// bloom, in both schemes: list rows have no fill, so their text sits straight
// on this ground. The bright cyan is the limiting hue: on the dark ground a
// peak above about 0.34 drops textFaint under 4.5:1, so no cyan peak exceeds
// 0.33 (chats was 0.42, calls 0.38 before round 7).

import { BRAND_CYAN, BRAND_VIOLET } from './theme';

/** The four bloom hues. */
export const AURORA_BLOOM = {
  cyan: BRAND_CYAN,
  violet: BRAND_VIOLET,
  green: '#22C55E',
  amber: '#F59E0B',
} as const;

/** One bloom: colour, size, centre (in the 390x844 reference), and peak opacity at the centre. */
export type AuroraBloom = { c: string; rx: number; ry: number; cx: number; cy: number; o: number };

const { cyan, violet, green, amber } = AURORA_BLOOM;

/** Per-screen compositions, in the 390x844 viewBox the design was drawn at. */
export const AURORA_COMPOSITIONS = {
  chats:   [
    { c: cyan,   rx: 190, ry: 170, cx: 78,  cy: 44,  o: 0.33 },   // was 0.42: textFaint 3.75:1 at the peak
    { c: violet, rx: 188, ry: 170, cx: 366, cy: 220, o: 0.36 },
    { c: green,  rx: 150, ry: 135, cx: 54,  cy: 622, o: 0.18 },
    { c: amber,  rx: 132, ry: 122, cx: 342, cy: 742, o: 0.16 },
  ],
  chat:    [
    { c: cyan,   rx: 180, ry: 160, cx: 48,  cy: 48,  o: 0.30 },
    { c: violet, rx: 164, ry: 150, cx: 360, cy: 450, o: 0.22 },
    { c: green,  rx: 146, ry: 136, cx: 52,  cy: 700, o: 0.13 },
  ],
  calls:   [
    { c: cyan,   rx: 202, ry: 184, cx: 80,  cy: 50,  o: 0.33 },   // was 0.38: textFaint 4.11:1 at the peak
    { c: green,  rx: 174, ry: 162, cx: 370, cy: 230, o: 0.24 },
    { c: violet, rx: 168, ry: 150, cx: 60,  cy: 620, o: 0.20 },
  ],
  status:  [
    { c: green,  rx: 194, ry: 178, cx: 80,  cy: 50,  o: 0.32 },
    { c: violet, rx: 176, ry: 164, cx: 375, cy: 285, o: 0.30 },
    { c: cyan,   rx: 160, ry: 150, cx: 50,  cy: 670, o: 0.18 },
  ],
  profile: [
    { c: amber,  rx: 210, ry: 190, cx: 190, cy: 30,  o: 0.28 },
    { c: violet, rx: 176, ry: 160, cx: 380, cy: 370, o: 0.28 },
    { c: cyan,   rx: 160, ry: 150, cx: 40,  cy: 690, o: 0.16 },
  ],
  mini:    [
    { c: cyan,   rx: 194, ry: 176, cx: 70,  cy: 40,  o: 0.32 },
    { c: violet, rx: 170, ry: 160, cx: 370, cy: 420, o: 0.24 },
    { c: amber,  rx: 154, ry: 140, cx: 50,  cy: 710, o: 0.14 },
  ],
} satisfies Record<string, AuroraBloom[]>;

/**
 * On a light ground the same opacities read as garish stains rather than light,
 * because the blooms are ADDING colour to something already bright instead of
 * lifting something dark. Scaling them back is what keeps the composition
 * recognisably the same picture in both themes.
 */
export const AURORA_LIGHT_OPACITY_SCALE = 0.32;
