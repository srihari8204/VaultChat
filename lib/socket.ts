// VaultChat real-time socket client.
//
// Single Socket.IO connection per app instance. Authenticated with the
// access JWT at handshake time (matches the backend's io.use middleware
// in server.js).
//
// Lifecycle:
//   getSocket()    — lazy connect on first use, returns the live socket
//   disconnect()   — call on logout to drop the connection + clear caches
//   on(event, cb)  — typed subscription with auto-cleanup via returned fn
//
// Reconnect:
//   socket.io has built-in reconnect with exponential backoff. We rely on
//   it. If the token expires mid-connection, the server kicks us; we then
//   refresh the token (via the api wrapper) and reconnect.

import { io as ioClient, Socket } from 'socket.io-client';
import { useSyncExternalStore } from 'react';
import { SERVER_URL } from '../constants/server';
import { getAccessToken } from './api';
import perf from './perf';

let socket: Socket | null = null;
let connecting: Promise<Socket> | null = null;

// ── Task 2: "Can't connect" state ───────────────────────────────────
// After 5 consecutive websocket failures we surface a persistent banner
// (rendered by the UI in Task 6). Reset to healthy on the next successful
// connect. Subscribe via onCantConnect(); read once via getCantConnect().
let connectFailures = 0;
let cantConnect = false;
const cantConnectListeners = new Set<(v: boolean) => void>();
function setCantConnect(v: boolean) {
  if (cantConnect === v) return;
  cantConnect = v;
  for (const l of cantConnectListeners) { try { l(v); } catch {} }
}
function noteConnectFailure() {
  connectFailures++;
  if (connectFailures >= 5) { setCantConnect(true); setConn('OFFLINE'); }
}
function noteConnectSuccess() {
  connectFailures = 0;
  setCantConnect(false);
  setConn('ONLINE');
}
export function onCantConnect(cb: (v: boolean) => void): () => void {
  cantConnectListeners.add(cb);
  cb(cantConnect);
  return () => { cantConnectListeners.delete(cb); };
}
export function getCantConnect(): boolean { return cantConnect; }

// ── 3-state connection status (ONLINE | CONNECTING | OFFLINE) ────────
// The single source for the connection banner + the sync engine's ONLINE
// trigger. Derived from the same socket lifecycle events below.
export type ConnState = 'ONLINE' | 'CONNECTING' | 'OFFLINE';
let connState: ConnState = 'OFFLINE';
const connListeners = new Set<(s: ConnState) => void>();
function setConn(s: ConnState) {
  if (connState === s) return;
  connState = s;
  for (const l of connListeners) { try { l(s); } catch {} }
}
export function getConnectionState(): ConnState { return connState; }
export function onConnectionState(cb: (s: ConnState) => void): () => void {
  connListeners.add(cb);
  cb(connState);
  return () => { connListeners.delete(cb); };
}
/** React hook for the "Connecting…" / "Waiting for network" banner. */
export function useConnectionState(): ConnState {
  return useSyncExternalStore(
    (cb) => onConnectionState(() => cb()),
    () => connState,
    () => connState,
  );
}

// Listeners that MUST survive socket re-creation (reconnect after a network
// drop, or a new instance after disconnect()/re-login). Re-applied every time
// a fresh Socket is constructed. This is what keeps incoming calls reliable —
// a one-shot `s.on('call_incoming', …)` is lost the moment the socket is
// replaced, which is exactly why calls were silently not ringing.
const persistentListeners = new Map<string, Set<(data: any) => void>>();
function applyPersistent(s: Socket) {
  for (const [event, hs] of persistentListeners) {
    for (const h of hs) { try { s.off(event, h); s.on(event, h); } catch {} }
  }
}

async function connect(): Promise<Socket> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');

  const s = ioClient(SERVER_URL, {
    // Task 2: websocket-only (no polling fallback — intentional launch
    // decision), aggressive-but-jittered reconnect for fast network recovery.
    transports: ['websocket'],
    auth: { token },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    timeout: 10000,
  });
  applyPersistent(s);   // re-attach call/global listeners onto the new socket

  // ── Task 1 perf: log the negotiated transport + any upgrade ──────
  perf.setConnState('connecting'); setConn('CONNECTING');
  s.on('connect', () => {
    const tname = (s as any).io?.engine?.transport?.name ?? 'unknown';
    perf.setTransport(tname);
    perf.setConnState('connected');
    perf.mark('socket_connect', { transport: tname });
    noteConnectSuccess();   // clears any "can't connect" state
    // RE-JOIN CHAT ROOMS. The server joins a fresh socket only to user:<uid>;
    // every chat-room membership dies with the old server-side session on
    // reconnect, and nothing else re-establishes it — so live location,
    // typing and every other room-fanout event silently stopped arriving
    // after any reconnect until the screen was re-entered. Found on two
    // physical devices that could each see themselves and never each other.
    for (const id of joinedChatRooms) s.emit('join_chat', { chatId: id });
    try {
      (s as any).io?.engine?.on('upgrade', (t: any) => {
        perf.setTransport(t?.name ?? 'unknown');
        perf.mark('socket_upgrade', { transport: t?.name });
      });
    } catch {}
  });
  s.on('disconnect', (reason: string) => { perf.setConnState('disconnected'); setConn('CONNECTING'); perf.mark('socket_disconnect', { reason }); });
  s.io.on('reconnect_attempt', () => { perf.setConnState('connecting'); setConn('CONNECTING'); perf.bumpReconnect(); });
  // Count consecutive failures → drives the "Can't connect" banner after 5.
  s.io.on('reconnect_error', () => noteConnectFailure());
  s.io.on('error', () => noteConnectFailure());
  s.on('connect_error', () => noteConnectFailure());

  return new Promise<Socket>((resolve, reject) => {
    const onReady = () => {
      s.off('connect_error', onErr);
      resolve(s);
    };
    const onErr = (err: any) => {
      s.off('ready', onReady);
      s.disconnect();
      reject(new Error(err?.message || 'socket connect failed'));
    };
    s.once('ready', onReady);
    s.once('connect_error', onErr);
  });
}

