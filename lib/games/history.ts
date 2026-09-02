// lib/games/history.ts — the games you have already played.
//
// WHY THIS IS LOCAL, WHICH IS NOT THE USUAL ANSWER HERE
//
// This codebase keeps logic on the backend and lets the app render what the
// server computed. History cannot follow that rule: the games server owns every
// result, it is a separate deployment we do not own the source of, and the only
// thing it tells VaultChat is a turn notification whose kinds are
// turn | invite | friend — there is NO game-over event and no results endpoint.
// So the only party that ever learns how a game ended is the device that was
// playing it, from the final snapshot on its own socket. That makes the device
// the only place a history can be written.
//
// The consequence is stated plainly rather than hidden: history is per device.
// A reinstall loses it, and a game played on the phone does not appear on the
// tablet. If the games server ever grows a results API, this becomes a cache.
//
// WHAT IS KEPT, AND WHY THE TWO LIMITS DIFFER
//
// Chess keeps every move of its last few games, because a move list is the
// thing a chess player actually wants back — and it is small (a few hundred
// short strings). The other three keep a longer run of results but no moves:
// nobody replays a ludo dice sequence, and a rummy hand is meaningless without
// thirteen cards of context the snapshot no longer holds.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GameKind } from '../gamesSocket';

// v2: v1 was written by a build whose finished-check treated chess's
// `result: "playing"` as a finished game, so any v1 store can contain records
// for games that were still being played. There is no migration worth writing
// for a handful of local rows — the key moves and the bad ones are left behind.
const KEY = 'games.history.v2';

/** Chess games that keep their full move list. */
export const MOVES_KEPT = 3;
/** Results kept per game. Small enough to read and write as one JSON blob. */
export const RESULTS_KEPT = 20;

export type GameOutcome = 'won' | 'lost' | 'draw' | 'ended';

/**
 * Values a `result` field carries while the game is STILL RUNNING.
 *
 * Chess sends `result: "playing"` on every frame. Treating any non-empty
 * `result` as "the game is over" therefore recorded a live chess game into the
 * history the moment the board opened — seen on device, filed as
 * "Chess vs Robo — playing" with no outcome. It also dropped the table out of
 * the live-games list while it was still being played.
 */
const IN_PROGRESS = new Set(['playing', 'ongoing', 'in_progress', 'in progress', 'active', 'started', 'live']);

/**
 * Is this snapshot a FINISHED game?
 *
 * The one definition, shared by everything that reacts to a game ending, so a
 * new game's wording cannot be handled two different ways in two files. Each
 * game words it differently and none of the fields is required, so any of them
 * may settle it — but a `result` that merely names the running state settles
 * nothing.
 */
export function isFinishedSnapshot(raw: any): boolean {
  const g = raw?.game ?? raw;
  if (!g || typeof g !== 'object') return false;
  if (g.phase === 'finished') return true;
  if (typeof g.winnerId === 'string' && g.winnerId) return true;
  if (typeof g.winner === 'string' && g.winner) return true;
  const res = typeof g.result === 'string' ? g.result.trim().toLowerCase() : '';
  return !!res && !IN_PROGRESS.has(res);
}

export interface GameRecord {
  game: GameKind;
  room: string;
  /** Epoch ms the result was seen. */
  at: number;
  outcome: GameOutcome;
  /** Who else was at the table, already formatted for display. */
  opponents: string[];
  /** One line the player can read: "Robo wins", "+40 coins", a final score. */
  detail: string;
  /** Chess only, and only for the most recent few: every move, in order. */
  moves?: string[];
}

/**
 * Read the outcome off a finished snapshot.
 *
 * Every game words this differently and none of them is required — a snapshot
 * that says nothing recognisable is recorded as 'ended' rather than guessed at.
 * This reads the server's own fields; it decides no game truth.
 */
export function outcomeOf(raw: any, you: string): GameOutcome {
  const g = raw?.game ?? {};
  if (!isFinishedSnapshot(raw)) return 'ended';
  const winner = typeof g.winnerId === 'string' ? g.winnerId
    : typeof g.winner === 'string' ? g.winner : null;
  const result = typeof g.result === 'string' ? g.result.toLowerCase() : '';
  if (result.includes('draw') || result.includes('stalemate')) return 'draw';
  // Chess reports the winning COLOUR, not a player id.
  if (winner === 'w' || winner === 'b') {
    const mine = typeof raw?.color === 'string' ? raw.color : null;
    if (mine) return winner === mine ? 'won' : 'lost';
    return 'ended';
  }
  if (winner) return winner === you ? 'won' : 'lost';
  if (result) return 'ended';
  return 'ended';
}

