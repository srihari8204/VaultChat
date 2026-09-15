// lib/games/rummyTable.selftest.ts — run: npx tsx lib/games/rummyTable.selftest.ts
//
// The invariants that matter are the ones a screenshot on one device cannot
// prove: that thirteen cards, six seats and the action bar all fit on EVERY
// screen the app ships to, in both orientations, with a notch taking a bite out
// of one edge. A layout bug here is not cosmetic — a Declare button under the
// gesture bar is a hand the player cannot finish.

import { readFileSync } from 'fs';
import { join } from 'path';
import { fanFor,
  metrics, seatSpots, pileTop, actionBarWidth, seatAvatar, seatHasDetail, SEAT_CHROME_H, SEAT_CHROME_BASE, handWidthAt, secondsLeft, ranked, activeCount,
  allowsBots, newPrivateCode, normalizeCode, CARD_RATIO, CARD_MIN, CARD_COMFORT, filterBySeats, pickTable,
  tableKind, filterByKind,
  type RummyPlayer, type TableInfo,
} from './rummyTable';

let failures = 0;
/**
 * Landscape table sizes to sweep the seat ring and the piles across.
 *
 * Real phones and tablets held sideways, plus the two the device reports have
 * pinned over the years (732x369 "Honor", 820x369). Rummy plays landscape-only,
 * so these are the widths that matter.
 */
const VIEWPORTS: [number, number][] = [
  [568, 320], [640, 360], [732, 369], [800, 360], [820, 369],
  [844, 390], [914, 412], [1024, 768], [2264, 1080],
];
const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

/** Real devices, not round numbers. Portrait dimensions; landscape is swapped. */
const DEVICES: { name: string; w: number; h: number; insets: { top: number; bottom: number; left: number; right: number } }[] = [
  { name: 'iPhone SE (small)',      w: 320, h: 568, insets: { top: 20, bottom: 0,  left: 0, right: 0 } },
  { name: 'Pixel 4a',               w: 393, h: 851, insets: { top: 24, bottom: 24, left: 0, right: 0 } },
  { name: 'iPhone 15 Pro (notch)',  w: 393, h: 852, insets: { top: 59, bottom: 34, left: 0, right: 0 } },
  { name: 'iPhone 15 Pro Max',      w: 430, h: 932, insets: { top: 59, bottom: 34, left: 0, right: 0 } },
  { name: 'Galaxy Fold (closed)',   w: 280, h: 653, insets: { top: 24, bottom: 24, left: 0, right: 0 } },
  { name: 'Galaxy Fold (open)',     w: 673, h: 841, insets: { top: 24, bottom: 24, left: 0, right: 0 } },
  { name: 'iPad Pro 11"',           w: 834, h: 1194, insets: { top: 24, bottom: 20, left: 0, right: 0 } },
  { name: 'iPad Pro 12.9"',         w: 1024, h: 1366, insets: { top: 24, bottom: 20, left: 0, right: 0 } },
];

console.log('\nRummy table layout\n');

// -- every screen, both ways round -----------------------------------
let worstCard = Infinity;
let overflowed = '';
let squashed = '';

for (const d of DEVICES) {
  for (const land of [false, true]) {
    const win = land ? { width: d.h, height: d.w } : { width: d.w, height: d.h };
    // In landscape the notch moves to a side, which is exactly the case a
    // width-only layout gets wrong.
    const insets = land
      ? { top: 0, bottom: d.insets.bottom, left: d.insets.top, right: d.insets.top }
      : d.insets;

    const m = metrics(win, insets);
    worstCard = Math.min(worstCard, m.cardW);

    // The hand may scroll, but it must not need to on anything but the
    // smallest screens — and it must never be sized wider than the box.
    // Against trayW, not width: the score panel sits in the band and takes its
    // share first, so a hand sized against the FULL width lands under it.
    if (handWidthAt(m.cardW) > m.trayW + 0.5 && m.cardW > 32) {
      overflowed = `${d.name} ${land ? 'landscape' : 'portrait'}: needs ${Math.round(handWidthAt(m.cardW))} in ${m.trayW}`;
    }

    // Everything must add up to no more than the usable height, or something
    // is under the system bars. The header is a real band now and the status
    // strip is gone — the score panel says what it used to say.
    const used = m.headerH + m.tableH + m.handH + 46;
    if (used > m.height + 1) {
      squashed = `${d.name} ${land ? 'landscape' : 'portrait'}: ${used} used of ${m.height}`;
    }
  }
}

