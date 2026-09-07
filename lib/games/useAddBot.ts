// lib/games/useAddBot.ts — "Add a bot" must not fail silently.
//
// WHAT THIS IS FOR, and it is a real defect rather than a nicety.
//
// The games server can accept `addbot` and simply never seat one. Observed on a
// device 2026-09-07: in a room whose state had gone stale, "Add a bot" was
// enabled, the tap landed (proven — other controls on the same screen opened
// their sheets), no error came back, no toast appeared, and no bot ever
// arrived. "Start game" therefore stayed disabled forever. From the player's
// side the button is simply dead, with nothing on screen admitting it.
//
// The protocol gives us no failure signal — there is no `addbot` ack and no
// error frame for it — so the only honest evidence is ABSENCE: we asked, and
// the seat count did not move. That is what this watches.
//
// It does NOT retry, and it does not pick a different room. A retry would spam
// a server that may be refusing on purpose, and changing rooms silently is the
// kind of "helpful" behaviour that loses a player their invited friends. It
// only tells the truth so the player can act.
//
// ponytail: no timer library, no state machine. One ref, one timeout.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Long enough for a slow link, short enough to still feel like feedback. */
export const ADD_BOT_TIMEOUT_MS = 6000;

export interface AddBot {
  /**
   * Ask for a bot. Takes the message because the games differ: chess sends
   * `{t:'addbot', level}` and the others send a bare `{t:'addbot'}` — this
   * watches the OUTCOME and has no opinion about the payload.
   */
  addBot: (msg?: Record<string, unknown>) => void;
  /** We asked, and no seat appeared in time. Cleared by the next success. */
  stalled: boolean;
}

/**
 * @param send   the socket's send, unchanged
 * @param seated how many members the lobby currently reports
 */
export function useAddBot(
  send: (msg: Record<string, unknown>) => void,
  seated: number,
  timeoutMs: number = ADD_BOT_TIMEOUT_MS,
): AddBot {
  const [stalled, setStalled] = useState(false);
  /** Seat count at the moment we asked. null = nothing outstanding. */
  const asked = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };
  // A pending timeout that fires after unmount would set state on a dead
  // component, which is the classic way a lobby leaks a warning per visit.
  useEffect(() => stop, []);

  // A seat appeared: the ask landed. This is the ONLY success signal available.
  useEffect(() => {
    if (asked.current != null && seated > asked.current) {
      asked.current = null;
      stop();
      setStalled(false);
    }
  }, [seated]);

  const addBot = useCallback((msg: Record<string, unknown> = { t: 'addbot' }) => {
    asked.current = seated;
    setStalled(false);          // asking again clears the previous complaint
    stop();
    timer.current = setTimeout(() => {
      // Still outstanding when the clock ran out — say so.
      if (asked.current != null) setStalled(true);
    }, timeoutMs);
    send(msg);
  }, [seated, send, timeoutMs]);

  return { addBot, stalled };
}

/**
 * What to tell the player. One string, so the four lobbies cannot word this
 * differently, and so it can be checked without a renderer.
 *
 * It names the way OUT that already exists — the hub mints a fresh private
 * room for both "Private" and "vs Bot" — rather than leaving them staring at a
 * dead button.
 */
export const ADD_BOT_STALLED =
  'The table didn’t seat a bot. It may be busy — go back and start a private table instead.';
