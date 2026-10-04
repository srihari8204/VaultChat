/**
 * lib/gamesSocket.ts — native games WebSocket client.
 *
 * Replaces the WebView-based session bootstrap with a direct native connection to
 * the separately-deployed games server. The flow mirrors what the web clients do
 * (games-web/*.js → establishSession → connect), but in RN:
 *
 *   1. Mint a short-lived Ed25519-signed launch token from crazzychat's OWN backend
 *      (POST /games/launch-token) — the token carries vaultId + name only.
 *   2. Exchange it for a games session by POSTing to the games server's
 *      /api/session with credentials:'include' — the server sets a `gsid` cookie
 *      that identifies the verified vaultId for the WebSocket handshake.
 *   3. Open a native WebSocket to the game's realtime endpoint
 *      (wss://games.corefinite.com/<game>/ws). RN's WebSocket sends the cookie
 *      from the same cookie jar that fetch stored it in (OkHttp on Android,
 *      NSURLSession on iOS).
 *
 * The games server is AUTHORITATIVE — it holds the deck, validates every move,
 * and broadcasts authoritative state. This client only sends intents and
 * renders the state it receives back. This is the same trust model as the web
 * clients; the only difference is the rendering layer (RN Views, not DOM).
 *
 * Security invariant: the games server receives identity-for-scoring (a scoped,
 * 15-minute token) and nothing else. No bridge to the crypto core, messages,
 * contacts, or file vault.
 */

import { AppState, type NativeEventSubscription } from "react-native";

import { api } from "./api";

/** The separately-deployed games origin (HTTPS). Exported so the REST callers
 * (wallet, leaderboard, /api/me) name the host from this one place. */
export const GAMES_HTTP = "https://games.corefinite.com";
/** The same origin as a WebSocket URL. */
const GAMES_WS = GAMES_HTTP.replace(/^http/, "ws");

export type GameKind = "tictactoe" | "ludo" | "chess" | "rummy";

/**
 * Mint a launch token and exchange it for a games session cookie.
 *
 * Shared because the matchmaking socket (/live/ws) needs exactly the same
 * session as a table socket — it is the same server and the same cookie jar.
 * Duplicating the handshake would mean two places to get the credentials mode
 * wrong, and `credentials: "include"` is the whole reason the WebSocket is
 * authenticated at all.
 */
