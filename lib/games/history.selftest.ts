// lib/games/history.selftest.ts — what the history is allowed to claim.
//
//   npx tsx lib/games/history.selftest.ts
//
// The reading rules are the whole risk here. A record is written from ONE
// snapshot of a reverse-engineered protocol, and every field it reads is
// optional — so the failure mode is not a crash, it is a history that quietly
// says you won a game you lost, or invents an opponent. Every rule below is
// "when the server did not say, say nothing".
//
// Chess is the exception that has to be checked separately: its winner is a
// COLOUR ('w'/'b'), not a player id, so the id comparison every other game uses
// would silently report every chess game as a loss.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  outcomeOf, opponentsOf, detailOf, movesOf, capHistory, isSameGame,
  whenLabel, isFinishedSnapshot, MOVES_KEPT, RESULTS_KEPT, type GameRecord,
} from './history';

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nGame history\n');

// ── is it over at all? THE BUG THIS CAUGHT ────────────────────────────
// Chess sends `result: "playing"` on EVERY frame. A truthiness test on that
// field reported a live game as finished, which filed it into the history the
// moment the board opened ("Chess vs Robo — playing") and dropped the table out
// of the live-games list while it was still being played. Seen on device.
A(!isFinishedSnapshot({ game: { result: 'playing' } }),
  '0. `result: "playing"` is NOT a finished game');
for (const live of ['ongoing', 'in_progress', 'active', 'started', 'live', 'PLAYING']) {
  A(!isFinishedSnapshot({ game: { result: live } }), `0a. nor is "${live}"`);
}
A(isFinishedSnapshot({ game: { result: 'checkmate' } }), '0b. a terminal result IS finished');
A(isFinishedSnapshot({ game: { phase: 'finished' } }), '0c. and so is phase finished');
A(isFinishedSnapshot({ game: { winnerId: 'x' } }) && isFinishedSnapshot({ game: { winner: 'w' } }),
  '0d. and a winner of either shape');
A(!isFinishedSnapshot({ game: {} }) && !isFinishedSnapshot(null),
  '0e. an empty snapshot is not finished');
A(outcomeOf({ game: { result: 'playing' } }, 'me') === 'ended',
  '0f. and a live game never yields a win or a loss');
A(detailOf({ game: { result: 'playing' } }, 'ended') === 'Finished',
  '0g. "playing" is never used as the description of how a game ended');

// ── outcome ───────────────────────────────────────────────────────────
A(outcomeOf({ game: { winnerId: 'me' } }, 'me') === 'won', '1. my id as winner is a win');
A(outcomeOf({ game: { winnerId: 'them' } }, 'me') === 'lost', '1a. someone else winning is a loss');
A(outcomeOf({ game: { result: 'Draw agreed' } }, 'me') === 'draw', '1b. a draw result is a draw');
A(outcomeOf({ game: { result: 'stalemate' } }, 'me') === 'draw', '1c. stalemate too');
A(outcomeOf({ game: { winner: 'w' }, color: 'w' }, 'me') === 'won',
  '2. CHESS: the winner is a COLOUR — comparing it to a player id would report '
  + 'every chess game as a loss');
A(outcomeOf({ game: { winner: 'b' }, color: 'w' }, 'me') === 'lost', '2a. and the other colour is a loss');
A(outcomeOf({ game: { winner: 'w' } }, 'me') === 'ended',
  '2b. a colour with no colour of our own is UNKNOWN, not a guess');
A(outcomeOf({ game: {} }, 'me') === 'ended' && outcomeOf(null, 'me') === 'ended',
  '3. a snapshot that says nothing records "ended", never a win');

// ── opponents ─────────────────────────────────────────────────────────
const opp = opponentsOf({ game: { players: [{ id: 'me', name: 'Me' }, { id: 'x', name: 'Ravi' }] } }, 'me');
A(opp.length === 1 && opp[0] === 'Ravi', '4. lists the others and never yourself');
A(opponentsOf({ lobby: { members: [{ vaultId: 'b', name: 'Robo', isBot: true }] } }, 'me')[0] === 'Robo (bot)',
  '4a. a bot is labelled a bot — the same rule the tables follow');
const dup = opponentsOf({
  game: { players: [{ id: 'x', name: 'Ravi' }] },
  lobby: { members: [{ vaultId: 'x', name: 'Ravi' }] },
}, 'me');
A(dup.length === 1, '4b. a player in both the game and the lobby is listed once');
A(opponentsOf({}, 'me').length === 0, '4c. nothing to read means nobody, not "Player"');

