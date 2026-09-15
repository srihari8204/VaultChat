// lib/games/match.ts — Pool (101/201) and Deals (best-of-2/6) rummy.
//
// The games server plays ONE format: 13-card Points rummy. docs/GAMES_PROTOCOL.md
// is explicit — "no pool score, no elimination and no deal count, and the engine
// only ever settles a single deal at a time" — and it is a separate deployment
// we do not own the source of.
//
// Pool and Deals are only scoring wrappers around repeated Points deals, and the
// server already gives us both inputs: each deal's per-player result, and
// `start` to re-deal the same table. So a match is server-owned deals plus a
// score crazzychat owns (GET/POST /games/matches, migration 126).
//
// NOTHING HERE SCORES ANYTHING. The rules live in the Go handler and only
// there — a pool total decides who is ELIMINATED, so every seat must agree on
// it, and a device that missed a deal while reconnecting would otherwise carry a
// different total from everyone else. This file reports what the games server
// said and renders what the backend answers. Same thin-client rule as the rest
// of the games code.
//
// TOLERANT OF A BACKEND THAT HAS NOT SHIPPED YET. Migration 126 and the Go
// handlers are written but the deploy is the owner's to run, so until then every
// call here 404s. That MUST read as "this table has no match" and never as an
// error over a working game — the same rule useLiveTables follows, and the same
// failure the game-invite card hit when migration 124 was undeployed ("Could not
// send the invite — invalid type").

// Lazy-require, so a Node-run selftest that imports the pure helpers below does
// not drag in ../api and, through it, all of react-native. Same pattern and same
// reason as the RTC require in useTableVoice.ts. The pure half of this file is
// the half worth checking off-device, and a top-level import would make that
// impossible.
function apiCall<T>(path: string, init?: any): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../api').api as (p: string, i?: any) => Promise<T>)(path, init);
}

/** The four formats, as the backend names them. */
export type MatchVariant = 'pool101' | 'pool201' | 'deals2' | 'deals6';

export interface MatchScore {
  name: string;
  points: number;
  chips: number;
  status: 'playing' | 'out';
}

export interface Match {
  id: string;
  tableId: string;
  variant: MatchVariant;
  status: 'running' | 'finished';
  dealsPlayed: number;
  /** 101 or 201 for a pool, 0 otherwise. Published so the app renders "83 / 101". */
  poolLimit: number;
  /** 2 or 6 for a deals match, 0 otherwise. */
  dealsTotal: number;
  scores: Record<string, MatchScore>;
}

/** One player's outcome in a single deal, as the games server reported it. */
export interface DealResult {
  vaultId: string;
  name: string;
  points: number;
  winner: boolean;
}

export const VARIANTS: { id: MatchVariant; label: string; blurb: string }[] = [
  { id: 'pool101', label: 'Pool 101', blurb: 'Out at 101 points. Last player standing wins.' },
  { id: 'pool201', label: 'Pool 201', blurb: 'Out at 201 points. A longer game.' },
  { id: 'deals2',  label: 'Deals — best of 2', blurb: 'Two deals. Most chips wins.' },
  { id: 'deals6',  label: 'Deals — best of 6', blurb: 'Six deals. Most chips wins.' },
];

export function variantLabel(v: MatchVariant | null | undefined): string {
  return VARIANTS.find(x => x.id === v)?.label ?? 'Points rummy';
}

/**
 * Read whatever the server sent into a Match, or null.
 *
 * Defensive because the alternative is a crash on a live board: one malformed
 * field must degrade to "no match", never to a render error inside a game.
 */
