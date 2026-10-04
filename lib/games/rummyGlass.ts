// lib/games/rummyGlass.ts — the rummy table's glass design language.
//
// ONE SOURCE for every colour and every surface on the felt. Before this, the
// cloth's three stops lived in Rummy.tsx, the pills each carried their own
// hand-written `rgba(0,0,0,0.34)`, the trays carried a different one, and the
// card colours a third set — so "make the table more premium" meant editing
// eight literals and missing two. The file's own comments already recorded that
// failure once: a documented green→teal swap that never reached the gradient
// actually painting the table, because the gradient repeated the hexes instead
// of reading them.
//
// Pure data. No React, no react-native import — so it can be linted, read by a
// self-check and diffed without a renderer. Everything here is a plain object
// or string that a RN `style` prop accepts verbatim.
//
// TWO GLASS FAMILIES, and picking the wrong one is the mistake this file
// exists to prevent:
//
//   onFelt  — DARK glass. The cloth is a lit mid-tone emerald, so a surface on
//             it has to DARKEN to keep white ink legible. Frosting over a lit
//             table works the opposite way round from frosting over an unlit
//             one.
//   onRoom  — LIGHT glass. The room (C.bg, near-black) is unlit, so a surface
//             on it lifts. This is the same primitive as theme.ts `glass`.
//
// ponytail: no BlurView anywhere. What sits behind these surfaces is a smooth
// radial gradient, and blurring a smooth gradient returns almost the same
// gradient — for a real per-frame cost on a screen that animates thirteen cards
// and a turn ring. See the same note in theme.ts.

/* ── the cloth ──────────────────────────────────────────────────────── */

/**
 * The felt, brightest first: the lit centre, the body of the cloth, and the
 * shadow at the rail. ONE LINE TO CHANGE if you want a different table.
 *
 * Teal emerald keeps ivory ranks clear and separates the felt from the slate
 * surround. The rail's transparent highlights share the same cool light.
 */
export const FELT = ['#23977C', '#0F6A59', '#063C38'] as const;

/**
 * The room the table stands in.
 *
 * Slate, lit from both sides. Amber catches the fine brass inlay; the teal
 * reflection connects the surround to the felt without a bitmap or blur.
 */
export const ROOM = ['#23394A', '#122235', '#07101E'] as const;
export const ROOM_GLOW = [
  { color: '#C98A3C', opacity: 0.22, cx: '4%',  cy: '34%', rx: '46%', ry: '62%' },
  { color: '#2E6B7A', opacity: 0.16, cx: '86%', cy: '6%',  rx: '42%', ry: '56%' },
  { color: '#C98A3C', opacity: 0.10, cx: '92%', cy: '82%', rx: '34%', ry: '46%' },
] as const;

/**
 * Ink on the cloth.
 *
 * It has moved every time the cloth has, and it must: ink and cloth are ONE
 * decision, not two. '#e7f3ea' for the old green, '#FFF8F1' for the wine,
 * '#F2F7F8' for the teal — which read faintly blue, because a cool ink on a
 * warm green is the one combination that looks accidental rather than chosen.
 * This is that brightness carried a hair warm, so it sits on emerald and still
 * belongs to the gold hardware around it.
 */
export const INK = '#F4F6F1';
/** The same ink, dimmed, for a second line under a name. */
export const INK_DIM = 'rgba(244,246,241,0.72)';

/** The brass rail, lit from above: hot cap, body, dark underside, shadow. */
export const RAIL = ['#FFE9A8', '#D9A93C', '#8A6416', '#4A330B'] as const;
/** Walnut between brass and cloth — the part a player rests a hand on. */
export const WOOD = ['#5C3A1E', '#2B1A0C'] as const;

/**
 * The cyan the table is lit with.
 *
 * A single cool accent against all that warm brass is what stops the felt
 * reading as a casino template: the rim catches it, the score's third stat
 * carries it, and nothing else does. Spent once, like the gold.
 */
export const CYAN = '#6FE3D2';

/* ── glass surfaces ─────────────────────────────────────────────────── */

export type GlassTone = 'navy' | 'emerald' | 'teal' | 'gold' | 'blue' | 'danger';

/**
 * The five tones §16 asks for, as {fill, border} pairs measured to sit on the
 * FELT. Each is a near-black base with a hue in it rather than a saturated
 * colour at low alpha — a colour-tinted transparency over a green cloth
 * composites to mud, which is what the first attempt at this looked like.
 */
const TONE: Record<GlassTone, { fill: string; edge: string; ink: string }> = {
  navy:    { fill: 'rgba(6,14,28,0.68)',   edge: 'rgba(255,255,255,0.22)', ink: INK },
  emerald: { fill: 'rgba(3,36,27,0.66)',   edge: 'rgba(126,240,190,0.34)', ink: '#CFF6E4' },
  teal:    { fill: 'rgba(3,32,38,0.66)',   edge: 'rgba(111,227,210,0.38)', ink: CYAN },
  gold:    { fill: 'rgba(34,22,3,0.70)',   edge: 'rgba(243,194,69,0.50)',  ink: '#FFDD72' },
  blue:    { fill: 'rgba(8,20,44,0.68)',   edge: 'rgba(127,216,255,0.36)', ink: '#BFE6FF' },
  danger:  { fill: 'rgba(44,7,14,0.70)',   edge: 'rgba(255,125,134,0.46)', ink: '#FF9BA2' },
};

/** The colour a tone's own text should be, so a caller never guesses. */
export const toneInk = (tone: GlassTone): string => TONE[tone].ink;
export const toneEdge = (tone: GlassTone): string => TONE[tone].edge;

/** The lit top edge. With no solid fill this is most of what says "thickness". */
const RIM = 'inset 0 1px 0 rgba(255,255,255,0.16)';

