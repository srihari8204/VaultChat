// lib/games/tableCode.ts — what "Join a table by code" was actually given.
//
// A bare room code says nothing about its game: the matchmaker's ids and the
// codes the hub mints (newPrivateCode) are plain slugs for every game. The hub
// used to open every code as rummy, so chess, ludo and tic-tac-toe codes were
// dead there. An invite LINK (or the whole invite line pasted from a chat)
// does carry the game — `vaultchat://games?game=chess&room=K7P2QX` — so read
// it when it is there, and otherwise report `game: null` so the hub asks.
//
// Pure, no React Native, so the selftest runs it under plain node.

import type { GameKind } from '../gamesSocket';
import { GAME_NAMES, slug } from './inviteLink';
import { normalizeCode } from './rummyTable';

export interface TableCode { game: GameKind | null; room: string }

const isKind = (g: string): g is GameKind => Object.prototype.hasOwnProperty.call(GAME_NAMES, g);

/** null when nothing usable was typed. */
export function parseTableCode(raw: string): TableCode | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const roomParam = /[?&]room=([^&#\s]+)/.exec(text);
  if (roomParam) {
    let decoded = '';
    try { decoded = decodeURIComponent(roomParam[1]); } catch { decoded = ''; }
    const room = slug(decoded);
    if (!room) return null;
    const g = /[?&]game=([a-z]+)/.exec(text)?.[1] ?? '';
    return { game: isKind(g) ? g : null, room };
  }
  const room = normalizeCode(text);
  return room ? { game: null, room } : null;
}
