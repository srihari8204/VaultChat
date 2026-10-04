// lib/games/ludoBoard.ts — where a ludo token sits on the 15x15 board.
//
// Moved out of components/games/Ludo.tsx (2026-10 round 4) so the geometry can
// be checked in Node (lib/games/ludoBoard.selftest.ts and ludoGlass.selftest).
// It decides nothing about the game — no captures, no safe-square rule, no
// six-rolls-again; the server sends `movable` for that.
//
// GEOMETRY IS COPIED FROM THE REFERENCE CLIENT, NOT RE-DERIVED. RING,
// START_OFFSET, HOME_COORDS and BASE_SPOTS below are the same tables
// games-web/ludo.js uses, and that file carries an explicit warning that they
// must match go-server/internal/games/ludo. A second, independently invented
// mapping would put tokens on the wrong squares for the same authoritative
// state — the kind of bug that looks like a server fault and is not.
//
// Token step encoding (server): -1 base · 0..50 ring · 51..55 home column ·
// 56 HOME (finished).

/** 52-cell ring [row,col] on a 15x15 board, clockwise from red's start. */
export const RING: [number, number][] = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],
  [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0],
];
export const START_OFFSET = [0, 13, 26, 39];
export const HOME_STEP = 56;
export const CENTER_RC: [number, number] = [7, 7];
export const HOME_COORDS: [number, number][][] = [
  [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],       // 0 red (left)
  [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],       // 1 green (top)
  [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],   // 2 yellow (right)
  [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],   // 3 blue (bottom)
];
export const BASE_SPOTS: [number, number][][] = [
  [[1,1],[1,4],[4,1],[4,4]], [[1,10],[1,13],[4,10],[4,13]],
  [[10,10],[10,13],[13,10],[13,13]], [[10,1],[10,4],[13,1],[13,4]],
];

/** Safe ring cells — starts and star squares. Decorative; the server enforces. */
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/** Yard origin [row,col] per corner, each 6x6 of the 15x15 grid. */
export const YARD_RC: [number, number][] = [[0, 0], [0, 9], [9, 9], [9, 0]];

/**
 * Where a token sits, given its owner's corner and its step.
 *
 * Total by construction. Every lookup here is indexed by data that arrives off
 * the wire, and returning `undefined` for an unexpected seat or step crashes
 * the whole board at the destructure rather than misplacing one disc — which
 * is exactly what happened when `step` was accidentally undefined.
 */
export function coord(corner: number, tokenIdx: number, step: number): [number, number] {
  const c = Number.isInteger(corner) && corner >= 0 && corner < 4 ? corner : 0;
  const i = Number.isInteger(tokenIdx) && tokenIdx >= 0 && tokenIdx < 4 ? tokenIdx : 0;
  const s = Number.isFinite(step) ? step : -1;
  if (s < 0) return BASE_SPOTS[c][i];
  if (s <= 50) return RING[(START_OFFSET[c] + s) % 52];
  if (s >= HOME_STEP) return CENTER_RC;
  return HOME_COORDS[c][Math.max(0, Math.min(s - 51, 4))];
}

/**
 * A token IS its step. The server sends `Tokens []int` and the web client reads
 * them straight through (`p.tokens.filter(s => s >= HOME_STEP)`); wrapping them
 * in `{step}` produced `undefined` everywhere and crashed the board the moment
 * a game started, because `coord()` then returned undefined and the caller
 * destructured it.
 */
export type LPlayer = { id?: string; vaultId?: string; name: string; seat: number; tokens: number[]; isBot?: boolean };

export const pid = (p: LPlayer) => p.id ?? p.vaultId ?? '';
