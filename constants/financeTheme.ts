// constants/financeTheme.ts — palette + tokens for the Vault Finance hub.
//
// Ice-glass morphism: a cool arctic ground with translucent white panes on top.
// Mirrors the Figma variable collection "Vault Finance / Color" in file
// N5Y6KcMUPA3LgtWjfHPctz — that file is the source of truth, this is its
// implementation. Changing a colour here without changing it there is drift.
//
// The two stable palettes are selected by useFinanceTheme using the app's
// saved light/dark/system preference. Static FIN remains the light palette
// for existing consumers that explicitly choose their own scheme.
//
// ── Two token names carry the whole restyle ──────────────────────────
// Every finance screen writes `backgroundColor: FIN.bg` for its root and
// `backgroundColor: FIN.card` for its cards. So:
//
//   FIN.bg   = transparent  → the ice gradient rendered once in
//                             app/finance/_layout.tsx shows through every screen
//   FIN.card = translucent  → every card on every screen becomes a glass pane
//
// That is why 18 screens changed appearance without 18 screens being edited.
// If you need a genuinely opaque surface, use FIN.cardSolid.

import { BRAND_ACCENT } from './theme';

export const FIN = {
  // ── Brand. Deliberately still the lavender family: the Mini Apps hub tile
  //    (app/(tabs)/mini.tsx) gradients into these exact colours and is outside
  //    this module's scope, so drifting the hue would break that handshake.
  brand:      BRAND_ACCENT,   // #9D6FD0
  brandDeep:  '#6D3FA8',
  brandInk:   '#4C2A7A',      // text weight of the brand — for labels on brandSoft
  brandSoft:  '#EFE7FA',
  accent:     '#7C3AED',

  // ── Semantic finance state. Every one of these clears WCAG AA (4.5:1) as
  //    text on white and on its own soft fill; pinned by grid.selftest.ts §8.
  //    The previous values (#16A34A, #D97706) did not, at the 11-13pt sizes
  //    these are actually used at.
  good:       '#05603A',      // lent / positive
  goodSoft:   '#DFF5EA',
  bad:        '#B42318',      // borrowed / overdue
  badSoft:    '#FDECEA',
  warn:       '#B54708',      // pending / due
  warnSoft:   '#FDF1E3',
  info:       '#175CD3',
  infoSoft:   '#E6EEFC',

  // ── The ice ground. Rendered once as a gradient in the finance _layout;
  //    `bg` is transparent so it shows through every screen's root View.
  bg:         'transparent',
  bgTop:      '#F0F3FA',
  bgMid:      '#E3E9F4',
  bgBottom:   '#D4DEEE',

  // ── Glass. Translucent white over the ground — NOT a backdrop blur.
  //    expo-blur is installed but a live blur behind a scrolling list is the
  //    single most expensive thing you can put on a mid-range Android GPU, and
  //    on a ground this light it buys almost nothing visually. A translucent
  //    fill plus a bright rim reads as frost for free.
  card:       'rgba(255,255,255,0.82)',   // the default pane
  cardStrong: 'rgba(255,255,255,0.94)',   // raised: sheets, selected chips
  cardSolid:  '#FFFFFF',                  // when opacity is actually required
  card2:      '#F1F4FA',
  glassEdge:  'rgba(44,62,96,0.18)',      // visible cool rim on the light ground
  glassRim:   'rgba(16,24,40,0.12)',      // the cool outer hairline

  border:     '#D8DFEC',
  line:       '#E7ECF5',

  // ── The capped reading column, including its gutters. Not a colour, but it
  //    lives here because every finance screen already imports FIN and none of
  //    them would otherwise need an import to stop stretching on a tablet.
  //    = FIN_CONTENT_MAX_DP (600) + FIN_GUTTER (16) on each side.
  contentMax: 632,

  // ── Text
  text:       '#101828',
  sub:        '#475467',
  // #98A2B3 was only 2.6:1 on white. `faint` is not decorative — it is the
  // placeholder in every money field and the hint under every form label, so it
  // has to be readable. #566176 also clears AA directly on the tinted ground.
  faint:      '#566176',
  onBrand:    '#FFFFFF',
} as const;

/**
 * Hero gradients. The hero is the ONE saturated surface in the module, so its
 * variants are named here rather than assembled inline — a screen reaching for
 * a one-off `['#0f7a38', ...]` is how a palette starts to rot.
 *
 * Each runs dark → light along the diagonal, matching the brand hero, and each
 * dark stop is chosen so white body text clears AA across the whole sweep.
 */
