// lib/games/rummyTable.ts — the geometry and the reading of a rummy table.
//
// Pure functions only: no React, no server calls, nothing that decides game
// truth. Two jobs.
//
//  1. FIT THE TABLE TO THE ACTUAL SCREEN. Thirteen cards, up to five groups,
//     five opponents' seats, two piles and an action bar have to coexist on
//     anything from a 5" phone to a tablet, in either orientation, with a notch
//     eating one edge in landscape. Hard-coded sizes fit one device and clip on
//     every other, and a clipped Declare button is a lost hand.
//
//  2. READ THE SERVER'S PLAYER RECORDS. The wire shape is fixed by the games
//     server (games-web/rummy.js): `status` is 'active' | 'won' | 'dropped' |
//     'lost' and `points` is the score. Nothing here computes either.
//
// Kept out of the component so it can be checked without a renderer — see
// rummyTable.selftest.ts.

/** One row of the server's `{t:'tables'}` frame. */
export interface TableInfo {
  id: string;
  name: string;
  /** Human string the server already formatted, e.g. "0.05/pt". */
  stakes: string;
  players: number;
  maxPlayers: number;
  status: string;
  /** 0 marks a practice table — the only kind that accepts bots. */
  pointValue?: number;
}

/** A seat in the `game.players` array. */
export interface RummyPlayer {
  id: string;
  name: string;
  handCount: number;
  points: number;
  status: 'active' | 'won' | 'dropped' | 'lost' | string;
  isTurn?: boolean;
}

/** `{t:'state'}`'s top-level `settlement`: coins won or lost, per player id. */
export type Settlement = Record<string, { delta: number } | undefined>;

/* -- screen fitting ------------------------------------------------- */

/** Playing cards are 2.5x3.5in. Anything else stops reading as a card. */
export const CARD_RATIO = 1.4;

/**
 * Below this a rank pip is unreadable at arm's length; above it a hand of
 * thirteen stops fitting on a phone at all.
 */
const CARD_MIN = 32;
/**
 * Lowered 70 → 62 → 54 across two rounds of owner feedback on real phones.
 *
 * At 70 a hand filled a 2664px table edge to edge and STILL had to overlap; at
 * 62 it fitted but only just, with the fan doing the work. At 54 the fan
 * reaches 1 on both test phones — thirteen cards, none covering another, with
 * roughly 230-260px of table left over. Bigger cards were never buying
 * legibility, because the overlap they forced was taking it straight back.
 */
const CARD_MAX = 54;

/**
 * How much width each card after the first in a group costs.
 *
 * FAN of 1 means no overlap at all; 0.58 means 42% of every card is hidden
 * behind the next. This used to be a CONSTANT 0.58, which made a wide landscape
 * table look exactly as cramped as a small one — cards buried under each other
 * with room to spare on both sides. Reported from a device photo.
 *
 * It is now the widest fan that actually fits, clamped to this range: spread
 * out when there is room, tuck in when there is not. FAN stays exported as the
 * tightest permitted value because the fitting check is written against it.
 */
export const FAN = 0.58;
const FAN_MAX = 1;

/** Padding inside a group tray, and the gap between two trays. */
const TRAY_PAD = 16;
const TRAY_GAP = 20;

/**
 * Breathing room at both ends of the hand, so the last card is never clipped.
 *
 * PROPORTIONAL, not a fixed 28px. A flat margin was enough on a 2340px table
 * and not on a 2664px one: measured on the Honor, the row still ran to the
 * screen edge and the hand rendered as twelve cards with five overlapping
 * pairs. The layout carries chrome this model does not know about — tray
 * borders, group margins — and that chrome grows with the table, so the
 * allowance has to as well. 6% is what leaves visible slack on both devices.
 */
const EDGE_FRACTION = 0.06;
const EDGE_MIN = 28;

/** 13-card Indian rummy, laid out in at most five groups (handGroups.MAX_GROUPS). */
const HAND_SIZE = 13;
const GROUPS = 5;

/** Tray padding above/below the cards plus the meld badge line under them. */
const BADGE_H = 32;
/** One row of action buttons, at the compact size. */
const ACTIONS_H = 46;
/** The turn/status pill. */
const STATUS_H = 30;
/**
 * The least felt worth drawing: two piles, the wild card and a row of seats.
 *
 * It is a FLOOR, not a reservation — on a short landscape screen (a folded
 * Galaxy, a phone in landscape with a tall gesture bar) the cards shrink to
 * respect it rather than the felt pushing the action bar off the bottom.
 */
const MIN_TABLE_H = 80;

export interface Insets { top: number; bottom: number; left: number; right: number }

