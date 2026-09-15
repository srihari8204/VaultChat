// lib/ccwire/client.ts — the CC-Wire v1 dialer.
//
// Used by the opt-in lib/socket.ts transport branch. transport.ts owns
// protobuf submission, inbound app events, and HTTP fallback.
//
// LAYERING, top to bottom:
//   this file          dial, handshake, keepalive, reconnect, event surface
//   lib/ccwire/codec   ccwire.v1.Frame  <-> bytes, with every bound enforced
//   lib/ccwire/frame   u8 version + u32 length + payload
// Nothing here builds a frame by hand: every outbound byte goes through
// encodeFrameMessage() then encodeFrame(), and every inbound byte through
// decodeStream() then decodeFrameMessage(). That is what keeps the bounds in
// one place instead of two that can disagree.
//
// ── AUTHENTICATION: WHY A HEADER, AND WHAT THAT COSTS ────────────────────────
//
// internal/httpx.RequireAuth reads the access token from ONE place:
//
//     m := bearerRe.FindStringSubmatch(r.Header.Get("Authorization"))
//
// No query parameter, no cookie, no Sec-WebSocket-Protocol, and the check runs
// BEFORE the upgrade — so an unauthenticated socket never exists. That means
// the client MUST be able to set a request header on the upgrade:
//
//   * React Native / Expo (iOS, Android): YES. RN's WebSocket takes a third
//     argument, `new WebSocket(url, protocols, { headers })`, which is exactly
//     why this works on the platforms crazzychat actually ships to.
//   * `ws` under Node (the selftest, and any CLI tool): YES, same 3-arg shape.
//   * A BROWSER (Expo web): NO. The DOM WebSocket constructor cannot set
//     headers, and there is no supported workaround. On web this client will
//     get a 401 at the upgrade and surface it as a `closed` event with
//     reason 'auth'. It does not fall back to a token in the URL, because a
//     token in a URL lands in proxy logs — and the Go side would not read it
//     anyway. Web support needs a server-side change (a subprotocol or a
//     one-shot ticket), not a client workaround.
//
// ── TYPE CONSTRAINT ──────────────────────────────────────────────────────────
//
// tsconfig.json sets `strict: false` and `strictNullChecks: false`, so
// discriminated unions DO NOT NARROW (see the long note at the top of
// frame.ts). Every result and event below is ONE interface with optional
// fields. Check the tag, then read the fields that belong to it. Do not "tidy"
// these into unions.

import {
  decodeStream,
  encodeFrame,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  type FrameError,
} from './frame';
import {
  decodeFrameMessage,
  encodeFrameMessage,
  LIMITS,
  APP_EVENT_LOGICAL_MAX,
  type Frame,
  type Fragment,
  type Limits,
} from './codec';
import { AppEventFragments } from './appEventFragments';

// ─── Constants from proto/ccwire/v1 ──────────────────────────────────────────

/** Frame.body field numbers this client names. Mirrors codec.BODY_NAMES. */
export const BODY = {
  client_hello: 16,
  server_hello: 17,
  ping: 19,
  pong: 20,
  go_away: 21,
  ack: 22,
  error: 23,
} as const;

const TRAFFIC_CLASS_CONTROL = 1;
const STREAM_CONTROL = 1;

/** capabilities.proto Limits defaults for the two heartbeat fields. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5000;
export const HANDSHAKE_TIMEOUT_MS = 15000;

/** errors.proto ErrorClass. A FATAL error ends the session. */
const ERROR_CLASS_FATAL = 2;
const ERROR_CLASS_AUTH = 3;

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * Why a session ended. A value, never a string to parse.
 *
 * The three PERMANENT ones — 'framing', 'protocol', 'client' — do not
 * reconnect. A length-prefixed stream cannot be resynchronised after a bad
 * length (the next frame boundary is unknowable), and reconnecting into a peer
 * that just spoke nonsense is a loop, not a recovery.
 */
export type CloseReason =
  | 'transport'            // the socket closed or errored; retryable
  | 'auth'                 // 401 at the upgrade, or a server auth Error
  | 'handshake_incomplete' // closed after dial and before ServerHello
  | 'heartbeat_timeout'    // no Pong inside heartbeat_timeout_ms
  | 'framing'              // PERMANENT: malformed frame off the wire
  | 'protocol'             // PERMANENT: a frame that is legal but not allowed here
  | 'client';              // PERMANENT: close() was called

