// lib/games/liveTable.ts — what a live-table row IS. No React Native in here.
//
// Split out of useLiveTables.ts for the same reason as inviteLink.ts: these are
// the rules that decide what a player is shown, and a selftest must be able to
// run them under plain node. useLiveTables pulls in React and the API client,
// neither of which survives `npx tsx`.
//
// Everything here is pure and total: given junk it returns null, never throws.

import type { GameKind } from '../gamesSocket';

export interface LiveTable {
  game: GameKind;
  room: string;
  /** What the last notification said. Not a claim about the board. */
  yourTurn: boolean;
  /** The lines the games server itself wrote for the push. */
  title: string;
  body: string;
  updatedAt: string;
}

const KINDS: GameKind[] = ['chess', 'rummy', 'ludo', 'tictactoe'];

/**
 * One row, or null when it is malformed.
 *
 * This is JSON off the network and one bad row must not blank the list — the
 * same rule the leaderboard parser follows. A game this app does not expose is
 * dropped rather than shown: /games falls back to the menu for an unknown
 * kind, so the row would be a button that leads nowhere.
 */
export function liveTableOf(v: any): LiveTable | null {
  const game = typeof v?.game === 'string' ? (v.game as GameKind) : null;
  const room = typeof v?.room === 'string' ? v.room.trim() : '';
  if (!game || !KINDS.includes(game) || !room) return null;
  return {
    game,
    room,
    yourTurn: !!v.yourTurn,
    title: typeof v.title === 'string' ? v.title : '',
    body: typeof v.body === 'string' ? v.body : '',
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
  };
}

/**
 * "2h ago" — when we last HEARD, never how long a turn has left.
 *
 * The notify contract carries no turn deadline (the board gets the real one
 * over the WebSocket every frame), so a countdown here would be invented. An
 * unparseable timestamp renders nothing rather than "NaN ago".
 */
export function agoLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
