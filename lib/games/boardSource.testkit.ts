// lib/games/boardSource.testkit.ts — TEST-ONLY helper (uses node:fs; never
// import it from app code, it would break assembleRelease).
//
// The boards were split (2026-10 round 4): components/games/Chess.tsx keeps the
// board and its pieces live beside it in components/games/chess/, and the same
// for ludo/ and rummy/. The source-level selftests assert properties of a BOARD
// ("chess takes its moves from `legal`", "the hand card is memoised"), not of
// one file, so they read the board as its main file followed by every file in
// its folder. The main file comes first, so a check that slices the source at
// a marker still sees the component before its pieces.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GAMES = join(__dirname, '..', '..', 'components', 'games');

export function boardSource(name: 'Chess' | 'Ludo' | 'Rummy' | 'TicTacToe'): string {
  const main = readFileSync(join(GAMES, `${name}.tsx`), 'utf8');
  const dir = join(GAMES, name.toLowerCase());
  if (!existsSync(dir)) return main;
  const parts = readdirSync(dir)
    .filter(f => /\.tsx?$/.test(f) && !f.endsWith('.selftest.ts'))
    .sort()
    .map(f => readFileSync(join(dir, f), 'utf8'));
  return [main, ...parts].join('\n');
}

/** A repo file, for the few checks that follow a value into lib/games. */
export function repoSource(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

/** A repo file by path, with a board's main file read as the whole board. */
export function readRepo(rel: string): string {
  const m = rel.match(/^components\/games\/(Chess|Ludo|Rummy|TicTacToe)\.tsx$/);
  return m ? boardSource(m[1] as 'Chess' | 'Ludo' | 'Rummy' | 'TicTacToe') : repoSource(rel);
}