check('the hand never needs more width than the screen has', !overflowed, overflowed);

// -- the wide layout may never cost a readable card ------------------
//
// The score panel and the side gutters take width from the hand, so "is this
// screen wide enough for the full layout" is really "does the full layout still
// leave a card worth reading". It used to be a WIDTH — 700dp — and sweeping the
// real device found what that hid: 699dp gave a 53dp card, 700dp gave 39dp. A
// one-pixel change in viewport dropping the cards by a quarter.
//
// Adding a panel always costs SOME width, so the step is inherent and this does
// not assert monotonicity. What it asserts is the floor: wherever the wide
// layout switches on, the card it leaves is still one you can read.
{
  let tooSmall = '';
  let halfDressed = '';
  for (let w = 480; w <= 1600; w += 7) {
    for (const h of [320, 360, 390, 480, 768]) {
      const m = metrics({ width: w, height: h }, { top: 0, bottom: 0, left: 0, right: 0 });
      // Read from the module, never re-typed here — a check pinned to a copy
      // of a constant passes for the wrong reason the moment the real one moves,
      // which is exactly what a hardcoded 40 did when CARD_COMFORT became 34.
      if (m.sidePanels && m.cardW < CARD_COMFORT && m.cardW > CARD_MIN) tooSmall = `${w}x${h}: wide layout left a ${m.cardW}dp card`;
      // One decision, so there is no width that gets half the design.
      if (m.sidePanels !== (m.scoreW > 0)) halfDressed = `${w}x${h}: panels ${m.sidePanels} but score ${m.scoreW}`;
    }
  }
  check('the wide layout never leaves a card under the comfort floor', !tooSmall, tooSmall);

  // THE ACTION BAR MUST FIT. Found by sweeping the Honor, not by any model
  // check here: at 666dp the bar wanted 680dp and DROP was pushed off the
  // right-hand edge. A decision the player cannot reach is a hand they cannot
  // finish, which is the one failure this whole file exists to prevent.
  let barOver = '';
  let noStandings = '';
  for (let w = 400; w <= 1600; w += 3) {
    for (const h of [300, 320, 360, 390, 480, 768]) {
      const m = metrics({ width: w, height: h }, { top: 0, bottom: 0, left: 0, right: 0 });
      if (actionBarWidth(m) > m.width + 0.5) barOver = `${w}x${h}: bar needs ${actionBarWidth(m)} of ${m.width}`;
      // The bar gives up its optional controls in ONE order, cheapest first:
      // the deadwood toggle, then the trio degrades to a single button, then
      // that goes too. What must never happen is the trio and the button at
      // once (the row would say it twice) or the readout appearing in the bar
      // while the panel already carries it in the band.
      if (m.barTrio && m.barStandings) noStandings = `${w}x${h}: trio AND button`;
      if (m.scoreW > 0 && (m.barTrio || m.barStandings)) noStandings = `${w}x${h}: readout twice`;
    }
  }
  check('the action bar always fits, so DROP is never pushed off screen', !barOver, barOver);

  // THE HAND MUST FIT ITS TRAY REGION, AND IT MUST NOT BURY THE CARDS.
  //
  // Two bugs in one place, both reported off a screenshot rather than found
  // here. `overlap` was computed from fanFor(cardW, WIDTH) while the cards live
  // in trayW — so once the score panel moved into the band the hand thought it
  // had the whole viewport, chose a fan of ~1, and ran 135-177dp past the trays
  // on EVERY size that showed the panel. And sizing cards as large as the width
  // allowed then collapsed the fan to its 0.58 floor: 42% of every card buried.
  //
  // Asserted against the RENDERED arithmetic — thirteen cards, eight tucks,
  // plus the chrome — not against the model's own fan, which is what let both
  // through.
  let handOver = '';
  let buried = '';
  for (let w = 480; w <= 1600; w += 7) {
    for (const h of [300, 320, 360, 369, 390, 480, 768]) {
      const m = metrics({ width: w, height: h }, { top: 0, bottom: 0, left: 0, right: 0 });
      const rendered = 13 * m.cardW - 8 * m.overlap + (16 + 2) * 5 + 12 * 4 + 8;
      if (rendered > m.trayW + 0.5) handOver = `${w}x${h}: hand ${rendered} in tray ${m.trayW}`;
      // Above the card floor the comfort fan had room to work, so a heavy tuck
      // means something stopped honouring it.
      if (m.cardW > CARD_MIN && m.overlap / m.cardW > 0.25) {
        buried = `${w}x${h}: ${Math.round(100 * m.overlap / m.cardW)}% of a ${m.cardW}dp card hidden`;
      }
    }
  }
  check('the hand always fits the tray region it is actually drawn in', !handOver, handOver);
  check('...and the cards are never buried under each other', !buried, buried);
  check('...and the bar never shows the score readout twice', !noStandings, noStandings);
  // Below the width that fits a seventh control the bar has no standings entry
  // at all, so the SHEET carries it — asserted against the source, because the
  // guarantee is "always reachable", not "always in the bar".
  {
    const src = readFileSync(join(__dirname, '..', '..', 'components/games/Rummy.tsx'), 'utf8');
    check('...and the settings sheet always offers Standings, whatever the width',
      /label="Standings"[\s\S]{0,220}setShowStandings\(true\)/.test(src),
      'the bar drops it on a narrow screen; the sheet must not');
  }
  check('the gutters and the score panel are one decision', !halfDressed, halfDressed);

  // The case that actually shipped broken, pinned by name.
  const honor = metrics({ width: 732, height: 369 }, { top: 0, bottom: 0, left: 0, right: 0 });
  check('the Honor at its real 732dp viewport gets the full layout',
    honor.sidePanels && honor.scoreW > 0, `card ${honor.cardW}, score ${honor.scoreW}`);
}
check('table + hand + actions + status never exceed the safe height', !squashed, squashed);
check('cards stay legible on the smallest screen', worstCard >= 32, `smallest card ${worstCard}px`);

