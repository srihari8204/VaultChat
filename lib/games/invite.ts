// lib/games/invite.ts — inviting someone to a table, and bragging afterwards.
//
// Every web game has a 🔗 Invite and a 📣 Share; the native boards had neither,
// which meant the only way to play a specific person was to already be in the
// same room by accident. This is the growth loop the reference client is built
// around, so it is not decoration.
//
// TWO WAYS OUT, AND ONE OF THEM IS THE POINT
//
// The share sheet sends the invite OUT of VaultChat and hopes it finds its way
// back. But the app it was going to be pasted into is this one: VaultChat IS
// the chat thread. So the first-class path is a card posted straight into a
// VaultChat chat (`sendGameInvite`), and the OS share sheet stays as the
// out-of-app fallback for someone who is not on VaultChat yet.
//
// The card is an ordinary message of type 'game_invite' (migration 124), so it
// inherits delivery, E2EE, retention and sync from the message it already is —
// no new table, no new endpoint. Its `meta` is {game, room} and its E2EE body
// is the readable fallback line, so a client too old to know the type renders
// something a person can read instead of an empty bubble. That empty bubble is
// exactly what shipped for 'group_ref' (lib/groupRefRouting.selftest.ts).
//
// The pure half — link building and card parsing — lives in ./inviteLink so a
// selftest can run it without React Native.

import { Share } from 'react-native';
import type { GameKind } from '../gamesSocket';
import { sendMessage } from '../chatService';
import { GAME_NAMES, inviteText, slug, tableLink } from './inviteLink';

export { gameInviteOf, gameName, inviteText, tableLink, type GameInvite } from './inviteLink';

/**
 * Post an invite card into a VaultChat chat.
 *
 * Returns false when there is no shareable room — a table the player is at by
 * default has no id worth sending, and a card to nothing is worse than a
 * disabled button.
 */
export async function sendGameInvite(chatId: string, game: GameKind, room: string): Promise<boolean> {
  const r = slug(room);
  if (!r) return false;
  const msg = await sendMessage(chatId, inviteText(game, r), 'game_invite', { meta: { game, room: r } });

  // CACHE OUR OWN CARD, OR IT VANISHES FROM THE THREAD.
  //
  // This send happens from the games screen, so the chat screen is not mounted
  // to persist it, and a sender never receives their own message back over the
  // socket. Meanwhile the server has already advanced that chat's
  // `last_delivered_message_id` to this id as part of the fan-out — so the next
  // cold-start delta (`m.id > last_delivered`) returns nothing for it, and
  // chat.tsx only re-fetches a page when the local cache for the chat is EMPTY.
  // The result, seen on device: the card is in the database, the recipient can
  // read it, and the sender's own thread never shows it again.
  //
  // Caching it here closes that for the one path that creates it. The general
  // hole — delivery advancing before the client has stored anything — is wider
  // than this feature and is written up in the change notes.
  try {
    if (msg && typeof msg.id === 'number') {
      const { cacheMessages } = await import('../localDb');
      await cacheMessages(chatId, [msg]);
    }
  } catch { /* a cache miss must not fail an invite that the server accepted */ }
  return true;
}

/**
 * Invite someone outside VaultChat, through the OS share sheet.
 *
 * Kept as the fallback path: it is the only way to reach someone who does not
 * have the app yet.
 */
export async function inviteToTable(game: GameKind, room: string): Promise<boolean> {
  if (!tableLink(game, room)) return false;
  try {
    await Share.share({ message: inviteText(game, room) });
    return true;
  } catch {
    // A cancelled share sheet is not a failure worth reporting.
    return false;
  }
}

// ── Opening the picker from a board ──────────────────────────────────
//
// All four boards already call one function with (game, room) from their own
// layouts. Rather than thread a modal and its state through four screens, the
// sheet is mounted ONCE in app/games.tsx and opened through this one
// subscription. A board keeps its single call and gains the chat picker.
//
// ponytail: one subscriber, last-registered wins — there is only ever one games
// screen mounted. If a second surface ever needs the picker, make this a list.

type Opener = (game: GameKind, room: string) => void;
let opener: Opener | null = null;

/** app/games.tsx registers the mounted sheet here. Returns the unsubscriber. */
export function registerInvitePicker(fn: Opener): () => void {
  opener = fn;
  return () => { if (opener === fn) opener = null; };
}

/**
 * Ask for the invite picker. Falls back to the OS share sheet when no picker is
 * mounted, so a board never loses the affordance it had.
 */
export function openInvite(game: GameKind, room: string): void {
  if (!slug(room)) return;
  if (opener) opener(game, room);
  else void inviteToTable(game, room);
}

/** Share the result after a game. */
export async function shareResult(game: GameKind, won: boolean): Promise<void> {
  try {
    await Share.share({
      message: won
        ? `I just won at ${GAME_NAMES[game]} on VaultChat.`
        : `Good game of ${GAME_NAMES[game]} on VaultChat — rematch?`,
    });
  } catch {}
}