// ── detail ────────────────────────────────────────────────────────────
A(detailOf({ game: { result: 'Robo wins' } }, 'lost') === 'Robo wins', "5. the server's own words win");
A(detailOf({ settlement: { me: { delta: 40 } } }, 'won') === '+40 coins', '5a. a settlement reads as coins');
A(detailOf({ settlement: { me: { delta: -25 } } }, 'lost') === '-25 coins', '5b. including a loss');
A(detailOf({}, 'draw') === 'Draw', '5c. and a bare outcome still says something true');
A(detailOf({ settlement: { me: { delta: 0 } } }, 'lost') === 'You lost',
  '5d. a ZERO delta says nothing and must not displace the outcome — a rummy loss '
  + 'read "+0 coins" on device');
A(detailOf({ settlement: { them: { delta: 40 }, me: { delta: -40 } } }, 'lost', 'me') === '-40 coins',
  '5e. MY delta, not whoever the server listed first — the first-value read '
  + "showed another player's coins as mine");

// ── moves ─────────────────────────────────────────────────────────────
A(JSON.stringify(movesOf({ game: { history: ['e4', 'e5'] } })) === '["e4","e5"]', '6. plain SAN moves');
A(movesOf({ game: { history: [{ from: 'e2', to: 'e4' }] } })?.[0] === 'e2e4',
  '6a. object moves fall back to from+to rather than "[object Object]"');
A(movesOf({ game: {} }) === undefined && movesOf(null) === undefined, '6b. no history is undefined, not []');

// ── the two caps ──────────────────────────────────────────────────────
const rec = (game: any, at: number, moves?: string[]): GameRecord =>
  ({ game, room: 'r' + at, at, outcome: 'won', opponents: [], detail: 'x', moves });

const manyChess = capHistory(Array.from({ length: 10 }, (_, i) => rec('chess', 1000 + i, ['e4'])));
A(manyChess.filter(r => r.moves?.length).length === MOVES_KEPT,
  `7. only the newest ${MOVES_KEPT} chess games keep their moves`);
A(manyChess.length === 10,
  '7a. and the older ones are KEPT without moves — the result outlives the move list');
A(manyChess[0].at === 1009, '7b. newest first');

const flood = capHistory(Array.from({ length: 40 }, (_, i) => rec('ludo', i)));
A(flood.length === RESULTS_KEPT, `8. results are capped at ${RESULTS_KEPT} per game`);
A(flood.every(r => !r.moves), '8a. and non-chess games never carry moves');

const mixed = capHistory([...Array.from({ length: 30 }, (_, i) => rec('ludo', i)),
                          ...Array.from({ length: 30 }, (_, i) => rec('rummy', 100 + i))]);
A(mixed.filter(r => r.game === 'ludo').length === RESULTS_KEPT
  && mixed.filter(r => r.game === 'rummy').length === RESULTS_KEPT,
  '8b. the cap is PER GAME — a busy rummy week must not erase every chess game');

// ── the same finished snapshot arrives over and over ──────────────────
A(isSameGame(rec('ludo', 1000), { ...rec('ludo', 1000), at: 1000 + 60_000 }),
  '9. the same table seconds apart is ONE game — a finished snapshot repeats on '
  + 'every frame until the player leaves');
A(!isSameGame(rec('ludo', 1000), { ...rec('ludo', 1000), at: 1000 + 10 * 60_000 }),
  '9a. but a rematch on the same table later is a new game');

// ── the timestamp ─────────────────────────────────────────────────────
const now = Date.now();
A(whenLabel(now - 30_000, now) === 'just now', '10. under a minute');
A(whenLabel(now - 5 * 60_000, now) === '5m ago', '10a. minutes');
A(whenLabel(now - 3 * 3600_000, now) === '3h ago', '10b. hours');
A(whenLabel(now + 3600_000, now) === '', '10c. a future timestamp renders NOTHING, not "-60m ago"');
A(whenLabel(NaN, now) === '', '10d. and so does junk');

// ── it is wired to the one place that sees a finished game ────────────
const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const HOOK = code(read('lib/games/useGameSocket.ts'));
A(/if \(isFinishedSnapshot\(s\)\)/.test(HOOK),
  '11z. the hook uses the SHARED finished rule, not a truthiness test on `result`');
A(/void recordGame\(\{/.test(HOOK),
  '11. a finished snapshot is recorded from useGameSocket — the one place all '
  + 'four boards share, so no game can forget to do it');
A(/moves: game === 'chess' \? movesOf\(s\) : undefined/.test(HOOK),
  '11a. and only chess carries moves');
A(/<HistorySheet/.test(read('app/games.tsx')), '11b. the hub can show it');

console.log(failed === 0 ? '\nAll good.\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
