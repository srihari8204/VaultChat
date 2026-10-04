// lib/games/useLiveTables.ts — the games you are in the middle of.
//
// The games platform has ~19 registered players and typically zero online at
// the same moment, so Quick Match nearly always ends in a bot offer. Playing
// asynchronously — you move, they get a push, they play hours later — is the
// only structural fix, and it is the loop Chess.com is built on.
//
// The push half already existed and had nowhere to land: a player who missed or
// dismissed the notification had no way back to their own game. This is the
// list. It is served by crazzychat's backend (GET /games/tables, migration 125),
// derived from the turn notifications the games server signs.
//
// A LAUNCHER, NOT A SOURCE OF TRUTH. Every row is what the games server last
// SAID; the board re-reads the authoritative snapshot the moment it opens.
// Nothing here decides whose turn it is.
//
// TOLERANT OF A BACKEND THAT HAS NOT SHIPPED YET. A missing endpoint (404) means
// "no list". Any other failure keeps whatever was shown and sets `failed`, so
// the hub can offer a quiet retry — never a blocking error: the four boards
// worked before this existed and must keep working if it goes away.
//
// Refreshed on focus, so coming back from a board shows the turn you just took.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { api } from '../api';
import type { GameKind } from '../gamesSocket';
import { liveTableOf, type LiveTable } from './liveTable';

export { agoLabel, type LiveTable } from './liveTable';

export interface LiveTablesState {
  tables: LiveTable[];
  loading: boolean;
  /** The last refresh failed for a reason other than a missing endpoint. */
  failed: boolean;
  refresh: () => void;
  /** Drop a table from the list — the app calls this when a game is over. */
  forget: (game: GameKind, room: string) => void;
}

export function useLiveTables(): LiveTablesState {
  const [tables, setTables] = useState<LiveTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    setLoading(true);
    api<{ tables?: any[] }>('/games/tables')
      .then(res => {
        if (!alive.current) return;
        setTables((Array.isArray(res?.tables) ? res.tables : []).map(liveTableOf).filter(Boolean) as LiveTable[]);
        setFailed(false);
      })
      .catch((e: { status?: number } | undefined) => {
        if (!alive.current) return;
        if (e?.status === 404) { setTables([]); setFailed(false); }
        else setFailed(true);
      })
      .finally(() => { if (alive.current) setLoading(false); });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useFocusEffect(refresh);

  const forget = useCallback((game: GameKind, room: string) => {
    setTables(prev => prev.filter(t => !(t.game === game && t.room === room)));
    void forgetTable(game, room);
  }, []);

  return { tables, loading, failed, refresh, forget };
}

/**
 * Tell the backend this table is done with.
 *
 * The client is the ONLY party that ever learns a game ended: the notify
 * contract the games server signs has kinds turn | invite | friend and no
 * game-over event, and we cannot add one to a server we do not own. So a board
 * that sees a finished snapshot relays that, and the sweep catches the rest.
 *
 * Fire-and-forget: a failed cleanup leaves a stale row that costs one tap to
 * discover, which is not worth an error in front of a player.
 */
export async function forgetTable(game: GameKind, room: string): Promise<void> {
  try {
    await api(`/games/tables?game=${encodeURIComponent(game)}&room=${encodeURIComponent(room)}`,
      { method: 'DELETE' });
  } catch {}
}
