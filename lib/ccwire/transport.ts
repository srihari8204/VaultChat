// lib/ccwire/transport.ts — the join between lib/socket.ts and CCWireClient.
//
// A supervisor for AT MOST ONE CCWireClient per app instance, with an
// explicit four-state lifecycle, a bounded number of pre-handshake attempts,
// and a status callback for metrics. Supervisor failures are status transitions;
// submission failures preserve normal request rejection semantics.
//
// Eligible text submissions use protobuf after ServerHello. One function owns
// the attempt and sequential HTTP fallback, preserving the same ciphertext and
// clientId (the server's shared idempotency key). With app_events_v1 negotiated,
// named inbound events go to the shared event facade. lib/socket.ts selects
// this exclusive connection or legacy Socket.IO after closing this owner.
//
// NODE-IMPORTABLE ON PURPOSE. No react-native, no expo, no constants/*. The
// server URL, the token reader and the clock come in as options, which is what
// lets transport.selftest.ts drive the real thing under `npx tsx`.

import CCWireClient from './client';
import { decodeMessageAck, type PublicMeta, type AppEvent } from './codec';
import { SessionEndedError } from '../sessionEnded';

/** The CC-Wire route, mirroring realtime.CCWirePath in the Go server. */
export const CCWIRE_PATH = '/ccwire/v1';

/**
 * Explicit states. There is no fifth, and there is no "unknown".
 *
 *   'off'     nothing has been started
 *   'pending' dialling or handshaking; NOT usable
 *   'ready'   ServerHello accepted; the session is live
 *   'error'   stopped; transient failures may recover on a platform signal
 *
 * The app coordinator bounds readiness and selects legacy when initial
 * negotiation fails. A pending connection is not reported as ready to UI.
 */
export type CCWireStatus = 'off' | 'pending' | 'ready' | 'error';

export interface StartCCWireOptions {
  requireAppEvents?: boolean;
  onAppEvent?: (event: string, payload: any) => void;
  onResyncRequired?: () => Promise<void>;
  /** e.g. https://api.corefinite.com — converted to wss://…/ccwire/v1. */
  serverUrl: string;
  /** Read fresh per dial; a token captured once outlives its 15-minute expiry. */
  getToken: () => string | Promise<string>;
  deviceId?: string;
  carrier?: 'rust-ws' | 'ws' | 'rust-wt';
  /** A single optional WebTransport attempt hands over to this WebSocket. */
  webSocketFallback?: { WebSocketImpl?: any; carrier: 'rust-ws' | 'ws' };
  seed?: number;
  /** Called on every transition. Must not throw; it is wrapped anyway. */
  onStatus?: (s: CCWireStatus, detail?: string) => void;
  /** Injectables for the selftest. Unused by the app. */
  WebSocketImpl?: any;
  setTimeoutImpl?: (fn: () => void, ms: number) => any;
  clearTimeoutImpl?: (h: any) => void;
  now?: () => number;
}

/**
 * How many times we may close WITHOUT ever having completed a handshake before
 * giving up for this app session.
 *
 * A server without CCWIRE_WS answers 404 on /ccwire/v1. The client's
 * own backoff would happily retry that until the app is killed. Three strikes
 * turns "the route does not exist" into one short burst and then silence,
 * instead of a permanent background retry ladder on a handset whose messaging
 * is working fine over Socket.IO.
 *
 * Reset on every successful ServerHello, so a server that restarts mid-session
 * is a reconnect, not a strike.
 */
const MAX_PREHANDSHAKE_CLOSES = 3;

/** Dial + handshake budget. Past this we stop waiting and call it an error. */
const HANDSHAKE_DEADLINE_MS = 15000;
const EVENT_UTF8 = new TextDecoder('utf-8', { fatal: true });

let client: CCWireClient | null = null;
let status: CCWireStatus = 'off';
let preHandshakeCloses = 0;
let everReady = false;
let deadlineTimer: any = null;
let onStatus: StartCCWireOptions['onStatus'] = null;
let clearT: (h: any) => void = (h) => clearTimeout(h);
let setT: (fn: () => void, ms: number) => any = (fn, ms) => setTimeout(fn, ms);
let carrier = 'ws';
let sessionGeneration = 0;
const pendingSubmissions = new Set<() => void>();
let submitted = 0;
let acknowledged = 0;
let fallbacks = 0;
let lastError: string | undefined;
let recoveryOptions: StartCCWireOptions | null = null;
let recoverable = false;
let recoveryTimer: any = null;
let lastRecoveryAt = -Infinity;
const RECOVERY_COOLDOWN_MS = 30000;

