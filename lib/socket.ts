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
