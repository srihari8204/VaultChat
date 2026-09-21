// lib/games/ludoGlass.ts — the Ludo board's own room and its glass surfaces.
//
// WHY THIS EXISTS INSTEAD OF MORE TOKENS IN theme.ts.
//
// theme.ts is shared by the hub and (still) by Rummy and Tic-Tac-Toe. Ludo was
// redesigned on its own (2026-09-06) to a midnight room lit with violet, cyan
// and gold, and folding those colours into the shared palette would have
// restyled the other boards with it. So the room is local — exactly like
// lib/games/rummyGlass.ts and lib/games/chessRoom.ts, which exist for the same
// reason and set the pattern this file follows.
//
// What is NOT local: spacing (S), radii (R), elevation (E), the type ramp and
// every shared control in components/games/ui.tsx. Ludo still lays out on the
// same grid as its siblings; only the light in the room is different.
//
// ACCENT.ludo (#FFD166) is deliberately UNTOUCHED, and it is load-bearing
// twice: it is the identity mark on the hub card, and it is also SEAT[2] —
// yellow's colour on the board. The hub and the board have to agree, so this
// file reads the same hex rather than restating a near-miss.
//
// Pure data. No React, no react-native import — so it can be linted, checked by
// a self-check and diffed without a renderer. Everything here is a plain object
// or a string that a RN `style` prop or an SVG attribute takes verbatim.
//
// ponytail: no BlurView. Same call as theme.ts and rummyGlass.ts — what sits
// behind these surfaces is a smooth radial wash, and blurring a smooth gradient
// returns almost the same gradient, for a per-frame cost on a board that
// animates sixteen tokens. Revisit only if a board ever gains detailed content
// behind a panel for the blur to dissolve.
//
// Designed in Figma first per the standing rule:
// file BamgQ9YetsdRxW2CfWM7By, frames "Ludo v2 — midnight — 390×844",
// "— small — 360×780", "— large — 430×932", "— tokens →" and "— states →".

import { BOARD_GUTTER, BOARD_MIN } from './boardFit';

/* ── the room ───────────────────────────────────────────────────────── */

/** Every value here is used by Ludo.tsx and nothing else. */
export const LR = {
  /** The ground BEFORE the ambient wash — no real pixel is this colour. */
  bg: '#070A18',
  /**
   * The room as it actually composites, for anything previewed outside it.
   * Same idea as `roomLit` in theme.ts, measured for this room.
   */
  lit: '#2A2350',
  text: '#F4F5FF',
  /**
   * Checked, not chosen. `muted` carries the seat status line, the fairness CTA
   * and the turn subtitle at 10.5–12dp on surfaces that composite to roughly
   * #3B3663 under the wash. #C9CBE8 measures 7.4:1 there, clear of the 4.5 WCAG
   * AA needs at this size, and is still visibly dimmer than `text`. Raising any
   * surface alpha below means re-running this — that is the regression the last
   * glass restyle shipped and had to fix.
   */
  muted: '#C9CBE8',
  /** State. Never the only signal — each ships with a word beside it. */
  ok: '#8CF5BE',
  bad: '#FF9BA2',
  /** Ink for text sitting on the gold CTA — gold is a light surface. */
  onGold: '#1A1206',
} as const;

/**
 * The four glows that light the room.
 *
 * Load-bearing, not decoration, for the same reason AMBIENT is in theme.ts: a
 * translucent surface has no colour of its own and shows whatever is behind it.
 * Over a flat near-black ground every cell, yard and card on this screen
 * composites toward the same dim grey and the board goes muddy — which is
 * exactly what the first pass of this design looked like.
 *
 * Each stop list is a FOUR-stop falloff. The two-stop version left a visible
 * hard ring where the mid stop sat, and a gradient that ends abruptly reads as
 * a drawn circle rather than as light.
 */
export const LR_AMBIENT = [
  { color: '#6D4BFF', opacity: 0.30, cx: '50%',  cy: '-4%', rx: '72%', ry: '30%' },
  { color: '#1FA8FF', opacity: 0.20, cx: '102%', cy: '22%', rx: '58%', ry: '26%' },
  { color: '#FFB03A', opacity: 0.13, cx: '-6%',  cy: '56%', rx: '52%', ry: '24%' },
  { color: '#FF3D9A', opacity: 0.18, cx: '82%',  cy: '94%', rx: '66%', ry: '30%' },
] as const;

