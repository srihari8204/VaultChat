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

/**
 * How long appEventFragments.ts keeps a partial set before its sweep drops it.
 *
 * Mirrored here rather than imported because that module does not export it,
 * and the positions this client holds back for a pending set (see
 * `fragmentFloor`) have to disappear exactly when the set does. Kept identical
 * so the two agree; if it ever drifts, drifting LONG is the safe direction — a
 * floor held past its set costs a replay of frames the app already has, while a
 * floor released early costs the frames themselves.
 */
const FRAGMENT_TTL_MS = 30000;

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
  /**
   * ServerHello.resume_token — the credential for the NEXT connection.
   *
   * Handed over now because there is no later opportunity: a dropped
   * connection cannot deliver anything. Held in memory only. It is NOT
   * persisted: a token that outlives the process would outlive the session it
   * refers to, and a stale credential on disk is worth more to an attacker
   * than a fresh resync is worth to us.
   */
  resumeToken?: string;
  /** Capabilities.resumption — the server will honour a token next time. */
  resumption?: boolean;
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

/**
 * The same span, read as BYTES that happen to live in a string — one code point
 * per byte, in and out, never UTF-8.
 *
 * envelope.proto declares `bytes resume_token = 6`, and the server compares a
 * credential byte for byte. strOf() above decodes leniently, which substitutes
 * U+FFFD for anything the UTF-8 decoder dislikes — so a token carrying such a
 * byte would come back on the next ClientHello as something the server never
 * issued. Nothing errors: the resume is simply refused, forever, and the client
 * full-resyncs every reconnect for the life of the install. codec.ts calls the
 * same substitution "a parser differential" and decodes fatally for exactly
 * this reason; a credential cannot even afford the fatal version, because it
 * must SURVIVE, not merely be detected.
 *
 * Today's tokens are base64url ASCII, where this is a no-op on the wire. What
 * is being pinned is the contract, not today's alphabet.
 */
function binaryStrOf(fs: WireField[], field: number): string {
  const b = bytesOf(fs, field);
  if (!b) return '';
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
/** The inverse of binaryStrOf. Pair them, or the round trip is not byte-exact. */
function binaryBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
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
export function encodeClientHello(
  deviceId?: string,
  resume?: { token?: string; from?: { stream: number; seq: string }[] },
): Uint8Array {
  const out: number[] = [];
  putVarintField(out, 1, 1);                 // protocol_major
  putStringField(out, 5, deviceId ?? '');    // device_id
  // capabilities (3): fragmentation (1) + resumption (2) + app_events_v1 (8).
  // resumption is offered unconditionally — offering it costs nothing when the
  // server does not support it, because the reply is an INTERSECTION and a
  // server that cannot resume simply omits it.
  out.push(26, 6, 8, 1, 16, 1, 64, 1);
  if (resume?.token) {
    // resume_token — written back as the BYTES it arrived as. See binaryStrOf:
    // a credential the server matches byte for byte cannot go through a UTF-8
    // encoder that was never handed UTF-8.
    putBytesField(out, 7, binaryBytes(resume.token));
  }
  for (const c of resume?.from ?? []) {
    // StreamCursor{stream = 1, last_delivered_seq = 2}
    const sc: number[] = [];
    putVarintField(sc, 1, c.stream);
    putVarintFieldFromString(sc, 2, c.seq);
    putBytesField(out, 8, Uint8Array.from(sc));
  }
  return Uint8Array.from(out);
}

/**
 * Ping.progress — the acknowledgement that lets the server release retained
 * frames.
 *
 * Same StreamCursor shape as ClientHello.resume_from, on field 2 of Ping. An
 * empty cursor list encodes to a zero-byte body, which is byte-for-byte the
 * bare Ping this client sent before resume existed — so a client that has been
 * handed nothing sequenced is indistinguishable from the old one.
 */
export function encodePingProgress(from: { stream: number; seq: string }[]): Uint8Array {
  const out: number[] = [];
  for (const c of from) {
    const sc: number[] = [];
    putVarintField(sc, 1, c.stream);
    putVarintFieldFromString(sc, 2, c.seq);
    putBytesField(out, 2, Uint8Array.from(sc));
  }
  return Uint8Array.from(out);
}

/**
 * seq travels as a STRING through the JS layer on purpose: envelope.proto marks
 * it jstype = JS_STRING so a sequence past 2^53 cannot be silently truncated by
 * a double. Encoding it back to a varint has to go through BigInt for the same
 * reason — Number() here would reintroduce exactly the bug the string prevents.
 */
function putVarintFieldFromString(out: number[], field: number, value: string): void {
  out.push((field << 3) | 0);
  let v = BigInt(value || '0');
  if (v < 0n) v = 0n;
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) { out.push(byte); return; }
    out.push(byte | 0x80);
  }
}

