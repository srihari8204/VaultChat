// lib/games/boardLabels.selftest.ts — run: npx tsx lib/games/boardLabels.selftest.ts
import assert from 'node:assert/strict';
import {
  chessSquareName, chessSquareLabel, chessSelectionAnnouncement,
  ludoTokenPosition, ludoTokenLabel, rummyCardName, rummyCardLabel, tttCellLabel, emoteLabel,
} from './boardLabels';

let n = 0;
const eq = (a: unknown, b: unknown, what: string) => { assert.deepEqual(a, b, what); n++; };

// chess: index 0 = a8, 63 = h1; e4 is row 4 (rank 4), col 4.
eq(chessSquareName(0), 'a8', '1a. a8');
eq(chessSquareName(63), 'h1', '1b. h1');
const e4 = 4 * 8 + 4;
eq(chessSquareName(e4), 'e4', '1c. e4');
eq(chessSquareLabel(e4, { t: 'n', c: 'w' }), 'e4, white knight', '1d. piece name, not a letter');
eq(chessSquareLabel(e4, null, { target: true }), 'e4, empty, can move here', '1e. empty target');
eq(chessSquareLabel(e4, { t: 'p', c: 'b' }, { target: true, capture: true, last: true }),
  'e4, black pawn, can capture, last move', '1f. capture outranks move, last move appended');
eq(chessSquareLabel(60, { t: 'k', c: 'w' }, { check: true }), 'e1, white king, king in check', '1g. check');
eq(chessSelectionAnnouncement(52, { t: 'p', c: 'w' }, 2),
  'pawn on e2 selected, 2 moves. Choose a square marked can move here.', '1h. selection');
eq(chessSelectionAnnouncement(57, { t: 'n', c: 'w' }, 1).startsWith('knight on b1 selected, 1 move.'), true, '1i. singular');

// ludo: the server's step encoding.
eq(ludoTokenPosition(-1), 'in base', '2a. base');
eq(ludoTokenPosition(Number.NaN), 'in base', '2b. junk is base, never a crash');
eq(ludoTokenPosition(0), 'square 1 of 51', '2c. first ring square');
eq(ludoTokenPosition(50), 'square 51 of 51', '2d. last ring square');
eq(ludoTokenPosition(51), 'home column, 1 of 5', '2e. home column');
eq(ludoTokenPosition(55), 'home column, 5 of 5', '2f. end of home column');
eq(ludoTokenPosition(56), 'home', '2g. home');
eq(ludoTokenLabel('Red', 1, 13, true), 'Ludo token 2, red, square 14 of 51, can move', '2h. full label');
eq(ludoTokenLabel('Blue', 0, -1, false), 'Ludo token 1, blue, in base', '2i. not movable');

// rummy
eq(rummyCardName({ suit: 'H', rank: '7' }), '7 of hearts', '3a. pip card');
eq(rummyCardName({ suit: 'S', rank: 'K' }), 'king of spades', '3b. face card spoken as a word');
eq(rummyCardName({ suit: 'D', rank: 'A' }), 'ace of diamonds', '3c. ace');
eq(rummyCardName({ suit: 'JOKER', rank: '' }), 'joker', '3d. printed joker');
eq(rummyCardLabel({ suit: 'C', rank: '10' }, { wild: true, group: 'group 2, pure sequence' }),
  '10 of clubs, wild, group 2, pure sequence', '3e. wild + group');
eq(rummyCardLabel({ suit: 'JOKER', rank: '' }, { wild: true }), 'joker', '3f. a joker is not also "wild"');

// tic-tac-toe
eq(tttCellLabel(1, -1, 0, true), 'row 1, column 2, empty, tap to play', '4a. playable empty');
eq(tttCellLabel(8, -1, 0, false), 'row 3, column 3, empty', '4b. not playable');
eq(tttCellLabel(4, 0, 0, false), 'row 2, column 2, cross, yours', '4c. own mark');
eq(tttCellLabel(4, 1, 0, false), "row 2, column 2, nought, opponent's", '4d. their mark');
eq(tttCellLabel(4, 1, null, false), 'row 2, column 2, nought', '4e. spectator: no owner');

// emotes: every emoji either board offers has a spoken name
for (const e of ['👍', '😂', '😮', '😢', '🔥', '👏', '🎲', '🍀', '😎', '💀', '🤝']) {
  eq(/^Send [a-z]/.test(emoteLabel(e)), true, `5a. ${e} is named`);
}
eq(emoteLabel('🦄'), 'Send 🦄', '5b. an unknown emoji falls back to itself, never to nothing');

console.log(`boardLabels.selftest: ${n} passed`);