/**
 * The stage light behind the board.
 *
 * The single highest-leverage thing in this file. Every surface ON the board is
 * translucent white, so without a lit ground beneath them the whole board
 * resolves to near-black and no amount of tinting the cells recovers it. This
 * is the "soft radial light behind the board" the design asks for, and it is
 * why the yards read as lit glass rather than as mud.
 *
 * Sized and placed against the board, not the screen: at screen scale it lit
 * the chrome instead and the room stopped being midnight.
 */
export const LR_STAGE = {
  /** Multiple of the board edge. 1.31 puts the falloff just outside the rim. */
  scale: 1.31,
  stops: [
    { offset: '0',    color: '#7E62E8', opacity: 0.34 },
    { offset: '0.40', color: '#5B47B8', opacity: 0.20 },
    { offset: '0.74', color: '#3A2E77', opacity: 0.07 },
    { offset: '1',    color: '#6D4BFF', opacity: 0 },
  ],
} as const;

/* ── the four seats ─────────────────────────────────────────────────── */

/**
 * A light, a base and a deep per seat, so a surface can be SHADED rather than
 * filled flat — which is the whole difference between a glass piece and a
 * coloured circle.
 *
 * Retuned off the previous set for the midnight room. The old values were mixed
 * against a maroon ground; on indigo the reds went slightly brown and the blue
 * lost its separation from the room itself.
 *
 * THE NAMES STAY HONEST: each is still recognisably its colour, because the
 * server and the seat labels both call them Red/Green/Yellow/Blue. Seat order
 * is the server's — 0 red, 1 green, 2 yellow, 3 blue — and must not be
 * reordered; it indexes the same arrays as RING / HOME_COORDS / BASE_SPOTS.
 */
export const SEAT = [
  { base: '#FF5C77', light: '#FFA3B4', deep: '#B01E3C' }, // 0 red    — ruby
  { base: '#3EE89B', light: '#93F5C6', deep: '#128F58' }, // 1 green  — emerald
  { base: '#FFD166', light: '#FFE9AE', deep: '#B8862A' }, // 2 yellow — champagne (= ACCENT.ludo)
  { base: '#5CC8FF', light: '#A9E4FF', deep: '#1C6FA8' }, // 3 blue   — sapphire
] as const;

/** Flat lists, for the SVG gradient defs that want one array. */
export const P  = SEAT.map(s => s.base)  as unknown as readonly string[];
export const PL = SEAT.map(s => s.light) as unknown as readonly string[];
export const PD = SEAT.map(s => s.deep)  as unknown as readonly string[];

export const COLOR_NAMES = ['Red', 'Green', 'Yellow', 'Blue'] as const;

/**
 * SHAPE MARKERS — accessibility, not decoration.
 *
 * Red and green are the classic deuteranopia pair, and identifying seats by
 * colour alone makes the game unplayable rather than merely harder for roughly
 * one man in twelve. Each seat carries a distinct shape as well, on the pawn
 * AND on the seat card.
 */
export const SHAPE = ['▲', '●', '■', '◆'] as const;

/* ── glass surfaces ─────────────────────────────────────────────────── */

/**
 * Translucent white over the lit room. These are ALPHAS, not colours: the
 * surface takes its hue from whatever the stage light and the four glows put
 * behind it, which is what makes the board a different colour in each corner.
 *
 * Raising any of these changes the contrast of the ink on top — see LR.muted.
 */
export const LG = {
  /** The board pane itself. */
  pane: 0.10,
  /** A plain track cell. */
  cell: 0.09,
  /** The hairline between cells. On glass a dark stroke is invisible. */
  cellEdge: 0.14,
  /** A safe / star cell — brighter, and it also carries a gold star. */
  safe: 0.26,
  /** The top-left specular on the pane, at its hottest stop. */
  sheen: 0.22,
  /** A seat card at rest, and an action-bar control. */
  card: 0.06,
  /** The seat whose turn it is. */
  cardActive: 0.13,
  /** The fairness CTA — quieter than everything else on purpose. */
  ctaQuiet: 0.045,
} as const;

/** Inset home sockets separate the colored pieces from their light yard. */
export const WELL = '#E5ECF4';

/** Light playing surface inside the midnight glass frame; dark markings stay readable. */
export const TRACK = { cell: '#F6F8FC', safe: '#E2EAF4', edge: '#78889E', ink: '#26364C' } as const;
/** The dice tray the die floats over. Recessed, for the same reason. */
export const TRAY = 'rgba(0,0,0,0.30)';

/** Translucent white — the substance every glass surface here is made of. */
export const w = (a: number) => `rgba(255,255,255,${a})`;

