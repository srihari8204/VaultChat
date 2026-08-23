// lib/games/useWallet.ts — the games coin balance.
//
// ═══════════════════════════════════════════════════════════════════════
//  THESE ARE DEMO COINS. NOT MONEY.
// ═══════════════════════════════════════════════════════════════════════
//
// The games server says so in its own source, repeatedly — "Demo coins only —
// never real money" sits above the poker, trivia, carrom and provably-fair
// engines. Nothing here buys, sells, cashes out or touches a payment rail, and
// the wording in the UI has to keep saying so.
//
// That is not squeamishness. Real-money gaming is separately licensed in most
// of the markets this app ships to, and Play policy treats a real-money wager
// as a different product with its own declarations. Turning this into cash is a
// legal project, not a UI change — and the moment coins buy anything of value,
// every table becomes a regulated surface.
//
// The balance is authoritative on the SERVER. This only reads it: a client that
// decided its own balance could stake coins it does not have, and the stake is
// the one number both players are trusting.

import { useCallback, useEffect, useRef, useState } from 'react';
import { establishGamesSession } from '../gamesSocket';

const GAMES_HTTP = 'https://games.corefinite.com';

export interface WalletState {
  balance: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useWallet(): WalletState {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // The wallet needs the same games session a table does. Establishing it
        // here means the hub can show a balance before any table is opened.
        await establishGamesSession();
        const res = await fetch(`${GAMES_HTTP}/api/wallet`, { credentials: 'include' });
        const j: any = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error('Could not read your balance.');
        if (!alive.current) return;
        setBalance(typeof j.balance === 'number' ? j.balance : 0);
      } catch (err: unknown) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { balance, loading, error, refresh };
}

/**
 * The stake tiers, from games-web/ludo.js LUDO_STAKES.
 *
 * Free is FIRST and the default. A stake has to be a deliberate choice — a
 * table that quietly costs something is how a player loses coins they did not
 * mean to put up.
 */
export const STAKES = [0, 50, 200, 500] as const;

export const stakeLabel = (v: number) => (v === 0 ? 'Free' : `${v}`);
