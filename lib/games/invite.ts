// lib/games/invite.ts — inviting someone to a table, and bragging afterwards.
//
// Every web game has a 🔗 Invite and a 📣 Share; the native boards had neither,
// which meant the only way to play a specific person was to already be in the
// same room by accident. This is the growth loop the reference client is built
// around, so it is not decoration.
//
// The link is a VaultChat deep link, not a games.corefinite.com URL: a
// recipient who has the app should land on the native table, and app.json
// registers `vaultchat://` for exactly this.

import { Share } from 'react-native';
import type { GameKind } from '../gamesSocket';

const NAMES: Record<GameKind, string> = {
  chess: 'Chess',
  rummy: 'Rummy',
  ludo: 'Ludo',
  tictactoe: 'Tic-Tac-Toe',
};

/**
 * Only ids the games server itself would mint.
 *
 * The room id goes into a URL that other people open, so anything with a
 * slash, a quote, a `?` or a `#` in it would rewrite the link rather than fill
 * it in. Same rule the backend applies when it mints a notification slug.
 */
function slug(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s) ? s : '';
}

export function tableLink(game: GameKind, room: string): string | null {
  const r = slug(room);
  if (!r) return null;
  return `vaultchat://games?game=${game}&room=${encodeURIComponent(r)}`;
}

/**
 * Invite someone to this table.
 *
 * Returns false when there is no shareable room — a table the player is at by
 * default has no id worth sending, and a link to nothing is worse than a
 * disabled button.
 */
export async function inviteToTable(game: GameKind, room: string): Promise<boolean> {
  const link = tableLink(game, room);
  if (!link) return false;
  try {
    await Share.share({
      message: `Play ${NAMES[game]} with me on VaultChat — ${link}`,
    });
    return true;
  } catch {
    // A cancelled share sheet is not a failure worth reporting.
    return false;
  }
}

/** Share the result after a game. */
export async function shareResult(game: GameKind, won: boolean): Promise<void> {
  try {
    await Share.share({
      message: won
        ? `I just won at ${NAMES[game]} on VaultChat.`
        : `Good game of ${NAMES[game]} on VaultChat — rematch?`,
    });
  } catch {}
}

export function gameName(game: GameKind): string { return NAMES[game]; }
