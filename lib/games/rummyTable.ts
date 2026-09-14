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
export const CARD_MIN = 32;
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
 * A tablet gets bigger cards, and the reason is not "there is room".
 *
 * 54 was chosen against a PHONE held at arm's length. A tablet in landscape is
 * held further away and is physically larger, so the same 54dp card subtends a
 * smaller angle at the eye — the card that was comfortable on a Redmi is the
 * smallest thing on an iPad. Designed in Figma at 1024x768 before it was
 * written: the fan absorbs the extra width (0.79 rather than 1.0), so the hand
 * still fits with room to spare.
 *
 * Stepped rather than continuous ON PURPOSE. A `width * 0.07` ramp would change
 * the card size on every phone too, invalidating the two devices this layout is
 * actually proven on, to buy nothing — no phone is 900dp wide in landscape.
 */
const CARD_MAX_LARGE = 72;
const LARGE_SCREEN = 900;

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

/**
 * The fan we SIZE the cards to reach, rather than the tightest one we tolerate.
 *
 * This file already argues for it, in the note above CARD_MAX: "bigger cards
 * were never buying legibility, because the overlap they forced was taking it
 * straight back." Sizing the cards as large as the width allows and letting the
 * fan collapse to FAN does exactly that — once the score panel moved into the
 * band, every viewport that showed it sat at the 0.58 floor with 42% of every
 * card buried, which is the most crowded the hand has ever been.
 *
 * So the card is sized to leave room for a 15% tuck instead. It is the same
 * width spent differently, and it is a better trade on the number that actually
 * matters — the strip of each card you can SEE. At the 844dp reference:
 *
 *     50dp card at 0.58 fan -> 29.0dp visible per tucked card
 *     37dp card at 0.88 fan -> 32.5dp visible per tucked card
 *
 * ...and the top-left index, which is the whole of what you read a fanned hand
 * by, sits in that strip. CARD_MIN still wins if honouring this would push the
 * cards under it: an unreadable card spread out is worse than a readable one
 * tucked in.
 */
const FAN_COMFORT = 0.85;

/**
 * The chrome around the cards, in the same units the layout uses.
 *
 * These MUST match components/games/Rummy.tsx. They did not: the gap between
 * trays was modelled as 20 where the ScrollView uses S[3] = 12, the 1px tray
 * border on each side was not counted at all, and neither was the scroll
 * content's own S[1] padding at each end. A model that describes a layout other
 * than the one that renders reports a fit that does not happen.
 */
const TRAY_PAD = 16;        // GroupZone paddingHorizontal: S[2] on both sides
const TRAY_BORDER = 2;      // GroupZone borderWidth: 1 on both sides
const TRAY_GAP = 12;        // hand ScrollView contentContainerStyle gap: S[3]
const HAND_PAD = 8;         // ...and its paddingHorizontal: S[1] on both ends

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

/**
 * The pile row's parts, in the units Rummy.tsx lays them out in.
 *
 * Same contract as TRAY_PAD/TRAY_GAP above, and for the same reason: these MUST
 * match the renderer. The gaps are the row's `gap: S[4]` / `S[3]`; the label
 * floors are the width of a DeckLabel plate, which is `paddingHorizontal: S[2]`
 * on both sides around 9.5dp text at 0.8 letter-spacing — 11 characters of
 * "CLOSED DECK", 6 of "CLOSED".
 */
const PILE_GAP = 16, PILE_GAP_COMPACT = 12;
const PILE_LABEL_FULL = 92, PILE_LABEL_SHORT = 58;

/** One row of action buttons, at the compact size. */
const ACTIONS_H = 46;

/**
 * What the action bar can afford, in priority order.
 *
 * FOUND ON THE DEVICE, not in the model: sweeping the Honor at 666dp the bar
 * ran 680dp of controls into a 666dp screen and pushed DROP clean off the
 * right-hand edge. That is the exact failure this file's own header warns
 * about — a decision the player cannot reach is a hand they cannot finish —
 * and no height budget catches it, because the bar overflows sideways.
 *
 * So the bar is now budgeted. Six controls NEVER drop: Sort, Group, Ungroup,
 * Discard, Declare, Drop. Everything else earns its place only if the width is
 * there, cheapest-to-lose first: the deadwood toggle is a convenience and goes
 * before the score readout, and the readout itself degrades to a single button
 * before it disappears — Standings must stay reachable at every width.
 */
