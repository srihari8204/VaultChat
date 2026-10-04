// lib/games/useLeaderboard.ts — the standings, per game or across all four.
//
// Same shape as useWallet: establish the games session, read, never write. The
// server ranks and cuts the list (ten rows, and it ignores `?limit=`); the
// parsing and the per-scope stat choice live in leaderboard.ts, which a
// Node-run self-check exercises.

import { useCallback, useEffect, useRef, useState } from 'react';
import { establishGamesSession, GAMES_HTTP } from '../gamesSocket';
import { parseLeaderboard, type LeaderRow, type LeaderScope } from './leaderboard';

export interface LeaderboardState {
  rows: LeaderRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLeaderboard(scope: LeaderScope): LeaderboardState {
  const [rows, setRows] = useState<LeaderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // Switching tabs fast must not let a slow earlier request overwrite a newer
  // one — the board would settle on whichever answered last rather than on the
  // tab the player is looking at.
  const reqId = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(() => {
    const mine = ++reqId.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await establishGamesSession();
        const q = scope === 'all' ? '' : `?game=${encodeURIComponent(scope)}`;
        const res = await fetch(`${GAMES_HTTP}/api/leaderboard${q}`, { credentials: 'include' });
        const j: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error('Could not load the leaderboard.');
        if (!alive.current || mine !== reqId.current) return;
        setRows(parseLeaderboard(j));
      } catch (err: unknown) {
        if (!alive.current || mine !== reqId.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive.current && mine === reqId.current) setLoading(false);
      }
    })();
  }, [scope]);

  useEffect(() => { refresh(); }, [refresh]);

  return { rows, loading, error, refresh };
}
