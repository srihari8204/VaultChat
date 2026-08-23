/**
 * lib/gamesSocket.ts — native games WebSocket client.
 *
 * Replaces the WebView-based session bootstrap with a direct native connection to
 * the separately-deployed games server. The flow mirrors what the web clients do
 * (games-web/*.js → establishSession → connect), but in RN:
 *
 *   1. Mint a short-lived Ed25519-signed launch token from VaultChat's OWN backend
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

import { api } from "./api";

/** The separately-deployed games origin (HTTPS). */
const GAMES_HTTP = "https://games.corefinite.com";
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
  if (!token) throw new Error("No launch token returned by VaultChat backend.");

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

  private stateHandlers = new Set<StateHandler>();
  private msgHandlers = new Set<MessageHandler>();
  private phaseHandlers = new Set<PhaseHandler>();
  private eventHandlers = new Set<(msg: string) => void>();

  constructor(
    private readonly game: GameKind,
    private readonly roomId: string = "",
  ) {}

  // ── Public API ────────────────────────────────────────────────────────

  /** Begin the connect sequence (mint → session → ws). Idempotent. */
  async connect(): Promise<void> {
    if (this.phase === "connecting" || this.phase === "connected") return;
    this.setPhase("minting");
    this.reconnectAttempts = 0;

    try {
      await establishGamesSession(() => this.setPhase("connecting"));
      // The gsid cookie is now in the native jar, and the WebSocket sends it.
      this.openSocket();
    } catch (err) {
      this.handleError(err instanceof Error ? err.message : String(err));
    }
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

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.handleError(
        err instanceof Error ? err.message : "WebSocket creation failed",
      );
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setPhase("connected");
      // Join the room immediately — the server expects {t:'join', roomId}.
      this.send({ t: "join", roomId: this.roomId || defaultRoom(this.game) });
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
      if (this.disposed) return;
      this.setPhase("connecting");
      this.scheduleReconnect();
    };
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

/** The default room id when no deep-link or push roomId was passed. */
function defaultRoom(game: GameKind): string {
  switch (game) {
    case "tictactoe":
      return "tictactoe-main";
    case "ludo":
      return "ludo-main";
    case "chess":
      return "chess-main";
    case "rummy":
      return "practice"; // the rummy default table
  }
}
