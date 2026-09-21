// crazzychat real-time socket client.
//
// One shared realtime connection: CC-Wire app events over WebTransport,
// native WebSocket, or the platform WebSocket. It authenticates with the
// access JWT at handshake time.
//
// Lifecycle:
//   getSocket()    — lazy connect on first use, returns the shared event facade
//   disconnect()   — call on logout to drop the connection + clear caches
//   on(event, cb)  — typed subscription with auto-cleanup via returned fn
//
// Reconnect:
//   the CC-Wire supervisor owns backoff/recovery. If the token expires
//   mid-connection, the server closes the session; we refresh through the API
//   wrapper and reconnect.

import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { SERVER_URL } from '../constants/server';
import { getAccessToken, refreshAccessToken } from './api';
import { netKeyOf, reconnectReason, shouldKickOnForeground, shouldAbandonPendingConnect, SETTLE_MS } from './socketReconnect';
import perf from './perf';

export interface RealtimeSocket {
  connected: boolean;
  on(event: string, handler: (...args: any[]) => void): any;
  off(event: string, handler?: (...args: any[]) => void): any;
  once(event: string, handler: (...args: any[]) => void): any;
  emit(event: string, data?: any): any;
  connect(): any;
  disconnect(): any;
  removeAllListeners(): any;
  waitUntilReady?: () => Promise<RealtimeSocket>;
}
let socket: RealtimeSocket | null = null;
let connecting: Promise<RealtimeSocket> | null = null;
// When the in-flight connect started, so a hung handshake can be abandoned
// rather than wedging every caller behind it forever.
let connectingSince: number | null = null;

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
// a fresh facade is constructed. This is what keeps incoming calls reliable.
const persistentListeners = new Map<string, Set<(data: any) => void>>();
let persistentTarget: RealtimeSocket | null = null;
function applyPersistent(s: RealtimeSocket) {
  persistentTarget = s;
  for (const [event, hs] of persistentListeners) {
    for (const h of hs) { try { s.off(event, h); s.on(event, h); } catch {} }
  }
}

/** New app builds use CC-Wire for realtime events. */
export type TransportName = 'ccwire';
let ccwireGeneration = 0;
let stopCCWireSession: (() => void) | null = null;
let recoverCCWireSession: (() => void) | null = null;
export function selectTransport(): TransportName {
  return 'ccwire';
}

