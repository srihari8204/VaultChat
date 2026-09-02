// lib/games/useRematch.ts — playing the same person again.
//
// Every reference client offers a rematch at the end of a board, and it is the
// cheapest real opponent there is: they are already here, already seated, and
// finding them cost days. Losing them to a result screen with no way back is
// the most expensive moment in a game section with ~19 players on it.
//
// THE REMATCH ALREADY EXISTED, AND IT IS `start`.
//
// All four boards send `{t:'start'}` from their result screen, and the server
// deals the same table again with the same seats. Nothing needs a new room or a
// new protocol verb. What was missing is what happens when it does NOT work:
// the button fired into the socket and the screen did not change, so a player
// whose opponent had already left tapped a dead button with no way to tell.
//
// So this adds the two things around it: a waiting state that ENDS, and the
// honest fallback when the other seat is empty — invite them back to this same
// table, which is the card from lib/games/invite.ts pointed at this room.
//
// It decides no game truth. "Are they still here" is read from the lobby the
// server sends; "has the rematch started" is read from the next snapshot.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState } from './useGameSocket';
import type { GameKind, GamesMessage } from '../gamesSocket';
import { openInvite } from './invite';
import { isFinishedSnapshot } from './history';

/**
 * How long to wait before saying they have not come back.
 *
 * Long enough for a person who is looking at the screen to tap, short enough
 * that it is not an indefinite spinner. A rematch that arrives later still
 * lands: the snapshot clears the waiting state whenever it comes.
 */
const WAIT_MS = 20_000;

export interface Rematch {
  /** Waiting for the table to deal again. Ends on a snapshot or on time. */
  waiting: boolean;
  /** Nobody else is seated — asking would wait for a person who has gone. */
  alone: boolean;
  /** They did not come back in time. */
  timedOut: boolean;
  ask: () => void;
  cancel: () => void;
  /** Invite them back to THIS table. */
  invite: () => void;
}

// One definition of "finished", shared with the history and the live-games
// list — see isFinishedSnapshot. A truthiness test on `result` reported every
// chess frame as finished, because chess sends `result: "playing"`.

export function useRematch(
  game: GameKind,
  room: string,
  state: GameState,
  send: (m: GamesMessage) => void,
): Rematch {
  const [waiting, setWaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setWaiting(false);
  }, []);

  // A new deal is the answer. The snapshot is the only thing that says so —
  // the button firing is not evidence that anything happened.
  const isFinished = isFinishedSnapshot(state);
  useEffect(() => {
    if (!isFinished && waiting) { stop(); setTimedOut(false); }
  }, [isFinished, waiting, stop]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const ask = useCallback(() => {
    setTimedOut(false);
    setWaiting(true);
    send({ t: 'start' });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setWaiting(false); setTimedOut(true); }, WAIT_MS);
  }, [send]);

  const cancel = useCallback(() => { stop(); setTimedOut(false); }, [stop]);

  const invite = useCallback(() => {
    stop();
    setTimedOut(false);
    openInvite(game, room);
  }, [game, room, stop]);

  // Read from the lobby the server sends, never from a local guess about who
  // "should" be there. A missing lobby is not evidence of an empty table.
  const members = state.lobby?.members;
  const alone = Array.isArray(members) && members.filter(m => m.vaultId !== state.you).length === 0;

  return { waiting, alone, timedOut, ask, cancel, invite };
}
