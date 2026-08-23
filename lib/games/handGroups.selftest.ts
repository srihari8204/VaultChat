// lib/games/handGroups.selftest.ts — run: npx tsx lib/games/handGroups.selftest.ts
//
// The invariant that matters: an arrangement always contains EXACTLY the hand,
// each card once. A group holding a card the player no longer owns produces a
// declaration the server rejects for a reason the player cannot see on screen,
// and a card that falls out of every group vanishes from their hand entirely.

import {
  reconcile, groupUp, ungroup, sortLoose, sameGroups, moveCard,
  autoArrange, DEFAULT_GROUPS, MAX_GROUPS, type Groups,
} from './handGroups';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

/** Every card in the hand appears exactly once across all groups. */
const holds = (g: Groups, hand: string[]) => {
  const flat = g.flat();
  return flat.length === hand.length
    && new Set(flat).size === flat.length
    && hand.every(id => flat.includes(id));
};

console.log('\nRummy hand grouping\n');

// ── reconcile ────────────────────────────────────────────────────────
const hand13 = Array.from({ length: 13 }, (_, i) => `c${i}`);

let g = reconcile([], hand13);
check('a fresh deal lands as one loose pile', holds(g, hand13) && g.length === 1);

g = groupUp(g, ['c0', 'c1', 'c2']);
check('grouping pulls the picked cards out', holds(g, hand13) && g[0].join() === 'c0,c1,c2');
check('...and keeps a loose pile last', g[g.length - 1].length === 10);

// A draw: the new card must land loose, not vanish and not join a meld.
const drawn = [...hand13, 'c13'];
g = reconcile(g, drawn);
check('a drawn card joins the loose pile', holds(g, drawn) && g[g.length - 1].includes('c13'));
check('...without disturbing an existing group', g[0].join() === 'c0,c1,c2');

// A discard from inside a group: the group shrinks, nothing else moves.
const afterDiscard = drawn.filter(id => id !== 'c1');
g = reconcile(g, afterDiscard);
check('discarding from a group removes just that card',
  holds(g, afterDiscard) && g[0].join() === 'c0,c2');

// A whole new deal shares no ids: everything old must go.
const newDeal = Array.from({ length: 13 }, (_, i) => `n${i}`);
g = reconcile(g, newDeal);
check('a new deal replaces the arrangement entirely', holds(g, newDeal));

// ── ungroup ──────────────────────────────────────────────────────────
g = reconcile([], hand13);
g = groupUp(g, ['c0', 'c1', 'c2']);
g = groupUp(g, ['c3', 'c4']);
check('two groups plus a loose pile', g.length === 3 && holds(g, hand13));

g = ungroup(g, ['c1']);
check('ungrouping one card dissolves its whole group',
  holds(g, hand13) && g.length === 2 && !g[0].includes('c0'));
check('...and the freed cards go loose', ['c0', 'c1', 'c2'].every(id => g[g.length - 1].includes(id)));

// ── sort ─────────────────────────────────────────────────────────────
const deck: Record<string, { suit: string; rank: string }> = {
  a: { suit: 'H', rank: 'K' }, b: { suit: 'S', rank: '2' },
  c: { suit: 'H', rank: '3' }, d: { suit: 'S', rank: 'A' },
};
const sorted = sortLoose([['a', 'b', 'c', 'd']], id => deck[id]);
check('sorting the loose pile orders by suit then rank',
  sorted[0].join() === 'd,b,c,a',
  'spades before hearts, ace before king');

const withGroup = sortLoose([['a', 'b'], ['c', 'd']], id => deck[id]);
check('...and never reorders a group the player built',
  withGroup[0].join() === 'a,b',
  'that arrangement is the whole point of the screen');

// ── idempotence ──────────────────────────────────────────────────────
const twice = reconcile(reconcile([], hand13), hand13);
check('reconciling an unchanged hand changes nothing',
  sameGroups(twice, reconcile([], hand13)),
  'otherwise every snapshot would resend `arrange`');

// A duplicate id in the incoming arrangement must not survive: two decks are in
// play, so ids are the only thing telling two identical cards apart.
const deduped = reconcile([['x', 'x'], []], ['x', 'y']);
check('a duplicated id is not kept twice', holds(deduped, ['x', 'y']));

// ── moveCard — the drop half of drag-and-drop ────────────────────────
let m = reconcile([], hand13);
m = groupUp(m, ['c0', 'c1', 'c2']);

m = moveCard(m, 'c5', 0);
check('dropping a card into a group puts it there',
  holds(m, hand13) && m[0].includes('c5'));
check('...and removes it from where it was',
  m[m.length - 1].indexOf('c5') === -1);

m = moveCard(m, 'c5', m.length - 1);
check('dropping it back onto the loose pile works',
  holds(m, hand13) && !m[0].includes('c5') && m[m.length - 1].includes('c5'));

const stray = moveCard(m, 'c0', 99);
check('a drop outside every group lands loose rather than vanishing',
  holds(stray, hand13) && stray[stray.length - 1].includes('c0'),
  'a finger released between rows must still do something sensible');

check('dropping a card that is not in the hand changes nothing',
  sameGroups(moveCard(m, 'nope', 0), m));

check('moving a card into the group it already sits in is safe',
  holds(moveCard(m, m[0][0], 0), hand13),
  'remove first, then insert — otherwise the index shifts under the insert');

// ── autoArrange — the hand a deal starts in ──────────────────────────
const sc = (s: string) => ({ id: s, suit: s === 'JK' ? 'JOKER' : s[0], rank: s === 'JK' ? '' : s.slice(1) });
const isJk = (c: { suit: string }) => c.suit === 'JOKER';

// A run, a set, and four strays.
const dealt = ['H4', 'H5', 'H6', 'S7', 'D7', 'C7', 'SK', 'D2', 'C9', 'JK'].map(sc);
const arranged = autoArrange(dealt, isJk);

check('a dealt hand arrives already arranged, not as one loose pile',
  arranged.length >= DEFAULT_GROUPS,
  'four groups by default, as native rummy apps do');

check('...holding every dealt card exactly once',
  holds(arranged, dealt.map(c => c.id)));

check('...with the run pulled out',
  arranged.some(g => g.length === 3 && ['H4', 'H5', 'H6'].every(id => g.includes(id))));

check('...and the set pulled out',
  arranged.some(g => g.length === 3 && ['S7', 'D7', 'C7'].every(id => g.includes(id))));

check('a joker is left loose rather than spent for you',
  arranged.some(g => g.includes('JK') && !['H4', 'S7'].some(id => g.includes(id))),
  'auto-placing a joker into a meld the player did not want is worse than leaving it');

check('never more than five groups',
  autoArrange(
    ['H2','H3','H4','S5','S6','S7','D8','D9','D10','CJ','CQ','CK','H9','S9','C9'].map(sc),
    isJk,
  ).length <= MAX_GROUPS,
  'overflow merges into the last group rather than dropping cards');

// Every id distinct: two decks give duplicate CARDS, never duplicate ids.
const manyIds = ['H2','H3','H4','S5','S6','S7','D8','D9','D10','CJ','CQ','CK','H9','S9','C9'];
check('...and still holds every card after the merge',
  holds(autoArrange(manyIds.map(sc), isJk), manyIds));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all hand-grouping checks passed\n');
process.exit(failures ? 1 : 0);