export type CCWireEventType =
  | 'open'            // socket is up; ClientHello has been sent
  | 'hello'           // ServerHello accepted; the session is usable
  | 'resync_required' // ServerHello.resumed === false
  | 'frame'           // an application frame arrived
  | 'error'           // a structured ccwire Error frame arrived
  | 'closed';         // the session ended; see reason/willRetry

/** ONE interface, optional fields. See the TYPE CONSTRAINT note above. */
export interface CCWireEvent {
  type: CCWireEventType;
  /** 'frame' and 'error': the decoded frame. */
  frame?: Frame;
  /** 'hello': what the server bound us to. */
  hello?: ServerHello;
  /** 'closed'. */
  reason?: CloseReason;
  /** 'closed': the WebSocket close code, when there was one. */
  code?: number;
  /** 'closed': whether a reconnect has been scheduled. */
  willRetry?: boolean;
  /** 'closed': milliseconds until that reconnect. */
  retryInMs?: number;
  /** 'error': errors.proto ErrorCode / ErrorClass. */
  errorCode?: number;
  errorClass?: number;
  /** Human detail for logs. NEVER for control flow. */
  detail?: string;
  /** 'closed' after a framing refusal: the typed frame.ts reason. */
  frameError?: FrameError;
}

/** The binding half of the handshake. */
export interface ServerHello {
  appEventsV1?: boolean;
  protocolMajor?: number;
  protocolMinor?: number;
  sessionId?: string;
  /** ServerHello.resumed. FALSE MEANS FULL-RESYNC, and it is a command. */
  resumed?: boolean;
  /** Negotiated Limits, already tightened against this build's own. */
  limits?: Limits;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  serverTsMs?: string;
}

export type CCWireListener = (e: CCWireEvent) => void;

// ─── Minimal protobuf for the FOUR control bodies ────────────────────────────
//
// codec.ts types the six bodies that carry application data; the handshake
// bodies round-trip through it as opaque `raw`. These helpers read and write
// exactly that opaque span — a few scalar fields of ClientHello, ServerHello,
// Limits and Error. They are deliberately NOT a second protobuf codec: they do
// not recurse (Limits is scanned one level down, by hand, and no further), they
// cap the field count, and they never allocate from a length they have not
// bounds-checked first. Everything they are handed has already passed
// frame.ts's length ceiling and codec.ts's total-size check.

interface WireField { field: number; wire: number; u?: bigint; bytes?: Uint8Array }

const MAX_CONTROL_FIELDS = 64;

/** Scan one flat message. Returns null — never throws — on anything malformed. */
function scanFields(b: Uint8Array): WireField[] {
  const out: WireField[] = [];
  let p = 0;
  while (p < b.length) {
    if (out.length >= MAX_CONTROL_FIELDS) return null;
    // tag
    let t = 0n, shift = 0n, ok = false;
    for (let i = 0; i < 10 && p < b.length; i++) {
      const byte = b[p++];
      t |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) { ok = true; break; }
    }
    if (!ok) return null;
    const field = Number(t >> 3n), wire = Number(t & 7n);
    if (field === 0 || field > 0x1fffffff) return null;
    if (wire === 0) {
      let v = 0n, s = 0n, done = false;
      for (let i = 0; i < 10 && p < b.length; i++) {
        const byte = b[p++];
        v |= BigInt(byte & 0x7f) << s;
        s += 7n;
        if ((byte & 0x80) === 0) { done = true; break; }
      }
      if (!done) return null;
      out.push({ field, wire, u: v });
    } else if (wire === 2) {
      let n = 0, s = 1, done = false;
      for (let i = 0; i < 5 && p < b.length; i++) {
        const byte = b[p++];
        n += (byte & 0x7f) * s;
        s *= 128;
        if ((byte & 0x80) === 0) { done = true; break; }
      }
      if (!done || p + n > b.length) return null;   // bounds-checked BEFORE the view
      out.push({ field, wire, bytes: b.subarray(p, p + n) });
      p += n;
    } else if (wire === 1) {
      if (p + 8 > b.length) return null;
      p += 8;
    } else if (wire === 5) {
      if (p + 4 > b.length) return null;
      p += 4;
    } else {
      return null;   // wire type 3/4: proto2 groups, not representable in proto3
    }
  }
  return out;
}

