// lib/games/boardLabels.ts — what a screen reader says for each thing on a board.
//
// Pure and React-free so the wording can be checked in Node
// (lib/games/boardLabels.selftest.ts). Nothing here decides anything about the
// game: every input is a fact the server already sent and the board already
// draws. Piece words come from pieceNames.ts, because Chess.tsx is checked to
// carry no rules vocabulary (lib/games/gamesNative.selftest.ts).

import { PIECE_NAME } from './pieceNames';

/* ── chess ─────────────────────────────────────────────────────────── */

const FILES = 'abcdefgh';

/** "e4". Index 0 = a8, 63 = h1 — the wire convention. */
export function chessSquareName(sq: number): string {
  return `${FILES[sq & 7]}${8 - (sq >> 3)}`;
}

/**
 * "e4, white knight, can capture, last move".
 *
 * TAKES THE REAL SQUARE, NOT THE DRAWN POSITION. It used to take the display
 * index, so on a flipped board — every game the player has black — each square
 * was announced with its mirrored name: the pawn on e4 read as "d5". Selection
 * is carried by accessibilityState, so it is not repeated here.
 */
export function chessSquareLabel(
  sq: number,
  piece: { t: string; c: 'w' | 'b' } | null,
  o: { target?: boolean; capture?: boolean; check?: boolean; last?: boolean } = {},
): string {
  const what = piece ? `${piece.c === 'w' ? 'white' : 'black'} ${PIECE_NAME[piece.t] ?? piece.t}` : 'empty';
  const hint = o.capture ? ', can capture' : o.target ? ', can move here' : '';
  return `${chessSquareName(sq)}, ${what}${hint}${o.check ? ', king in check' : ''}${o.last ? ', last move' : ''}`;
}

/** Said when a piece is picked up: where it is and how many moves it has. */
export function chessSelectionAnnouncement(sq: number, piece: { t: string; c: 'w' | 'b' } | null, moves: number): string {
  const name = piece ? `${PIECE_NAME[piece.t] ?? piece.t} on ${chessSquareName(sq)}` : chessSquareName(sq);
  return `${name} selected, ${moves} ${moves === 1 ? 'move' : 'moves'}. Choose a square marked can move here.`;
}

/* ── ludo ──────────────────────────────────────────────────────────── */

/** The server's step encoding: -1 base · 0..50 ring · 51..55 home column · 56 home. */
const LUDO_HOME = 56;

/** Where a token is, in words a player can follow along the track. */
export function ludoTokenPosition(step: number): string {
  if (!Number.isFinite(step) || step < 0) return 'in base';
  if (step >= LUDO_HOME) return 'home';
  if (step <= 50) return `square ${step + 1} of 51`;
  return `home column, ${step - 50} of 5`;
}

/** "Ludo token 2, red, square 14 of 51, can move". */
export function ludoTokenLabel(color: string, index: number, step: number, movable: boolean): string {
  return `Ludo token ${index + 1}, ${color.toLowerCase()}, ${ludoTokenPosition(step)}${movable ? ', can move' : ''}`;
}

/* ── rummy ─────────────────────────────────────────────────────────── */

const RANK_NAME: Record<string, string> = { A: 'ace', J: 'jack', Q: 'queen', K: 'king' };
const SUIT_NAME: Record<string, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

/** "7 of hearts", "king of spades", "joker". */
export function rummyCardName(c: { suit: string; rank: string }): string {
  if (c.suit === 'JOKER' || !c.rank) return 'joker';
  return `${RANK_NAME[c.rank] ?? c.rank} of ${SUIT_NAME[c.suit] ?? c.suit}`;
}

/**
 * "7 of hearts, wild, group 2, pure sequence". `group` is the tray's own
 * label; selection is carried by accessibilityState, not repeated here.
 */
export function rummyCardLabel(c: { suit: string; rank: string }, o: { wild?: boolean; group?: string } = {}): string {
  const name = rummyCardName(c);
  return `${name}${o.wild && name !== 'joker' ? ', wild' : ''}${o.group ? `, ${o.group}` : ''}`;
}

/* ── emotes ────────────────────────────────────────────────────────── */

const EMOTE_NAME: Record<string, string> = {
  '👍': 'thumbs up', '😂': 'laughing', '😮': 'surprised', '😢': 'sad', '🔥': 'fire',
  '👏': 'applause', '🎲': 'dice', '🍀': 'four-leaf clover', '😎': 'cool', '💀': 'skull', '🤝': 'handshake',
};

/** "Send thumbs up" — a word a screen reader says the same on every platform. */
export function emoteLabel(emoji: string): string {
  return `Send ${EMOTE_NAME[emoji] ?? emoji}`;
}

/* ── tic-tac-toe ───────────────────────────────────────────────────── */

const MARK_NAME = ['cross', 'nought'];

/** "row 1, column 2, cross, yours" / "row 3, column 3, empty, tap to play". */
export function tttCellLabel(i: number, value: number, mySeat: number | null, playable: boolean): string {
  const where = `row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}`;
  if (value < 0) return `${where}, empty${playable ? ', tap to play' : ''}`;
  const whose = mySeat == null ? '' : value === mySeat ? ', yours' : ", opponent's";
  return `${where}, ${MARK_NAME[value] ?? 'mark'}${whose}`;
}