// A card that is not card-shaped stops reading as a card.
{
  const m = metrics({ width: 800, height: 400 }, { top: 0, bottom: 20, left: 44, right: 44 });
  check('cards keep their proportions', Math.abs(m.cardH / m.cardW - CARD_RATIO) < 0.02);
  check('safe-area insets come off the usable box', m.width === 800 - 88);
}

// -- seats, two- to six-handed ---------------------------------------
//
// Seats now ride an ELLIPSE around the felt rather than a shallow arc along the
// top of it, so "do they overlap" is a two-dimensional question: two capsules
// at different points on the arc may share a range of x and still not touch.
// Testing x alone (which is all the arc version needed) would now report a
// collision for every table.
{
  // The seat ring rides the drawn OVAL, not the felt frame: with side panels the
  // two differ by a third of the width, and seating against the frame puts the
  // outer capsules under the table panel and the emote feed.
  const HEADER = 6;
  let collided = '';
  let offEdge = '';
  let underHeader = '';
  // 1..5 opponents = a 2..6 player table. LANDSCAPE widths: rummy locks
  // landscape for the whole screen, and the ring is only collision-free above
  // tableW 372 — below that the width clamp pins capsules to their 72dp floor
  // faster than the spacing shrinks. The narrowest real landscape viewport is
  // about 480dp, so the floor is never reached in practice; it is documented on
  // seatSpots rather than defended here.
  for (const tableW of [420, 568, 640, 844, 1024, 1540]) {
    for (const tableH of [120, 155, 189, 543]) {
      for (let n = 1; n <= 5; n++) {
        const spots = seatSpots(n, tableW, tableH, HEADER);
        for (let i = 0; i < spots.length; i++) {
          for (let j = i + 1; j < spots.length; j++) {
            const a = spots[i], b = spots[j];
            const hit = a.x < b.x + b.w && b.x < a.x + a.w
                     && a.y < b.y + b.h && b.y < a.y + a.h;
            if (hit) collided = `${n} seats in ${tableW}x${tableH}: ${i} and ${j} overlap`;
          }
        }
        for (const s of spots) {
          if (s.x < 0 || s.x + s.w > tableW + 0.5) offEdge = `${n} in ${tableW}: x ${s.x}+${s.w}`;
          if (s.y + s.h > tableH + 0.5) offEdge = `${n} in ${tableW}x${tableH}: y ${s.y}+${s.h}`;
          // A capsule under the header band sits beneath the settings button.
          if (s.y < HEADER - 0.5) underHeader = `${n} in ${tableW}x${tableH}: y ${s.y}`;
        }
      }
    }
  }
  check('seats never overlap, two- to six-handed', !collided, collided);
  check('no seat hangs off the felt, in either axis', !offEdge, offEdge);
  check('no seat is drawn under the header band', !underHeader, underHeader);

  const five = seatSpots(5, 574, 189, HEADER);
  check('the middle seat sits furthest back', five[2].y < five[0].y && five[2].y < five[4].y);
  check('the outermost pair sits furthest round the sides',
    five[0].y > five[1].y && five[4].y > five[3].y);
  check('the ring is symmetric about the player',
    five[0].y === five[4].y && five[1].y === five[3].y
    && Math.abs((five[0].x + five[4].x + five[0].w) - 574) < 1.5);
  check('a lone opponent sits opposite, centred',
    Math.abs(seatSpots(1, 574, 189, HEADER)[0].x + seatSpots(1, 574, 189, HEADER)[0].w / 2 - 287) < 1);
  check('no seats when nobody is opposite', seatSpots(0, 574, 189, HEADER).length === 0);

  // THE CHECK THIS FILE WAS MISSING, and the reason a seat that overflowed its
  // own border by 12-18dp at every single viewport passed every run.
  //
  // Everything above compares seat rects with OTHER seat rects. Nothing asked
  // whether a seat can hold what is drawn inside it — so the capsule was capped
  // at 58dp while its three rows needed about 72, and the card-back row painted
  // onto bare felt below the rounded border, outside the gold turn ring. The
  // renderer had the avatar sum, this file had the height cap, and the two
  // disagreed by a whole row for as long as they both existed.
  //
  // There is now one budget (SEAT_CHROME_H + seatAvatar) and both read it. This
  // asserts the arithmetic closes at every size a seat can actually resolve to.
  let tooSmall = '';
  for (const [w, h] of VIEWPORTS) {
    const m = metrics({ width: w, height: h }, ZERO_INSETS);
    for (const n of [1, 2, 3, 4, 5]) {
      for (const sp of seatSpots(n, m.ovalW, m.ovalH, 6)) {
        const need = (seatHasDetail(sp.h) ? SEAT_CHROME_H : SEAT_CHROME_BASE) + seatAvatar(sp.h);
        if (need > sp.h + 0.5) tooSmall = `${w}x${h} n=${n}: capsule ${sp.h}dp holds ${need}dp`;
      }
    }
  }
  check('a seat is always tall enough for what is drawn in it', !tooSmall, tooSmall);

  // ...and wide enough that a name is a name. The old row layout left the name
  // `w - 57` after the avatar, the gap and the status dot had taken their cut —
  // 22dp, about three characters, on a 732dp-wide table. Standing the seat up
  // gives the name the whole capsule less its padding.
  let tooNarrow = '';
  for (const [w, h] of VIEWPORTS) {
    const m = metrics({ width: w, height: h }, ZERO_INSETS);
    const nameW = seatSpots(5, m.ovalW, m.ovalH, 6)[0].w - 12;
    if (nameW < 54) tooNarrow = `${w}x${h}: ${nameW}dp for a name`;
  }
  check('a six-handed seat has room for a name', !tooNarrow, tooNarrow);
}

