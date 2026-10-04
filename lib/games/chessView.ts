// lib/games/chessView.ts — the chess board's read-outs, derived from a frame.
//
// Moved out of components/games/Chess.tsx so they can be checked in Node
// (lib/games/chessView.selftest.ts). PRESENTATION ONLY: every function reads a
// fact the server already sent — the board, the clock, the roster, the result —
// and none of them decides anything about the game. Move legality stays the
// server's `legal` list (see lib/games/gamesNative.selftest.ts).

import type { GameState } from './useGameSocket';

export type Piece = { t: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'; c: 'w' | 'b' } | null;

/**
 * Filled glyphs for BOTH colours, tinted rather than outlined. Used for the
 * captured-material readout and the seat badges; the board draws vector paths.
 */
export const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

/** Material value per piece letter, for the captured-material readout. */
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** A full starting army, by letter. Used only to derive what has been taken. */
const ARMY: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

/** What each side has lost, plus the material edge. Presentation only. */
export function takenBy(board: Piece[]): { w: string[]; b: string[]; edge: number } {
  const alive: Record<'w' | 'b', Record<string, number>> = { w: {}, b: {} };
  for (const p of board) if (p) alive[p.c][p.t] = (alive[p.c][p.t] ?? 0) + 1;
  const out = { w: [] as string[], b: [] as string[], edge: 0 };
  for (const side of ['w', 'b'] as const) {
    for (const letter of Object.keys(ARMY)) {
      const gone = ARMY[letter] - (alive[side][letter] ?? 0);
      for (let i = 0; i < gone; i++) out[side].push(GLYPH[letter]);
      out.edge += (side === 'b' ? 1 : -1) * gone * VALUE[letter];
    }
  }
  return out;
}

export function clockFor(state: GameState, color: 'w' | 'b'): string | null {
  const c = state.raw?.clock;
  const ms = c && typeof c === 'object' ? c[color] : null;
  if (typeof ms !== 'number' || !isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The name this client plays under. Falls back to a label, never to an id. */
export function youName(state: GameState): string {
  const me = (state.lobby?.members ?? []).find(m => m.vaultId === state.you);
  return me?.name ?? 'You';
}

/** Whether the other seat is a bot, from the roster the server sent. */
export function opponentIsBot(state: GameState): boolean {
  const them = (state.lobby?.members ?? []).find(m => m.vaultId !== state.you);
  return !!them?.isBot;
}

/**
 * What a seat is doing, for the card's second line.
 *
 * Derived from the same frame the board renders — there is no separate seat
 * state to fall out of step with it.
 */
export function roleOf(state: GameState, game: any, isYou: boolean, mine: boolean): string {
  if (game?.result) return 'Game over';
  if (isYou) {
    if (state.spectator) return 'Watching';
    return mine ? (game?.check ? 'You are in check' : 'Play your move') : 'Waiting';
  }
  const bot = opponentIsBot(state);
  if (!mine) return bot ? 'Thinking…' : 'To move';
  return bot ? 'AI Challenger' : 'Waiting';
}

export function opponentName(state: GameState): string {
  const them = (state.lobby?.members ?? []).find(m => m.vaultId !== state.you);
  return them?.name ?? 'Opponent';
}

export function resultText(game: any, myColor: 'w' | 'b' | null): string {
  if (game.result === 'draw') return 'Draw';
  if (game.winner) return `${game.winner === myColor ? 'You win' : 'You lose'}`;
  return String(game.result ?? 'Game over');
}

export function pairUp(history: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    out.push(`${i / 2 + 1}. ${history[i] ?? ''} ${history[i + 1] ?? ''}`.trimEnd());
  }
  return out.join('   ');
}