const BAR_BTN = 62;
const BAR_GAP = 4;
const BAR_PAD = 16;
/** Narrowest a mandatory control may shrink to before the row would overflow. */
const BAR_BTN_MIN = 40;
/** The compact Standings button, and the full three-cell readout. */
const BAR_TRIO = 190 + BAR_GAP;
/** The SHOW DEADWOOD toggle. */
const BAR_TOGGLE = 118 + BAR_GAP;
/**
 * The least felt worth drawing: two piles, the wild card and a row of seats.
 *
 * It is a FLOOR, not a reservation — on a short landscape screen (a folded
 * Galaxy, a phone in landscape with a tall gesture bar) the cards shrink to
 * respect it rather than the felt pushing the action bar off the bottom.
 */
const MIN_TABLE_H = 80;

/**
 * The header band. It DOES come out of the height budget now.
 *
 * It used to be drawn over the felt to cost nothing, which is the right trade
 * when the header is three small buttons. It is no longer: the wordmark, the
 * Practice/Free/Bots tabs and the Talk/rules/settings controls are a real bar,
 * and overlapping the cloth with them made the top of the oval unusable for
 * seats anyway. Paying 34dp buys back the whole top arc.
 */
const HEADER_H = 34;

/**
 * The hand band is a TRAY, not a row of cards.
 *
 * Each group carries its name above the cards ("SEQUENCE", "SET") and what it
 * scores below, so the band is taller than the cards by a fixed amount. Naming
 * the group above it is what lets a player scan the hand without decoding the
 * cards — the badge underneath alone never did that.
 */
const TRAY_LABEL_H = 12;
const TRAY_PTS_H = 16;
const TRAY_PAD_V = 10;
const BAND_EXTRA = TRAY_LABEL_H + TRAY_PTS_H + TRAY_PAD_V;

/**
 * The score panel sits INSIDE the hand band, beside the trays.
 *
 * That is where a landscape screen has room for it, and it is why the status
 * strip could be given up: with meld, deadwood and score always visible at
 * full size, the one-line pill was repeating what the panel already said.
 *
 * It leaves the band on a narrow screen and returns to the action bar as the
 * compact trio, because the width it takes comes straight out of the cards —
 * measured, a 640dp screen drops from a 51dp card to 33dp if the panel stays.
 * Legible cards outrank a big score readout.
 */
// STACKED, so it is narrow. Three side-by-side cells wanted ~200dp of an 819dp
// screen, and that width came straight out of the hand: the cards ended up at
// the 0.58 fan floor with 42% of every one buried. Three ROWS say the same
// three numbers in 130dp and give the difference back to the fan.
const SCORE_MIN_W = 110;
const SCORE_MAX_W = 190;
// 0.26 -> 0.24. The panel's width comes straight out of the cards, and at 0.26
// the Honor's real 732dp viewport left a 39dp card — barely over the CARD_MIN
// floor, on the one device this layout can actually be checked on. 0.24 buys
// back 3dp there and 3dp at the reference size, and costs the panel nothing it
// needs: at every width it still clears SCORE_MIN_W comfortably.
const SCORE_SHARE = 0.16;

/**
 * The smallest card the wide layout is allowed to leave behind.
 *
 * THE LAYOUT SWITCH IS NOT A WIDTH. It was: first 700 for the score panel and
 * 760 for the gutters (whose gap the Honor fell straight into), then a single
 * 700 — and a width threshold cannot see what it costs. Sweeping the real
 * device showed the bill: at 699dp the hand gets a 53dp card, at 700dp the
 * panel takes its share and the same hand gets 39dp. A one-pixel change in
 * viewport dropping the cards by a quarter is not a responsive layout, it is a
 * cliff, and no number written here would have found it — the sweep did.
 *
 * So the panel appears only when it leaves a card at least this big. The rule
 * states the thing actually being protected (cards you can read) instead of
 * encoding a guess about which devices are wide enough, and it re-decides
 * itself on any screen rather than needing a new constant per device.
 */
export const CARD_COMFORT = 34;

/**
 * How much width the oval gives up so the side panels have somewhere to live.
 * Below WIDE_LAYOUT_MIN_W it gives up nothing and takes the whole width.
 */
