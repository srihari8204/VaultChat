// components/games/rummy/shared.ts — the few things every rummy file needs.
// Split out of components/games/Rummy.tsx (2026-10 round 4).

import { useMemo } from 'react';
import { S } from '../../../lib/games/theme';

export type Card = { id: string; suit: string; rank: string };

export const SUIT_GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣', JOKER: '★' };
export const RED = new Set(['H', 'D']);

/** A measured drop target, in window coordinates. */
export type Zone = { x: number; y: number; w: number; h: number };

/**
 * The one rummy format this server plays.
 *
 * `docs/GAMES_PROTOCOL.md`: "There is no pool (101/201) and no deals variant on
 * this server: the wire protocol has no pool score, no elimination and no deal
 * count, and the engine only ever settles a single deal at a time." Pool and
 * Deals would be a crazzychat-side match layer over repeated deals — see
 * openspec/changes/rummy-variants. Until then, say which one this is.
 */
export const VARIANT = 'Points rummy';

/** A readable lobby column inside GamesScreen's already-safe viewport. */
const COLUMN_MAX = 680;

export function useColumn() {
  return useMemo(() => ({
    paddingHorizontal: S[4],
    paddingTop: S[3],
    paddingBottom: S[5],
    maxWidth: COLUMN_MAX,
    width: '100%' as const,
    alignSelf: 'center' as const,
  }), []);
}