function u32Of(fs: WireField[], field: number): number {
  for (const f of fs) if (f.field === field && f.wire === 0) return Number(f.u & 0xffffffffn);
  return 0;
}
function u64StrOf(fs: WireField[], field: number): string {
  for (const f of fs) if (f.field === field && f.wire === 0) return f.u.toString();
  return '0';
}
function boolOf(fs: WireField[], field: number): boolean {
  for (const f of fs) if (f.field === field && f.wire === 0) return f.u !== 0n;
  return false;
}
function bytesOf(fs: WireField[], field: number): Uint8Array {
  for (const f of fs) if (f.field === field && f.wire === 2) return f.bytes;
  return null;
}
const UTF8 = new TextDecoder('utf-8', { fatal: false });
function strOf(fs: WireField[], field: number): string {
  const b = bytesOf(fs, field);
  return b ? UTF8.decode(b) : '';
}

/** Writer for the one body this client actually authors with content. */
function putVarintField(out: number[], field: number, value: number): void {
  if (!value) return;                                // proto3: defaults are absent
  let t = field * 8;
  while (t >= 128) { out.push((t & 0x7f) | 0x80); t = Math.floor(t / 128); }
  out.push(t);
  let v = value;
  while (v >= 128) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
}
function putStringField(out: number[], field: number, s: string): void {
  if (!s) return;
  const b = new TextEncoder().encode(s);
  let t = field * 8 + 2;
  while (t >= 128) { out.push((t & 0x7f) | 0x80); t = Math.floor(t / 128); }
  out.push(t);
  let n = b.length;
  while (n >= 128) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  for (let i = 0; i < b.length; i++) out.push(b[i]);
}

/**
 * ClientHello body.
 *
 * protocol_major = 1, device_id if we have one. The `credential` field is
 * DELIBERATELY NOT SET: this connection is authenticated by RequireAuth at the
 * upgrade, ccwire.go states in so many words that the credential inside
 * ClientHello is not read, and putting the access token in a second place that
 * nobody verifies is a copy of a secret that buys nothing.
 */
export function encodeClientHello(deviceId?: string): Uint8Array {
  const out: number[] = [];
  putVarintField(out, 1, 1);                 // protocol_major
  putStringField(out, 5, deviceId ?? '');    // device_id
  out.push(26, 4, 8, 1, 64, 1); // capabilities: fragmentation + app_events_v1
  return Uint8Array.from(out);
}

/** ServerHello body -> ServerHello. Returns null when the body is malformed. */
export function decodeServerHello(body: Uint8Array): ServerHello {
  const fs = scanFields(body ?? new Uint8Array(0));
  if (!fs) return null;
  const h: ServerHello = {
    protocolMajor: u32Of(fs, 1),
    protocolMinor: u32Of(fs, 2),
    sessionId: strOf(fs, 5),
    serverTsMs: u64StrOf(fs, 7),
    // ABSENT MEANS FALSE, and false means full-resync. The conservative reading
    // is also the correct one: the server never sets this today.
    resumed: boolOf(fs, 8),
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  };
  const capsBytes = bytesOf(fs, 3);
  if (capsBytes) {
    const caps = scanFields(capsBytes);
    if (!caps) return null;
    h.appEventsV1 = boolOf(caps, 8);
  }
  const limBytes = bytesOf(fs, 4);
  if (limBytes) {
    const lf = scanFields(limBytes);
    if (!lf) return null;
    const lim: Limits = {};
    const take = (dst: keyof typeof LIMITS, field: number) => {
      const v = u32Of(lf, field);
      // A negotiated limit may only TIGHTEN. codec.resolveLimits enforces this
      // again on every decode; doing it here too means a bogus ServerHello
      // cannot even be stored, let alone believed.
      if (v > 0 && v < LIMITS[dst]) lim[dst] = v;
    };
    take('max_frame_bytes', 1);
    take('max_opaque_bytes', 2);
    take('max_message_body_bytes', 3);
    take('max_fragments_per_message', 4);
    take('max_nesting_depth', 8);
    take('max_repeated_elements', 9);
    take('max_string_field_bytes', 10);
    h.limits = lim;
    const hi = u32Of(lf, 13), ht = u32Of(lf, 14);
    if (hi > 0) h.heartbeatIntervalMs = hi;
    if (ht > 0) h.heartbeatTimeoutMs = ht;
  }
  return h;
}

// ─── Backoff ─────────────────────────────────────────────────────────────────

