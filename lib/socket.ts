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
import { SERVER_URL } from '../constants/server';
import { getAccessToken } from './api';

let socket: Socket | null = null;
let connecting: Promise<Socket> | null = null;

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
    transports: ['websocket'],
    auth: { token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
  });
  applyPersistent(s);   // re-attach call/global listeners onto the new socket

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

// Convenience wrappers for the most common chat events.
export async function joinChatRoom(chatId: string): Promise<void> {
  await emit('join_chat', { chatId });
}
export async function leaveChatRoom(chatId: string): Promise<void> {
  await emit('leave_chat', { chatId });
}
export async function emitTypingStart(chatId: string, uid: string): Promise<void> {
  await emit('typing_start', { chatId, uid });
}
export async function emitTypingStop(chatId: string, uid: string): Promise<void> {
  await emit('typing_stop', { chatId, uid });
}

// Required by expo-router to silence "no default export" route warnings
// for files dropped in app/. lib/ isn't a route folder so this is a no-op,
// but keeping it consistent across our helper modules.
export default {};
