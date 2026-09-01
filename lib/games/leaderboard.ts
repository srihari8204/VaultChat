// lib/games/leaderboard.ts — reading the games server's standings.
//
// `GET /api/leaderboard[?game=<kind>]` answers
//
//   { ok: true, game: 'chess' | null,
//     leaderboard: [{ vaultId, name, balance, wins, rating, streak, best }] }
//
// and the two forms are NOT the same table:
//
//   GLOBAL (no `game`)  — every row's `rating` is 0. It ranks by coin balance
//                         across all four games.
//   PER-GAME (`?game=`) — rows carry a real Elo, 1200 being the unplayed
//                         starting value.
//
// Showing "0" as a rating on the global board would be reporting a number the
// server never claimed, so `headline` below picks the stat each form actually
// has. The SERVER owns the ordering and the cut — it returns ten rows and
// ignores `?limit=` — so nothing here re-sorts or re-ranks. A client that
// sorted the table itself would be showing a standing the server would not
// agree with, which is the same class of mistake as a client deciding its own
// balance.
//
// The parsing is deliberately paranoid: this is JSON off the network, the rows
// carry other players' display names, and one malformed row must not blank the
// whole board.

export type LeaderScope = 'all' | 'chess' | 'rummy' | 'ludo' | 'tictactoe';

export interface LeaderRow {
  vaultId: string;
  name: string;
  balance: number;
  wins: number;
  rating: number;
  streak: number;
  best: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One row, or null if it is not usable.
 *
 * A row with no `vaultId` is dropped rather than defaulted: the id is what says
 * which line is yours, and an empty one would match the player whose session
 * had not resolved yet and highlight a stranger as "you".
 */
export function parseRow(v: unknown): LeaderRow | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const vaultId = typeof r.vaultId === 'string' ? r.vaultId.trim() : '';
  if (!vaultId) return null;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : vaultId;
  return {
    vaultId,
    name,
    balance: num(r.balance),
    wins: num(r.wins),
    rating: num(r.rating),
    streak: num(r.streak),
    best: num(r.best),
  };
}

/** The whole payload. Anything unparseable yields an empty board, never a throw. */
export function parseLeaderboard(json: unknown): LeaderRow[] {
  if (!json || typeof json !== 'object') return [];
  const list = (json as Record<string, unknown>).leaderboard;
  if (!Array.isArray(list)) return [];
  return list.map(parseRow).filter((r): r is LeaderRow => r !== null);
}

/**
 * The stat that ranks THIS board, with the label to print beside it.
 *
 * Global has no rating, so it shows the balance it is actually ordered by.
 */
export function headline(row: LeaderRow, scope: LeaderScope): { label: string; value: string } {
  return scope === 'all'
    ? { label: 'coins', value: String(row.balance) }
    : { label: 'rating', value: String(row.rating) };
}

/** 🥇🥈🥉 for the podium, the plain number below it. `i` is zero-based. */
export function medal(i: number): string {
  return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);
}

/**
 * The secondary line: wins, and a streak only when there is one.
 *
 * A "0 streak" is noise on nine rows out of ten, and `best` only means anything
 * once it is above the current run.
 */
export function detail(row: LeaderRow): string {
  const bits = [`${row.wins} ${row.wins === 1 ? 'win' : 'wins'}`];
  if (row.streak > 0) bits.push(`${row.streak} in a row`);
  if (row.best > row.streak) bits.push(`best ${row.best}`);
  return bits.join(' · ');
}