/**
 * A sticky per-client jitter factor, drawn ONCE.
 *
 * The bug this avoids: `delay * Math.random()` re-rolled on every attempt. That
 * decorrelates a client from ITSELF (its retries walk around the mean) while
 * leaving the whole fleet correlated on the same exponential ramp — so after a
 * server restart everybody's attempt N still lands in the same window. Drawing
 * one factor per client and keeping it means two clients ramp on two different
 * ladders and never converge, which is the property that actually matters.
 *
 * mulberry32: 4 lines, deterministic from a seed, good enough for spreading
 * reconnects. Not for anything that needs to be unguessable.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BackoffOptions { baseMs?: number; maxMs?: number; seed?: number }

/** Exponential, capped, then multiplied by this client's sticky factor. */
export class Backoff {
  readonly baseMs: number;
  readonly maxMs: number;
  /** In [0.5, 1). Fixed for the life of the client. */
  readonly factor: number;
  private n = 0;

  constructor(o: BackoffOptions = {}) {
    this.baseMs = o.baseMs ?? 500;
    this.maxMs = o.maxMs ?? 30000;
    this.factor = 0.5 + mulberry32(o.seed ?? 1)() * 0.5;
  }
  get attempt(): number { return this.n; }
  reset(): void { this.n = 0; }
  /** Next delay, in ms. Never exceeds maxMs. */
  next(): number {
    // 2**n via a loop-free multiply that cannot overflow into Infinity before
    // the cap bites: n is clamped first.
    const steps = Math.min(this.n, 30);
    const raw = Math.min(this.baseMs * Math.pow(2, steps), this.maxMs);
    this.n++;
    return Math.max(1, Math.round(raw * this.factor));
  }
}

// ─── The client ──────────────────────────────────────────────────────────────

export interface CCWireClientOptions {
  /** wss://host/ccwire/v1 */
  url: string;
  /** Read fresh per dial — a token captured once outlives its expiry. */
  getToken: () => string | Promise<string>;
  deviceId?: string;
  /** Seed for the sticky backoff jitter. Use something per-install. */
  seed?: number;
  backoff?: BackoffOptions;
  /** Injectables, so the selftest needs no network and no RN. */
  WebSocketImpl?: any;
  setTimeoutImpl?: (fn: () => void, ms: number) => any;
  clearTimeoutImpl?: (h: any) => void;
  now?: () => number;
}

type State = 'idle' | 'connecting' | 'handshaking' | 'open' | 'closed';

export class CCWireClient {
  private appFragments = new AppEventFragments();
  private fragmentTimer: any = null;
  private readonly o: CCWireClientOptions;
  private readonly backoff: Backoff;
  private readonly listeners = new Map<CCWireEventType, Set<CCWireListener>>();
  private readonly setT: (fn: () => void, ms: number) => any;
  private readonly clearT: (h: any) => void;

  private ws: any = null;
  private st: State = 'idle';
  /** Read buffer. A WebSocket read is NOT a frame boundary. */
  private buf: Uint8Array = new Uint8Array(0);
  private hb: any = null;       // heartbeat interval timer
  private hbWait: any = null;   // outstanding-Pong timer
  private retry: any = null;
  private dialTimer: any = null;
  private dialGeneration = 0;
  private pendingPingId = '';
  private reqN = 0;
  private reqPrefix = '';
  private helloAt = 0;

  /** Negotiated bounds. Until ServerHello lands these are this build's own. */
  limits: Limits = {};
  maxFrameBytes: number = LIMITS.max_frame_bytes;
  serverHello: ServerHello = null;

  /**
   * ServerHello.resumed === false. Stays true until markResynced() is called.
   * It is a COMMAND: the owner must refetch its state before trusting anything
   * that arrives. Nothing here clears it on its own.
   */
  needsFullResync = false;

  /**
   * Set by a PERMANENT close. A fatal client does not reconnect and cannot be
   * reconnected — construct a new one. Resynchronising a length-prefixed stream
   * after a bad length is not possible, and retrying into a peer that spoke
   * nonsense is a loop.
   */
  fatal = false;

  constructor(o: CCWireClientOptions) {
    this.o = o;
    this.backoff = new Backoff({ seed: o.seed ?? 1, ...(o.backoff ?? {}) });
    this.setT = o.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimeoutImpl ?? ((h) => clearTimeout(h));
    this.reqPrefix = `c${(o.seed ?? 1) >>> 0}`;
  }

  get state(): State { return this.st; }
  /** Handshaken, live, and the caller has done any demanded resync. */
  get ready(): boolean { return this.st === 'open' && !this.needsFullResync; }
  get backoffFactor(): number { return this.backoff.factor; }