// -- the piles sit on the cloth, not in the near rail -----------------
//
// Pinned to the bottom of the felt (which is what they were) they land in the
// near rail of a tablet with 240dp of empty cloth above them.
{
  let clash = '';
  let offFelt = '';
  // Everything is measured against the OVAL — the piles sit on the cloth, which
  // is narrower than the felt frame wherever the side panels fit. The seat top
  // inside the oval is a small clearance, not the header.
  const SEAT_TOP = 6;
  for (const [w, h] of VIEWPORTS) {
    const m = metrics({ width: w, height: h }, ZERO_INSETS);
    const spots = seatSpots(5, m.ovalW, m.ovalH, SEAT_TOP);
    const stackH = 14 + 3 + Math.round(m.pileW * 1.4) + 2 + 13;
    const y = pileTop(m.ovalW, m.ovalH, spots, m.pileRowW, stackH);

    // A RECTANGLE INTERSECTION, not a restatement of pileTop's own formula.
    //
    // The old version of this check recomputed `SEAT_TOP + spots[0].h + 8` and
    // compared it to what pileTop returned from the same expression, so it
    // could only ever agree with itself. It agreed happily while seats 1 and 3
    // — which hang 9-10dp lower than seat 0, because the ring is an ARC — sat
    // on top of the CLOSED DECK plate at every landscape phone size.
    //
    // This asks the question the player asks: do these two boxes overlap?
    const x0 = (m.ovalW - m.pileRowW) / 2;
    const hit = spots.find(sp =>
      sp.x < x0 + m.pileRowW && sp.x + sp.w > x0 && sp.y < y + stackH && sp.y + sp.h > y);
    if (hit) clash = `${w}x${h}: a seat at (${hit.x},${hit.y},${hit.w}x${hit.h}) overlaps piles at ${y}..${y + stackH}`;
    if (y + stackH > m.ovalH + 0.5) offFelt = `${w}x${h}: piles end at ${y + stackH} of ${m.ovalH}`;
  }
  check('no seat ever overlaps the piles', !clash, clash);
  check('the piles never hang off the bottom of the felt', !offFelt, offFelt);

  // The extremes of the arc hang lowest of all, and they are also furthest from
  // the middle. Clearing past them would shove the stack off the felt to dodge
  // a collision that cannot happen, so pileTop must ignore them.
  const wide = [
    { x: 0, y: 200, w: 80, h: 80 },     // far left, hanging low, nowhere near
    { x: 400, y: 6, w: 80, h: 80 },     // straight across, over the piles
  ];
  check('only the seats over the piles set the clearance',
    pileTop(900, 560, wide, 240, 120) > 200,
    `${pileTop(900, 560, wide, 240, 120)} — the low seat at the rim must not count`);
  check('a tall felt centres the piles rather than dropping them in the rail',
    pileTop(696, 543, [{ x: 300, y: 6, w: 100, h: 88 }], 240, 102) > 200);
}