export async function establishGamesSession(onExchange?: () => void): Promise<void> {
  const res = await api<{ token: string }>("/games/launch-token", { method: "POST" });
  const token = res?.token;
  if (!token) throw new Error("No launch token returned by crazzychat backend.");

  onExchange?.();
  const sessionRes = await fetch(`${GAMES_HTTP}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  if (!sessionRes.ok) {
    throw new Error(
      `Games session rejected (${sessionRes.status}). The games server may be down.`,
    );
  }
}

/** Base URL of the games WebSocket, for sockets other than a game table. */
export const GAMES_WS_BASE = GAMES_WS;



/** The WebSocket path for each game (matches games-server/realtime/ws.ts). */
const WS_PATH: Record<GameKind, string> = {
  tictactoe: "/tictactoe/ws",
  ludo: "/ludo/ws",
  chess: "/chess/ws",
  rummy: "/ws",
};

export interface GamesMessage {
  t: string;
  [key: string]: any;
}

export type Phase = "idle" | "minting" | "connecting" | "connected" | "error";

type StateHandler = (state: any) => void;
type MessageHandler = (msg: GamesMessage) => void;
type PhaseHandler = (phase: Phase, error?: string) => void;

/**
 * A native connection to one game's realtime endpoint. Owns the WebSocket,
 * the session bootstrap, and the reconnection loop. One instance per game
 * screen; the hub creates it on mount and disconnects on unmount.
 */
export class GamesSocket {
  private ws: WebSocket | null = null;
  private phase: Phase = "idle";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  /**
   * A mint → session → open sequence is actually running.
   *
   * NOT the same thing as `phase === "connecting"`, and conflating the two is
   * what made every reconnect in all four games a no-op: `onclose` sets the
   * phase to "connecting" so the screen keeps its "Reconnecting — your hand is
   * safe" banner, and then the retry timer called `connect()`, whose guard was
   * `phase === "connecting" || phase === "connected"` — so it returned
   * immediately without opening anything. Nothing scheduled another attempt
   * either, because `scheduleReconnect` only ever runs from `onclose`. The
   * result was a permanent banner with every button dead, a turn clock running
   * out behind it, and the `reconnectAttempts > 8` error path unreachable so
   * the player never even got offered Retry.
   *
   * `phase` is what the SCREEN shows. This is whether a connect is in flight.
   * Cleared wherever an attempt ends: onopen, onclose, handleError, dispose.
   */
  private connecting = false;
  private appState: NativeEventSubscription | null = null;
  /**
   * The table THIS socket has already asked to sit at.
   *
   * Re-sending a join for the table you are already in makes the rummy server
   * close the connection — a bare CLOSE 1000 with no error frame, observed live
   * against wss://games.corefinite.com/ws. Joining a DIFFERENT table is fine.
   * So a second tap on the table you are sitting at, or any screen that re-asks
   * for the seat it already has, would drop the socket mid-hand and look like a
   * network failure.
   *
   * Per-SOCKET, not per-table: cleared whenever the connection is rebuilt, so a
   * reconnect still rejoins normally (that is a new socket, which has not asked
   * for anything yet).
   */
  private joinedOn: string | null = null;

  private stateHandlers = new Set<StateHandler>();
  private msgHandlers = new Set<MessageHandler>();
  private phaseHandlers = new Set<PhaseHandler>();
  private eventHandlers = new Set<(msg: string) => void>();

  constructor(
    private readonly game: GameKind,
    // Not readonly: rummy picks its table AFTER connecting (see join()), and
    // the reconnect loop has to rejoin whatever table the player is sitting at,
    // not the one the screen was opened with.
    private roomId: string = "",
  ) {
    // Doze, a call, or a few minutes in the background kill a socket WITHOUT
    // always firing `onclose`: the connection is half-dead and `readyState`
    // still reads OPEN until the first failed write. `send()` then drops every
    // frame on the floor silently, so the board looked live, the buttons were
    // enabled, and nothing the player tapped reached the table.
    //
    // Coming back to the foreground is the one moment we can cheaply tell. Any
    // socket that is not genuinely OPEN is rebuilt from scratch — which is also
    // what makes "background the app mid-hand and come back" work at all, since
    // there is no heartbeat in this protocol to notice it any sooner.
    this.appState = AppState.addEventListener("change", (next) => {
      if (next !== "active" || this.disposed) return;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      // Drop the stale phase first: a half-dead socket leaves it at
      // "connected", and connect() refuses to run in that state.
      this.setPhase("connecting");
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // A deliberate resume is not a failed retry, so the backoff starts over
      // rather than resuming at a ten-second delay.
      this.reconnectAttempts = 0;
      void this.connect();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Begin the connect sequence (mint → session → ws). Idempotent. */
  async connect(): Promise<void> {
    if (this.connecting || this.phase === "connected") return;
    this.connecting = true;
    this.setPhase("minting");
    // reconnectAttempts is NOT reset here. `onopen` owns it, because a reset on
    // every attempt is a reset on every RETRY — the backoff would restart at
    // one second forever and the ">8 attempts, offer Retry" branch would never
    // be reached. It is cleared when a connection actually succeeds.

    try {
      await establishGamesSession(() => this.setPhase("connecting"));
      // The gsid cookie is now in the native jar, and the WebSocket sends it.
      this.openSocket();
    } catch (err) {
      this.handleError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Take a seat at a specific table.
   *
   * Rummy is the one game where the table is chosen rather than defaulted: the
   * server answers `{t:'lobby'}` with its table list and the player picks one.
   * Storing the id here rather than passing it straight through is what makes
   * a mid-hand reconnect rejoin THAT table instead of dumping the player back
   * on the list with their cards gone.
   */
  join(roomId: string): void {
    // See `joinedOn`: the server answers a self-rejoin by hanging up.
    if (roomId && this.joinedOn === roomId) return;
    this.roomId = roomId;
    this.sendJoin();
  }

  /** The table currently seated at, for a screen that needs to share its code. */
  getRoomId(): string {
    return this.roomId;
  }

  /** Send a JSON message to the games server. No-op if not connected. */
  send(msg: GamesMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Subscribe to authoritative game state updates. Returns an unsubscribe. */
  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Subscribe to raw messages (for game-specific protocol handling). */
  onMessage(handler: MessageHandler): () => void {
    this.msgHandlers.add(handler);
    return () => this.msgHandlers.delete(handler);
  }

  /** Subscribe to phase changes (idle → minting → connecting → connected). */
  onPhase(handler: PhaseHandler): () => void {
    this.phaseHandlers.add(handler);
    handler(this.phase);
    return () => this.phaseHandlers.delete(handler);
  }

  /** Subscribe to server-sent event messages ({t:'event', msg}). */
  onEvent(handler: (msg: string) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** Disconnect and free all resources. The screen calls this on unmount. */
  dispose(): void {
    this.disposed = true;
    this.connecting = false;
    this.appState?.remove();
    this.appState = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.setPhase("idle");
  }

  /** Get the current connection phase. */
  getPhase(): Phase {
    return this.phase;
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private openSocket(): void {
    const path = WS_PATH[this.game];
    const url = `${GAMES_WS}${path}`;
    this.setPhase("connecting");
    // A fresh socket has asked for nothing yet.
    this.joinedOn = null;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.handleError(
        err instanceof Error ? err.message : "WebSocket creation failed",
      );
      return;
    }

    this.ws.onopen = () => {
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.setPhase("connected");
      this.sendJoin();
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      let msg: GamesMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      // Route to handlers based on the message type.
      switch (msg.t) {
        case "state":
          this.stateHandlers.forEach((h) => {
            try {
              h(msg);
            } catch {}
          });
          break;
        case "event":
          this.eventHandlers.forEach((h) => {
            try {
              h(msg.msg || "");
            } catch {}
          });
          break;
        case "error":
          this.eventHandlers.forEach((h) => {
            try {
              h(`⚠ ${msg.msg || "error"}`);
            } catch {}
          });
          break;
      }

      // Always fire the raw message handler (game-specific protocol).
      this.msgHandlers.forEach((h) => {
        try {
          h(msg);
        } catch {}
      });
    };

    this.ws.onerror = () => {
      // The close handler does the reconnect; this is just for surfacing.
    };

    this.ws.onclose = () => {
      this.connecting = false;
      this.joinedOn = null;
      if (this.disposed) return;
      this.setPhase("connecting");
      this.scheduleReconnect();
    };
  }

  /**
   * Ask for a seat, in the shape the game in question actually expects.
   *
   * THE FIELD NAME DIFFERS. Three of the four games take `{t:'join', roomId}`;
   * rummy takes `{t:'join', tableId}` (docs/GAMES_PROTOCOL.md, and
   * games-web/rummy.js sends exactly that). Sending `roomId` to rummy is not an
   * error the server reports — the field is simply not the one it reads, so
   * every native player was seated wherever the server defaulted no matter
   * which table they picked, and a shared invite code went nowhere.
   *
   * With no table chosen, rummy is asked for its LIST rather than guessing an
   * id: `{t:'lobby'}` is answered with `{t:'tables'}`, which is where public
   * tables, seat counts and stakes come from.
   */
  private sendJoin(): void {
    if (this.game === "rummy") {
      if (this.roomId) {
        this.joinedOn = this.roomId;
        this.send({ t: "join", tableId: this.roomId });
      } else {
        // No table chosen yet, so ask for the list. This is NOT a seat, and
        // recording it as one would block the join that follows it.
        this.send({ t: "lobby" });
      }
      return;
    }
    this.joinedOn = this.roomId || defaultRoom(this.game);
    this.send({ t: "join", roomId: this.joinedOn });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempts++;
    // Exponential backoff with jitter, capped at 10s (mirrors the web clients'
    // VGNet.retry). After ~8 attempts, surface a persistent error state.
    const base = Math.min(1000 * 2 ** this.reconnectAttempts, 10000);
    const jitter = Math.random() * 500;
    const delay = base + jitter;

    if (this.reconnectAttempts > 8) {
      this.setPhase(
        "error",
        "Lost connection to the games server. Tap retry to reconnect.",
      );
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.disposed) return;
      // Re-mint + re-session + re-open — the token may have expired.
      this.connect().catch((err) => this.handleError(String(err)));
    }, delay);
  }

  private handleError(msg: string): void {
    this.connecting = false;
    if (this.disposed) return;
    this.setPhase("error", msg);
  }

  private setPhase(phase: Phase, error?: string): void {
    if (this.phase === phase && !error) return;
    this.phase = phase;
    this.phaseHandlers.forEach((h) => {
      try {
        h(phase, error);
      } catch {}
    });
  }
}

/**
 * The default room id when no deep-link or push roomId was passed.
 *
 * Rummy is excluded on purpose: its tables are server-defined and it is asked
 * for the list instead (see sendJoin), so there is no id to invent here.
 */
function defaultRoom(game: Exclude<GameKind, "rummy">): string {
  switch (game) {
    case "tictactoe":
      return "tictactoe-main";
    case "ludo":
      return "ludo-main";
    case "chess":
      return "chess-main";
  }
}