  on(type: CCWireEventType, fn: CCWireListener): () => void {
    let s = this.listeners.get(type);
    if (!s) { s = new Set(); this.listeners.set(type, s); }
    s.add(fn);
    return () => { s.delete(fn); };
  }

  private emit(e: CCWireEvent): void {
    const s = this.listeners.get(e.type);
    if (!s) return;
    // A listener that throws is a bug in the listener. It must not take the
    // transport down with it.
    for (const fn of Array.from(s)) { try { fn(e); } catch { /* ignore */ } }
  }

  /** The owner has refetched its state. Only the owner can say this. */
  markResynced(): void { this.needsFullResync = false; }

  /**
   * Dial. Never throws: every failure arrives as a `closed` event.
   * Idempotent — a second call while connecting or open does nothing.
   */
  async connect(): Promise<void> {
    if (this.fatal) return;
    if (this.st === 'connecting' || this.st === 'handshaking' || this.st === 'open') return;
    this.st = 'connecting';
    this.buf = new Uint8Array(0);
    if (this.retry) { this.clearT(this.retry); this.retry = null; }
    const generation = ++this.dialGeneration;
    // Every attempt needs a deadline, including reconnects after a live session.
    this.dialTimer = this.setT(() => {
      if (generation !== this.dialGeneration || (this.st !== 'connecting' && this.st !== 'handshaking')) return;
      this.dialTimer = null;
      this.down('handshake_incomplete', { detail: 'handshake deadline' });
    }, HANDSHAKE_TIMEOUT_MS);

    let token = '';
    try {
      token = await this.o.getToken();
    } catch (e) {
      if (generation === this.dialGeneration) this.down('auth', { detail: `getToken: ${String(e)}` });
      return;
    }
    // The dial may have been cancelled while we awaited the token.
    if (generation !== this.dialGeneration || this.st !== 'connecting') return;
    if (!token) { this.down('auth', { detail: 'no access token' }); return; }

    const Impl = this.o.WebSocketImpl ?? (globalThis as any).WebSocket;
    if (!Impl) { this.down('transport', { detail: 'no WebSocket implementation' }); return; }

    let ws: any;
    try {
      // Third argument is the RN / `ws` extension that carries the header
      // RequireAuth reads. A DOM WebSocket ignores it and the upgrade 401s —
      // see the AUTHENTICATION note at the top.
      ws = new Impl(this.o.url, undefined, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      this.down('transport', { detail: String(e) });
      return;
    }
    this.ws = ws;
    try { ws.binaryType = 'arraybuffer'; } catch { /* some impls are read-only */ }

    ws.onopen = () => { if (this.ws === ws) this.onOpen(); };
    ws.onmessage = (ev: any) => { if (this.ws === ws) this.onMessage(ev?.data); };
    ws.onerror = (ev: any) => {
      if (this.ws !== ws) return;
      // onerror is always followed by onclose in every implementation that
      // matters, so the teardown is left to onclose; this only carries detail.
      this.lastErrorDetail = String(ev?.message ?? 'socket error');
    };
    ws.onclose = (ev: any) => {
      if (this.ws !== ws) return;
      const code = typeof ev?.code === 'number' ? ev.code : 0;
      // 1008 policy violation is what ccwire.go's refuse() sends; 4401/1002 are
      // what an upgrade rejection looks like across implementations. None of
      // them are permanent for US — the server may simply have restarted — but
      // an auth failure is worth naming so the owner can refresh a token.
      const reason: CloseReason = this.st === 'handshaking'
        ? 'handshake_incomplete'
        : (code === 4401 || code === 1008 ? 'auth' : 'transport');
      this.down(reason, { code, detail: this.lastErrorDetail });
    };
  }

  private lastErrorDetail = '';

  /** Close for good. Permanent: this client will not reconnect. */
  close(detail?: string): void {
    this.fatal = true;
    this.down('client', { detail });
  }

  // ── outbound ───────────────────────────────────────────────────────────────

  /** A request id unique within this client. */
  nextRequestId(): string { return `${this.reqPrefix}-${++this.reqN}`; }

  /**
   * Send one Frame. Returns false — never throws — when it could not go.
   *
   * Everything is encoded through codec.ts and then frame.ts, at the NEGOTIATED
   * bounds, so a frame this build should not have produced fails here rather
   * than on the peer.
   */
  send(f: Frame): boolean {
    if (this.st !== 'open') return false;
    if (f.body_field === 100 && this.serverHello?.appEventsV1) {
      const encoded = encodeFrameMessage(f, { maxBytes: APP_EVENT_LOGICAL_MAX, limits: this.limits, appEventsV1: true });
      if (!encoded.ok) return false;
      const bytes = encoded.bytes!;
      if (bytes.length <= this.maxFrameBytes) return this.writeEncoded(bytes);
      const chunkBytes = Math.min(128 * 1024, this.maxFrameBytes - 512);
      if (chunkBytes < 1) return false;
      const total = Math.ceil(bytes.length / chunkBytes);
      if (total > (this.limits.max_fragments_per_message ?? LIMITS.max_fragments_per_message)) return false;
      const id = this.nextRequestId();
      for (let index = 0; index < total; index++) {
        if (!this.write({ request_id: this.nextRequestId(), traffic_class: 1, stream: 1, body_field: 112,
          value: { fragment_id: id, index, total, total_bytes: String(bytes.length),
            chunk: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes), last: index === total - 1 } })) return false;
      }
      return true;
    }
    return this.write(f);
  }

