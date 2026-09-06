// lib/games/useRummyMatch.ts — the Pool/Deals match a rummy table is part of.
//
// The games server settles ONE deal and knows nothing about the match around
// it. This hook is the join between the two: it reads the match for a table,
// reports each deal as it finishes, and hands the board back a scoreboard.
//
// It computes NO scores. Every number comes from the backend, because a pool
// total decides who is eliminated and every seat has to agree on it
// (lib/games/match.ts, games_matches.go).
//
// The whole thing is inert when the backend has not shipped: getMatch returns
// null, `match` stays null, and the board renders exactly as it does today.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isFinishedSnapshot } from './history';
import { advanceMatch, getMatch, openMatch, resultsFrom, type Match, type MatchVariant } from './match';

export interface RummyMatch {
  /** The running match, or null when this table is a plain Points deal. */
  match: Match | null;
  /** Open a match at this table. Practice tables only — the backend refuses others. */
  open: (variant: MatchVariant, practice: boolean) => void;
  /** Re-read from the backend, e.g. after reconnecting. */
  refresh: () => void;
}

export function useRummyMatch(tableId: string, raw: any, you: string): RummyMatch {
  const [match, setMatch] = useState<Match | null>(null);
  const alive = useRef(true);

  // The match is keyed by table, so a change of table is a different match.
  const refresh = useCallback(() => {
    if (!tableId) { setMatch(null); return; }
    void getMatch(tableId).then(m => { if (alive.current) setMatch(m); });
  }, [tableId]);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  const open = useCallback((variant: MatchVariant, practice: boolean) => {
    if (!tableId) return;
    void openMatch(tableId, variant, practice).then(m => { if (alive.current && m) setMatch(m); });
  }, [tableId]);

  // REPORT THE DEAL, ONCE PER DEAL, FROM EVERY SEAT.
  //
  // `reported` is keyed on the deal index rather than a bare boolean: a match
  // plays several deals at the same table, and a boolean would report the first
  // and silently skip every later one — the score would freeze after deal one
  // and look like the backend was ignoring us.
  //
  // Every device posts; the backend's deal index makes it exactly-once. Electing
  // one reporter on the client would be picking the device that can disconnect.
  const reported = useRef<number | null>(null);
  useEffect(() => {
    if (!match || match.status !== 'running') return;

    // `result: "playing"` is sent on every frame by some games and is NOT a
    // finished game — one shared helper decides this for the history, the live
    // list and now the match.
    if (!isFinishedSnapshot(raw)) { reported.current = null; return; }
    if (reported.current === match.dealsPlayed) return;

    const results = resultsFrom(raw?.game?.players ?? raw?.players, raw?.game?.winnerId ?? raw?.winnerId);
    if (!results.length) return;

    reported.current = match.dealsPlayed;
    void advanceMatch(match.id, match.dealsPlayed, results)
      .then(m => { if (alive.current && m) setMatch(m); });
  }, [raw, match, you]);

  return { match, open, refresh };
}