export function matchOf(raw: any): Match | null {
  const m = raw?.match ?? raw;
  if (!m || typeof m !== 'object') return null;
  if (typeof m.id !== 'string' || !m.id) return null;
  if (typeof m.variant !== 'string') return null;

  const scores: Record<string, MatchScore> = {};
  const src = m.scores && typeof m.scores === 'object' ? m.scores : {};
  for (const id of Object.keys(src)) {
    const s = src[id] ?? {};
    scores[id] = {
      name: typeof s.name === 'string' && s.name ? s.name : id,
      points: num(s.points),
      chips: num(s.chips),
      status: s.status === 'out' ? 'out' : 'playing',
    };
  }

  return {
    id: m.id,
    tableId: typeof m.tableId === 'string' ? m.tableId : '',
    variant: m.variant as MatchVariant,
    status: m.status === 'finished' ? 'finished' : 'running',
    dealsPlayed: num(m.dealsPlayed),
    poolLimit: num(m.poolLimit),
    dealsTotal: num(m.dealsTotal),
    scores,
  };
}

/** A string where a number belongs must not survive as one, and must not be NaN. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/** The running match at a table, or null when there is none (or no backend). */
export async function getMatch(tableId: string): Promise<Match | null> {
  if (!tableId) return null;
  try {
    return matchOf(await apiCall<any>(`/games/matches?tableId=${encodeURIComponent(tableId)}`));
  } catch {
    return null;
  }
}

/**
 * Open a match at a table, or join the one already running there.
 *
 * `practice` is asserted by the caller and the backend refuses anything else: a
 * staked table already settles coins on every deal, so a pool over one would
 * charge a player per deal AND per match.
 */
export async function openMatch(
  tableId: string, variant: MatchVariant, practice: boolean,
): Promise<Match | null> {
  try {
    return matchOf(await apiCall<any>('/games/matches', {
      method: 'POST',
      body: JSON.stringify({ tableId, variant, practice }),
    }));
  } catch {
    return null;
  }
}

/**
 * Report one deal's result.
 *
 * EVERY SEAT CALLS THIS for the same deal — the backend's deal index makes it
 * exactly-once, so the five that lose the race simply read back the winner's
 * state. Do not try to elect a reporter on the client: whichever device you
 * pick can be the one that disconnected.
 */
export async function advanceMatch(
  matchId: string, dealIndex: number, results: DealResult[],
): Promise<Match | null> {
  if (!matchId || !results.length) return null;
  try {
    return matchOf(await apiCall<any>('/games/matches/deal', {
      method: 'POST',
      body: JSON.stringify({ matchId, dealIndex, results }),
    }));
  } catch {
    return null;
  }
}

/** Everyone still in the match, best first — the scoreboard's order. */
export function standings(m: Match): (MatchScore & { vaultId: string })[] {
  const rows = Object.keys(m.scores).map(id => ({ vaultId: id, ...m.scores[id] }));
  // A pool is won by the LOWEST score and a deals match by the highest, so the
  // sort has to know which game it is. Sorting one like the other silently puts
  // the loser at the top of the board.
  const pool = m.poolLimit > 0;
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'playing' ? -1 : 1;
    return pool ? a.points - b.points : b.chips - a.chips;
  });
}

/** What the scoreboard header says: progress through the match. */
export function progressLabel(m: Match): string {
  if (m.dealsTotal > 0) return `Deal ${Math.min(m.dealsPlayed + 1, m.dealsTotal)} of ${m.dealsTotal}`;
  return m.dealsPlayed === 1 ? '1 deal played' : `${m.dealsPlayed} deals played`;
}

/**
 * Build the deal report from the games server's own end-of-deal snapshot.
 *
 * `players[].points` and `winnerId` are the server's numbers; nothing is
 * computed here. A seat with no id is dropped rather than reported under an
 * empty key, which would collide every such player into one scoreboard row.
 */
export function resultsFrom(players: any[], winnerId: string | null | undefined): DealResult[] {
  if (!Array.isArray(players)) return [];
  const out: DealResult[] = [];
  for (const p of players) {
    const id = p?.vaultId ?? p?.id;
    if (!id || typeof id !== 'string') continue;
    out.push({
      vaultId: id,
      name: typeof p?.name === 'string' && p.name ? p.name : id,
      points: num(p?.points),
      winner: !!winnerId && id === winnerId,
    });
  }
  return out;
}
