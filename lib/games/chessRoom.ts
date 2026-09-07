// lib/games/chessRoom.ts — the Chess screen's own room, and only that screen's.
//
// WHY THIS EXISTS INSTEAD OF MORE TOKENS IN theme.ts.
//
// theme.ts is shared by four boards and the hub. Chess was redesigned on its
// own (2026-09-06) to a deep emerald table with bronze hardware — a chess club
// rather than the maroon card room the other three sit in — and folding those
// colours into the shared palette would have restyled Rummy, Ludo and
// Tic-Tac-Toe with it. So the room is local, exactly like lib/games/rummyGlass.
//
// What is NOT local: spacing (S), radii (R), elevation (E), the type ramp and
// every shared control. Chess still lays out on the same grid as its siblings;
// only the light in the room is different.
//
// ACCENT.chess (#7FD8FF, the ice blue on the hub card and the game's identity
// mark) is deliberately UNTOUCHED — the hub is not part of this redesign, and
// a game's identity colour is the one thing the hub and the board must still
// agree on. Gold is the board's own accent, spent on the active seat, the
// status pill and the board rim.

/** The chess room. Every value here is used by Chess.tsx and nothing else. */
export const CR = {
  /** The ground before the ambient wash — no real pixel is this colour. */
  bg: '#060E0B',
  /** Champagne through bronze. The rim gradient runs gold2 → gold → goldDeep. */
  gold: '#C79B3E',
  gold2: '#F2D89A',
  goldDeep: '#6B4A15',
  /** The lit gold used for text and edges, not for the rim. */
  line: '#E9C46A',
  lineSoft: 'rgba(233,196,106,.55)',
  /** Board squares. */
  ivory: '#EFE7D6',
  emerald: '#256750',
  text: '#FFF8F1',
  /**
   * RAISED FROM #D8CFC3 when the glass gained a sheen (2026-09-07), and that is
   * arithmetic rather than taste.
   *
   * The seat cards now carry a top-left gradient over their base alpha, so the
   * surface under the role line is no longer a single known value — it is
   * brightest exactly where the text starts. Composited against the lit room
   * (CR_LIT) the worst case reaches about white(0.185), i.e. #3E5F55, where the
   * old grey measured 4.55:1 — over the 4.5 line by a rounding error, on the
   * one colour that carries every subtitle at 12.5dp.
   *
   * #E4DCD2 measures 5.07:1 there and 7.34:1 on the flat inactive card, and is
   * still clearly dimmer than `text`, so the hierarchy the two colours exist to
   * express survives. RAISING ANY SURFACE ALPHA MEANS RE-RUNNING THIS — that is
   * the regression the last glass restyle shipped and had to come back and fix.
   */
  muted: '#E4DCD2',
  onGold: '#1A1206',
  /** State. Never the only signal — every one of these ships with a word. */
  ok: '#63E6A0',
  warn: '#F5C45A',
  bad: '#FF7D86',
  info: '#9FD9FF',
} as const;

/**
 * The four glows that light the room.
 *
 * Load-bearing, not decoration, for the same reason AMBIENT is in theme.ts: a
 * translucent panel has no colour of its own and shows whatever is behind it.
 * Over a flat near-black ground every glass card in this screen resolves to the
 * same dim grey and the whole thing goes flat. The fourth glow sits low because
 * the seat card, the status pill and the action dock all live down there.
 */
export const CR_AMBIENT = [
  { color: '#F5C860', opacity: 0.30, cx: '26%', cy: '-6%',  rx: '46%', ry: '26%' },
  { color: '#15B87A', opacity: 0.30, cx: '2%',  cy: '56%',  rx: '60%', ry: '30%' },
  { color: '#1189A6', opacity: 0.22, cx: '100%', cy: '10%', rx: '50%', ry: '24%' },
  { color: '#D08A32', opacity: 0.28, cx: '78%', cy: '92%',  rx: '58%', ry: '26%' },
] as const;

/**
 * The room as it actually composites, for anything that must be previewed
 * outside it. Same idea as `roomLit` in theme.ts, measured for this room.
 */
export const CR_LIT = '#123A2E';

/** Translucent gold, for the lit edges. Translucent white is `white()` in
 *  theme.ts — the glass substance is shared even where the room is not. */
export const g = (a: number) => `rgba(233,196,106,${a})`;

/**
 * Out-of-focus highlights, in the bands the board does not cover.
 *
 * The reference this screen was designed from is a PHOTOGRAPH of a room — a lit
 * table with a plant, a book and a stack of coins going soft behind the board.
 * No gradient reproduces that, but the thing the eye actually reads in it is
 * defocused highlights, and those are drawable.
 *
 * Every one sits above y≈70% or below y≈21%, because the board owns the middle
 * and is fully opaque: a bokeh behind it is a bokeh nobody sees.
 *
 * The bright RIM is the detail that matters. A defocused highlight is brightest
 * at its edge, not its centre — that is what a camera does to a point of light.
 * Drawn as a plain soft dot it reads as a smudge on the lens instead.
 */
export const CR_BOKEH = [
  { cx: '7.2%',  cy: '4.7%',  r: '7.0%', color: '#F5C860', opacity: 0.20 },
  { cx: '86.4%', cy: '1.5%',  r: '5.6%', color: '#F2D89A', opacity: 0.16 },
  { cx: '59.2%', cy: '6.3%',  r: '2.6%', color: '#FFE7B0', opacity: 0.13 },
  { cx: '15.1%', cy: '16.7%', r: '2.0%', color: '#8FE3C4', opacity: 0.10 },
  { cx: '91.8%', cy: '20.4%', r: '3.3%', color: '#12A06B', opacity: 0.14 },
  { cx: '5.6%',  cy: '76.3%', r: '7.3%', color: '#12A06B', opacity: 0.16 },
  { cx: '79.2%', cy: '78.3%', r: '6.2%', color: '#D08A32', opacity: 0.18 },
  { cx: '41.0%', cy: '85.3%', r: '3.0%', color: '#F5C860', opacity: 0.12 },
  { cx: '93.6%', cy: '92.1%', r: '4.4%', color: '#B4762A', opacity: 0.14 },
  { cx: '9.0%',  cy: '93.9%', r: '2.6%', color: '#15B87A', opacity: 0.10 },
] as const;

/**
 * How dark the room goes at its edges.
 *
 * Four wide glows with nothing over them read as a flat sheet of light — the
 * screen gets brighter but not deeper. The vignette is what turns the wash into
 * a space with a middle.
 */
export const CR_VIGNETTE = 0.58;