  private write(f: Frame): boolean {
    const enc = encodeFrameMessage(f, { maxBytes: this.maxFrameBytes, limits: this.limits, appEventsV1: !!this.serverHello?.appEventsV1 });
    if (!enc.ok) {
      this.emit({ type: 'error', detail: `encode refused: ${enc.error} ${enc.detail}`, errorCode: enc.errorCode });
      return false;
    }
    return this.writeEncoded(enc.bytes!);
  }
  private writeEncoded(bytes: Uint8Array): boolean {
    let framed: Uint8Array;
    try {
      framed = encodeFrame(bytes, this.maxFrameBytes);
    } catch (e) {
      this.emit({ type: 'error', detail: String(e) });
      return false;
    }
    try {
      this.ws.send(framed);
      return true;
    } catch (e) {
      this.lastErrorDetail = String(e);
      this.down('transport', { detail: this.lastErrorDetail });
      return false;
    }
  }

  // ── handshake ──────────────────────────────────────────────────────────────

  private onOpen(): void {
    this.st = 'handshaking';
    this.emit({ type: 'open' });
    this.write({
      request_id: this.nextRequestId(),
      traffic_class: TRAFFIC_CLASS_CONTROL,
      stream: STREAM_CONTROL,
      body_field: BODY.client_hello,
      raw: encodeClientHello(this.o.deviceId),
    });
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  private onMessage(data: any): void {
    if (this.st !== 'handshaking' && this.st !== 'open') return;

    let chunk: Uint8Array;
    if (data instanceof Uint8Array) chunk = data;
    else if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (data && data.buffer instanceof ArrayBuffer) {
      chunk = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset ?? 0, data.byteLength);
    } else {
      // CC-Wire is binary. A text message is not a lenient encoding of it —
      // ccwire.go refuses one with a protocol violation and so do we.
      this.down('protocol', { detail: 'non-binary message' });
      return;
    }

    // THE BUFFERING THIS CLASS EXISTS FOR. A WebSocket read is not a frame
    // boundary: a frame can arrive split across two reads, and two frames can
    // arrive in one. Concatenate, drain whole frames, keep the remainder.
    if (this.buf.length) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    } else {
      this.buf = chunk;
    }
    const r = decodeStream(this.buf, { maxBytes: this.maxFrameBytes });
    if (r.error) {
      // Unrecoverable by construction: after a bad length the next frame
      // boundary is unknowable, so there is nothing to resynchronise to.
      this.down('framing', { frameError: r.error, detail: r.error });
      return;
    }
    this.buf = r.consumed >= this.buf.length
      ? new Uint8Array(0)
      // A copy, not a view: the view would pin the whole merged buffer alive.
      : this.buf.slice(r.consumed);

    // THE RESIDUE is what must stay bounded — not the merged buffer.
    //
    // This check used to run BEFORE the drain, on everything that had just
    // arrived. But the whole reason this method buffers is that "two frames can
    // arrive in one" (see above), and two legal 200 KiB frames in a single read
    // are 409,610 bytes against a 262,149-byte cap. So the class refused the
    // exact case it exists to handle — and `down('framing')` sets fatal, which
    // is permanent for the life of the object: no reconnect, for the life of the
    // app.
    //
    // decodeFrame refuses an over-cap declared length BEFORE reporting
    // INCOMPLETE, so whatever is left after every whole frame has been drained
    // is at most one capped frame. That is the real invariant, and this asserts
    // it rather than assuming it.
    if (this.buf.length > HEADER_BYTES + Math.min(this.maxFrameBytes, MAX_FRAME_BYTES)) {
      this.down('framing', { detail: `read residue ${this.buf.length} over cap` });
      return;
    }