const OVAL_SHARE = 0.68;
/** Clearance between the oval and the top/bottom of its band. */
const OVAL_INSET = 8;

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
  /**
   * The pile row's OWN width — closed deck, open deck and wild, side by side.
   *
   * The row renders `left:0 right:0 justifyContent:'center'`, so its real width
   * was whatever its contents happened to measure, which nothing outside the
   * renderer could know. `pileTop` has to know: it can only avoid the seats
   * that are actually over the piles if it knows where the piles START and END.
   *
   * So the row is given this width explicitly and centred inside it. A column
   * is a card with a label plate above it, and the PLATE is the wider of the
   * two — "CLOSED DECK" at 9.5dp/800/0.8 tracking is about 74dp of glyphs plus
   * its 8dp padding on each side. Sized for the plate, floored so the label is
   * never the thing that overflows.
   */
  pileColW: number;
  pileRowW: number;
  /** The header bar. Costs height — see HEADER_H. */
  headerH: number;
  /** Score panel width inside the band; 0 when it falls back to the action bar. */
  scoreW: number;
  /** Width the group trays may use, after the score panel has taken its share. */
  trayW: number;
  /** The drawn oval, which is narrower than the felt when side panels fit. */
  ovalW: number;
  ovalX: number;
  ovalY: number;
  ovalH: number;
  /** Whether the table panel and the emote feed have gutters to live in. */
  sidePanels: boolean;
  /** The action bar's optional controls, in the order they are given up. */
  barTrio: boolean;
  barStandings: boolean;
  barToggle: boolean;
  /** Width of one mandatory control; shrinks before the row may overflow. */
  barBtnW: number;
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
  return cardW * cards + handChromeWidth();
}

/** Everything in the hand strip that is not a card. */
function handChromeWidth(): number {
  return (TRAY_PAD + TRAY_BORDER) * GROUPS + TRAY_GAP * (GROUPS - 1) + HAND_PAD;
}

/**
 * The widest fan a hand of this card size can use in this width.
 *
 * Solved from handWidthAt: everything except the fanned cards is fixed, so the
 * spare width divides evenly among them. Clamped to [FAN, 1] — never tighter
 * than the tuck the card size was chosen for, never wider than not overlapping.
 */