export const FIN_HERO: Record<'brand' | 'good' | 'bad' | 'warn', [string, string]> = {
  brand: ['#4C2A7A', '#6D3FA8'],
  good: ['#05603A', '#06704C'],
  bad:  ['#912018', '#B42318'],
  warn: ['#93370D', '#9F3C08'],
};

/**
 * Ink on a FIN_HERO gradient. Those are saturated and dark in BOTH schemes, so
 * their text is white in both: FIN.onBrand turns dark in dark mode, and the app
 * palette's onPrimary is documented as "not always white".
 */
export const HERO_INK = {
  /** Headline figure. */
  strong: '#FFFFFF',
  /** Secondary lines under the figure. */
  soft: 'rgba(255,255,255,0.9)',
  /** Small caps labels above the figure. */
  label: 'rgba(255,255,255,0.85)',
  /** Hairline rules and dividers inside a hero. */
  rule: 'rgba(255,255,255,0.22)',
} as const;

/** Corner radii. Matches "Vault Finance / Scale" in Figma. */
export const FIN_RADIUS = { xs: 8, sm: 12, md: 16, lg: 20, xl: 28, pill: 999 } as const;

/** Soft two-layer elevation for glass panes. Spread across two shadows so the
 *  pane reads as floating rather than outlined; `elevation` is what Android
 *  actually honours, the rest is iOS. */
export const FIN_SHADOW = {
  rest:   { shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  raised: { shadowColor: '#101828', shadowOpacity: 0.12, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  brand:  { shadowColor: '#6D3FA8', shadowOpacity: 0.30, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
} as const;

/** Money must align down a column, so every figure is rendered with tabular
 *  figures. Without this the proportional digits make ₹1,111 visibly narrower
 *  than ₹8,888 and a column of amounts looks ragged. */
export const TABULAR = { fontVariant: ['tabular-nums' as const] };

export type LedgerStatus = 'running' | 'overdue' | 'completed';

export const financeStatusColors = (FIN: FinancePalette): Record<LedgerStatus, { fg: string; bg: string; label: string }> => ({
  running:   { fg: FIN.good, bg: FIN.goodSoft, label: 'Running' },
  overdue:   { fg: FIN.bad,  bg: FIN.badSoft,  label: 'Overdue' },
  completed: { fg: FIN.sub,  bg: FIN.card2,    label: 'Completed' },
});
export const STATUS_COLORS = financeStatusColors(FIN);

/**
 * The ice-glass palette after dark.
 *
 * Same STRUCTURE as FIN, key for key, so a screen can swap palettes without
 * knowing which one it holds. Two things invert and nothing else has to:
 *   bg*   — the ground becomes deep slate instead of pale ice
 *   card  — a translucent WHITE pane over a dark ground reads as haze, so the
 *           dark pane is a translucent LIGHT-SLATE lift instead.
 *
 * The semantic colours are NOT the light ones reused: #05603A on a dark ground
 * is unreadable. Each is the lighter end of its ramp, chosen so it clears AA
 * (4.5:1) against `bg` — pinned by financeTheme.selftest.ts, not by eye.
 */
export const FIN_DARK = {
  brand:      '#C4A5E8',
  brandDeep:  '#B58AE4',
  brandInk:   '#E9DDF7',
  brandSoft:  '#2A1F3D',
  accent:     '#B98CF0',

  good:       '#6CE9A6',
  goodSoft:   '#0B2E20',
  bad:        '#FDA29B',
  badSoft:    '#3B1613',
  warn:       '#FEC84B',
  warnSoft:   '#3A2A0C',
  info:       '#84ADFF',
  infoSoft:   '#111F3D',

  bg:         'transparent',
  bgTop:      '#151A24',
  bgMid:      '#111621',
  bgBottom:   '#0B0F17',

  // A lift, not a wash: white at low alpha over near-black turns milky.
  card:       'rgba(255,255,255,0.07)',
  cardStrong: 'rgba(255,255,255,0.12)',
  cardSolid:  '#161B26',
  card2:      '#1B212E',
  glassEdge:  'rgba(255,255,255,0.14)',
  glassRim:   'rgba(0,0,0,0.40)',

  border:     '#2A3242',
  line:       '#222938',

  contentMax: 632,

  text:       '#F2F4F7',
  sub:        '#B4BCCA',
  faint:      '#98A2B3',
  onBrand:    '#101828',
} as const;

/** Both palettes share a shape, so this is the only lookup a screen needs. */
export const FIN_PALETTES = { light: FIN, dark: FIN_DARK } as const;
export type FinScheme = keyof typeof FIN_PALETTES;
export type FinancePalette = { [K in keyof typeof FIN]: typeof FIN[K] extends number ? number : string };

export default FIN;