// -- the turn clock --------------------------------------------------
console.log('\nTurn clock\n');
{
  const now = 1_700_000_000_000;
  check('counts down in whole seconds', secondsLeft(now + 24_400, now) === 24);
  check('never goes negative', secondsLeft(now - 5_000, now) === 0);
  check('no deadline shows no clock', secondsLeft(undefined, now) === null && secondsLeft(null, now) === null);
  check('a nonsense deadline is refused rather than displayed',
    secondsLeft(now + 20 * 60_000, now) === null,
    'a phone with a skewed clock would otherwise count down from twenty minutes');
  check('NaN is refused', secondsLeft(NaN, now) === null);
}

// -- reading the table -----------------------------------------------
console.log('\nStandings\n');
{
  const p = (id: string, points: number, status: string): RummyPlayer =>
    ({ id, name: id, handCount: 13, points, status });

  const table = [p('a', 40, 'lost'), p('w', 0, 'won'), p('b', 20, 'dropped'), p('c', 15, 'active')];
  const order = ranked(table, 'w').map(x => x.id);
  check('the declared winner ranks first', order[0] === 'w');
  check('then ascending points', order.join() === 'w,c,b,a', order.join());

  check('a winner the server named outranks a lower score',
    ranked([p('lo', 5, 'lost'), p('w', 80, 'won')], 'w')[0].id === 'w',
    'the server decides who won, not arithmetic on points');

  check('ranking with no winner yet still orders by points',
    ranked([p('a', 30, 'active'), p('b', 10, 'active')], null).map(x => x.id).join() === 'b,a');

  check('active count ignores the players who are out', activeCount(table) === 2);

  check('bots only at practice tables',
    allowsBots({ pointValue: 0 }) && !allowsBots({ pointValue: 0.05 }) && !allowsBots(null) && !allowsBots(undefined));
}