export function fanFor(cardW: number, width: number): number {
  const fixed = cardW * GROUPS + handChromeWidth();
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

  const byHeight = (height * handShare - BAND_EXTRA) / CARD_RATIO;
  // The third constraint, and the one that only bites on short screens: what is
  // left after the felt's floor, the header and the action bar have taken their
  // share. Without it the sum overflows the safe box and the action bar ends up
  // under the system navigation, where it cannot be tapped at all.
  const byBudget = (height - MIN_TABLE_H - HEADER_H - ACTIONS_H - BAND_EXTRA) / CARD_RATIO;
  const cardMax = width >= LARGE_SCREEN ? CARD_MAX_LARGE : CARD_MAX;

  // Price the wide layout before choosing it. The score panel takes its width
  // off the top, so the cards are sized against what is LEFT — and if what is
  // left is not a card worth reading, the panel does not get to be there.
  const fit = (avail: number) => {
    // Sized so the hand can spread to FAN_COMFORT, not so it merely fits at the
    // tightest tuck the layout tolerates. The edge margin is the same one
    // fanFor keeps, so the two agree about how much room there really is.
    const margin = Math.max(EDGE_MIN, avail * EDGE_FRACTION);
    const byComfort = (avail - margin - handChromeWidth())
      / (GROUPS + (HAND_SIZE - GROUPS) * FAN_COMFORT);
    // ...but never below the floor: a card you cannot read, spread out, is
    // worse than one you can read with a corner covered.
    const byFit = (avail - handChromeWidth()) / (GROUPS + (HAND_SIZE - GROUPS) * FAN);
    return Math.floor(clamp(CARD_MIN, cardMax,
      Math.min(Math.max(byComfort, CARD_MIN), byFit, byHeight, byBudget)));
  };

  const scoreTry = Math.round(clamp(SCORE_MIN_W, SCORE_MAX_W, width * SCORE_SHARE));
  const wide = fit(width - scoreTry - TRAY_GAP) >= CARD_COMFORT;

  const scoreW = wide ? scoreTry : 0;
  const trayW = width - (scoreW ? scoreW + TRAY_GAP : 0);
  const cardW = fit(trayW);
  const cardH = Math.round(cardW * CARD_RATIO);

  const handH = cardH + BAND_EXTRA;
  const tableH = Math.max(MIN_TABLE_H, height - HEADER_H - handH - ACTIONS_H);
  const compact = tableH < 190;

  // The gutters and the score panel are ONE decision, so there is no width at
  // which you get half the design.
  const sidePanels = wide;
  const ovalW = sidePanels ? Math.round(width * OVAL_SHARE) : width;
  const ovalH = Math.max(40, tableH - OVAL_INSET * 2);

  // The bar's budget. The six mandatory controls SHRINK before anything is
  // allowed to overflow — a narrow bar gets narrow buttons, never a missing
  // Drop. Everything optional is then bought out of what is left.
  const barBtnW = Math.floor(clamp(BAR_BTN_MIN, BAR_BTN, (width - BAR_PAD - 5 * BAR_GAP) / 6));
  const barMust = 6 * barBtnW + 5 * BAR_GAP + BAR_PAD;
  // `scoreW > 0` means the readout already lives in the band, so the bar
  // neither needs nor shows it.
  const barTrio = scoreW === 0 && width >= barMust + BAR_TRIO;
  const barStandings = scoreW === 0 && !barTrio && width >= barMust + barBtnW + BAR_GAP;
  const readout = barTrio ? BAR_TRIO : barStandings ? barBtnW + BAR_GAP : 0;
  const barToggle = width >= barMust + readout + BAR_TOGGLE;

  const pileW = Math.max(CARD_MIN, Math.round(cardW * (compact ? 0.82 : 0.95)));
  // The column is as wide as the wider of its two parts: the card, or the label
  // plate over it. `compact` shortens the labels ("CLOSED" rather than "CLOSED
  // DECK"), so the floor drops with them.
  const pileColW = Math.max(pileW, compact ? PILE_LABEL_SHORT : PILE_LABEL_FULL);

  return {
    width,
    height,
    landscape,
    compact,
    cardW,
    cardH,
    // Derived from the fan that fits, not from a fixed 0.58 — on a wide table
    // this goes to zero and the cards stop covering each other.
    //
    // CEIL, NOT ROUND, and it is a fit bug rather than a taste one. The overlap
    // that RENDERS is a whole number of pixels; rounding DOWN makes the real
    // tuck looser than the fan the fit was calculated from, so the hand comes
    // out wider than handWidthAt() promised. Found by building the layout at
    // 640x360 in Figma: the model said 637.6 of 640 and the render measured
    // 641 — a hand that scrolls by one pixel on the smallest supported screen,
    // which no assertion written against the unrounded fan could ever catch.
    // Ceil can only ever tuck tighter than the model, never looser.
    // AGAINST trayW, NOT width. The fan is "how far can these cards spread in
    // the room they have", and once the score panel moved into the band the
    // room stopped being the screen. Measured against `width` the hand thought
    // it had the whole viewport, chose a fan of ~1 — cards barely touching —
    // and ran 135-177dp past the trays on EVERY size that shows the panel.
    //
    // The cards were already SIZED off trayW (`fit(trayW)` above); only the fan
    // was still reading the old number, which is exactly the shape of bug this
    // file keeps catching: two places that must agree, and one of them moved.
    overlap: Math.ceil(cardW * (1 - fanFor(cardW, trayW))),
    handH,
    tableW: width,
    tableH,
    pileW,
    pileColW,
    pileRowW: 3 * pileColW + 2 * (compact ? PILE_GAP_COMPACT : PILE_GAP),
    headerH: HEADER_H,
    scoreW,
    trayW,
    ovalW,
    ovalX: Math.round((width - ovalW) / 2),
    ovalY: OVAL_INSET,
    ovalH,
    sidePanels,
    barTrio,
    barStandings,
    barToggle,
    barBtnW,
  };
}

/**
 * Width the action bar actually needs, for the check that it fits.
 *
 * Exported so the self-check can assert the thing that broke rather than
 * re-deriving it: six mandatory controls, plus whatever the budget allowed.
 */
