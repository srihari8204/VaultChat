// lib/games/useGameSocket.ts — one React binding for all four native games.
//
// GamesSocket owns the connection; this owns its lifecycle inside a screen and
// exposes the three things every game board needs: the authoritative state,
// the connection phase, and a way to send an intent.
//
// Shared rather than repeated per game, because the parts that are easy to get
// subtly wrong are identical everywhere — disposing on unmount, ignoring frames
// that arrive after unmount, and keeping `you`/`seat` in step with the state
// they arrived with. Four copies would be four chances to leak a socket.
//
// See docs/GAMES_PROTOCOL.md. The server is authoritative: `state` is a full
// snapshot and replaces whatever was here. Nothing in this file computes game
// truth, and nothing in a game board should either.

import { useCallback, useEffect, useRef, useState } from 'react';
import { GamesSocket, type GameKind, type GamesMessage, type Phase } from '../gamesSocket';
import { forgetTable } from './useLiveTables';
import { recordGame, outcomeOf, opponentsOf, detailOf, movesOf, isFinishedSnapshot } from './history';

/** The lobby half of a `state` frame — identical across all four games. */
export interface GameLobby {
  status: string;
  hostId?: string;
  members: { vaultId: string; name: string; isBot?: boolean; wins?: number }[];
  /**
   * Rummy seats a fixed number of players and says which table you are at.
   * Both are sent by the server and both were being read through an `as any`
   * on the board, which is a type lie that survives exactly until someone
   * renames a field. Optional because the other three games do not send them.
   */
  maxPlayers?: number;
  table?: { name?: string; stakes?: string; pointValue?: number };
}

/**
 * A `state` frame. `game` is deliberately `any`: its shape is per-game and the
 * server owns it, so each board narrows it itself rather than this file
 * pretending to know four schemas at once.
 */
export interface GameState {
  you: string;
  seat: number | null;
  spectator: boolean;
  lobby: GameLobby | null;
  game: any;
  /**
   * The whole `state` frame, untouched.
   *
   * Games carry their own TOP-LEVEL fields beside `game`, and they differ:
   * chess sends `color`, `legal` (the full legal-move list) and `clock`;
   * others send `seat` and `commitHash`. Narrowing to a fixed shape here would
   * silently drop the field a board depends on — and `legal` is what removes
   * the need for a chess rules engine, so losing it is not a small matter.
   */
  raw: any;
}

export interface UseGameSocket {
  phase: Phase;
  error: string | null;
  state: GameState;
  /** Server-sent notices ({t:'event'}) — most recent last, capped. */
  events: string[];
  send: (msg: GamesMessage) => void;
  /**
   * Seat at a table chosen after connecting, without rebuilding the socket.
   *
   * Passing the id as `roomId` instead would re-run the effect and tear the
   * connection down, which for rummy means losing the table list you picked
   * from — and, mid-hand, the hand.
   */
  join: (roomId: string) => void;
  /**
   * Watch every raw server frame, for as long as the screen is mounted.
   *
   * Unlike the `onMessage` option this SURVIVES a socket rebuild (a retry, a
   * table change), because the handler set lives in the hook rather than on the
   * socket. Table voice depends on that: its signalling rides the game socket,
   * and a mesh that silently stopped receiving offers after one reconnect would
   * look exactly like a microphone problem.
   */
  subscribe: (handler: (msg: GamesMessage) => void) => () => void;
  /**
   * Rebuild the socket from scratch: new connection, state cleared.
   *
   * Serves both "retry after a failure" and "leave this room" — the games
   * protocol has no leave intent, so a fresh socket is the only way out, and it
   * is what the reference web clients do with `location.reload()`.
   *
   * `roomId` OVERRIDES the one this screen was opened with, and `''` means
   * "join nothing". Without it, leaving a table that arrived as a deep link or
   * a turn notification would reconnect straight back into it, and the Leave
   * button would look broken.
   */
  retry: (roomId?: string) => void;
}

const EMPTY: GameState = { you: '', seat: null, spectator: false, lobby: null, game: null, raw: null };

