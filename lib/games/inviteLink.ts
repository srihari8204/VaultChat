// lib/games/inviteLink.ts — what an invite SAYS. No React Native in here.
//
// Split out of invite.ts so the rules that decide what a recipient opens can be
// run by a selftest under plain node: invite.ts pulls in react-native's Share
// and the chat service, and neither survives `npx tsx`.
//
// Everything here is pure and total: given junk it returns null, never throws.

import type { GameKind } from '../gamesSocket';

export const GAME_NAMES: Record<GameKind, string> = {
  chess: 'Chess',
  rummy: 'Rummy',
  ludo: 'Ludo',
  tictactoe: 'Tic-Tac-Toe',
};

const KINDS = Object.keys(GAME_NAMES) as GameKind[];

/**
 * Only ids the games server itself would mint.
 *
 * The room id goes into a URL that other people open, so anything with a
 * slash, a quote, a `?` or a `#` in it would rewrite the link rather than fill
 * it in. Same rule the backend applies when it mints a notification slug, and
 * the same rule it re-applies to a 'game_invite' card server-side — a client
 * check alone would be no check at all against a modified client.
 */
export function slug(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s) ? s : '';
}

/** A VaultChat deep link, not a games.corefinite.com URL: app.json registers it. */
export function tableLink(game: GameKind, room: string): string | null {
  const r = slug(room);
  if (!r) return null;
  return `vaultchat://games?game=${game}&room=${encodeURIComponent(r)}`;
}

/** The card a game_invite message carries. */
export interface GameInvite { game: GameKind; room: string }

/**
 * Read the card off a message, or null when it is malformed.
 *
 * Null for anything but the four games this app exposes and a plain-slug room:
 * a card the app cannot open must render as its readable text body rather than
 * as a button that leads nowhere.
 */
export function gameInviteOf(meta: unknown): GameInvite | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  const game = typeof m.game === 'string' ? (m.game as GameKind) : null;
  const room = slug(m.room);
  if (!game || !KINDS.includes(game) || !room) return null;
  return { game, room };
}

/** The line an older client — one with no branch for this type — will show. */
export function inviteText(game: GameKind, room: string): string {
  return `Play ${GAME_NAMES[game]} with me on VaultChat — ${tableLink(game, room) ?? ''}`.trim();
}

export function gameName(game: GameKind): string { return GAME_NAMES[game]; }