/** The other people at the table, by the names the server supplied. */
export function opponentsOf(raw: any, you: string): string[] {
  const seen = new Map<string, string>();
  const add = (id: unknown, name: unknown, isBot?: unknown) => {
    const i = typeof id === 'string' ? id : '';
    if (!i || i === you || seen.has(i)) return;
    const n = typeof name === 'string' && name ? name : 'Player';
    seen.set(i, isBot ? `${n} (bot)` : n);
  };
  for (const p of Array.isArray(raw?.game?.players) ? raw.game.players : []) {
    add(p?.id ?? p?.vaultId, p?.name, p?.isBot);
  }
  for (const m of Array.isArray(raw?.lobby?.members) ? raw.lobby.members : []) {
    add(m?.vaultId, m?.name, m?.isBot);
  }
  return [...seen.values()].slice(0, 5);
}

/** A readable line about how it ended. Falls back to nothing, never to a guess. */
export function detailOf(raw: any, outcome: GameOutcome): string {
  const g = raw?.game ?? {};
  // Only a TERMINAL result is a description of how it ended; "playing" is not.
  if (typeof g.result === 'string' && g.result && isFinishedSnapshot(raw)) return g.result;
  const st = raw?.settlement;
  if (st && typeof st === 'object') {
    const d = Object.values(st as Record<string, any>)
      .map(v => (typeof v?.delta === 'number' ? v.delta : null))
      .find(v => v != null);
    if (typeof d === 'number') return d >= 0 ? `+${d} coins` : `${d} coins`;
  }
  return outcome === 'won' ? 'You won' : outcome === 'lost' ? 'You lost' : outcome === 'draw' ? 'Draw' : 'Finished';
}

/** Chess move list off the snapshot, as strings. */
export function movesOf(raw: any): string[] | undefined {
  const h = raw?.game?.history;
  if (!Array.isArray(h) || h.length === 0) return undefined;
  return h.map((m: any) => (typeof m === 'string' ? m : m?.san ?? `${m?.from ?? ''}${m?.to ?? ''}`))
    .filter((s: string) => !!s)
    .slice(0, 400);
}

/**
 * Apply the two caps.
 *
 * Newest first. Every game keeps RESULTS_KEPT results; only the newest
 * MOVES_KEPT chess games keep their moves, and older ones are stripped rather
 * than dropped — the result is still worth having after the moves stop being.
 */
export function capHistory(list: GameRecord[]): GameRecord[] {
  const sorted = [...list].sort((a, b) => b.at - a.at);
  const perGame = new Map<string, number>();
  let chessWithMoves = 0;
  const out: GameRecord[] = [];
  for (const r of sorted) {
    const n = (perGame.get(r.game) ?? 0) + 1;
    if (n > RESULTS_KEPT) continue;
    perGame.set(r.game, n);
    if (r.game === 'chess' && r.moves?.length) {
      chessWithMoves += 1;
      out.push(chessWithMoves > MOVES_KEPT ? { ...r, moves: undefined } : r);
    } else {
      out.push(r);
    }
  }
  return out;
}

/** Two records for the same finished table are the same game. */
export function isSameGame(a: GameRecord, b: GameRecord): boolean {
  return a.game === b.game && a.room === b.room && Math.abs(a.at - b.at) < 5 * 60_000;
}

export async function readHistory(): Promise<GameRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return capHistory(list.filter((r: any) => r && typeof r.game === 'string' && typeof r.at === 'number'));
  } catch {
    return [];
  }
}

/**
 * Record a finished game. Fail-soft: a history that cannot be written must not
 * disturb the table the player is still looking at.
 */
export async function recordGame(rec: GameRecord): Promise<void> {
  try {
    const list = await readHistory();
    if (list.some(r => isSameGame(r, rec))) return;   // the same snapshot arrives repeatedly
    await AsyncStorage.setItem(KEY, JSON.stringify(capHistory([rec, ...list])));
  } catch {}
}

export async function clearHistory(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}

/** "2 Sep, 18:40" — short, local, and never a relative lie about the future. */
export function whenLabel(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at > now + 60_000) return '';
  const d = new Date(at);
  // FLOOR, not round: 30 seconds ago is still "just now", and rounding it up
  // to "1m ago" makes a game you have only just finished look stale.
  const mins = Math.floor((now - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