export function actionBarWidth(m: Metrics): number {
  return 6 * m.barBtnW + 5 * BAR_GAP + BAR_PAD
    + (m.barTrio ? BAR_TRIO : m.barStandings ? m.barBtnW + BAR_GAP : 0)
    + (m.barToggle ? BAR_TOGGLE : 0);
}

export interface Spot { x: number; y: number; w: number; h: number }

/**
 * THE SEAT IS A COLUMN, NOT A ROW — and that is the fix for four separate bugs.
 *
 * It used to be a wide capsule laid out left-to-right: avatar, then the name
 * beside it, then a status dot, with two more rows tucked underneath. Measured
 * on real viewports, that shape could not hold its own contents:
 *
 *   - The name got `w - 57` after the avatar, the gap and the dot had taken
 *     their share — 22dp on a 732dp-wide table. "Arjun" rendered as "Arj".
 *   - The rows under it were indented past the avatar, leaving 29-41dp for a
 *     string like "13 cards · 40", so an opponent's POINTS were ellipsised away
 *     on every phone — on a staked table, the one number you want.
 *   - Three rows need about 72dp and the capsule was capped at 58, so the card
 *     backs painted BELOW the rounded border, on bare felt, outside the gold
 *     turn ring. The three-row branch fired on every landscape phone.
 *   - And the capsule was wide enough (0.16 of the felt) to reach into the
 *     middle of the table, where the piles are.
 *
 * Turning it upright fixes all four at once, because a column spends its width
 * on ONE thing. The name now gets the full capsule (56-84dp, roughly double),
 * the card count moves onto the avatar as a badge instead of claiming a third
 * row, and the capsule is narrower — which buys back both the arc spacing
 * between seats (31-46dp, up from 24-33) and the clearance from the piles.
 *
 * It is also simply what a rummy table looks like: every client in the category
 * seats a player as a portrait chip, because that is how a person reads as
 * sitting somewhere rather than as a row in a scoreboard.
 */
const SEAT_W_MIN = 68, SEAT_W_MAX = 132;
const SEAT_H_MIN = 50, SEAT_H_MAX = 88;
/**
 * A share of the felt, and it is the binding constraint at every real size —
 * the side-by-side packing bound below never is. Lowered 0.16 → 0.145 with the
 * column layout: the capsule needs less width and the arc wants more air.
 */
const SEAT_W_SHARE = 0.145;
/**
 * Of the band under the header. The column is taller than the old row, but it
 * cannot take whatever it likes: the piles have to live under the arc, and on a
 * 320dp-tall phone held sideways the oval is 141dp and the pile stack alone is
 * 77 of them. 0.42 fitted every viewport except that one, where the top-centre
 * seat — the one that is unavoidably over the piles — ended 8dp into them.
 */
const SEAT_H_SHARE = 0.36;
/** Least gap between two capsules when width, not the arc, is the constraint. */
const SEAT_GAP = 8;
/** Keeps the outermost capsules off the brass rail. */
const SEAT_EDGE = 6;

/**
 * Everything in the seat that is NOT the avatar, in the order it stacks.
 *
 * Written down as numbers, and the reason is the bug above: the old seat sized
 * its avatar with `Math.min(28, h - 20)`, budgeting 20dp for two rows that
 * actually cost 30 — and it measured those rows by their FONT SIZE, which is
 * not their height. A 9.5dp font occupies about 12dp of line box. Every one of
 * those estimates was short, and they were short in the same direction, so the
 * capsule overflowed at every size.
 *
 * These are line boxes, not font sizes, and Rummy.tsx sets `lineHeight` to
 * exactly these values so the two cannot drift. The avatar is then whatever is
 * left over, which makes "the contents fit" arithmetic rather than a hope.
 */
const SEAT_PAD = 5;
export const SEAT_NAME_LINE = 14;   // fontSize 11.5
export const SEAT_DETAIL_LINE = 12; // fontSize 9.5
const SEAT_GAP_AV = 3;              // avatar → name
const SEAT_GAP_NAME = 2;            // name → detail
/** Avatar and name — the two things a seat cannot do without. */
export const SEAT_CHROME_BASE = SEAT_PAD * 2 + SEAT_GAP_AV + SEAT_NAME_LINE;
/** ...and the line under the name, where there is room for it. */
export const SEAT_CHROME_H = SEAT_CHROME_BASE + SEAT_GAP_NAME + SEAT_DETAIL_LINE;
const SEAT_AV_MIN = 22, SEAT_AV_MAX = 36;