function putBytesField(out: number[], field: number, b: Uint8Array): void {
  out.push((field << 3) | 2);
  let len = b.length;
  for (;;) {
    const byte = len & 0x7f;
    len >>>= 7;
    if (len === 0) { out.push(byte); break; }
    out.push(byte | 0x80);
  }
  for (let i = 0; i < b.length; i++) out.push(b[i]);
}

/**
 * The lowest a negotiated limit may go before we stop believing it.
 *
 * Tightening is checked in one direction only — anything under this build's own
 * value is adopted — so `max_frame_bytes: 1` from a broken or hostile server
 * used to be accepted verbatim. Nothing on the wire then works: every frame
 * this client writes, the keepalive Ping included, is refused by its own
 * encoder before it reaches the socket, and the failure is silent because a
 * refused encode is not a socket error.
 *
 * The floors sit where no working session can be. A ClientHello, a Ping and a
 * Pong are a few hundred bytes each; the longest string this client sends is a
 * request id; a Frame nests body-inside-Frame and no deeper on the way out. A
 * proposal under one of these is not a tightening, it is a bad ServerHello, and
 * the safe reading is to keep our own default and let the server refuse what it
 * dislikes with a real Error.
 */
const LIMIT_FLOORS: Record<keyof typeof LIMITS, number> = {
  max_frame_bytes: 4096,
  max_opaque_bytes: 1024,
  max_message_body_bytes: 1024,
  max_fragments_per_message: 2,
  max_nesting_depth: 3,
  max_repeated_elements: 16,
  max_string_field_bytes: 256,
};

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
    resumeToken: binaryStrOf(fs, 6) || undefined,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  };
  const capsBytes = bytesOf(fs, 3);
  if (capsBytes) {
    const caps = scanFields(capsBytes);
    if (!caps) return null;
    h.appEventsV1 = boolOf(caps, 8);
    // Capabilities is an INTERSECTION: the server only sets this when it will
    // actually honour a token, so it is safe to treat as permission to offer one.
    h.resumption = boolOf(caps, 2);
  }
  const limBytes = bytesOf(fs, 4);
  if (limBytes) {
    const lf = scanFields(limBytes);
    if (!lf) return null;
    const lim: Limits = {};
    const take = (dst: keyof typeof LIMITS, field: number) => {
      const v = u32Of(lf, field);
      // A negotiated limit may only TIGHTEN, and only down to LIMIT_FLOORS.
      // codec.resolveLimits enforces the tightening again on every decode;
      // doing it here too means a bogus ServerHello cannot even be stored, let
      // alone believed.
      if (v >= LIMIT_FLOORS[dst] && v < LIMITS[dst]) lim[dst] = v;
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

/**
 * A backoff seed from the per-install device id.
 *
 * The sticky factor above only decorrelates the fleet if the SEED differs per
 * install. Every caller that leaves `seed` unset gets the default 1, mulberry32
 * draws the one value 1 always draws, and every handset then computes an
 * identical backoff ladder — the thundering herd the factor exists to prevent,
 * reassembled. services/deviceService's id is the identifier already in hand at
 * the call site: persisted, per install, and never a secret that matters here
 * (it is sent in the clear in every ClientHello).
 *
 * FNV-1a, because the only property needed is that two ids land on two
 * different 32-bit numbers. Not a hash anything depends on.
 */
export function seedFromDeviceId(deviceId?: string): number {
  // No id (SecureStore locked during boot, say) still must not fall back to a
  // shared constant: a per-process seed spreads a fleet just as well, and costs
  // only that this install re-rolls its ladder on the next app start.
  if (!deviceId) return (Math.random() * 0x100000000) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < deviceId.length; i++) h = Math.imul(h ^ deviceId.charCodeAt(i), 16777619);
  return h >>> 0;
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
   * ServerHello.resume_token, held for the next connection. In memory only.
   *
   * A `#` FIELD, NOT A `private` ONE. TypeScript's `private` is a compile-time
   * annotation and nothing else: the property is an ordinary enumerable own
   * property at runtime, so `JSON.stringify(client)` carries the credential and
   * `(client as any).resumeToken` reads it. ccwireClient() in transport.ts
   * hands this object out "for diagnostics", which is precisely what a crash
   * reporter or a state dump serialises — the same hazard the public
   * `serverHello` copy is stripped for, one level up. A `#` field is not an own
   * property, so neither reaches it, and close() clears what is left.
   */
  #resumeToken: string | undefined;

  /**
   * Did THIS connection's ClientHello actually offer a resume?
   *
   * ServerHello.resumed is only meaningful as an answer to a question we asked.
   * A connection that offered no token is a brand-new session numbering from 1
   * whatever the flag says, so the positions from the previous one describe
   * frames it has never sent. Carrying them forward puts a future cursor in
   * Ping.progress — the same "client's own memory fed back as a position" the
   * ClientHello note below is written about, except resume_from is gated on
   * holding a token and Ping.progress is gated on nothing.
   */
  private offeredResume = false;

  /**
   * The lowest `seq` of every fragment set that is still INCOMPLETE, by
   * fragment_id, with the expiry its set was given.
   *
   * A reported position is a promise that everything up to it has been handed
   * to the app, and that is what lets the server release it. Fragments break
   * that promise from the side: recording only at completion (below) stops the
   * fragments themselves from advancing the position, but it does not stop any
   * OTHER sequenced frame on the same stream from stepping over them. Fragment
   * 0 of 2 at seq 10, an ordinary frame at seq 12, then a drop: down() throws
   * the partial set away, the resume asks to replay from 13, and 10-11 never
   * come back. Nothing errors and the event is gone.
   *
   * So the position reported for a stream is capped at (lowest pending seq − 1)
   * for as long as the set is unfinished. The FIRST fragment of a set to arrive
   * carries that lowest seq — seq is assigned in send order however the indices
   * are ordered — and the cap is folded into streamSeq in down(), because by
   * then the set is gone and the cap with it.
   */
  private fragmentFloor = new Map<string, { stream: number; seq: string; expires: number }>();

  /**
   * Highest `seq` handed to the application, per stream, as a DECIMAL STRING.
   *
   * This is the other half of resume. The server retains what it has sent and
   * cannot serve a gap it has no position for; this is the position. Without
   * it the server answers `resumed=false` on every reconnect and the replay
   * window it is holding goes unused — correct, and pointless.
   *
   * Recorded only after `emit({type:'frame'})`, because the promise being made
   * is "I have this", not "I received bytes". Reporting a frame the app never
   * saw would lose it in exactly the way `resumed=false` exists to prevent.
   *
   * Strings, never numbers: envelope.proto marks seq jstype = JS_STRING, and a
   * sequence past 2^53 must not be truncated by a double.
   */
  private streamSeq: Record<number, string> = {};

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
      //
      // THE CODE IS TESTED FIRST, and the state only decides what an unnamed
      // close was. refuse() sends its 1008 AFTER the upgrade has succeeded, so
      // an expired token is refused while we are still 'handshaking' — and
      // asking the state first reported that as 'handshake_incomplete', which
      // says "the server went away", not "your credential is stale".
      // eventsSocket.ts refreshes the access token only for a reason containing
      // 'auth', so the refresh never fired: the client spent its retry budget
      // re-offering the same dead token and surfaced 'CC-Wire unavailable'.
      const reason: CloseReason = (code === 4401 || code === 1008)
        ? 'auth'
        : (this.st === 'handshaking' ? 'handshake_incomplete' : 'transport');
      this.down(reason, { code, detail: this.lastErrorDetail });
    };
  }

  private lastErrorDetail = '';
  /**
   * Connection-scoped wire totals. Counts and byte lengths only — never a
   * frame body, id, token or any payload. Exposed through metrics() so
   * ccwireDiagnostics() can answer "did this session exchange protobuf at
   * all", which the three submit counters in transport.ts cannot: they only
   * ever move for an eligible outbound plain-text chat message.
   */
  private m = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, decodeFailures: 0, encodeRefusals: 0 };
  /** Wire totals for this connection. Safe to log: no payload, no identifiers. */
  metrics() { return { ...this.m }; }

  /** Close for good. Permanent: this client will not reconnect. */
  close(detail?: string): void {
    this.fatal = true;
    // The credential names a session this client will never dial again, so
    // holding it past close() buys nothing and keeps a live secret reachable
    // for the lifetime of an object the app may hold onto — a logged-out
    // client whose token still works is exactly what "in memory only" was
    // supposed to rule out.
    this.#resumeToken = undefined;
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
      this.m.encodeRefusals++;
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
      this.m.framesOut++; this.m.bytesOut += framed.length;
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
    const offered = this.#resumeToken ? { token: this.#resumeToken, from: this.cursors() } : null;
    // Remembered because ServerHello.resumed is an ANSWER: it only says "your
    // positions still stand" if we offered any. See offeredResume above.
    this.offeredResume = !!offered;
    this.write({
      request_id: this.nextRequestId(),
      traffic_class: TRAFFIC_CLASS_CONTROL,
      stream: STREAM_CONTROL,
      body_field: BODY.client_hello,
      // Both halves, or neither.
      //
      // A token says WHICH session; the positions say WHERE it got to, and the
      // server needs both — with a token alone it has nothing to replay from
      // and refuses. But positions WITHOUT a token are worse than useless: the
      // server can only open a fresh session numbering from 1, and a cursor
      // from the previous session is then far ahead of anything this one has
      // sent, which it refuses as a future cursor. That is a reconnect loop
      // fed by the client's own memory.
      raw: encodeClientHello(this.o.deviceId, offered ?? {}),
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
    this.m.framesIn++; this.m.bytesIn += payload.length;
    const d = decodeFrameMessage(payload, { maxBytes: reassembled ? APP_EVENT_LOGICAL_MAX : this.maxFrameBytes,
      limits: this.limits, appEventsV1: !!this.serverHello?.appEventsV1, depth: reassembled ? 1 : 0 });
    if (!d.ok) {
      this.m.decodeFailures++;
      this.down('framing', { detail: `${d.error}: ${d.detail}` });
      return;
    }
    const f = d.frame;
    if (reassembled && f.body_field !== 100) { this.down('protocol', { detail: 'reassembled body is not app_event' }); return; }
    if (this.st === 'open' && f.body_field === 112 && this.serverHello?.appEventsV1) {
      // The FRAGMENT carries the sequence number, not the app_event inside it:
      // the inner message is encoded once and then split, so it has none of its
      // own. But the position is recorded only when the event COMPLETES, never
      // per fragment.
      //
      // Recording per fragment loses messages. Half an event arrives, the
      // position advances past those fragments, the socket drops, down() clears
      // the partial set — and the resume then starts AFTER the fragments that
      // were thrown away, so the event can never be completed and never
      // arrives. Worse, the same premature position goes out in Ping.progress,
      // which is precisely what tells the server it may release those frames.
      // Nothing errors; the event is simply gone.
      //
      // Recording the last fragment's seq at completion loses nothing, because
      // seq is monotonic per stream and the final fragment carries the highest.
      //
      // Not advancing on a fragment is only half of it, though: any OTHER
      // sequenced frame on the same stream would still carry the position over
      // the pending set and lose it in exactly the way described above. So
      // while the set is unfinished its lowest seq is remembered as a ceiling
      // on what this stream may report — see fragmentFloor.
      const fragmentId = (f.value as Fragment)?.fragment_id ?? '';
      try {
        const now = (this.o.now ?? Date.now)();
        const bytes = this.appFragments.accept(f.value as Fragment, now);
        this.scheduleFragmentExpiry();
        if (bytes) {
          this.fragmentFloor.delete(fragmentId);
          this.onFrame(bytes, true);
          this.noteDelivered(f);
        } else if (!this.fragmentFloor.has(fragmentId) && (f.stream ?? 0) && (f.seq ?? '0') !== '0') {
          // The first fragment of a set to ARRIVE carries its lowest seq,
          // whatever order the indices come in: seq is assigned in send order.
          // An unsequenced fragment holds nothing back — there is no position
          // to replay from, so there is nothing to protect.
          this.fragmentFloor.set(fragmentId, { stream: f.stream, seq: f.seq, expires: now + FRAGMENT_TTL_MS });
        }
      } catch {
        // NOT every refusal from accept() is the peer speaking nonsense, and
        // the difference is the difference between losing one event and losing
        // realtime. down('protocol') sets fatal, which is permanent for the
        // life of this object: transport.ts reports recoverable=false and
        // CC-Wire never restarts for the rest of the app session.
        //
        // accept() refuses for two unrelated kinds of reason:
        //   * THE FRAGMENT IS MALFORMED — an index past total, `last` on a
        //     non-final index, a chunk longer than the declared total. No
        //     correct server sends that, and it stays a protocol violation.
        //   * THE FRAGMENT IS FINE AND OUR BUFFER IS NOT — the partial set it
        //     belongs to has already expired, its index arrived twice, or it
        //     would be a ninth concurrent set against the eight we hold. Those
        //     are timing and capacity events on THIS side. The backgrounded-app
        //     case is the common one: JS timers are throttled, so the expiry
        //     sweep never runs, and fragment 6 of 8 lands 40 s late on resume.
        //     The event is lost either way; killing realtime until the app is
        //     restarted is not a remedy for it.
        //
        // Which one it was is answered by asking the same validator again with
        // an empty buffer: a fragment a fresh reassembler would take is one
        // that only our state refused. That keeps the malformed-input checks
        // exactly as strict as appEventFragments.ts wrote them — it IS those
        // checks — with no second copy here to drift out of step.
        if (!this.fragmentIsWellFormed(f.value as Fragment)) {
          this.down('protocol', { detail: 'invalid app event fragments' });
          return;
        }
        // accept() has already dropped the offending set; the session is
        // otherwise untouched, so there is nothing to do but keep reading. The
        // ceiling goes with the set: there is no longer anything pending for it
        // to protect, and a ceiling nothing can lift would stall this stream's
        // position for the life of the session.
        this.fragmentFloor.delete(fragmentId);
        this.scheduleFragmentExpiry();
      }
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
      // THE PUBLIC COPY NEVER CARRIES THE CREDENTIAL.
      //
      // `serverHello` is reachable from anywhere through ccwireClient() in
      // transport.ts, documented for diagnostics — which is precisely what a
      // crash reporter or a state dump serialises. The private field below is
      // cleared when the server withdraws resumption; this object is cleared by
      // nothing, not down(), not close(), not an auth failure. Storing the
      // token here would put a live credential in every log that stringifies
      // it, and "in memory only, never persisted" would stop being true the
      // first time something wrote that log to disk.
      const publicHello: ServerHello = { ...h, resumeToken: undefined };
      this.serverHello = publicHello;
      this.limits = h.limits ?? {};
      this.maxFrameBytes = Math.min(
        this.limits.max_frame_bytes ?? LIMITS.max_frame_bytes,
        MAX_FRAME_BYTES,
      );
      this.st = 'open';
      if (this.dialTimer) { this.clearT(this.dialTimer); this.dialTimer = null; }
      this.helloAt = (this.o.now ?? Date.now)();
      // THE BACKOFF IS NOT RESET HERE. A completed handshake is not a healthy
      // session: a load balancer that kills the socket just after the upgrade,
      // or a server crash-looping after it answers, completes this handshake
      // every time. Resetting on ServerHello made each of those cycles start
      // the ladder over, so the ramp never happened — measured at six
      // hello-then-drop rounds all ~407ms apart, about 2.5 dials a second per
      // handset for as long as the app is foregrounded, against
      // 407/814/1627/3254/6508/13017 when no ServerHello arrives at all. The
      // reset moved to the Pong handler, which is the first point at which the
      // session has demonstrably carried traffic in both directions.
      this.needsFullResync = !h.resumed;
      // Positions belong to the session that produced them. A server that
      // answered resumed=false has started a NEW session whose sequence numbers
      // begin again at 1, so carrying the old ones forward would make the next
      // reconnect offer a resume_from far ahead of anything that session sent —
      // which the server refuses as a future cursor. One un-resumed connection
      // would poison every resume after it, for the life of the process.
      //
      // AND `resumed` ONLY COUNTS AS AN ANSWER IF WE ASKED. A connection that
      // held no token offered neither field 7 nor field 8, so whatever the flag
      // says the server has opened a fresh session numbering from 1 — the old
      // positions describe frames it has never sent. resume_from is already
      // gated on holding a token; Ping.progress was gated on nothing, so the
      // first heartbeat of a brand-new session still reported the dead one's
      // cursors. Today's server never sets `resumed`, which makes this latent
      // rather than harmless.
      if (!(h.resumed && this.offeredResume)) this.streamSeq = {};
      // Keep the token for the NEXT connection, and only while the server says
      // it will honour one. Held in memory, never persisted: a token that
      // outlives the process outlives the session it names, and a stale
      // credential on disk is worth more to an attacker than a fresh resync is
      // worth to us.
      this.#resumeToken = h.resumption ? h.resumeToken : undefined;
      // Listeners get the same stripped copy: an event object outlives the call
      // in whatever the listener does with it, and that is a second place for
      // the credential to be retained by something that never asked for one.
      this.emit({ type: 'hello', hello: publicHello });
      // Capability negotiation may synchronously reject and close this owner.
      if (this.st !== 'open') return;
      // resumed === false is a COMMAND to full-resync, not a hint. The flag is
      // set before the event so a handler that checks `ready` sees the truth.
      if (!h.resumed) {
        this.emit({ type: 'resync_required', hello: publicHello });
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
          // AND THIS IS WHERE THE BACKOFF EARNS ITS RESET. A Pong is the first
          // thing that proves the session survived the handshake and that the
          // peer is still answering — a connection that drops before one has
          // come back never stayed up, so it does not get to put the ladder
          // back on its bottom rung. See the note in the ServerHello branch.
          this.backoff.reset();
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
        this.noteDelivered(f);
    }
  }

  /**
   * Record a frame the application has now seen.
   *
   * Unsequenced frames (seq 0) carry no position and move nothing — that is the
   * whole of the control plane, and the EPHEMERAL frames the server never
   * sequences because they are lossy by design.
   */
  private noteDelivered(f: Frame): void {
    const stream = f.stream ?? 0;
    const seq = f.seq ?? '0';
    if (!stream || seq === '0') return;
    const have = this.streamSeq[stream];
    // BigInt, not Number: comparing decimal strings lexically would rank "9"
    // above "10", and Number() is the truncation the string type exists to
    // avoid.
    if (have === undefined || BigInt(seq) > BigInt(have)) this.streamSeq[stream] = seq;
  }

  /**
   * The tracked positions in the shape both Ping.progress and ClientHello want,
   * each one held at or below the gap any unfinished fragment set has left.
   *
   * A position is a promise that the app HAS everything up to it, and the
   * server releases what it has retained on the strength of that promise. A
   * stream with fragments 10-11 still incomplete has a hole at 10 however far
   * past it the ordinary frames have run, so 9 is the most that may be claimed
   * — and a stream whose hole starts at 1 may claim nothing at all.
   *
   * The sweep here uses the same `expires <= now` predicate
   * appEventFragments.expire() does, so a ceiling stops applying at the same
   * instant the set it guards is dropped, without this class having to watch
   * for a removal it cannot see.
   */
  private cursors(): { stream: number; seq: string }[] {
    const now = (this.o.now ?? Date.now)();
    const ceiling: Record<number, bigint> = {};
    for (const [id, pending] of this.fragmentFloor) {
      if (pending.expires <= now) { this.fragmentFloor.delete(id); continue; }
      const most = BigInt(pending.seq) - 1n;
      if (ceiling[pending.stream] === undefined || most < ceiling[pending.stream]) ceiling[pending.stream] = most;
    }
    const out: { stream: number; seq: string }[] = [];
    for (const k of Object.keys(this.streamSeq)) {
      const stream = Number(k);
      let seq = BigInt(this.streamSeq[stream]);
      const most = ceiling[stream];
      if (most !== undefined && most < seq) seq = most;
      if (seq > 0n) out.push({ stream, seq: seq.toString() });
    }
    return out;
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
        // Ping.progress (field 2). A bare Ping is still a zero-byte body when
        // nothing has been delivered yet, so a client that has seen nothing
        // sends exactly what it always sent. Beyond that, this is what lets the
        // server RELEASE retained frames: without it every window fills to its
        // ceiling and stays there until the session ends.
        raw: encodePingProgress(this.cursors()),
      });
      if (!sent) {
        // A keepalive that could not be written is not a beat to skip. Bailing
        // out here armed NEITHER timer, so the loop never ran again: no Ping,
        // no Pong deadline, no liveness detection at all, and the session sat
        // in 'open' on a socket that may already be dead. write() also reports
        // failure for an encode refusal, which never touches the socket and so
        // is reported by nothing else. Ending the session is the same answer a
        // missed Pong gets, and 'transport' retries the same way.
        this.down('transport', { detail: 'keepalive write failed' });
        return;
      }
      const to = this.serverHello?.heartbeatTimeoutMs || DEFAULT_HEARTBEAT_TIMEOUT_MS;
      // ONE outstanding deadline at a time, and it is the OLDEST one.
      //
      // heartbeat_interval_ms and heartbeat_timeout_ms arrive independently and
      // are not validated against each other, so an interval SHORTER than the
      // timeout is reachable — and then beat 2 fires while beat 1's deadline is
      // still armed. Overwriting this.hbWait there left beat 1's timer running
      // and untracked: a Pong cleared the handle we kept, the forgotten one
      // fired later, and a perfectly healthy session was torn down.
      //
      // Clearing the old timer instead would be wrong the other way: every beat
      // would push the deadline further out and a silent link would never be
      // detected at all. Keeping the earliest deadline is the only version that
      // both leaks nothing and still fails a link that has stopped answering.
      if (!this.hbWait) {
        this.hbWait = this.setT(() => {
          this.hbWait = null;
          if (this.st === 'open') this.down('heartbeat_timeout', { detail: `no pong in ${to}ms` });
        }, to);
      }
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

  /**
   * Would an EMPTY reassembler have taken this fragment? See the long note in
   * onFrame: this is how a malformed fragment is told apart from one our own
   * buffer could not hold. The throwaway instance has no state, so only the
   * fragment's own fields can make it refuse.
   */
  private fragmentIsWellFormed(f: Fragment): boolean {
    try { new AppEventFragments().accept(f, 0); return true; } catch { return false; }
  }

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
    // THE CEILING HAS TO OUTLIVE THE SET IT CAME FROM. The partial sets are
    // thrown away on the line below and their fragments are never re-delivered
    // on this connection, but streamSeq is what the NEXT ClientHello's
    // resume_from is built from — and a raw streamSeq has already been carried
    // past those fragments by whatever ordinary frames followed them. Folding
    // the ceiling in first makes the resume ask to replay from the hole rather
    // than from after it, which is the difference between the event arriving
    // late and the event never arriving at all.
    const held = this.cursors();
    this.streamSeq = {};
    for (const c of held) this.streamSeq[c.stream] = c.seq;
    this.fragmentFloor.clear();
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