/** Coalesce platform recovery signals; never reopen fatal/auth refusals. */
export function recoverCCWire(): void {
  if (status !== 'error' || !recoverable || !recoveryOptions || recoveryTimer) return;
  const options = recoveryOptions;
  const resume = () => {
    recoveryTimer = null;
    if (status !== 'error' || !recoverable || recoveryOptions !== options) return;
    lastRecoveryAt = (options.now ?? Date.now)();
    status = 'off';
    startCCWire(options);
  };
  const delay = Math.max(0, RECOVERY_COOLDOWN_MS - ((options.now ?? Date.now)() - lastRecoveryAt));
  if (delay) recoveryTimer = setT(resume, delay);
  else resume();
}

export function ccwireStatus(): CCWireStatus { return status; }
/** The live client, for diagnostics. */
export function ccwireClient(): CCWireClient | null { return client; }
export function ccwireCarrier(): string { return status === 'ready' ? carrier : 'none'; }
export function ccwireDiagnostics() {
  return { status, carrier, submitted, acknowledged, fallbacks, lastError };
}

export interface MessageSubmission {
  content: string; type: string; replyToId?: number | null;
  meta?: Record<string, any> | null; clientId: string;
}
type MessageApi = <T>(path: string, options?: { method?: string; json?: any }) => Promise<T>;

/** Existing SubmitMessage has no type/reply field; never silently lose either. */
function textMeta(p: MessageSubmission): PublicMeta | null {
  if (p.type !== 'text' || p.replyToId != null || !p.clientId || !p.content) return null;
  const out: PublicMeta = {};
  const keys = { viewOnce: 'view_once', announcement: 'announcement', silent: 'silent', encrypted: 'encrypted' };
  for (const [key, value] of Object.entries(p.meta ?? {})) {
    if (Object.prototype.hasOwnProperty.call(keys, key) && typeof value === 'boolean') out[keys[key]] = value;
    else if (key === 'audience' && typeof value === 'string') out.audience = value;
    else if (key === 'mentionUserIds' && Array.isArray(value) && value.every((id) => typeof id === 'string')) out.mention_user_ids = value;
    else return null;
  }
  return out;
}

/** Single owner for each encrypted submission, shared by queued and direct sends. */
export async function submitCCWireMessage<T>(chatId: string, payload: MessageSubmission, http: MessageApi): Promise<{ message: T; transport: string }> {
  const path = `/chats/${encodeURIComponent(chatId)}/messages`;
  const generation = sessionGeneration;
  const ensureSession = () => { if (generation !== sessionGeneration) throw new SessionEndedError(); };
  const c = client;
  const meta = textMeta(payload);
  if (status === 'ready' && c?.ready && meta && pendingSubmissions.size < 32) {
    const usedCarrier = carrier;
    const requestId = c.nextRequestId();
    let refusal: Error & { status?: number };
    const messageId = await new Promise<string | null>((resolve) => {
      let finished = false;
      let timer: any;
      const off: (() => void)[] = [];
      const finish = (id: string | null) => {
        if (finished) return;
        finished = true;
        if (timer) clearT(timer);
        for (const remove of off) remove();
        pendingSubmissions.delete(cancel);
        resolve(id);
      };
      const cancel = () => finish(null);
      pendingSubmissions.add(cancel);
      off.push(c.on('closed', cancel));
      off.push(c.on('error', (e) => {
        if (e.frame?.request_id !== requestId) return;
        // Definitive denials and rate limits must not be tried again through
        // HTTP. Only unavailable operations/transports use that fallback.
        const refusedStatus = ({ 5: 403, 6: 429, 8: 400 } as Record<number, number>)[e.errorCode];
        if (refusedStatus) {
          refusal = Object.assign(new Error(refusedStatus === 429 ? 'Too many messages; try again shortly' : 'Message submission refused'), { status: refusedStatus });
        }
        finish(null);
      }));
      off.push(c.on('frame', (e) => {
        if (e.frame?.body_field !== 22 || e.frame.request_id !== requestId) return;
        const ack = decodeMessageAck(e.frame.raw ?? new Uint8Array());
        const id = ack.ok ? ack.value?.message_id : '';
        const valid = /^[1-9][0-9]*$/.test(id ?? '');
        if (valid) acknowledged++;
        finish(valid ? id : null);
      }));
      timer = setT(cancel, 12000);
      if (!c.send({ request_id: requestId, traffic_class: 2, stream: 2, body_field: 48,
        value: { envelope: { chat_id: chatId, client_msg_id: payload.clientId, msg_class: 1, public_meta: meta },
          sealed: new TextEncoder().encode(payload.content) } })) finish(null);
      else submitted++;
    });
    ensureSession();
    if (refusal) throw refusal;
    if (messageId) {
      // ponytail: Ack has only id/time. Read the canonical row until protobuf
      // carries all Message fields, including disappearing/vanish semantics.
      try {
        const rows = await http<any[]>(`${path}?before=${BigInt(messageId) + 1n}&limit=1`);
        ensureSession();
        const row = rows?.find((m) => String(m?.id) === messageId && m?.chatId === chatId);
        if (row) return { message: row as T, transport: `ccwire-${usedCarrier}` };
      } catch { ensureSession(); }
    }
    // An Ack may be lost after commit. REST uses the exact same key and bytes,
    // so ON CONFLICT returns that persisted row instead of inserting another.
    fallbacks++;
    lastError = messageId ? 'canonical message lookup unavailable' : 'submission unavailable or acknowledgement missing';
  }
  ensureSession();
  const message = await http<T>(path, { method: 'POST', json: payload });
  ensureSession();
  return { message, transport: 'http' };
}

