// lib/games/useCountdown.ts — the turn clock, for every board.
//
// Lifted out of Rummy, which was the only board that had one. A turn clock is
// table stakes in every reference client (RummyCircle draws a ring, Chess.com a
// pair of clocks), and a player who cannot see the turn running out finds out
// by losing it.
//
// It renders the SERVER'S deadline and computes nothing: `secondsLeft` lives in
// rummyTable.ts with its own tests, and refuses a number the device clock says
// is nonsense — which is why this can return null on a running turn. A board
// with no deadline on the wire shows no clock at all; a frozen zero would be
// the client inventing a fact about a game it does not referee.
//
// It holds the SECOND, not the clock reading. `setNow(Date.now())` was a new
// value every time by construction, so every tick re-rendered the whole screen
// and half of them redrew the identical digit. Storing what is actually shown
// lets React bail out on the unchanged value, which is also why the interval
// can be fine enough to keep the tick honest without costing anything extra.

import { useEffect, useState } from 'react';
import { secondsLeft } from './rummyTable';

export function useCountdown(deadline: unknown, live: boolean): number | null {
  const [secs, setSecs] = useState<number | null>(() => secondsLeft(deadline, Date.now()));
  useEffect(() => {
    if (!live || typeof deadline !== 'number') { setSecs(null); return; }
    const tick = () => setSecs(secondsLeft(deadline, Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline, live]);
  return live ? secs : null;
}