/**
 * Whether the line under the name fits — points, or "dropped", or the clock.
 *
 * The smallest screen in the support matrix (320x568, held sideways) leaves a
 * 141dp oval, and the piles want 77 of it. There is no seat height that carries
 * an avatar, a name AND a detail line and still leaves the stack somewhere to
 * go. Something has to be dropped, and it is the third line: a seat that says
 * who is there is worth more than one that says how they are doing but is
 * painted through the closed deck.
 *
 * Everywhere else — every other device in the matrix, portrait or landscape —
 * this is true and the seat is the full three lines.
 */
export function seatHasDetail(h: number): boolean {
  return h >= SEAT_CHROME_H + SEAT_AV_MIN;
}

/**
 * How big the avatar may be in a capsule this tall — the leftovers, clamped.
 *
 * Exported so the renderer and the self-check read ONE budget. The old code
 * kept its avatar sum in Rummy.tsx and its height cap in this file, which is
 * why they disagreed by a whole row for as long as they did.
 *
 * SEAT_H_MIN is deliberately above `SEAT_CHROME_H + SEAT_AV_MIN`, so the clamp
 * is a taste limit and never a fit one.
 */
export function seatAvatar(h: number): number {
  const chrome = seatHasDetail(h) ? SEAT_CHROME_H : SEAT_CHROME_BASE;
  return Math.round(clamp(SEAT_AV_MIN, SEAT_AV_MAX, h - chrome));
}

/**
 * Seat `n` opponents AROUND the oval — not in a row along the top of it.
 *
 * This used to be a shallow arc across the far edge: every opponent lived in
 * the top strip of the felt and the sides of the table were empty. That reads
 * as a scoreboard above a table rather than as people sitting at one, and it
 * wasted the only space a landscape screen has to spare.
 *
 * A capsule's CENTRE now rides an ellipse inscribed in the felt, with the local
 * player holding the bottom of it (their hand is the near edge of the table),
 * so opponents fill the remaining arc: one at the far side, the rest fanning
 * down the left and right. Six-handed that is the layout every rummy client
 * uses, and the shape is the reason it survives a tablet — on a 584dp-tall felt
 * the seats spread down the sides instead of huddling along one edge.
 *
 * DISTRIBUTED BY X, NOT BY ANGLE, and that is load-bearing. Equal angular steps
 * bunch points near the left and right extremes of a wide, short ellipse, which
 * is exactly the shape a landscape felt is: five seats at equal angles on an
 * 844x176 band put two capsules 60dp apart and overlapping. Equal steps in x
 * with y read off the ellipse gives the same visual arc and makes separation a
 * property of the arithmetic — adjacent centres are always `2·rx/(n-1)` apart.
 *
 * `top` is the header band. A capsule that starts at y=0 sits under the
 * settings button; passing `metrics().headerH` is what keeps the two apart.
 *
 * FLOOR: the ring is collision-free for `tableW >= 372`. Below that the width
 * clamp pins capsules to SEAT_W_MIN faster than the spacing shrinks and they
 * begin to touch — a portrait-phone width, and rummy plays landscape-only.
 */
export function seatSpots(n: number, tableW: number, tableH: number, top = 0): Spot[] {
  if (n <= 0) return [];

  // Never wider than a share of the felt, and never so wide that n of them
  // could not stand side by side with a gap between.
  const w = Math.floor(clamp(
    SEAT_W_MIN, SEAT_W_MAX,
    Math.min(tableW * SEAT_W_SHARE, (tableW - SEAT_GAP * (n - 1)) / n),
  ));
  const band = Math.max(1, tableH - top);
  const h = Math.round(clamp(SEAT_H_MIN, SEAT_H_MAX, band * SEAT_H_SHARE));

  // The ellipse the CENTRES ride. Both radii are shrunk by half a capsule so a
  // seat placed at an extreme lands flush inside the felt rather than centred
  // on its edge with half of itself outside.
  const rx = Math.max(0, (tableW - w) / 2 - SEAT_EDGE);
  const ry = Math.max(0, (band - h) / 2);

  return Array.from({ length: n }, (_, i) => {
    // -1 at the player's left hand, +1 at their right, 0 straight across.
    const u = n === 1 ? 0 : -1 + (2 * i) / (n - 1);
    return {
      x: Math.round(tableW / 2 + u * rx - w / 2),
      // The ellipse's top arc: 0 at the far side, ry at the extremes.
      y: Math.round(top + ry * (1 - Math.sqrt(Math.max(0, 1 - u * u)))),
      w,
      h,
    };
  });
}