export interface Metrics {
  /** Usable box after safe areas — never place a control outside it. */
  width: number;
  height: number;
  landscape: boolean;
  /** Very short screens drop the table's decorative height, not its controls. */
  compact: boolean;
  cardW: number;
  cardH: number;
  /** Negative gap that produces the fan. */
  overlap: number;
  /** Height the hand strip needs, trays and meld badge included. */
  handH: number;
  /** The felt: everything above the hand. */
  tableW: number;
  tableH: number;
  /** Piles are drawn a touch smaller than held cards so the hand stays the focus. */
  pileW: number;
}

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

/**
 * Width one full hand needs at a given card size.
 *
 * Exported because the self-check asserts the chosen size actually fits, which
 * is the whole point of choosing it.
 */
export function handWidthAt(cardW: number, fan: number = FAN): number {
  const cards = GROUPS + (HAND_SIZE - GROUPS) * fan;
  return cardW * cards + TRAY_PAD * GROUPS + TRAY_GAP * (GROUPS - 1);
}

/**
 * The widest fan a hand of this card size can use in this width.
 *
 * Solved from handWidthAt: everything except the fanned cards is fixed, so the
 * spare width divides evenly among them. Clamped to [FAN, 1] — never tighter
 * than the tuck the card size was chosen for, never wider than not overlapping.
 */
export function fanFor(cardW: number, width: number): number {
  const fixed = cardW * GROUPS + TRAY_PAD * GROUPS + TRAY_GAP * (GROUPS - 1);
  const fanned = cardW * (HAND_SIZE - GROUPS);
  if (fanned <= 0) return FAN_MAX;
  // EDGE_MARGIN, or the spread fills the width to the pixel and the last card
  // lands exactly on the screen edge — measured on device at 2664px, where the
  // thirteenth card was pushed off entirely and the hand rendered as twelve.
  // Filling the width is not the same as fitting in it.
  const margin = Math.max(EDGE_MIN, width * EDGE_FRACTION);
  return clamp(FAN, FAN_MAX, (width - fixed - margin) / fanned);
}

/**
 * Resolve every size on the table from the window and the safe-area insets.
 *
 * Both constraints bind: on a wide, short landscape screen height decides the
 * card size, and on a narrow one width does. Taking the smaller is what keeps
 * the hand on screen in both — sizing off width alone overflows the bottom of
 * a 16:9 landscape phone and puts the action bar under the gesture bar.
 */
export function metrics(win: { width: number; height: number }, insets: Insets): Metrics {
  const width = Math.max(240, win.width - insets.left - insets.right);
  const height = Math.max(240, win.height - insets.top - insets.bottom);
  const landscape = width > height;

  // The strip the hand may claim. Landscape is short, so it gets a bigger
  // share: there is no room to spend on a decorative felt, and the cards are
  // what the player is actually looking at.
  const handShare = landscape ? 0.42 : 0.30;

  const byWidth = (width - TRAY_PAD * GROUPS - TRAY_GAP * (GROUPS - 1)) / (GROUPS + (HAND_SIZE - GROUPS) * FAN);
  const byHeight = (height * handShare - BADGE_H) / CARD_RATIO;
  // The third constraint, and the one that only bites on short screens: what is
  // left after the felt's floor, the action bar and the status pill have taken
  // their share. Without it the sum overflows the safe box and the action bar
  // ends up under the system navigation, where it cannot be tapped at all.
  const byBudget = (height - MIN_TABLE_H - ACTIONS_H - STATUS_H - BADGE_H) / CARD_RATIO;
  const cardW = Math.floor(clamp(CARD_MIN, CARD_MAX, Math.min(byWidth, byHeight, byBudget)));
  const cardH = Math.round(cardW * CARD_RATIO);

  const handH = cardH + BADGE_H;
  const tableH = Math.max(MIN_TABLE_H, height - handH - ACTIONS_H - STATUS_H);
  const compact = tableH < 190;

  return {
    width,
    height,
    landscape,
    compact,
    cardW,
    cardH,
    // Derived from the fan that fits, not from a fixed 0.58 — on a wide table
    // this goes to zero and the cards stop covering each other.
    overlap: Math.round(cardW * (1 - fanFor(cardW, width))),
    handH,
    tableW: width,
    tableH,
    pileW: Math.max(CARD_MIN, Math.round(cardW * (compact ? 0.82 : 0.95))),
  };
}

export interface Spot { x: number; y: number; w: number }

/**
 * Place `n` opponents around the far edge of the table.
 *
 * An arc, not a row: the players nearest the middle sit further back, which is
 * what makes an oval read as an oval and — more usefully — is what stops five
 * seats colliding on a narrow screen, because the arc spends vertical space
 * where horizontal space has run out.
 *
 * The span (12%-88% of the width) is the reference client's, so a native table
 * seats people where a player who has seen the web one expects them.
 *
 * Seat width is DERIVED from the spacing rather than fixed: six-handed on a
 * small phone has to shrink the avatars, and overlapping names are worse than
 * small ones.
 */