/**
 * Options for a table opened by matchmaking rather than by hand.
 *
 * Quick Match drops both players straight into a room, so the lobby they land
 * in exists only to be left: nobody chose those seats and there is nothing to
 * arrange. `auto` starts it for them. `autoBot` covers the matchmaker's
 * `botoffer` — nobody was waiting, so the table fills the second seat itself.
 */
export interface AutoStart {
  auto?: boolean;
  autoBot?: boolean;
  /**
   * Raw server frames, for the fields that arrive OUTSIDE `state`.
   *
   * Rummy's table list (`{t:'tables'}`) is the reason this exists: it is sent
   * once on connect, before any lobby, so a board that only ever sees `state`
   * can never show the player which tables are open.
   */
  onMessage?: (msg: GamesMessage) => void;
}

export function useGameSocket(game: GameKind, roomId = '', opts: AutoStart = {}): UseGameSocket {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<GameState>(EMPTY);
  const [events, setEvents] = useState<string[]>([]);

  const sockRef = useRef<GamesSocket | null>(null);
  // Set by retry(room); outlives the rebuild so the new socket opens where the
  // caller asked rather than where the screen was originally pointed.
  const roomOverride = useRef<string | null>(null);
  // Stable across socket rebuilds — see `subscribe` on the interface above.
  const subsRef = useRef(new Set<(m: GamesMessage) => void>());
  // Latest-ref rather than an effect dependency: the callback is written inline
  // at the call site, so depending on it would rebuild the socket every render.
  const onMsgRef = useRef(opts.onMessage);
  onMsgRef.current = opts.onMessage;
  // Frames can land between the socket closing and React unmounting; without
  // this they would setState on a dead component and, worse, resurrect state
  // for a game the user has already left.
  const aliveRef = useRef(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    aliveRef.current = true;
    const sock = new GamesSocket(game, roomOverride.current ?? roomId);
    sockRef.current = sock;

    const offPhase = sock.onPhase((p, err) => {
      if (!aliveRef.current) return;
      setPhase(p);
      // Keep the last error visible through a reconnect attempt; only a
      // successful connection clears it, or a retry that supersedes it.
      if (err) setError(err);
      else if (p === 'connected') setError(null);
    });

    // `hello` and `joined` carry identity before any board exists, so they are
    // merged rather than replacing — otherwise the first `state` is the only
    // thing that ever tells us who we are, and the lobby renders "you" as
    // nobody until then.
    const offMsg = sock.onMessage((m) => {
      if (!aliveRef.current) return;
      if (m.t === 'hello' || m.t === 'joined') {
        setState(prev => ({
          ...prev,
          you: typeof m.you === 'string' ? m.you : prev.you,
          spectator: typeof m.spectator === 'boolean' ? m.spectator : prev.spectator,
        }));
      } else if (m.t === 'error' && typeof m.msg === 'string') {
        // A rejected intent is a notice, not a connection failure — the next
        // snapshot already corrects the board, so this must not read as "the
        // game is broken".
        setEvents(prev => [...prev, `⚠ ${m.msg}`].slice(-20));
      }
      // A subscriber that throws must not take the socket, nor the other
      // subscribers, down with it.
      try { onMsgRef.current?.(m); } catch { /* a board's handler must not kill the socket */ }
      subsRef.current.forEach((h) => { try { h(m); } catch {} });
    });

    // The whole snapshot, every time. See the protocol doc: never a delta.
    const offState = sock.onState((s: any) => {
      if (!aliveRef.current || !s) return;
      // A finished game leaves the "your games" list. THE CLIENT IS THE ONLY
      // PARTY THAT EVER LEARNS THIS: the games server's notify contract has
      // kinds turn | invite | friend and no game-over event, and we do not own
      // that server. This is not the client deciding game truth — it is
      // relaying what the authoritative snapshot just said, to a list that was
      // only ever a record of notifications. Each game words it differently, so
      // all three forms are checked and none of them is required.
      // isFinishedSnapshot, not a truthiness test on `result`: chess sends
      // `result: "playing"` every frame, which read as "finished" and both
      // dropped a live table out of the games list and filed it into the
      // history as a game that had ended. Seen on device.
      if (isFinishedSnapshot(s)) {
        const room = roomOverride.current ?? roomId;
        void forgetTable(game, room);
        // ...and write it into the history, from the same snapshot and for the
        // same reason: this device is the only party that ever learns a game
        // ended. Once per table — recordGame drops a repeat of the same
        // finished snapshot, which arrives on every frame until the player
        // leaves. Chess carries its move list; the others carry the result.
        const you = typeof s.you === 'string' ? s.you : '';
        void recordGame({
          game,
          room,
          at: Date.now(),
          outcome: outcomeOf(s, you),
          opponents: opponentsOf(s, you),
          detail: detailOf(s, outcomeOf(s, you)),
          moves: game === 'chess' ? movesOf(s) : undefined,
        });
      }
      setState({
        you: typeof s.you === 'string' ? s.you : '',
        seat: typeof s.seat === 'number' ? s.seat : null,
        spectator: !!s.spectator,
        lobby: s.lobby ?? null,
        game: s.game ?? null,
        raw: s,
      });
    });

    const offEvent = sock.onEvent((msg) => {
      if (!aliveRef.current) return;
      setEvents(prev => [...prev, msg].slice(-20));   // capped: a long table would grow forever
    });

    sock.connect().catch((e: any) => {
      if (aliveRef.current) setError(e?.message ?? 'Could not reach the games server.');
    });

    return () => {
      aliveRef.current = false;
      offPhase(); offMsg(); offState(); offEvent();
      sock.dispose();          // closes the socket AND stops its reconnect loop
      sockRef.current = null;
    };
  }, [game, roomId, attempt]);

  const send = useCallback((msg: GamesMessage) => {
    sockRef.current?.send(msg);
  }, []);

  const join = useCallback((roomId: string) => {
    sockRef.current?.join(roomId);
  }, []);

  const subscribe = useCallback((handler: (m: GamesMessage) => void) => {
    const set = subsRef.current;
    set.add(handler);
    return () => { set.delete(handler); };
  }, []);

  // ── auto-start, for tables that came from matchmaking ────────────────
  //
  // Lives here rather than in each board because all four have the same lobby
  // shape, and four copies would be four chances to fire `start` twice. The
  // refs make each intent once-only for the life of the socket: the server
  // answers a second `start` with an error, which would surface to the player
  // as a broken table on an otherwise fine game.
  const botSent = useRef(false);
  const startSent = useRef(false);
  const { auto, autoBot } = opts;

  useEffect(() => { botSent.current = false; startSent.current = false; }, [game, roomId, attempt]);

  useEffect(() => {
    if (!auto || phase !== 'connected') return;
    const lobby = state.lobby;
    // Only the host may seat a bot or deal; anyone else waits for them.
    if (!lobby || !state.you || lobby.hostId !== state.you) return;
    if (state.game) return;                       // already dealt

    const seated = lobby.members?.length ?? 0;
    if (autoBot && seated < 2 && !botSent.current) {
      botSent.current = true;
      sockRef.current?.send({ t: 'addbot' });
      return;                                     // wait for the seat to appear
    }
    if (seated >= 2 && !startSent.current) {
      startSent.current = true;
      sockRef.current?.send({ t: 'start' });
    }
  }, [auto, autoBot, phase, state.lobby, state.you, state.game]);

  const retry = useCallback((room?: string) => {
    roomOverride.current = typeof room === 'string' ? room : null;
    setError(null);
    setState(EMPTY);
    setAttempt(n => n + 1);     // re-runs the effect, which builds a fresh socket
  }, []);

  return { phase, error, state, events, send, join, subscribe, retry };
}

/** True when it is this player's turn — the one check every board needs. */
export function isMyTurn(state: GameState): boolean {
  const g = state.game;
  if (!g || state.spectator) return false;
  if (typeof g.turnPlayerId === 'string') return g.turnPlayerId === state.you;
  if (typeof g.turn === 'number' && typeof state.seat === 'number') return g.turn === state.seat;
  return false;
}