/**
 * Where the closed deck, the open pile and the wild card sit on the felt.
 *
 * Centre them, but never under a seat, and never off the bottom. On a phone the
 * seat clearance wins and they sit low; on a tablet the centring wins and they
 * land in the middle of the oval, rather than in the near rail with 240dp of
 * empty cloth above them.
 *
 * CLEARANCE IS MEASURED FROM THE SEATS THAT ARE ACTUALLY IN THE WAY.
 *
 * This used to be `headerH + seatH + 8` — the top of the ring plus one capsule,
 * as if every seat began at `top`. Only ONE does. The ring is an arc, so with
 * five opponents the seats at u = ±0.5 hang 9-10dp lower than the one at the
 * far side, and that is exactly where they ended up: below the line this
 * function had just declared clear. Measured at 844x390, seat 1's bottom edge
 * was 73 and the piles started at 72, and once the capsule's own overflow was
 * counted the real intrusion was 16dp. Horizontally the CLOSED DECK plate and
 * the WILD column ran straight under those two capsules, and since the piles
 * are painted after the seats, the labels came out on top of them.
 *
 * Two corrections, both of them "look at what is there rather than assume":
 *
 *   1. Take the LOWEST bottom edge among the seats, not the first seat's
 *      height. `spots` is already computed by the caller; it costs a max().
 *   2. Only count seats whose x-range meets the pile row's. The seats at the
 *      extremes of the arc hang lowest of all, and they are also the furthest
 *      from the middle of the table — clearing the piles past them would push
 *      the stack off the bottom of the felt to avoid a collision that cannot
 *      happen. `rowW` is why this takes the row's width rather than guessing:
 *      the caller gives the row an explicit width (metrics().pileRowW) so the
 *      range tested here is the range that renders.
 */
