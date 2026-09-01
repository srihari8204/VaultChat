// lib/games/leaderboard.selftest.ts — run: npx tsx lib/games/leaderboard.selftest.ts
//
// The board is other players' names and numbers, parsed off the network. These
// check the two things that would be wrong in a way nobody would notice: a
// malformed row taking the whole table down with it, and the global board
// printing a rating the server never sent.

import { parseRow, parseLeaderboard, headline, medal, detail } from './leaderboard';

let failures = 0;
const check = (name: string, ok: boolean, detailMsg = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detailMsg ? `  (${detailMsg})` : ''}`);
};

console.log('\nLeaderboard\n');

// A real response, trimmed — captured from the deployment.
const LIVE = {
  ok: true,
  game: 'rummy',
  leaderboard: [
    { vaultId: 'v20cf51d5e67c', name: 'arun Prakash', balance: 2025, wins: 1, rating: 1200, streak: 1, best: 1 },
    { vaultId: 'cap-test-1', name: 'Cap1', balance: 1250, wins: 0, rating: 1200, streak: 0, best: 0 },
  ],
};

console.log('parsing');
const rows = parseLeaderboard(LIVE);
check('a real payload parses', rows.length === 2);
check('...keeping the server order', rows[0].name === 'arun Prakash' && rows[1].name === 'Cap1',
  'the server ranks; re-sorting here would show a standing it does not agree with');
check('...and every field', rows[0].balance === 2025 && rows[0].wins === 1 && rows[0].rating === 1200 && rows[0].streak === 1);

console.log('\nbad input cannot blank the board');
check('one broken row is dropped, the rest survive',
  parseLeaderboard({ leaderboard: [null, LIVE.leaderboard[0], 'nope', 7] }).length === 1,
  'a single bad row taking the table with it is how a live board goes empty');
check('a row with no vaultId is dropped',
  parseRow({ name: 'Ghost', balance: 10 }) === null,
  'the id is what marks your own line — an empty one would highlight a stranger as you');
check('a blank name falls back to the id',
  parseRow({ vaultId: 'v1', name: '   ' })?.name === 'v1');
check('missing numbers read as 0, not NaN',
  parseRow({ vaultId: 'v1' })?.balance === 0 && parseRow({ vaultId: 'v1' })?.rating === 0);
check('a string where a number belongs does not survive as one',
  parseRow({ vaultId: 'v1', balance: '9999' as unknown as number })?.balance === 0);
check('no leaderboard key is an empty board, not a throw', parseLeaderboard({ ok: true }).length === 0);
check('a non-object is an empty board', parseLeaderboard(null).length === 0 && parseLeaderboard('x').length === 0);

console.log('\nthe stat each board actually has');
const row = rows[0];
check('a per-game board shows the rating', headline(row, 'chess').value === '1200' && headline(row, 'chess').label === 'rating');
check('the global board shows coins instead',
  headline(row, 'all').value === '2025' && headline(row, 'all').label === 'coins',
  'global rows carry rating 0 — printing it would report a number the server never claimed');

console.log('\ntrimmings');
check('the podium is medals', medal(0) === '🥇' && medal(1) === '🥈' && medal(2) === '🥉');
check('...and below it, positions', medal(3) === '4' && medal(9) === '10');
check('one win is singular', detail({ ...row, wins: 1, streak: 0, best: 0 }) === '1 win');
check('...and none is plural', detail({ ...row, wins: 0, streak: 0, best: 0 }) === '0 wins');
check('a streak shows only when there is one',
  detail({ ...row, wins: 3, streak: 2, best: 2 }) === '3 wins · 2 in a row');
check('best shows only when it beats the current run',
  detail({ ...row, wins: 3, streak: 1, best: 5 }) === '3 wins · 1 in a row · best 5');

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all leaderboard checks passed\n');
process.exit(failures ? 1 : 0);