// -- room codes ------------------------------------------------------
console.log('\nRoom codes\n');
{
  // Deterministic: the check is the alphabet and the length, not the draw.
  let seed = 0;
  const code = newPrivateCode(() => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648));
  check('a private code is six safe characters', /^[A-HJ-NP-Z2-9]{6}$/.test(code), code);
  check('no ambiguous glyphs', !/[IO01]/.test(newPrivateCode()));

  check('a pasted code is stripped to what the server accepts',
    normalizeCode('  ab/cd?ef#  ') === 'abcdef');
  check('an all-punctuation code comes back empty rather than as junk',
    normalizeCode('///???') === '');
  check('a hyphenated code survives', normalizeCode('room-7_x') === 'room-7_x');
}

/* -- the fan spreads when there is room ----------------------------- */
//
// FAN was a fixed 0.58 — 42% of every card hidden behind the next, on a wide
// landscape table with space to spare on both sides. Reported from a device
// photo of a Redmi in landscape.
{
  const wide = fanFor(48, 2340);
  const tight = fanFor(48, 700);
  check('a wide table stops overlapping the cards', wide === 1);
  check('a narrow one still tucks them in', tight >= 0.58 && tight < 1);
  check('and never tighter than the size was chosen for', fanFor(70, 320) === 0.58);
  // The two real phones, at the card size the cap now allows: thirteen upright
  // cards, none covering another, with table left over — the look of the
  // reference mockup rather than a fanned pile.
  for (const [cardW, width, dev] of [[175, 2664, 'Honor'], [148, 2340, 'Redmi']] as [number, number, string][]) {
    const f = fanFor(cardW, width);
    check(`${dev}: no overlap at the shipped card size`, f >= 1);
    check(`${dev}: the hand fits inside the display`, handWidthAt(cardW, f) < width);
  }
  // The margin is PROPORTIONAL: a flat one was enough at 2340px and not at
  // 2664px, where the row still reached the screen edge and the hand rendered
  // as twelve cards with five overlapping pairs. Measured on two phones.
  for (const [cardW, width] of [[202, 2664], [170, 2340], [120, 1600]] as [number, number][]) {
    const slack = width - handWidthAt(cardW, fanFor(cardW, width));
    check(`a ${width}px table keeps real slack (${Math.round(slack)}px)`, slack >= width * 0.05);
  }
  check('the hand still fits at the fan it chose',
    handWidthAt(48, fanFor(48, 2340)) <= 2340 + 1);
}