async function connect(): Promise<RealtimeSocket> {
  const generation = ccwireGeneration;
  perf.setSendTransport('http');
  perf.setConnState('connecting'); setConn('CONNECTING');
  let candidate: RealtimeSocket | null = null;
  try {
    // Token, module setup, native transport discovery, and device id are all
    // independent. Keep them overlapped so the first network handshake is not
    // serialized behind a Keystore read during cold start.
    //
    // WHAT THIS ACTUALLY BUYS: the expensive pieces are the Android Keystore
    // reads for the access token and device id. Module imports are mostly
    // synchronous Metro work, but overlapping them with those reads keeps the
    // first CC-Wire dial from waiting on each step one after another.
    //
    // FAILURE SEMANTICS: preserved for every entry — a transport/eventsSocket/
    // client rejection still rejects and lands in the catch below; nativeSocket
    // still degrades to null; getDeviceId() still degrades to undefined. ONE
    // difference: because the requires run left-to-right as the array is built,
    // getDeviceId() now also runs on a failing-transport path where it used to
    // be skipped, so a first-run device may persist vc_device_id there. It is
    // idempotent and would happen on the next successful connect anyway.
    const [token, m, { CCWireEventSocket }, { seedFromDeviceId }, deviceId, native] = await Promise.all([
      getAccessToken(),
      import('./ccwire/transport'),
      import('./ccwire/eventsSocket'),
      import('./ccwire/client'),
      import('../services/deviceService').then((x) => x.getDeviceId()).catch(() => undefined) as Promise<string | undefined>,
      import('./ccwire/nativeSocket').catch(() => null),
    ]);
    if (!token) throw new Error('Not signed in');
    let firstToken: string | null = token;
    const webSocket = native?.getNativeWebSocketImpl();
    const webTransportUrl = m.ccwireWebTransportUrl(SERVER_URL, process.env.EXPO_PUBLIC_CCWIRE_WEBTRANSPORT_URL);
    const webTransport = webTransportUrl ? native?.getNativeWebSocketImpl(webTransportUrl) : undefined;
    if (generation !== ccwireGeneration) throw new Error('Session ended');
    recoverCCWireSession = () => m.recoverCCWire();
    const s = new CCWireEventSocket({
      serverUrl: SERVER_URL,
      getToken: async () => {
        if (firstToken) { const t = firstToken; firstToken = null; return t; }
        return (await getAccessToken()) ?? '';
      },
      onResyncRequired: async () => { await (await import('./syncEngine')).resyncRequired(); },
      // Stable per-install id for the protobuf ClientHello. Authorization
      // remains the upgrade JWT; devices without the native module use JS WS.
      deviceId,
      // The same id, as the reconnect jitter seed. Left unset it defaults to 1
      // on every install, so every handset draws the same jitter factor and
      // rebuilds the same backoff ladder — a restart that drops every socket
      // brings them all back in one millisecond window, which is exactly what
      // the jitter is there to stop.
      seed: seedFromDeviceId(deviceId),
      WebSocketImpl: webTransport ?? webSocket,
      carrier: webTransport ? 'rust-wt' : webSocket ? 'rust-ws' : 'ws',
      webSocketFallback: webTransport ? { WebSocketImpl: webSocket, carrier: webSocket ? 'rust-ws' : 'ws' } : undefined,
      onStatus: (status, detail) => {
        if (status === 'error') perf.mark('transport_ccwire_unavailable', { detail });
        else perf.mark(`transport_ccwire_${status}`, { carrier: m.ccwireDiagnostics().carrier });
        if (status === 'pending') setConn('CONNECTING');
      },
    }, refreshAccessToken);
    candidate = s;
    stopCCWireSession = () => s.disconnect();
    applyPersistent(s);
    s.on('connect', () => {
      applyPersistent(s);
      perf.setTransport(m.ccwireCarrier() === 'none' ? 'websocket' : m.ccwireCarrier());
      perf.setConnState('connected');
      noteConnectSuccess();
      for (const id of joinedChatRooms) s.emit('join_chat', { chatId: id });
    });
    s.on('disconnect', (reason: string) => {
      perf.setConnState('disconnected');
      setConn('CONNECTING');
      perf.mark('socket_disconnect', { reason });
    });
    s.on('connect_error', noteConnectFailure);
    await s.waitUntilReady();
    if (generation !== ccwireGeneration) throw new Error('Session ended');
    return s;
  } catch (e) {
    candidate?.disconnect();
    candidate?.removeAllListeners();
    stopCCWireSession = null;
    recoverCCWireSession = null;
    perf.mark('transport_ccwire_unavailable', { detail: String(e) });
    throw e;
  }
}

// ── Rebuild the transport the moment the platform says something changed ──
//
// Nothing here used to watch the network, so a Wi-Fi→cellular switch left a
// socket whose TCP connection was ALREADY DEAD but which still reported
// `connected === true` — so no retry began. Waiting for transport heartbeat
// expiry added seconds of "Connecting..." before the first attempt. Foregrounding
// after Android killed the socket in Doze had the same shape.
//
// Both are things the OS already knows and will tell us for free. The decision
// of WHEN to act on that lives in ./socketReconnect (pure, selftested); this
// owns the subscriptions and the teardown.
let netKey: string | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let watching = false;

/** Force a fresh transport NOW rather than waiting out a ping timeout. */
function kickReconnect(why: string): void {
  // A connect already in flight will normally succeed or fail on its own, and
  // stomping it would restart the very handshake we are trying to hurry.
  //
  // But it can hang: connect() settles only on 'ready' or 'connect_error', and
  // a transport that opens without completing the handshake fires neither. That
  // promise then never resolves, `socket` stays null, and — because this guard
  // used to be unconditional — every later kick became a no-op FOREVER. The app
  // sat offline on a working link until it was force-stopped. Past the deadline
  // there is nothing real left to protect, so abandon it and start over.
  if (connecting && !shouldAbandonPendingConnect(connectingSince, Date.now())) return;
  if (connecting) {
    perf.mark('socket_connect_abandoned', { why });
    connecting = null;
    connectingSince = null;
  }
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    kickTimer = null;
    perf.mark('socket_kick', { why });
    setConn('CONNECTING');
    const s = socket;
    if (s) {
      // connect() must follow the explicit close so the shared facade starts a
      // fresh CC-Wire handshake immediately.
      try { s.disconnect(); s.connect(); return; } catch { /* fall through */ }
    }
    getSocket().catch(() => { /* the retry ladder owns the next attempt */ });
  }, SETTLE_MS);
}

