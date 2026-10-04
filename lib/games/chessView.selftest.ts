// lib/games/chessView.selftest.ts — run: npx tsx lib/games/chessView.selftest.ts
import assert from 'node:assert/strict';
import type { GameState } from './useGameSocket';
import { takenBy, clockFor, youName, opponentIsBot, opponentName, roleOf, resultText, pairUp, type Piece } from './chessView';

let n = 0;
const eq = (a: unknown, b: unknown, what: string) => { assert.deepEqual(a, b, what); n++; };

// A full army minus white's queen and one black pawn.
const army = (c: 'w' | 'b'): Piece[] => ([
  ...'rnbqkbnr'.split(''), ...'pppppppp'.split(''),
] as NonNullable<Piece>['t'][]).map(t => ({ t, c }));
const board = [...army('b').slice(0, 15), ...army('w').filter(p => p!.t !== 'q')];
const cap = takenBy(board);
eq(cap.w, ['♛'], '1a. white lost the queen');
eq(cap.b, ['♟'], '1b. black lost a pawn');
eq(cap.edge, -8, '1c. black is ahead by 9 - 1');
eq(takenBy([...army('w'), ...army('b')]).edge, 0, '1d. nothing taken, level');

const st = (over: Partial<GameState>): GameState => ({
  you: 'me', seat: null, spectator: false, lobby: null, game: null, raw: null, ...over,
} as GameState);
eq(clockFor(st({ raw: { clock: { w: 65_400, b: 0 } } }), 'w'), '1:05', '2a. clock rounds to seconds');
eq(clockFor(st({ raw: { clock: { w: 65_400, b: -5 } } }), 'b'), '0:00', '2b. never negative');
eq(clockFor(st({ raw: {} }), 'w'), null, '2c. no clock frame shows nothing, not a zero');
eq(clockFor(st({ raw: { clock: { w: Number.NaN } } }), 'w'), null, '2d. junk is nothing');

const lobby = { status: 'playing', members: [{ vaultId: 'me', name: 'Asha' }, { vaultId: 'b1', name: 'Bot', isBot: true }] } as any;
eq(youName(st({ lobby })), 'Asha', '3a. own name from the roster');
eq(youName(st({})), 'You', '3b. never an id');
eq(opponentName(st({ lobby })), 'Bot', '3c. opponent name');
eq(opponentName(st({})), 'Opponent', '3d. fallback');
eq(opponentIsBot(st({ lobby })), true, '3e. bot flag from the roster');

eq(roleOf(st({ lobby }), { result: 'mate' }, true, true), 'Game over', '4a. result first');
eq(roleOf(st({ lobby }), {}, true, true), 'Play your move', '4b. your move');
eq(roleOf(st({ lobby }), { check: true }, true, true), 'You are in check', '4c. in check');
eq(roleOf(st({ lobby, spectator: true }), {}, true, false), 'Watching', '4d. spectator');
eq(roleOf(st({ lobby }), {}, false, false), 'Thinking…', '4e. bot to move');
eq(roleOf(st({ lobby }), {}, false, true), 'AI Challenger', '4f. bot waiting');

eq(resultText({ result: 'draw' }, 'w'), 'Draw', '5a. draw');
eq(resultText({ result: 'mate', winner: 'w' }, 'w'), 'You win', '5b. winner is a colour');
eq(resultText({ result: 'mate', winner: 'b' }, 'w'), 'You lose', '5c. loss');
eq(resultText({ result: 'abandoned' }, null), 'abandoned', '5d. other results pass through');

eq(pairUp(['e4', 'e5', 'Nf3']), '1. e4 e5   2. Nf3', '6a. moves paired by number');
eq(pairUp([]), '', '6b. empty');

console.log(`chessView.selftest: ${n} passed`);
