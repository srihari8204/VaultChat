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
  // WHAT MARKS A DEAL AS ALREADY SENT — and why it is not the deal index.
  //
  // This used to be `if (reported.current === match.dealsPlayed) return;`, which
  // reported one finished deal over and over until the match was gone:
  // `advanceMatch` resolves with a match whose `dealsPlayed` has gone UP, that
  // `setMatch` re-runs this effect, `raw` is still the same finished snapshot —
  // so the guard compared 0 against 1, did not match, and posted deal zero's
  // scores again as deal one. And again as deal two. The backend takes it,
  // because games_matches.go only checks that the index is the one it expects
  // and this client always sends exactly that. A Pool 101 eliminated players on
  // the first hand and a best-of-6 ended after one, from every seat at once.
  //
  // The counter was never the right key: it CHANGES as a direct result of
  // reporting, so anything compared against it is stale the moment it is true.
  // What actually identifies "this deal is done" is the finished snapshot, and
  // the reset below is what separates one deal from the next — the server sends
  // unfinished frames all through the following deal, so a plain "have I sent
  // this one" flag is cleared long before there is anything new to send.
  //
  // Every device posts; the backend's deal index makes it exactly-once. Electing
  // one reporter on the client would be picking the device that can disconnect.
  //
  // ponytail: a screen that MOUNTS onto an already-finished snapshot (reconnect
  // between deals) has a fresh ref and will post results the backend has already
  // counted, at the next index. Closing that needs the server to reject a deal
  // whose results it has already recorded — games_matches.go compares the index
  // only. Narrow next to the loop above, and the server is the right place to
  // fix it.
  const reported = useRef(false);
  useEffect(() => {
    if (!match || match.status !== 'running') return;

    // `result: "playing"` is sent on every frame by some games and is NOT a
    // finished game — one shared helper decides this for the history, the live
    // list and now the match.
    if (!isFinishedSnapshot(raw)) { reported.current = false; return; }
    if (reported.current) return;

    const results = resultsFrom(raw?.game?.players ?? raw?.players, raw?.game?.winnerId ?? raw?.winnerId);
    if (!results.length) return;

    reported.current = true;
    void advanceMatch(match.id, match.dealsPlayed, results)
      .then(m => { if (alive.current && m) setMatch(m); });
  }, [raw, match, you]);

  return { match, open, refresh };
}
