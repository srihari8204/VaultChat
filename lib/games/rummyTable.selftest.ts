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
  metrics, seatSpots, handWidthAt, secondsLeft, ranked, activeCount,
  allowsBots, newPrivateCode, normalizeCode, CARD_RATIO,
  type RummyPlayer,
} from './rummyTable';

let failures = 0;
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
    if (handWidthAt(m.cardW) > m.width + 0.5 && m.cardW > 32) {
      overflowed = `${d.name} ${land ? 'landscape' : 'portrait'}: needs ${Math.round(handWidthAt(m.cardW))} in ${m.width}`;
    }

    // Everything must add up to no more than the usable height, or something
    // is under the system bars.
    const used = m.tableH + m.handH + 46 + 30;
    if (used > m.height + 1) {
      squashed = `${d.name} ${land ? 'landscape' : 'portrait'}: ${used} used of ${m.height}`;
    }
  }
}

check('the hand never needs more width than the screen has', !overflowed, overflowed);
check('table + hand + actions + status never exceed the safe height', !squashed, squashed);
check('cards stay legible on the smallest screen', worstCard >= 32, `smallest card ${worstCard}px`);

// A card that is not card-shaped stops reading as a card.
{
  const m = metrics({ width: 800, height: 400 }, { top: 0, bottom: 20, left: 44, right: 44 });
  check('cards keep their proportions', Math.abs(m.cardH / m.cardW - CARD_RATIO) < 0.02);
  check('safe-area insets come off the usable box', m.width === 800 - 88);
}

// -- seats, two- to six-handed ---------------------------------------
{
  let collided = '';
  let offEdge = '';
  // 1..5 opponents = a 2..6 player table, across the narrowest and widest felts.
  for (const tableW of [232, 320, 393, 673, 1024]) {
    for (let n = 1; n <= 5; n++) {
      const spots = seatSpots(n, tableW, 200);
      for (let i = 1; i < spots.length; i++) {
        if (spots[i].x < spots[i - 1].x + spots[i - 1].w) {
          collided = `${n} seats in ${tableW}px overlap`;
        }
      }
      for (const s of spots) {
        if (s.x < 0 || s.x + s.w > tableW + 0.5) offEdge = `${n} seats in ${tableW}px: seat at ${s.x}+${s.w}`;
      }
    }
  }
  check('seats never overlap, two- to six-handed', !collided, collided);
  check('no seat hangs off the edge of the felt', !offEdge, offEdge);

  const five = seatSpots(5, 800, 200);
  check('the middle seat sits furthest back', five[2].y < five[0].y && five[2].y < five[4].y);
  check('a lone opponent sits centred', Math.abs(seatSpots(1, 800, 200)[0].x + seatSpots(1, 800, 200)[0].w / 2 - 400) < 1);
  check('no seats when nobody is opposite', seatSpots(0, 800, 200).length === 0);
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

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all rummy table checks passed\n');
process.exit(failures ? 1 : 0);