/** Controls follow the measured board, including when a short viewport shrinks it. */
export function ludoControls(columnWidth: number, fontScale: number) {
  return {
    stacked: columnWidth < 320 || fontScale >= 1.4,
    seatColumns: columnWidth < 300 || fontScale >= 1.4 ? 1 : 2,
    dieSize: Math.round(Math.max(52, Math.min(76, columnWidth * 0.19))),
  };
}

/** Wide viewports put controls beside the board instead of reserving 400dp below it. */
export function ludoLayout(width: number, height: number, fontScale: number) {
  const available = Math.max(1, width - BOARD_GUTTER * 2);
  const minimumControls = Math.ceil(220 * Math.min(1.5, Math.max(1, fontScale)));
  const wide = width > height && available >= BOARD_MIN + 12 + minimumControls;
  const controlsWidth = wide ? Math.floor(Math.max(minimumControls, Math.min(360, available * 0.38)))
    : Math.min(available, Math.max(BOARD_MIN, height - BOARD_GUTTER * 2));
  const boardSize = wide ? Math.floor(Math.min(available - controlsWidth - 12, Math.max(BOARD_MIN, height - BOARD_GUTTER * 2)))
    : controlsWidth;
  return { wide, boardSize, controlsWidth, contentWidth: wide ? boardSize + 12 + controlsWidth : boardSize };
}

/**
 * A seat colour with an alpha. Takes the hex from SEAT so a caller can never
 * drift a near-miss of a seat's own colour into a fill.
 */
export function seatA(seat: number, tone: 'base' | 'light' | 'deep', a: number): string {
  const h = (SEAT[seat] ?? SEAT[0])[tone].replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * The yards.
 *
 * NEW, and it is the change that makes the board read as four players'
 * territory rather than one grey sheet: each quadrant is filled with its own
 * seat colour instead of plain white. Near-opaque on purpose — a 13% tint over
 * a near-black ground composites to mud however carefully it is mixed, which
 * the first pass proved.
 */
export const YARD = {
  fillTop: 0.98,
  fillMid: 0.96,
  fillBottom: 0.94,
  rim: 0.9,
  glow: 0.55,
} as const;

/**
 * THE PAWN SILHOUETTE, in a 0..100 box.
 *
 * It was a flat circle — four colours of the same disc, with no shape at all.
 * This is a token: a head, a WAIST, a flared skirt and a plinth.
 *
 * The waist is the load-bearing part and the reason this reads. Without it the
 * head merges into the body into one lump, and 18.5dp (measured on the Redmi:
 * cell = 393/15 = 26.2, token = cell * 0.78) is the ONLY size it is ever seen
 * at. Every curve here was checked against a true-size render in Figma before
 * it was written down; detail that dies at 18dp is worse than no detail.
 *
 * Drawn in a 100-box and scaled by the caller, so the geometry never depends on
 * the board size — `d` stays `cell * 0.78` and the token still lands exactly
 * where the server thinks it is.
 */
export const PAWN_BODY =
  'M 50 11 C 59.4 11 67 18.6 67 28 C 67 34 63.9 39.3 59.2 42.3 '
  + 'C 65.5 46.5 70 54 71.5 63 L 73 74 L 27 74 L 28.5 63 '
  + 'C 30 54 34.5 46.5 40.8 42.3 C 36.1 39.3 33 34 33 28 C 33 18.6 40.6 11 50 11 Z';

/** The plinth, under the body. Rounded — the first pass drew a square slab. */
export const PAWN_BASE =
  'M 27 73 L 73 73 C 77.4 73 81 76.6 81 81 L 81 85 C 81 89.4 77.4 93 73 93 '
  + 'L 27 93 C 22.6 93 19 89.4 19 85 L 19 81 C 19 76.6 22.6 73 27 73 Z';

/**
 * The pawn.
 *
 * `d` is NOT here. A pawn is `cell * 0.78` and cell is `size / 15`, both fixed
 * by the board's geometry contract — a token that grows is a token drawn where
 * the server does not think it is. The touch target grows instead, via hitSlop.
 */
export const PAWN = {
  /** Rest, then the roll-permitted state. Only the rim and the glow change. */
  rimRest: 0.7,
  rimMovable: 1,
  glowRest: 0.6,
  glowMovable: 1,
  /** The single specular. Two would read as plastic. */
  specular: 0.72,
  /** The shape marker, sitting on the pawn's own colour. */
  markerInk: 'rgba(0,0,0,0.82)',
} as const;
