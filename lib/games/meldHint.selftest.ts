// lib/games/meldHint.selftest.ts — run: npx tsx lib/games/meldHint.selftest.ts
//
// The hint is advisory, but a WRONG hint is worse than none: it invites the
// exact 80-point misdeclare it exists to prevent. So the classifier is pinned
// against the rules of 13-card Indian rummy here.

import { classifyGroup, analyzeHand, type HintCard } from './meldHint';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

// Terse card builder: 'H5' = five of hearts, 'JK' = printed joker.
const c = (s: string): HintCard => ({ id: s, suit: s === 'JK' ? 'JOKER' : s[0], rank: s === 'JK' ? '' : s.slice(1) });
const g = (...ids: string[]) => ids.map(c);

console.log('\nRummy meld hint\n');

// ── sequences ────────────────────────────────────────────────────────
check('three in a row, one suit, no joker → pure sequence',
  classifyGroup(g('H4', 'H5', 'H6')).type === 'pure');

check('a joker in the run makes it impure',
  classifyGroup(g('H4', 'JK', 'H6')).type === 'impure',
  'the joker fills the gap at H5');

check('a joker on the END still extends a run',
  classifyGroup(g('H4', 'H5', 'JK')).type === 'impure',
  'only gaps INSIDE the span consume a joker');

check('a gap with no joker to fill it is not a sequence',
  classifyGroup(g('H4', 'H6', 'H9')).type === 'invalid');

check('mixed suits are not a sequence',
  classifyGroup(g('H4', 'S5', 'H6')).type === 'invalid');

check('a repeated rank is not a sequence',
  classifyGroup(g('H4', 'H4', 'H5')).type === 'invalid',
  'two decks are in play, so duplicates genuinely occur');

// ── sets ─────────────────────────────────────────────────────────────
check('same rank, different suits → set',
  classifyGroup(g('H7', 'S7', 'D7')).type === 'set');

check('a set may be four cards',
  classifyGroup(g('H7', 'S7', 'D7', 'C7')).type === 'set');

check('five cards is not a set',
  classifyGroup(g('H7', 'S7', 'D7', 'C7', 'JK')).type === 'invalid');

check('a repeated suit breaks a set',
  classifyGroup(g('H7', 'H7', 'D7')).type === 'invalid');

// ── size and scoring ─────────────────────────────────────────────────
check('two cards are never a meld',
  classifyGroup(g('H4', 'H5')).type === 'invalid');

check('an empty group is empty, not invalid',
  classifyGroup([]).type === 'empty',
  'the loose pile must not read as a mistake');

check('deadwood counts A/10/J/Q/K as ten',
  classifyGroup(g('HA', 'S10', 'DK')).points === 30);

check('a meld costs nothing',
  classifyGroup(g('H4', 'H5', 'H6')).points === 0);

// ── the wild rank ────────────────────────────────────────────────────
// The round's wild rank acts as a joker wherever it appears.
check('a wild-rank card behaves as a joker',
  classifyGroup(g('H4', 'S7', 'H6'), '7').type === 'impure',
  'the seven fills the H5 gap when 7 is wild');

check('...and a run made only of wild-rank cards is not pure',
  classifyGroup(g('H4', 'H5', 'H6'), '5').type === 'impure');

// ── whole hand ───────────────────────────────────────────────────────
const deck: Record<string, HintCard> = {};
for (const id of ['H4','H5','H6','S9','S10','SJ','D2','D3','D4','C8','S8','H8','D8','HK'])
  deck[id] = c(id);
const card = (id: string) => deck[id];

const good = analyzeHand([['H4','H5','H6'], ['S9','S10','SJ'], ['D2','D3','D4'], ['C8','S8','H8','HK']], card);
check('a hand needs every card melded',
  !good.allArranged,
  'the last group is four of a kind plus a stray king');

const valid = analyzeHand([['H4','H5','H6'], ['S9','S10','SJ'], ['D2','D3','D4'], ['C8','S8','H8','D8']], card);
check('thirteen cards, two sequences, one pure → valid',
  valid.valid && valid.hasPure && valid.hasTwoSeq,
  'all thirteen must be melded, not merely most of them');

const noPure = analyzeHand([['H4','JK','H6'], ['S9','S10','SJ'], ['D2','D3','D4'], ['C8','S8','H8']],
  id => deck[id] ?? c(id));
check('...and at least one sequence must be PURE',
  noPure.hasTwoSeq && noPure.hasPure,
  'S9-S10-SJ is still pure here');

const onlyOneSeq = analyzeHand([['H7','S7','D7'], ['C8','S8','H8'], ['H4','H5','H6'], ['D2','D3','D4']], id => deck[id] ?? c(id));
check('two sequences are required, not one',
  onlyOneSeq.hasTwoSeq,
  'H4-H5-H6 and D2-D3-D4 are both sequences');

check('the misdeclare cost is capped at 80',
  analyzeHand([['HK','HK','HK','HK','HK','HK','HK','HK','HK']], id => c('HK')).fullCount === 80);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all meld-hint checks passed\n');
process.exit(failures ? 1 : 0);
