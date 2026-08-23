// lib/games/useQuickMatch.ts — find a real opponent.
//
// The games server runs a matchmaker on /live/ws (presence + a per-game queue,
// Redis-backed across nodes). Without it the only opponent reachable from the
// app is a bot, which is what made the native games feel offline even though
// every table was already multiplayer.
//
// Protocol, from games-web (durak.js / snakeladders.js quickMatch):
//
//   → {t:"queue", game}
//   ← {t:"queued"}              still searching, at your skill level
//   ← {t:"match",    roomId}    a human was found — join and auto-start
//   ← {t:"botoffer", roomId}    nobody showed up — join with a bot instead
//
// The socket is closed as soon as a room arrives: it exists only to be paired,
// and the table has its own connection.

import { useCallback, useEffect, useRef, useState } from 'react';
import { establishGamesSession, GAMES_WS_BASE, type GameKind } from '../gamesSocket';

export type MatchPhase = 'idle' | 'connecting' | 'searching' | 'matched' | 'error';

export interface QuickMatchResult {
  phase: MatchPhase;
  /** Human-readable status for the searching screen. */
  status: string;
  error: string | null;
  /** Set once paired. `withBot` means no human was found in time. */
  match: { roomId: string; withBot: boolean } | null;
  start: (game: GameKind) => void;
  cancel: () => void;
}

export function useQuickMatch(): QuickMatchResult {
  const [phase, setPhase] = useState<MatchPhase>('idle');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [match, setMatch] = useState<{ roomId: string; withBot: boolean } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const aliveRef = useRef(true);

  const close = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) { try { ws.close(); } catch { /* already gone */ } }
  }, []);

  // A queued player who walks away must leave the queue, or the next searcher
  // is paired against a socket that is no longer listening.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; close(); };
  }, [close]);

  const cancel = useCallback(() => {
    close();
    if (!aliveRef.current) return;
    setPhase('idle');
    setStatus('');
    setMatch(null);
  }, [close]);

  const start = useCallback((game: GameKind) => {
    close();
    setPhase('connecting');
    setStatus('Connecting…');
    setError(null);
    setMatch(null);

    establishGamesSession()
      .then(() => {
        if (!aliveRef.current) return;
        const ws = new WebSocket(`${GAMES_WS_BASE}/live/ws`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!aliveRef.current) return;
          setPhase('searching');
          setStatus('Searching for an opponent…');
          ws.send(JSON.stringify({ t: 'queue', game }));
        };

        ws.onmessage = (ev) => {
          if (!aliveRef.current) return;
          let m: any;
          try { m = JSON.parse(String(ev.data)); } catch { return; }

          if (m.t === 'match' || m.t === 'botoffer') {
            close();
            setPhase('matched');
            setMatch({ roomId: String(m.roomId), withBot: m.t === 'botoffer' });
          } else if (m.t === 'queued') {
            setStatus('Searching at your skill level…');
          }
        };

        ws.onerror = () => {
          if (!aliveRef.current) return;
          setPhase('error');
          setError('Could not reach the matchmaker.');
        };

        ws.onclose = () => {
          // A close while still searching is a dropped queue, not a match —
          // say so rather than leaving a spinner running forever.
          if (!aliveRef.current || wsRef.current !== ws) return;
          wsRef.current = null;
          setPhase(p => (p === 'searching' || p === 'connecting' ? 'error' : p));
          setError(e => e ?? 'Lost contact with the matchmaker.');
        };
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [close]);

  return { phase, status, error, match, start, cancel };
}