export function pileTop(
  tableW: number, tableH: number,
  spots: readonly Spot[], rowW: number, stackH: number,
): number {
  const x0 = (tableW - rowW) / 2;
  const x1 = x0 + rowW;
  const inTheWay = spots.filter(sp => sp.x < x1 && sp.x + sp.w > x0);
  const lo = (inTheWay.length ? Math.max(...inTheWay.map(sp => sp.y + sp.h)) : 0) + 8;
  const hi = tableH - 2 - stackH;
  // No room under the seats at all: the bottom is the least bad answer, and a
  // negative top would push the piles off the felt entirely. The 8dp above is
  // breathing room, not clearance — losing some of it costs air, not overlap.
  if (hi <= lo) return Math.max(0, hi);
  return Math.round(clamp(lo, hi, (tableH - stackH) / 2));
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

/** How the hub asked us to be seated, when it did not name a table. */
export type SeatIntent = 'auto' | 'bot';

/**
 * Pick a REAL table to sit at.
 *
 * WHY THIS EXISTS — the bug it fixes, stated plainly.
 *
 * Rummy tables are OWNED BY THE SERVER. Unlike the other three games, whose
 * rooms are created on demand from whatever id you send, rummy only knows the
 * tables it published in `{t:'tables'}` (ids like `practice`). Sending any other
 * id is not an error: the server silently seats you at one of its own instead.
 *
 * So every id the app invented or imported was a dead end, and it broke BOTH
 * ways of playing a human:
 *   - "Play online" passed the MATCHMAKER's roomId, which is a /live/ws room id
 *     and never a rummy table.
 *   - "Private room" passed a freshly minted code like `2YR7QG`.
 * Two players sharing either one were substituted independently and each landed
 * alone reading "1/6 seated" — which is exactly "online and private both do not
 * connect". Proven on two phones: joining `practice` from the real table card
 * seats BOTH at one table, "2/6 seated".
 *
 * The cure is to stop inventing ids and choose from the list the server sent.
 *
 * `bot`  — the practice table: `pointValue === 0` is the only kind that accepts
 *          `addbot` (a staked table seating a bot would put the house in the pot).
 * `auto` — where the humans already are: the fullest table that is not full.
 *          Falling back to any open table, then to the practice table, so this
 *          never returns null while a single seat exists anywhere.
 */
export function pickTable(
  tables: readonly TableInfo[] | null | undefined, intent: SeatIntent,
): TableInfo | null {
  const open = (tables ?? []).filter(t => t && t.players < t.maxPlayers);
  if (!open.length) return null;

  const practice = open.find(t => t.pointValue === 0) ?? null;
  if (intent === 'bot') return practice;

  // Most-seated first so two people choosing "online" a minute apart land
  // together instead of opening two empty tables side by side. A stable
  // tiebreak keeps the choice deterministic across devices.
  const seatedFirst = [...open].sort((a, b) =>
    b.players - a.players || a.id.localeCompare(b.id));
  return seatedFirst.find(t => t.players > 0) ?? seatedFirst[0] ?? practice;
}

/* -- what KIND of table this is ------------------------------------- */

/**
 * Practice or staked — and `unknown`, which is the whole reason this is a
 * function rather than a comparison at each call site.
 *
 * `pointValue` is documented on `lobby.table` (GAMES_PROTOCOL.md), NOT on the
 * `{t:'tables'}` rows, which the doc lists as `{id,name,stakes,players,
 * maxPlayers,status}`. The server does appear to send it on the list too —
 * `pickTable` has relied on it for the bot path since it was written, and that
 * path works on two phones — but "appears to" is not a promise, and a filter
 * built on an undocumented field must degrade rather than lie.
 *
 * So a table whose point value is missing is `unknown`, and an unknown table
 * appears under EVERY filter. Excluding it would hide a real, joinable table on
 * evidence we do not have, which reads to a player as "there are no tables".
 */
export type TableKind = 'practice' | 'stakes' | 'unknown';

export function tableKind(t: { pointValue?: number } | null | undefined): TableKind {
  if (!t || typeof t.pointValue !== 'number' || !Number.isFinite(t.pointValue)) return 'unknown';
  return t.pointValue === 0 ? 'practice' : 'stakes';
}

/**
 * Which kind of game a player is looking for.
 *
 * `bots` lists the SAME tables as `practice` and that is correct rather than a
 * duplicate: only a practice table accepts `addbot` (a staked table seating a
 * bot would put the house in the pot, so the server refuses). The two differ in
 * what JOINING does — from the bots tab the client seats you and asks for a bot
 * straight away, so the difference is behaviour, not the list.
 */
export type KindFilter = 'all' | 'practice' | 'stakes' | 'bots';

export function filterByKind(tables: readonly TableInfo[], mode: KindFilter): TableInfo[] {
  const list = tables ?? [];
  if (mode === 'all') return [...list];
  return list.filter(t => {
    const k = tableKind(t);
    // Unknown survives every filter — see tableKind.
    if (k === 'unknown') return true;
    return mode === 'stakes' ? k === 'stakes' : k === 'practice';
  });
}

/** Which table sizes a player wants to see. */
export type SeatFilter = 'all' | 'heads-up' | 'multi';

/**
 * Narrow the table list to head-to-head or multi-player tables.
 *
 * The server has always sent `maxPlayers` on every entry of `{t:'tables'}` and
 * the app has always rendered it as text ("2/6 seated") with no way to filter
 * on it — so a player who wants a head-to-head game reads every card looking
 * for one. This is the whole of that feature: the data was already in hand.
 *
 * MULTI IS `> 2`, NOT `=== 6`. The protocol documents a 2–6 seat range, so
 * pinning it to 6 would silently hide every 3-, 4- and 5-seat table and look
 * exactly like "there are no tables open".
 *
 * Order is the server's and is preserved — it lists tables in the order it
 * wants them shown, and re-sorting here would fight that for no reason.
 */
export function filterBySeats(tables: readonly TableInfo[], mode: SeatFilter): TableInfo[] {
  const list = tables ?? [];
  if (mode === 'all') return [...list];
  return list.filter(t =>
    mode === 'heads-up' ? t.maxPlayers === 2 : t.maxPlayers > 2);
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