    for (const payload of r.frames) {
      if (this.st !== 'handshaking' && this.st !== 'open') return;
      this.onFrame(payload);
    }
  }

  private onFrame(payload: Uint8Array, reassembled = false): void {
    const d = decodeFrameMessage(payload, { maxBytes: reassembled ? APP_EVENT_LOGICAL_MAX : this.maxFrameBytes,
      limits: this.limits, appEventsV1: !!this.serverHello?.appEventsV1, depth: reassembled ? 1 : 0 });
    if (!d.ok) {
      this.down('framing', { detail: `${d.error}: ${d.detail}` });
      return;
    }
    const f = d.frame;
    if (reassembled && f.body_field !== 100) { this.down('protocol', { detail: 'reassembled body is not app_event' }); return; }
    if (this.st === 'open' && f.body_field === 112 && this.serverHello?.appEventsV1) {
      try {
        const bytes = this.appFragments.accept(f.value as Fragment, (this.o.now ?? Date.now)());
        this.scheduleFragmentExpiry();
        if (bytes) this.onFrame(bytes, true);
      } catch { this.down('protocol', { detail: 'invalid app event fragments' }); }
      return;
    }

    if (this.st === 'handshaking') {
      // THE HANDSHAKE IS NOT OPTIONAL AND NOT LENIENT. Anything before
      // ServerHello — including an Error, which is what the server sends when
      // it is about to hang up — is a failed handshake, not a usable session.
      if (f.body_field !== BODY.server_hello) {
        if (f.body_field === BODY.error) {
          const e = this.readError(f);
          this.emit({ type: 'error', frame: f, errorCode: e.code, errorClass: e.cls, detail: e.detail });
          this.down(e.cls === ERROR_CLASS_AUTH ? 'auth' : 'handshake_incomplete', { detail: e.detail });
          return;
        }
        this.down('protocol', { detail: `expected server_hello, got ${f.body ?? f.body_field}` });
        return;
      }
      const h = decodeServerHello(f.raw);
      if (!h) { this.down('protocol', { detail: 'malformed ServerHello' }); return; }
      if (h.protocolMajor !== 1) {
        this.down('protocol', { detail: `protocol_major ${h.protocolMajor}` });
        return;
      }
      this.serverHello = h;
      this.limits = h.limits ?? {};
      this.maxFrameBytes = Math.min(
        this.limits.max_frame_bytes ?? LIMITS.max_frame_bytes,
        MAX_FRAME_BYTES,
      );
      this.st = 'open';
      if (this.dialTimer) { this.clearT(this.dialTimer); this.dialTimer = null; }
      this.helloAt = (this.o.now ?? Date.now)();
      this.backoff.reset();
      this.needsFullResync = !h.resumed;
      this.emit({ type: 'hello', hello: h });
      // Capability negotiation may synchronously reject and close this owner.
      if (this.st !== 'open') return;
      // resumed === false is a COMMAND to full-resync, not a hint. The flag is
      // set before the event so a handler that checks `ready` sees the truth.
      if (!h.resumed) {
        this.emit({ type: 'resync_required', hello: h });
      }
      this.startHeartbeat();
      return;
    }

    switch (f.body_field) {
      case BODY.pong:
        // Matched by request_id. ccwire.go echoes both the id and the body.
        if (!this.pendingPingId || f.request_id === this.pendingPingId) {
          this.pendingPingId = '';
          if (this.hbWait) { this.clearT(this.hbWait); this.hbWait = null; }
        }
        return;

      case BODY.ping:
        // The server does not ping today. Answer anyway — the body is echoed
        // verbatim, which is also how ccwire.go answers ours.
        this.write({
          request_id: f.request_id,
          traffic_class: TRAFFIC_CLASS_CONTROL,
          stream: STREAM_CONTROL,
          body_field: BODY.pong,
          raw: f.raw ?? new Uint8Array(0),
        });
        return;

      case BODY.server_hello:
        this.down('protocol', { detail: 'duplicate ServerHello' });
        return;

      case BODY.error: {
        const e = this.readError(f);
        this.emit({ type: 'error', frame: f, errorCode: e.code, errorClass: e.cls, detail: e.detail });
        // RETRYABLE errors leave the session up, exactly as the server treats
        // them. FATAL and AUTH end it.
        if (e.cls === ERROR_CLASS_FATAL) this.down('protocol', { detail: e.detail });
        else if (e.cls === ERROR_CLASS_AUTH) this.down('auth', { detail: e.detail });
        return;
      }

      case BODY.go_away:
        this.emit({ type: 'frame', frame: f });
        this.down('transport', { detail: 'go_away' });
        return;

      default:
        this.emit({ type: 'frame', frame: f });
    }
  }

  private readError(f: Frame): { code: number; cls: number; detail: string } {
    const fs = scanFields(f.raw ?? new Uint8Array(0));
    if (!fs) return { code: 0, cls: ERROR_CLASS_FATAL, detail: 'malformed Error' };
    return { code: u32Of(fs, 1), cls: u32Of(fs, 2), detail: strOf(fs, 3) };
  }

  // ── keepalive ──────────────────────────────────────────────────────────────

  /**
   * Ping every heartbeat_interval_ms, expect a Pong inside
   * heartbeat_timeout_ms. Both come from the ServerHello Limits and default to
   * capabilities.proto's 10000 / 5000. The server's own idle bound is 60 s, so
   * several missed beats is the right shape of failure.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const iv = this.serverHello?.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
    const beat = () => {
      if (this.st !== 'open') return;
      this.pendingPingId = this.nextRequestId();
      const sent = this.write({
        request_id: this.pendingPingId,
        traffic_class: TRAFFIC_CLASS_CONTROL,
        stream: STREAM_CONTROL,
        body_field: BODY.ping,
        raw: new Uint8Array(0),   // a bare Ping is a zero-byte body in proto3
      });
      if (!sent) return;
      const to = this.serverHello?.heartbeatTimeoutMs || DEFAULT_HEARTBEAT_TIMEOUT_MS;
      this.hbWait = this.setT(() => {
        this.hbWait = null;
        if (this.st === 'open') this.down('heartbeat_timeout', { detail: `no pong in ${to}ms` });
      }, to);
      this.hb = this.setT(beat, iv);
    };
    this.hb = this.setT(beat, iv);
  }

  private stopHeartbeat(): void {
    if (this.hb) { this.clearT(this.hb); this.hb = null; }
    if (this.hbWait) { this.clearT(this.hbWait); this.hbWait = null; }
    this.pendingPingId = '';
  }

  // ── teardown and reconnect ─────────────────────────────────────────────────

  private scheduleFragmentExpiry(): void {
    if (this.fragmentTimer) this.clearT(this.fragmentTimer);
    this.fragmentTimer = null;
    if (!this.appFragments.size) return;
    this.fragmentTimer = this.setT(() => {
      this.fragmentTimer = null;
      this.appFragments.expire((this.o.now ?? Date.now)());
      this.scheduleFragmentExpiry();
    }, Math.max(1, this.appFragments.nextExpiry - (this.o.now ?? Date.now)()));
  }

  /** The one path out of a live session. Idempotent. */
  private down(reason: CloseReason, extra: Partial<CCWireEvent> = {}): void {
    this.appFragments.clear();
    if (this.fragmentTimer) { this.clearT(this.fragmentTimer); this.fragmentTimer = null; }
    if (reason === 'client' && this.retry) { this.clearT(this.retry); this.retry = null; }
    if (this.st === 'closed' || this.st === 'idle') {
      // Still make close() stick even if we were never up.
      if (reason === 'client') this.st = 'closed';
      return;
    }
    this.dialGeneration++;
    if (this.dialTimer) { this.clearT(this.dialTimer); this.dialTimer = null; }
    const wasHandshaking = this.st === 'handshaking';
    this.st = 'closed';
    this.stopHeartbeat();
    if (this.retry) { this.clearT(this.retry); this.retry = null; }

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch { /* already gone */ }
    }
    this.buf = new Uint8Array(0);

    // PERMANENT reasons never reconnect, and mark the client unusable.
    if (reason === 'framing' || reason === 'protocol' || reason === 'client') this.fatal = true;

    let retryInMs = 0;
    const willRetry = !this.fatal;
    if (willRetry) {
      retryInMs = this.backoff.next();
      this.retry = this.setT(() => {
        this.retry = null;
        if (this.fatal) return;
        this.st = 'idle';
        void this.connect();
      }, retryInMs);
    }
    this.emit({
      type: 'closed',
      reason: wasHandshaking && reason === 'transport' ? 'handshake_incomplete' : reason,
      willRetry,
      retryInMs,
      ...extra,
    });
  }
}

export default CCWireClient;