export function seatSpots(n: number, tableW: number, tableH: number): Spot[] {
  if (n <= 0) return [];

  const spanL = 0.12, spanR = 0.88;
  const span = (spanR - spanL) * tableW;

  // Two constraints, and the second is the one that is easy to miss: a seat is
  // CENTRED on its point, so the outermost pair can only be as wide as twice
  // the margin outside them. Sizing off the spacing alone made the end seats
  // overhang, and clamping them back inside the felt then pushed them into
  // their neighbours — three-handed on a folded phone had two names on top of
  // each other. The 4px is breathing room between adjacent seats.
  const bySpacing = n === 1 ? tableW * 0.22 : span / (n - 1) - 4;
  const byEdge = 2 * spanL * tableW;
  const w = Math.floor(clamp(34, 92, Math.min(bySpacing, byEdge)));
  const lift = Math.min(22, tableH * 0.11);

  return Array.from({ length: n }, (_, i) => {
    const frac = n === 1 ? 0.5 : i / (n - 1);
    const cx = (spanL + frac * (spanR - spanL)) * tableW;
    return {
      // Clamped so an end seat cannot hang off the edge on a narrow screen.
      x: clamp(0, Math.max(0, tableW - w), cx - w / 2),
      y: Math.round(lift - Math.sin(frac * Math.PI) * lift),
      w: Math.round(w),
    };
  });
}

/* -- the turn clock ------------------------------------------------- */

/**
 * No rummy turn is longer than this. A "remaining" larger than it means the
 * device clock disagrees with the server's, and a wrong countdown is worse than
 * none — a player who trusts "45s" and loses the turn at 20 blames the app.
 */
const MAX_TURN_SECONDS = 180;

/**
 * Seconds left on the current turn, or null when there is nothing trustworthy
 * to show.
 *
 * `deadline` is server epoch-ms and `now` is the device's, so this is only as
 * good as the phone's clock. That is the same bet the reference client makes;
 * the difference is that this one declines to display a number it can tell is
 * nonsense rather than counting down from twenty minutes.
 */
export function secondsLeft(deadline: unknown, now: number): number | null {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return null;
  const left = (deadline - now) / 1000;
  if (left > MAX_TURN_SECONDS) return null;
  return Math.max(0, Math.round(left));
}

/* -- reading the table ---------------------------------------------- */

/**
 * Final standing for the round.
 *
 * Points rummy scores DOWN: the winner takes 0 and everyone else carries their
 * deadwood, so the ranking is ascending. The declared winner is pinned first
 * regardless, because the server's word on who won outranks arithmetic on
 * points that may tie.
 */
export function ranked(players: RummyPlayer[], winnerId?: string | null): RummyPlayer[] {
  return players.slice().sort((a, b) => {
    if (winnerId) {
      if (a.id === winnerId && b.id !== winnerId) return -1;
      if (b.id === winnerId && a.id !== winnerId) return 1;
    }
    // A player who dropped or lost ranks below one still holding a hand at the
    // same score, so the order does not flicker as points tie.
    const rank = (p: RummyPlayer) => (p.status === 'won' ? 0 : p.status === 'active' ? 1 : 2);
    return rank(a) - rank(b) || (a.points ?? 0) - (b.points ?? 0);
  });
}

/** Everyone still holding cards. Used for "3 players left". */
export function activeCount(players: RummyPlayer[]): number {
  return players.filter(p => p.status === 'active' || p.status === 'won').length;
}

/** A player id, whichever key this server frame used for it. */
export function pid(p: { id?: string; vaultId?: string }): string {
  return p.id ?? p.vaultId ?? '';
}

/**
 * Only practice tables accept bots.
 *
 * The reference client hides "+ Add bot" unless `pointValue === 0`, because a
 * staked table seating a bot would be putting the house in the pot. The native
 * board offered it everywhere and the server refused, which read as a bug.
 */
export function allowsBots(table: { pointValue?: number } | null | undefined): boolean {
  return !!table && table.pointValue === 0;
}

/** A shareable code for a table nobody has to be told about in person. */
export function newPrivateCode(rand: () => number = Math.random): string {
  // Ambiguous glyphs left out: this gets read aloud and typed by hand.
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += A[Math.floor(rand() * A.length)];
  return out;
}

/**
 * The room code a player typed, reduced to something the server will accept.
 *
 * The same character class the invite links and the backend's notification
 * slugs use — a code with a slash or a `?` in it would rewrite the deep link
 * rather than fill it in.
 */
export function normalizeCode(raw: string): string {
  const s = raw.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return s;
}
