// match.selftest.ts — the Pool/Deals client layer.
//
// The SCORING is not tested here because it is not here: it lives in the Go
// handler (games_matches.go) and is covered by games_matches_test.go. Every
// check below is about the two things the client genuinely owns — reading the
// server's answer without crashing a live board, and reporting a deal without
// inventing a number.
//
//   npx tsx lib/games/match.selftest.ts

import { matchOf, standings, progressLabel, resultsFrom, variantLabel, VARIANTS } from './match';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

const M = (over: any = {}) => matchOf({
  match: {
    id: 'm1', tableId: 't1', variant: 'pool101', status: 'running',
    dealsPlayed: 2, poolLimit: 101, dealsTotal: 0,
    scores: {
      a: { name: 'Asha', points: 40, chips: 0, status: 'playing' },
      b: { name: 'Ravi', points: 12, chips: 0, status: 'playing' },
      c: { name: 'Meera', points: 105, chips: 0, status: 'out' },
    },
    ...over,
  },
})!;

console.log('\nReading a match\n');
{
  const m = M();
  check('a real payload parses', !!m && m.id === 'm1');
  check('...with its variant and limit', m.variant === 'pool101' && m.poolLimit === 101);
  check('...and every seat', Object.keys(m.scores).length === 3);
  check('an out player is marked out', m.scores.c.status === 'out');

  // A malformed field must never crash a live board — the alternative to
  // tolerance here is a render error on top of a running game.
  check('no match is null, not a throw', matchOf(null) === null);
  check('an empty object is null', matchOf({}) === null);
  check('a match with no id is null', matchOf({ match: { variant: 'pool101' } }) === null);
  check('an explicit null match is null', matchOf({ match: null }) === null);

  const junk = matchOf({ match: { id: 'x', variant: 'pool101', scores: { a: { points: 'lots' } } } });
  check('a string where a number belongs does not survive as one',
    junk!.scores.a.points === 0, `${junk!.scores.a.points}`);
  check('...and never as NaN', Number.isFinite(junk!.scores.a.points));
  check('a nameless seat falls back to its id', junk!.scores.a.name === 'a');
  check('missing counters read as 0', junk!.dealsPlayed === 0 && junk!.poolLimit === 0);
  check('an unknown status is treated as still playing', junk!.scores.a.status === 'playing');
}

console.log('\nStandings\n');
{
  // A POOL IS WON BY THE LOWEST SCORE AND A DEALS MATCH BY THE HIGHEST.
  // Sorting one like the other silently puts the loser at the top.
  const pool = standings(M());
  check('pool: still-playing seats come first', pool[0].status === 'playing' && pool[2].status === 'out');
  check('pool: the LOWEST score leads', pool[0].vaultId === 'b', pool.map(r => r.vaultId).join(','));

  const deals = standings(M({
    variant: 'deals6', poolLimit: 0, dealsTotal: 6,
    scores: {
      a: { name: 'Asha', points: 0, chips: 10, status: 'playing' },
      b: { name: 'Ravi', points: 0, chips: 55, status: 'playing' },
    },
  }));
  check('deals: the HIGHEST chip count leads', deals[0].vaultId === 'b',
    deals.map(r => r.vaultId).join(','));

  check('an empty scoreboard sorts to nothing, not a throw',
    standings(matchOf({ match: { id: 'z', variant: 'pool101', scores: {} } })!).length === 0);
}

console.log('\nProgress label\n');
{
  check('a deals match counts its deals',
    progressLabel(M({ variant: 'deals6', poolLimit: 0, dealsTotal: 6, dealsPlayed: 2 })) === 'Deal 3 of 6');
  check('...and never past the total',
    progressLabel(M({ variant: 'deals2', poolLimit: 0, dealsTotal: 2, dealsPlayed: 2 })) === 'Deal 2 of 2',
    'a finished best-of-2 must not read "Deal 3 of 2"');
  check('a pool counts what has been played', progressLabel(M({ dealsPlayed: 4 })) === '4 deals played');
  check('one deal is singular', progressLabel(M({ dealsPlayed: 1 })) === '1 deal played');
}

console.log('\nReporting a deal\n');
{
  const players = [
    { id: 'a', name: 'Asha', points: 0 },
    { id: 'b', name: 'Ravi', points: 30 },
    { vaultId: 'c', name: 'Meera', points: 25 },
  ];
  const rs = resultsFrom(players, 'a');
  check('every seat is reported', rs.length === 3);
  check('the winner is flagged', rs.find(r => r.vaultId === 'a')!.winner === true);
  check('...and only the winner', rs.filter(r => r.winner).length === 1);
  check('points come from the server untouched', rs.find(r => r.vaultId === 'b')!.points === 30);
  check('either id field is read', !!rs.find(r => r.vaultId === 'c'));

  // A seat with no id would collide every such player into ONE scoreboard row.
  check('a seat with no id is dropped, not reported under an empty key',
    resultsFrom([{ name: 'ghost', points: 5 }], 'a').length === 0);
  check('no winner at all is not a crash', resultsFrom(players, null).every(r => !r.winner));
  check('a non-array is empty, not a throw', resultsFrom(null as any, 'a').length === 0);
  check('a non-numeric score reads as 0',
    resultsFrom([{ id: 'q', points: 'many' }], null)[0].points === 0);
}

console.log('\nVariants\n');
{
  check('exactly the four RummyCircle formats', VARIANTS.length === 4);
  check('...pool 101 and 201', VARIANTS.some(v => v.id === 'pool101') && VARIANTS.some(v => v.id === 'pool201'));
  check('...deals best-of-2 and best-of-6', VARIANTS.some(v => v.id === 'deals2') && VARIANTS.some(v => v.id === 'deals6'));
  check('a known variant is labelled', variantLabel('pool201') === 'Pool 201');
  check('an unknown variant falls back to the format this server plays',
    variantLabel(null) === 'Points rummy');
}

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all match checks passed\n');
process.exit(failures ? 1 : 0);