export async function getSocket(): Promise<Socket> {
  if (socket && socket.connected) return socket;
  if (connecting) return connecting;
  connecting = connect()
    .then((s) => { socket = s; connecting = null; return s; })
    .catch((e) => { connecting = null; throw e; });
  return connecting;
}

export function disconnect(): void {
  if (socket) {
    try { socket.removeAllListeners(); socket.disconnect(); } catch {}
    socket = null;
  }
  connecting = null;
  // Keep persistentListeners — they must re-arm on the next (re-login) socket.
  // Drop the room set: a different account must not inherit this one's rooms;
  // live screens re-join on mount.
  joinedChatRooms.clear();
}

/**
 * Register a listener that auto-re-attaches whenever the socket is (re)created
 * — survives reconnects AND disconnect()/re-login. Also keeps retrying the
 * initial connection so it arms even if called before sign-in completes.
 * Use this for app-global events like incoming calls. Returns an unsubscribe.
 */
export function addPersistentListener<T = any>(event: string, handler: (data: T) => void): () => void {
  let set = persistentListeners.get(event);
  if (!set) { set = new Set(); persistentListeners.set(event, set); }
  set.add(handler as any);
  if (socket) { try { socket.off(event, handler as any); socket.on(event, handler as any); } catch {} }
  // Kick off / keep retrying a connection until signed in, so it actually attaches.
  let stop = false;
  (async () => {
    for (let i = 0; i < 30 && !stop; i++) {
      try { await getSocket(); break; } catch { await new Promise(r => setTimeout(r, 1500)); }
    }
  })();
  return () => { stop = true; persistentListeners.get(event)?.delete(handler as any); try { socket?.off(event, handler as any); } catch {} };
}

/**
 * Subscribe to a socket event. Returns an unsubscribe function.
 * Auto-connects if no socket is alive yet.
 */
export async function on<T = any>(
  event: string,
  handler: (data: T) => void,
): Promise<() => void> {
  const s = await getSocket();
  s.on(event, handler);
  return () => { try { s.off(event, handler); } catch {} };
}

/**
 * Send an event to the server. Auto-connects if needed.
 */
export async function emit(event: string, data?: any): Promise<void> {
  const s = await getSocket();
  s.emit(event, data);
}

// Rooms that must survive reconnection — the client-side twin of
// persistentListeners. Listeners survive a socket swap because we re-attach
// them; room membership lives on the SERVER's per-connection session and must
// be re-requested, which the connect handler above does from this set.
const joinedChatRooms = new Set<string>();

// Convenience wrappers for the most common chat events.
export async function joinChatRoom(chatId: string): Promise<void> {
  joinedChatRooms.add(String(chatId));
  await emit('join_chat', { chatId });
}
export async function leaveChatRoom(chatId: string): Promise<void> {
  joinedChatRooms.delete(String(chatId));
  await emit('leave_chat', { chatId });
}
export async function emitTypingStart(chatId: string, uid: string): Promise<void> {
  await emit('typing_start', { chatId, uid });
}
export async function emitTypingStop(chatId: string, uid: string): Promise<void> {
  await emit('typing_stop', { chatId, uid });
}

// Live Chat Viewers (feature #58) — ephemeral "who's viewing this chat".
export type ViewerActivity = 'reading' | 'typing' | 'uploading';
export async function emitChatView(
  chatId: string,
  status: 'VIEWING' | 'LEFT',
  activity?: ViewerActivity,
  resync?: boolean,
): Promise<void> {
  await emit('chat_view', { chatId, status, activity, resync });
}

// Required by expo-router to silence "no default export" route warnings
// for files dropped in app/. lib/ isn't a route folder so this is a no-op,
// but keeping it consistent across our helper modules.
export default {};