// -- the tuck has to survive the render ------------------------------
//
// THE BUG THIS CATCHES. The fan was applied as `gap: -overlap`. Gap is a Yoga
// gutter and, exactly as in CSS, may not be negative — the value is invalid and
// resolves to 0, so the fan fanFor() computed was silently thrown away and the
// hand laid out fully spread. Every check above passed the whole time, because
// they test the MODEL against itself and never what renders. On the Redmi in
// landscape that shipped as thirteen cards dealt and twelve on screen.
{
  const src = readFileSync(join(__dirname, '..', '..', 'components', 'games', 'Rummy.tsx'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  check('the hand never tucks with a NEGATIVE GAP — Yoga resolves it to 0',
    !/gap:\s*-\s*overlap/.test(code));
  check('...it tucks with a negative margin, which Yoga honours',
    /marginLeft:\s*-overlap/.test(code));
  check('...and the paddingRight that compensated for the gap is gone',
    !/paddingRight:\s*overlap/.test(code));
}

// Fit has to hold at every width the hand actually renders at. Rummy locks
// LANDSCAPE while playing (Rummy.tsx), so those are the sizes that matter, and
// the overflow this change fixes only ever appeared there.
for (const [w, h, name] of [
  [2264, 1036, 'Redmi landscape'], [2588, 1180, 'Honor landscape'],
  [960, 540, 'small landscape'], [640, 360, 'smallest landscape'],
] as [number, number, string][]) {
  const m = metrics({ width: w, height: h }, { top: 0, bottom: 0, left: 0, right: 0 });
  check(`${name}: the hand fits`, handWidthAt(m.cardW, fanFor(m.cardW, m.width)) <= m.width);

  // ...AND IT FITS AT THE OVERLAP THAT ACTUALLY RENDERS.
  //
  // handWidthAt takes the real-valued fan; the layout tucks by `m.overlap`,
  // which is a whole number of pixels. Every assertion above was written
  // against the fan, so a rounding that made the real tuck LOOSER than the
  // model passed while the hand overflowed — at 640x360 the model said 637.6
  // of 640 and the render measured 641, found by building the layout in Figma
  // rather than by any check here. The layout is five trays holding thirteen
  // cards: thirteen card widths, less the eight tucks, plus the chrome.
  const rendered = 13 * m.cardW - 8 * m.overlap + (16 + 2) * 5 + 12 * 4 + 8;
  check(`${name}: ...and at the whole-pixel overlap it renders with`,
    rendered <= m.width, `${rendered} in ${m.width}, overlap ${m.overlap}`);
}

// Below about 454dp there is no honest fit: thirteen cards at the smallest
// readable size (CARD_MIN) and the tightest permitted tuck (FAN) still need
// more room than that. The hand is a horizontal scroller, so it degrades to
// scrolling rather than shrinking the cards past legibility — a deliberate
// floor, not a bug. The lobby is the only place the hand is seen this narrow,
// and it holds no cards.
{
  const narrow = metrics({ width: 360, height: 640 }, { top: 0, bottom: 0, left: 0, right: 0 });
  check('a phone-portrait width cannot show thirteen cards, and pins the card size to its floor',
    narrow.cardW === 32 && handWidthAt(narrow.cardW, fanFor(narrow.cardW, narrow.width)) > narrow.width);
}

// FILTERING BY TABLE SIZE.
//
// RummyCircle offers 2-player and 6-player tables as a first-class choice. The
// server has always published `maxPlayers` per table; the app just never let
// anyone filter on it.
console.log('\nTable size filter\n');
{
  const T = (id: string, maxPlayers: number): TableInfo =>
    ({ id, name: id, stakes: '0.05/pt', players: 0, maxPlayers, status: 'open' });

  // Deliberately includes a 4-seat table: the protocol documents a 2–6 range,
  // so anything that tests only 2 and 6 misses the bug this guards against.
  const tables = [T('a', 2), T('b', 6), T('c', 4), T('d', 2), T('e', 5)];

  // -- and by KIND: practice, staked, or bot-friendly ------------------
  //
  // `pointValue` is documented on `lobby.table`, NOT on the `{t:'tables'}` rows.
  // The server does seem to send it there too, but a filter built on an
  // undocumented field has to degrade rather than lie — so a row without one is
  // `unknown` and shows under every tab. Hiding a real, joinable table on
  // evidence we do not have reads to a player as "there are no tables".
  {
    const K = (id: string, pointValue?: number): TableInfo =>
      ({ id, name: id, stakes: '—', players: 0, maxPlayers: 6, status: 'open', ...(pointValue == null ? {} : { pointValue }) });

    const mixed = [K('free', 0), K('cash', 0.05), K('mystery'), K('free2', 0), K('rich', 1)];

    check('a zero point value is a practice table', tableKind(K('a', 0)) === 'practice');
    check('anything above zero is staked', tableKind(K('a', 0.05)) === 'stakes');
    check('a missing point value is UNKNOWN, not practice',
      tableKind(K('a')) === 'unknown',
      'defaulting to practice would offer a bot the server refuses');
    check('NaN is unknown too', tableKind({ pointValue: NaN }) === 'unknown');
    check('a null table is unknown, not a throw', tableKind(null) === 'unknown');

    check('kind all: every table survives', filterByKind(mixed, 'all').length === 5);
    check('practice: the free tables', filterByKind(mixed, 'practice').map(t => t.id).join() === 'free,mystery,free2');
    check('stakes: the paid tables', filterByKind(mixed, 'stakes').map(t => t.id).join() === 'cash,mystery,rich');
    check('an unknown table is never hidden by a kind filter',
      filterByKind(mixed, 'practice').some(t => t.id === 'mystery')
      && filterByKind(mixed, 'stakes').some(t => t.id === 'mystery'));
    check('bots lists exactly what practice lists',
      filterByKind(mixed, 'bots').map(t => t.id).join() === filterByKind(mixed, 'practice').map(t => t.id).join(),
      'only a practice table accepts addbot; the tab differs in what JOINING does');
    check('kind filters keep the order the server sent',
      filterByKind(mixed, 'all').map(t => t.id).join() === 'free,cash,mystery,free2,rich');
    check('kind: an empty list is empty, not a throw', filterByKind([], 'practice').length === 0);
    check('kind: the input is not mutated',
      (() => { const before = mixed.map(t => t.id).join(); filterByKind(mixed, 'stakes'); return mixed.map(t => t.id).join() === before; })());

    // The two filters have to compose: the screen applies both at once.
    const both = filterBySeats(filterByKind(mixed, 'practice'), 'multi');
    check('kind and seat filters compose', both.length === 3, `${both.length}`);
  }

  check('all: every table survives', filterBySeats(tables, 'all').length === 5);
  check('all: in the order the server sent them',
    filterBySeats(tables, 'all').map(t => t.id).join('') === 'abcde',
    're-sorting fights the order the server chose');

  const heads = filterBySeats(tables, 'heads-up');
  check('heads-up: only the 2-seat tables', heads.map(t => t.id).join('') === 'ad');

  const multi = filterBySeats(tables, 'multi');
  check('multi: every table above 2 seats', multi.map(t => t.id).join('') === 'bce');
  check('multi: a 4-seat table is NOT hidden', multi.some(t => t.maxPlayers === 4),
    'a hardcoded ===6 would drop 3-, 4- and 5-seat tables and read as "no tables open"');
  check('multi: a 5-seat table is NOT hidden', multi.some(t => t.maxPlayers === 5));

  check('the two filters partition the list',
    heads.length + multi.length === tables.length,
    'a table that matches neither would be unreachable from the list');

  check('an empty list is empty, not a throw', filterBySeats([], 'heads-up').length === 0);
  check('no table of that size returns empty so the UI can say so',
    filterBySeats([T('x', 6)], 'heads-up').length === 0);
  check('the input is not mutated',
    (() => { const src = [T('a', 2), T('b', 6)]; filterBySeats(src, 'multi'); return src.length === 2; })());
}

// SEATING AT A REAL TABLE.
//
// The bug: rummy tables are server-owned, so every id the app invented ("private
// room") or imported from the matchmaker ("play online") was substituted
// silently and two players each landed alone at "1/6 seated". These checks pin
// the cure — choose from the list the server actually sent.
console.log('\nPicking a real table\n');
{
  const T = (id: string, players: number, maxPlayers = 6, pointValue = 1): TableInfo =>
    ({ id, name: id, stakes: 's', players, maxPlayers, status: 'open', pointValue });

  const practice = T('practice', 0, 6, 0);
  const casual = T('casual', 2);
  const pro = T('pro', 1);

  check('bot: seats at the practice table, the only one that accepts a bot',
    pickTable([casual, practice, pro], 'bot')?.id === 'practice');
  check('bot: no practice table means no seat, not a staked one',
    pickTable([casual, pro], 'bot') === null,
    'a staked table refuses addbot — offering it is a button that does nothing');

  check('auto: goes where the humans already are',
    pickTable([practice, casual, pro], 'auto')?.id === 'casual',
    'casual has 2 players, pro 1, practice 0');
  check('auto: skips a FULL table',
    pickTable([T('full', 6), casual], 'auto')?.id === 'casual');
  check('auto: an all-empty list still seats somewhere',
    !!pickTable([practice, T('casual', 0)], 'auto'),
    'returning null would drop the player back on the list they just left');
  check('auto: the choice is deterministic across devices',
    pickTable([T('b', 0), T('a', 0)], 'auto')?.id === pickTable([T('a', 0), T('b', 0)], 'auto')?.id,
    'two players picking differently is the whole bug being fixed');

  check('no tables at all is null, not a throw', pickTable([], 'auto') === null);
  check('null is null, not a throw', pickTable(null, 'auto') === null);
  check('every table full is null', pickTable([T('f', 6)], 'auto') === null);
}

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all rummy table checks passed\n');
process.exit(failures ? 1 : 0);