export interface GlassStyle {
  backgroundColor: string;
  borderWidth: number;
  borderColor: string;
  borderRadius: number;
  boxShadow: string;
}

/**
 * A dark-glass surface for the felt.
 *
 * `lift` is elevation, not decoration: 0 is flush (a tray the cards lie in),
 * 1 is a control, 2 is something floating over the table (the turn pill).
 */
export function onFelt(
  tone: GlassTone,
  { radius = 12, lift = 1, active = false }: { radius?: number; lift?: number; active?: boolean } = {},
): GlassStyle {
  const t = TONE[tone];
  const drop =
    lift <= 0 ? '' :
    lift === 1 ? ', 0 2px 8px rgba(0,0,0,0.38)' :
    ', 0 10px 26px rgba(0,0,0,0.48), 0 2px 6px rgba(0,0,0,0.3)';
  return {
    backgroundColor: t.fill,
    borderWidth: 1,
    borderColor: active ? t.edge.replace(/[\d.]+\)$/, '0.85)') : t.edge,
    borderRadius: radius,
    boxShadow: `${RIM}${drop}`,
  };
}

/**
 * A light-glass surface for the ROOM — the lobby, the table list, the sheets.
 *
 * Separate from theme.ts `glass` only in that it takes a radius and no
 * elevation-12 Android fallback: these are inline surfaces inside a scroller,
 * not floating panels, and `elevation` on a scrolling child costs a layer.
 */
export function onRoom(radius = 16, alpha = 0.075): GlassStyle {
  return {
    backgroundColor: `rgba(255,255,255,${alpha})`,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: radius,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 22px rgba(0,0,0,0.35)`,
  };
}

/* ── cards ──────────────────────────────────────────────────────────── */

/**
 * Premium ivory, not white. A pure-white card on a lit emerald cloth reads as a
 * cut-out; real card stock is warm and slightly absorbent, and the difference
 * is most of what makes a hand look like objects rather than rectangles.
 */
export const CARD = {
  face: '#FFFEFA',
  /** The paper's shaded lower half — a one-stop gradient, not a texture image. */
  faceLow: '#F1F3EC',
  jokerFace: '#F7F0FF',
  edge: '#C7CEC5',
  ink: '#111C22',
  red: '#BF1730',
  joker: '#7C3AED',
  /**
   * The back: NAVY, not the old crimson pair.
   *
   * Crimson backs sat in the same hue family as the red suits, so a fanned
   * opponent's hand and a player's own hearts read as the same material. Navy
   * is the one colour on the table that belongs to nothing else, which is what
   * a card back is for.
   */
  back: ['#24406E', '#132444'] as const,
  backLine: 'rgba(247,244,234,0.14)',
} as const;

/** Selected/live card lift. Kept as strings so the card can pick one branchlessly. */
export const CARD_SHADOW = {
  rest: '0 2px 6px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.85)',
  raised: '0 8px 18px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.9)',
  wild: (gold: string) => `0 0 0 2px ${gold}, 0 6px 14px rgba(0,0,0,0.45)`,
} as const;

/* ── the score trio ─────────────────────────────────────────────────── */

/**
 * Gold → meld, red → deadwood, cyan → score (§10).
 *
 * These are the ONLY three colours on the score strip and they are not
 * interchangeable: meld is what you have built, deadwood is what it will cost
 * you, and score is the server's number. A player reads the colour before the
 * label, so swapping two of them silently changes what the strip means.
 */
export const STAT = {
  meld: '#F3C245',
  deadwood: '#FF7D86',
  score: CYAN,
} as const;

/* ── named literals the board files used to inline (2026-10 split) ──── */
//
// Moved here when components/games/Rummy.tsx was split into
// components/games/rummy/*, so the board files carry no colour literals and
// every rummy colour stays in this one module. Values are unchanged except
// MELD_INK.bad (see below).

/** The table's frame and cloth overlays, as TableTop paints them. */
export const TABLE_TOP = {
  /** The dark glass frame under the brass rail, lit top-left. */
  glass: ['#86664B', '#3D2B24', '#151018'] as const,
  /** The cloth's sheen, cool and fading to a teal-black underside. */
  sheen: '#DFFFF4',
  sheenLow: '#041C22',
  /** The drop where cloth meets frame. */
  bevel: '#000000',
  /** The frame's hairline and the dashed stitching on the cloth. */
  rimLine: '#C6F1DF',
  /** The quiet suit medallions printed into the cloth. */
  suits: '#D7F7E9',
  /** The house mark printed into the cloth, and its RUMMY line (= RAIL[1]). */
  houseMark: '#FFF8F1',
  houseSub: '#D9A93C',
} as const;

/** An opponent's seat capsule: avatar fills, icon and initials ink, the out dot, the name. */
export const SEAT_AVATAR = {
  bot: '#1C4F86',
  human: '#2B6658',
  botIcon: '#C6DFFF',
  initials: '#E4FFF0',
  out: '#9A8F8F',
  name: '#fff',
} as const;

/** Ink on the three coloured action buttons (Declare, Drop, Discard). */
export const ACTION_INK = { good: '#F2FFF7', danger: '#FFF1F2', blue: '#F0F8FF' } as const;

/**
 * The meld verdict on a group tray. The trays are LIGHT glass over the room,
 * and the old red (#ff8080, and C.bad for the title) measured 3.2:1 there;
 * `bad` is lifted to clear WCAG AA (4.7:1). `pure` measures 4.7:1 as it was.
 */
export const MELD_INK = { pure: '#5fe08c', bad: '#FFB4BA' } as const;

/** The status pill's words when it is not your turn (11.5:1 on navy glass). */
export const STATUS_INK = '#cfe8d8';