/** Armed once, on first use. Idempotent. */
function watchNetwork(): void {
  if (watching) return;
  watching = true;

  try {
    NetInfo.addEventListener((st) => {
      const next = netKeyOf(st as any);
      const why = reconnectReason(netKey, next);
      netKey = next;
      if (why) { recoverCCWireSession?.(); kickReconnect(why); }
      else if (next === null) setConn('OFFLINE');   // radio gone: say so, don't retry
    });
  } catch { /* NetInfo unavailable (Expo Go / web) — timeouts still recover */ }

  try {
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      recoverCCWireSession?.();
      if (!shouldKickOnForeground(!!socket?.connected)) return;
      kickReconnect('foreground');
    });
  } catch { /* AppState unavailable — same fallback */ }
}

export async function getSocket(): Promise<RealtimeSocket> {
  watchNetwork();
  if (socket && socket.connected) return socket;
  if (socket?.waitUntilReady) return socket.waitUntilReady();
  // A pending attempt is shared rather than duplicated — UNLESS it has hung
  // past the deadline, in which case handing it out again would wedge this
  // caller too. See kickReconnect for how that happens.
  if (connecting && !shouldAbandonPendingConnect(connectingSince, Date.now())) return connecting;
  connectingSince = Date.now();
  const generation = ccwireGeneration;
  const attempt = connect()
    .then((s) => {
      if (generation !== ccwireGeneration) { s.disconnect(); throw new Error('Session ended'); }
      socket = s;
      if (connecting === attempt) { connecting = null; connectingSince = null; }
      return s;
    })
    .catch((e) => {
      if (connecting === attempt) { connecting = null; connectingSince = null; }
      throw e;
    });
  connecting = attempt;
  return connecting;
}

export function disconnect(): void {
  ccwireGeneration++;
  // A kick scheduled a moment before logout would otherwise fire into an empty
  // session and start dialling again — connect() would refuse it for lack of a
  // token, but only after churning. Cancel it here, where the intent is known.
  if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
  // A CC-Wire session is authenticated with THIS user's access token and must
  // not outlive the session. Cancel it synchronously before another account
  // can log in; the generation guard also cancels unfinished native startup.
  stopCCWireSession?.();
  stopCCWireSession = null;
  recoverCCWireSession = null;
  if (socket) {
    try { socket.removeAllListeners(); socket.disconnect(); } catch {}
    socket = null;
  }
  connecting = null;
  connectingSince = null;
  persistentTarget = null;
  // Keep persistentListeners — they must re-arm on the next (re-login) socket.
  // Drop the room set: a different account must not inherit this one's rooms;
  // live screens re-join on mount.
  joinedChatRooms.clear();
  roomRefs.clear();
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
  //
  // The delay RAMPS rather than sitting flat at 1500ms. The overwhelmingly
  // common early failure is "Not signed in" — a local SecureStore read that
  // resolves in milliseconds — and a flat poll meant the socket idled up to a
  // full 1.5s AFTER the token landed, on every cold launch, three times over
  // (_layout arms three persistent listeners). Ramping catches that moment in
  // ~200ms while still reaching the same 1.5s ceiling for the case that
  // actually deserves patience: a network that is genuinely down, where fast
  // retries would just churn sockets and radio.
  let stop = false;
  (async () => {
    for (let i = 0; i < 30 && !stop; i++) {
      try { await getSocket(); break; } catch {
        await new Promise(r => setTimeout(r, Math.min(1500, 200 * (i + 1))));
      }
    }
  })();
  return () => { stop = true; persistentListeners.get(event)?.delete(handler as any); try { (persistentTarget ?? socket)?.off(event, handler as any); } catch {} };
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
//
// REFCOUNTED. Several independent subscribers share one room — a circle's
// presence relay, the space-location platform and the trip channel all join
// the same chatId — and an unconditional leave meant the FIRST one to
// unsubscribe silently kicked the rest out of the room. The refcount makes
// join/leave pairs compose; a double join_chat on the wire is harmless.
const roomRefs = new Map<string, number>();
export async function joinChatRoom(chatId: string): Promise<void> {
  const id = String(chatId);
  roomRefs.set(id, (roomRefs.get(id) ?? 0) + 1);
  joinedChatRooms.add(id);
  await emit('join_chat', { chatId });
}
export async function leaveChatRoom(chatId: string): Promise<void> {
  const id = String(chatId);
  const n = (roomRefs.get(id) ?? 1) - 1;
  if (n > 0) { roomRefs.set(id, n); return; }   // someone still needs the room
  roomRefs.delete(id);
  joinedChatRooms.delete(id);
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
