// components/games/chess/style.ts — the chess board's look: board themes,
// piece paths and inks, the rim and rail geometry.
//
// Split out of components/games/Chess.tsx (2026-10 round 4) so the board file
// holds behaviour and this holds values. A .ts module, not .tsx: these are
// data, and the board's own palette is a documented theme exemption
// (lib/themeCoverage.selftest.ts) — every colour here is the chess room's, not
// the app theme's.

import { CR } from '../../../lib/games/chessRoom';

export type Move = { from: number; to: number; promo?: string };

/** Fill + fake-stroke per side. See OutlinedGlyph. */
export type Ink = { w: { fill: string; line: string }; b: { fill: string; line: string } };

export type BoardTheme = {
  light: string; dark: string; hl: string; sel: string;
  /** Board rim. Defaults to the dark wood edge every painted theme uses. */
  edge?: string;
  /** Legal-move dot. The default is INK — it is drawn for light squares. */
  dot?: string;
  /** Capture ring. Same reasoning as `dot`. */
  ring?: string;
  /** Piece ink. Defaults to black-on-cream; only `glass` needs its own. */
  ink?: Ink;
};

/** chess.com board themes, from games-web/chess.js BOARD_THEMES — plus `glass`. */
export const THEMES = {
  /**
   * The house board — a deep emerald table with warm ivory squares.
   *
   * THE KEY IS STILL `glass`, AND THAT IS DELIBERATE. It is the value written
   * into AsyncStorage under BOARD_KEY by every player who has ever kept the
   * default, and renaming it would silently invalidate their stored choice and
   * drop them back to whatever the default happened to be that week. The key is
   * storage; the colours are design. Only the colours moved.
   *
   * It used to be literally translucent — white at .16/.045 over the room —
   * which read as glass but gave chess the one thing a board must not have:
   * squares whose colour depends on what is behind them. The 2026-09-06
   * redesign makes the BOARD opaque and puts the glass in the panels around it,
   * which is both what the reference asks for and what every chess client does.
   *
   * Because the squares are opaque again, the BLACK pieces come back to black.
   * The previous version played the dark side in the ice accent, because black
   * on a dark translucent square is a silhouette on a shadow; on solid emerald
   * that problem is gone. What replaces the tint is a champagne rim — the same
   * trick the white pieces have always used, in the other direction — so an
   * obsidian piece on an emerald square still has an edge.
   */
  glass:      { light: CR.ivory, dark: CR.emerald,
                hl: 'rgba(233,196,106,.42)', sel: 'rgba(233,196,106,.62)',
                edge: CR.gold, dot: 'rgba(24,38,32,.65)',
                ring: 'rgba(24,38,32,.65)',
                ink: { w: { fill: '#FBF4E6', line: '#2B2620' },
                       b: { fill: '#14120F', line: '#E0B455' } } },
  classic:    { light: '#ece6d3', dark: '#6f6253', hl: 'rgba(214,175,99,.50)', sel: 'rgba(214,175,99,.68)' },
  green:      { light: '#ebecd0', dark: '#739552', hl: 'rgba(155,199,0,.45)',  sel: 'rgba(155,199,0,.55)' },
  blue:       { light: '#dee3e6', dark: '#8ca2ad', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
  brown:      { light: '#f0d9b5', dark: '#b58863', hl: 'rgba(205,210,106,.45)', sel: 'rgba(205,210,106,.55)' },
  midnight:   { light: '#b7c6d8', dark: '#3a4b66', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
  tournament: { light: '#e8e8e8', dark: '#7d8a99', hl: 'rgba(155,199,0,.41)',  sel: 'rgba(155,199,0,.55)' },
} satisfies Record<string, BoardTheme>;
export type ThemeName = keyof typeof THEMES;

export const isThemeName = (v: unknown): v is ThemeName =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(THEMES, v);

export const FILES = 'abcdefgh';
// chess.css: `.sq.check { box-shadow: inset 0 0 0 60px rgba(225,90,90,.55) }`
// with a 1s pulse to .3. OPAQUE here because the pulse below animates opacity —
// a .55 colour at .55 opacity is .30 at rest, so the check marker was arriving
// at half strength and reading as a faint blush rather than an alarm.
export const CHECK_RED = '#e15a5a';
export const DOT = 'rgba(40,35,28,.32)';

/**
 * The pieces, as vector paths on a 100x100 grid.
 *
 * THEY WERE UNICODE GLYPHS, and that was a device risk rather than a look. A
 * glyph is drawn by whatever font the platform resolves it to; every Android
 * skin ships its own symbol fonts, and OutlinedGlyph's own comment used to warn
 * that whether the outline set renders hollow is a font-fallback question — on
 * a skin that answers it the other way, the white king comes out solid black
 * and you cannot tell your own pieces from your opponent's. That was a question
 * of which phone, not whether.
 *
 * A path renders as one shape everywhere, and it takes a REAL stroke, which is
 * what the four offset copies below it were faking.
 *
 * Drawn in Figma first per the standing rule (file BamgQ9YetsdRxW2CfWM7By,
 * frame "Chess v2 - piece set (draft)"), and kept to absolute M/L/C/Z: that is
 * the only path grammar Figma's parser accepts. react-native-svg takes far
 * more, but authoring to the smaller grammar is what lets the design file and
 * the code hold the same string.
 */
const BASE_WIDE = 'M 22 78 L 78 78 C 80.2 78 82 79.8 82 82 L 82 88 L 18 88 L 18 82 C 18 79.8 19.8 78 22 78 Z';
const COLLAR = 'M 32 66 L 68 66 C 70.2 66 72 67.8 72 70 L 72 74 L 28 74 L 28 70 C 28 67.8 29.8 66 32 66 Z';

export const PIECE_PATH: Record<string, string> = {
  // A head, a NECK, and a flared skirt. Without the waist the head and the body
  // merge into one lump and it stops reading at board size, which is the only
  // size it is ever seen at.
  p: 'M 50 16 C 57.18 16 63 21.82 63 29 C 63 36.18 57.18 42 50 42 C 42.82 42 37 36.18 37 29 C 37 21.82 42.82 16 50 16 Z'
   + ' M 44 41.5 C 42.6 44.8 41.4 47.8 41 50.6 C 40.1 56.8 36.6 63.8 32.4 70 L 30 76 L 70 76 L 67.6 70 C 63.4 63.8 59.9 56.8 59 50.6 C 58.6 47.8 57.4 44.8 56 41.5 C 54.2 42.7 52.2 43.3 50 43.3 C 47.8 43.3 45.8 42.7 44 41.5 Z'
   + ' M 26 76 L 74 76 C 76.2 76 78 77.8 78 80 L 78 88 L 22 88 L 22 80 C 22 77.8 23.8 76 26 76 Z',
  r: 'M 24 14 L 37 14 L 37 25 L 44 25 L 44 14 L 56 14 L 56 25 L 63 25 L 63 14 L 76 14 L 76 35 L 67 42 L 64 65 L 73 75 L 73 78 L 27 78 L 27 75 L 36 65 L 33 42 L 24 35 Z ' + BASE_WIDE,
  b: 'M 50 11 C 53.31 11 56 13.69 56 17 C 56 20.31 53.31 23 50 23 C 46.69 23 44 20.31 44 17 C 44 13.69 46.69 11 50 11 Z'
   + ' M 50 21 C 60 27 67 36.5 67 45 C 67 52 63.4 58.2 57.9 61.8 L 61.5 67 L 38.5 67 L 42.1 61.8 C 36.6 58.2 33 52 33 45 C 33 36.5 40 27 50 21 Z'
   + ' M 36 67 L 64 67 C 66.2 67 68 68.8 68 71 L 68 74 L 32 74 L 32 71 C 32 68.8 33.8 67 36 67 Z ' + BASE_WIDE,
  n: 'M 38 78 L 38 74 C 38 65 41.4 58.4 48.2 53.4 C 52.6 50.2 55.2 47.5 56.5 44.2 L 48.1 47.4 L 44.5 41.2 L 51.1 36.6 C 52.5 34.6 53.3 32.2 53.5 29.4 L 46.9 32 L 44.5 25.4 L 53.5 20.8 C 56.1 16.8 60.1 14.2 65.1 13.4 L 67.7 20.8 L 74.1 24.4 C 78.1 26.6 80.5 30.6 80.5 35.6 L 80.5 78 Z ' + BASE_WIDE,
  q: 'M 50 10 C 53.04 10 55.5 12.46 55.5 15.5 C 55.5 18.54 53.04 21 50 21 C 46.96 21 44.5 18.54 44.5 15.5 C 44.5 12.46 46.96 10 50 10 Z'
   + ' M 28 25 C 30.76 25 33 27.24 33 30 C 33 32.76 30.76 35 28 35 C 25.24 35 23 32.76 23 30 C 23 27.24 25.24 25 28 25 Z'
   + ' M 72 25 C 74.76 25 77 27.24 77 30 C 77 32.76 74.76 35 72 35 C 69.24 35 67 32.76 67 30 C 67 27.24 69.24 25 72 25 Z'
   + ' M 50 20 L 58 38 L 71 27 L 68 50 L 65.5 66 L 34.5 66 L 32 50 L 29 27 L 42 38 Z ' + COLLAR + ' ' + BASE_WIDE,
  k: 'M 46.5 9 L 53.5 9 L 53.5 15 L 59.5 15 L 59.5 22 L 53.5 22 L 53.5 31 L 46.5 31 L 46.5 22 L 40.5 22 L 40.5 15 L 46.5 15 Z'
   + ' M 46.5 30 C 38 32.6 32 39.5 32 47.6 C 32 52.2 33.9 56.4 37 59.5 L 34 66 L 66 66 L 63 59.5 C 66.1 56.4 68 52.2 68 47.6 C 68 39.5 62 32.6 53.5 30 Z ' + COLLAR + ' ' + BASE_WIDE,
};

/**
 * The outline, in VIEWBOX UNITS rather than pixels.
 *
 * Was 1.2 — a px count copied from chess.css's -webkit-text-stroke and faked
 * with four offset glyph copies. A path takes a real stroke, and expressing it
 * in the 100-unit grid means it scales WITH the board instead of getting
 * proportionally heavier as the squares get smaller.
 */
export const PIECE_STROKE = 2.2;

/**
 * Fill and stroke per side, straight from chess.css:
 *   .piece.w { color: #f4f0e6; -webkit-text-stroke: 1.2px #2b2620 }
 *   .piece.b { color: #1d1a16; -webkit-text-stroke: 1.2px #000 }
 *
 * Black's stroke is BLACK — it thickens the glyph rather than outlining it. An
 * earlier pass here gave black a light stroke, which is a different piece set:
 * it turns a solid black knight into an engraved one.
 */
export const PIECE_INK = {
  w: { fill: '#f4f0e6', line: '#2b2620' },
  b: { fill: '#1d1a16', line: '#000000' },
} as const;

/** The bronze board frame, in dp. */
export const RIM = 3;

/**
 * The felt rail between the frame and the grid, as a fraction of the board.
 *
 * THE COORDINATES LIVE ON IT, and that is the point. They used to be drawn
 * inside the first column and last row of squares, which is what chess.css
 * does — but it means eight squares carry a label a piece then stands on top
 * of, and on a phone the label and the piece fight for the same 40dp. A rail
 * is where a real board puts them.
 *
 * It is a RATIO rather than a constant because it has to hold its proportion
 * from a 320dp phone to a tablet; at 358dp it resolves to 19dp, which fits a
 * 10dp digit with air around it. Clamped so it can neither vanish on a small
 * screen nor eat the board on a large one.
 */
export const RAIL_RATIO = 0.053;
export const RAIL_MIN = 13;
export const RAIL_MAX = 26;

/** The rail itself: the green felt a board's frame holds. */
export const FELT = '#12483A';
export const RAIL_INK = 'rgba(207,227,216,.85)';

/**
 * The lit and shadowed ends of each side's body gradient, and the black side's
 * light trim (its edge, the engraved details and the knight's eye). White's
 * trim is its own `line` ink, so only black needs separate values.
 */
export const PIECE_SHADE = {
  w: { hi: '#FFFFFF', lo: '#C8C3B7' },
  b: { hi: '#66717C', lo: '#0D131A', edge: '#A0ABB4', engrave: '#DCE4E8', eye: '#FFFFFF' },
} as const;

/** The contact shadow under every piece. */
export const CONTACT_SHADOW = '#000000';

/** The seat clock: warm gold while that seat is to move, parchment at rest. */
export const SEAT_CLOCK = { active: '#FFDD9E', idle: '#EFE3D0' } as const;

/** The draw-offer banner's heading: 7.2:1 on its gold-tinted glass over the room. */
export const DRAW_OFFER_INK = '#ffd97a';