function setStatus(s: CCWireStatus, detail?: string): void {
  if (s === 'error') lastError = detail ? 'connection unavailable' : 'connection stopped';
  if (s === 'ready') lastError = undefined;
  if (status === s) return;
  status = s;
  try { onStatus?.(s, detail); } catch { /* a metrics sink must not break the transport */ }
}

/** https→wss, http→ws, anything else left alone; path appended exactly once. */
export function ccwireUrlFor(serverUrl: string): string {
  const base = String(serverUrl ?? '').replace(/\/+$/, '');
  const ws = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return ws + CCWIRE_PATH;
}

/** Optional trusted-host HTTPS endpoint; never invent or advertise a default. */
export function ccwireWebTransportUrl(serverUrl: string, configured?: string): string | undefined {
  if (!configured) return undefined;
  try {
    const api = new URL(serverUrl);
    const endpoint = new URL(configured);
    if (api.protocol !== 'https:' || endpoint.protocol !== 'https:' || endpoint.hostname !== api.hostname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined;
    return endpoint.href;
  } catch { return undefined; }
}

/**
 * Dial the shared CC-Wire owner.
 *
 * Fire-and-forget by design: it returns void, synchronously, and the caller
 * must not await it. Idempotent — a second call while a session exists does
 * nothing, so a reconnect cannot accumulate sessions.
 */
export function startCCWire(o: StartCCWireOptions): void {
  if (client || status === 'error') return;
  recoveryOptions = o;
  recoverable = false;
  onStatus = o.onStatus ?? null;
  clearT = o.clearTimeoutImpl ?? ((h) => clearTimeout(h));
  setT = o.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  carrier = o.carrier ?? 'ws';
  preHandshakeCloses = 0;
  everReady = false;
  let lastCloseWasAuth = false;
  setStatus('pending');

  const fallbackToWebSocket = () => {
    if (o.carrier !== 'rust-wt' || !o.webSocketFallback) return false;
    // End the old owner and every pending Ack before creating the WSS owner.
    // A submitted message falls back to HTTP with its existing idempotency key.
    for (const cancel of [...pendingSubmissions]) cancel();
    if (deadlineTimer) { clearT(deadlineTimer); deadlineTimer = null; }
    const previous = client;
    client = null;
    previous?.close('WebTransport fallback');
    status = 'off';
    startCCWire({ ...o, carrier: o.webSocketFallback.carrier, WebSocketImpl: o.webSocketFallback.WebSocketImpl, webSocketFallback: undefined });
    return true;
  };

  let c: CCWireClient;
  try {
    c = new CCWireClient({
      url: ccwireUrlFor(o.serverUrl),
      getToken: o.getToken,
      deviceId: o.deviceId,
      seed: o.seed,
      WebSocketImpl: o.WebSocketImpl,
      setTimeoutImpl: o.setTimeoutImpl,
      clearTimeoutImpl: o.clearTimeoutImpl,
      now: o.now,
    });
  } catch (e) {
    if (fallbackToWebSocket()) return;
    // The app coordinator handles legacy fallback after this owner fails.
    setStatus('error', `construct: ${String(e)}`);
    return;
  }
  client = c;

  // Dial failure, handshake failure, auth failure, capability mismatch and a
  // 404 route all arrive here as one typed `closed` event. See the matrix in
  // CloseReason (client.ts) — this file only has to decide "retry or give up".
  let helloGeneration = 0;
  c.on('hello', (e) => {
    if (client !== c) return;
    helloGeneration++;
    if (o.requireAppEvents && !e.hello?.appEventsV1) {
      stopCCWire('app_events_v1 unsupported');
      return;
    }
    everReady = true;
    preHandshakeCloses = 0;
    if (deadlineTimer) { clearT(deadlineTimer); deadlineTimer = null; }
    setStatus('ready');
  });
  c.on('frame', (e) => {
    if (client !== c || status !== 'ready' || e.frame?.body_field !== 100) return;
    const body = e.frame.value as AppEvent;
    if (!body?.event || body.event.length > 64 || !body.payload_json) return;
    try { o.onAppEvent?.(body.event, JSON.parse(EVENT_UTF8.decode(body.payload_json))); }
    catch { /* malformed input or a consumer exception cannot kill the carrier */ }
  });
  c.on('resync_required', () => {
    if (client !== c || !o.onResyncRequired) return;
    const generation = helloGeneration;
    void o.onResyncRequired().then(() => {
      if (client === c && status === 'ready' && generation === helloGeneration) c.markResynced();
    }).catch(() => { /* HTTP submission remains available until recovery succeeds */ });
  });
  c.on('closed', (e) => {
    if (client !== c) return;
    lastCloseWasAuth = e.reason === 'auth';
    if (fallbackToWebSocket()) return;
    if (!everReady || !e.willRetry) preHandshakeCloses++;
    const giveUp = lastCloseWasAuth || !e.willRetry || c.fatal || preHandshakeCloses >= MAX_PREHANDSHAKE_CLOSES;
    if (giveUp) { stopCCWire(`closed: ${e.reason}${e.detail ? ` ${e.detail}` : ''}`, !c.fatal && !lastCloseWasAuth); return; }
    // Still retrying (the client owns the backoff): not ready, not dead.
    setStatus('pending', e.reason);
  });

  deadlineTimer = setT(() => {
    if (client !== c) return;
    deadlineTimer = null;
    if (status !== 'ready' && !fallbackToWebSocket()) stopCCWire('handshake deadline', !lastCloseWasAuth);
  }, HANDSHAKE_DEADLINE_MS);

  // connect() never throws and never rejects; the void is deliberate.
  try { void c.connect(); } catch (e) { stopCCWire(`connect: ${String(e)}`); }
}

/**
 * End this session. Only explicitly transient failures allow platform recovery.
 *
 * startCCWire() alone cannot reopen an error. recoverCCWire() requires a
 * platform signal and applies a cooldown; fatal/auth refusals stay stopped.
 * Logout clears recovery and starts a new account boundary.
 */
export function stopCCWire(detail?: string, transient = false): void {
  if (detail === 'logout') sessionGeneration++;
  if (recoveryTimer) { clearT(recoveryTimer); recoveryTimer = null; }
  recoverable = transient && detail !== 'logout';
  if (detail === 'logout') { recoveryOptions = null; lastRecoveryAt = -Infinity; }
  for (const cancel of [...pendingSubmissions]) cancel();
  // Never started ⇒ nothing to stop, and nothing to poison. Logout calls this
  // unconditionally; it must not leave a never-dialled app in 'error'.
  if (!client && status === 'off') return;
  if (deadlineTimer) { clearT(deadlineTimer); deadlineTimer = null; }
  const c = client;
  client = null;
  if (c) { try { c.close(detail); } catch { /* already down */ } }
  setStatus(detail === 'logout' ? 'off' : 'error', detail);
}

/** Test seam only. */
export function __resetCCWireForTest(): void {
  sessionGeneration++;
  for (const cancel of [...pendingSubmissions]) cancel();
  if (deadlineTimer) { clearT(deadlineTimer); deadlineTimer = null; }
  const c = client;
  client = null;
  if (c) { try { c.close('reset'); } catch {} }
  status = 'off';
  preHandshakeCloses = 0;
  everReady = false;
  onStatus = null;
  submitted = 0;
  acknowledged = 0;
  fallbacks = 0;
  lastError = undefined;
  if (recoveryTimer) { clearT(recoveryTimer); recoveryTimer = null; }
  recoveryOptions = null;
  recoverable = false;
  lastRecoveryAt = -Infinity;
}

export default { startCCWire, stopCCWire, ccwireStatus, ccwireUrlFor, CCWIRE_PATH };
