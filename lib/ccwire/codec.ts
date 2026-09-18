// lib/ccwire/codec.ts — CC-Wire v1 protobuf codec for ccwire.v1.Frame.
//
// STATUS: LIVE on the app path. lib/ccwire/client.ts imports encodeFrameMessage
// and decodeFrameMessage; client -> transport.ts -> socket.ts, where 'ccwire' is
// the only TransportName. Every frame the app sends or receives is encoded here.
// (This header previously read "NOT WIRED"; that was stale and misleading.)
//
// Layering: lib/ccwire/frame.ts owns the length-prefixed envelope and hands up
// an OPAQUE payload. This file is what turns that payload into a Frame. The
// separation is load-bearing — the byte-length ceiling is enforced in frame.ts
// BEFORE a decoder ever sees the input, so nothing here can be made to allocate
// from a number a peer chose.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY HAND-WRITTEN AND NOT protobufjs
//
// protobufjs 8.8.0 was evaluated and rejected on three counts, any one of which
// is disqualifying:
//
//  1. IT DROPS UNKNOWN FIELDS. proto/ccwire/v1/envelope.proto states, as part of
//     the contract and not as advice, "unknown fields = PRESERVED (never
//     dropped, never rejected)". protobufjs's generated decoders call
//     reader.skipType() on an unrecognised tag and discard the bytes. A
//     middlebox or an older client that decodes and re-encodes would silently
//     strip fields a newer peer depends on. This alone rules it out.
//  2. REFLECTION NEEDS RUNTIME CODEGEN. protobufjs builds its verifiers and
//     codecs with `new Function(...)`. Hermes ships without eval, so the
//     runtime-.proto-loading option (a) is not a mobile option at all, and the
//     static-codegen option (b) only avoids it for the generated path.
//  3. BUNDLE AND BUILD COST. ~250 KB of library plus, for option (b), a
//     generated static module for 50 message types of which this codec needs
//     six, plus a codegen step in CI that can drift from the .proto.
//
// Hand-written costs ~450 lines and buys: zero dependencies, zero bundle delta,
// no build step, unknown-field preservation by construction, and per-field
// control of every bound below. The trade is that adding a body type is manual
// — which is why codec.selftest.ts asserts the body field numbers here against
// proto/ccwire/v1/envelope.proto, so the drift that costs you is caught.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS AND IS NOT TYPED HERE
//
// All 28 oneof body field numbers are KNOWN (BODY_NAMES) — that is what the
// EPHEMERAL invariant is enforced on, so it covers every body, including the
// ones this build does not decode. Seven bodies are decoded into fields; the
// rest round-trip as opaque `raw` bytes. An unimplemented body is therefore
// never lost and never silently reinterpreted.
//
// Seven, not six: app_event (100) is typed HERE and nowhere else. Go's
// TypedBodies and Rust's TYPED_BODIES carry six. That asymmetry is recorded in
// __vectors__/codec.json's `bodiesTypedByTypescriptOnly` so it cannot widen
// unnoticed — it is a real difference, not a bookkeeping one.
//
// ─────────────────────────────────────────────────────────────────────────────
// TYPE CONSTRAINT
//
// tsconfig.json sets `strict: false` and `strictNullChecks: false`.
// Discriminated-union narrowing REQUIRES strictNullChecks — `if (!r.ok)
// { r.error }` does not narrow and does not compile. Every result below is ONE
// interface with optional fields, exactly as lib/ccwire/frame.ts documents. Do
// not "tidy" these into unions.

import { MAX_FRAME_BYTES } from './frame';

// ─── Bounds ──────────────────────────────────────────────────────────────────
//
// Every number here is copied from proto/ccwire/v1/capabilities.proto's Limits
// message, where it sits as the trailing comment on its field. They are the
// server's defaults; a negotiated ServerHello.limits may be SMALLER, which is
// what the `limits` decode option is for. None may ever be larger.

export const LIMITS = {
  /** Limits.max_frame_bytes — 256 KiB. Hard ceiling stays frame.ts MAX_FRAME_BYTES. */
  max_frame_bytes: 262144,
  /** Limits.max_opaque_bytes — 192 KiB. Every `bytes` field the server routes but never reads. */
  max_opaque_bytes: 196608,
  /** Limits.max_message_body_bytes — 1 MiB. SubmitMessage.sealed only. */
  max_message_body_bytes: 1048576,
  /** Limits.max_fragments_per_message — Fragment.total ceiling. */
  max_fragments_per_message: 16,
  /** Limits.max_nesting_depth — the decoder recursion limit named in envelope.proto. */
  max_nesting_depth: 6,
  /** Limits.max_repeated_elements — any repeated field, and the unknown-field count. */
  max_repeated_elements: 1024,
  /** Limits.max_string_field_bytes — measured in BYTES, checked before UTF-8 decode. */
  max_string_field_bytes: 4096,
} as const;

export type Limits = Partial<Record<keyof typeof LIMITS, number>>;

// ─── Typed failures ──────────────────────────────────────────────────────────

/** Why input was refused. A value, never a string to parse. */
export type CodecError =
  | 'TRUNCATED'            // a field ran off the end of the buffer
  | 'BAD_WIRE_TYPE'        // wire type 3/4 (proto2 groups) or a mismatch
  | 'VARINT_OVERFLOW'      // a varint longer than 64 bits can hold
  | 'FIELD_ZERO'           // field number 0 — not representable, so it is an attack
  | 'INVALID_UTF8'         // a `string` field that is not valid UTF-8
  | 'STRING_TOO_LONG'      // over max_string_field_bytes
  | 'BYTES_TOO_LONG'       // over max_opaque_bytes / max_message_body_bytes
  | 'TOO_MANY_ELEMENTS'    // over max_repeated_elements
  | 'NESTING_TOO_DEEP'     // over max_nesting_depth
  | 'SIZE_OVER_MAX'        // the whole payload is over the negotiated frame size
  | 'DUPLICATE_BODY'       // two oneof bodies in one Frame
  | 'PROTOCOL_VIOLATION';  // the EPHEMERAL invariant, or an unset traffic class

/**
 * Map to proto/ccwire/v1/errors.proto ErrorCode, so a caller can put the right
 * number in an Error frame without a second switch that can disagree with this
 * one.
 */
export const ERROR_CODE: Record<CodecError, number> = {
  TRUNCATED: 8,           // ERROR_CODE_PAYLOAD_INVALID
  BAD_WIRE_TYPE: 8,
  VARINT_OVERFLOW: 8,
  FIELD_ZERO: 8,
  INVALID_UTF8: 8,
  STRING_TOO_LONG: 8,
  BYTES_TOO_LONG: 8,
  TOO_MANY_ELEMENTS: 8,
  NESTING_TOO_DEEP: 8,
  SIZE_OVER_MAX: 7,       // ERROR_CODE_FRAME_TOO_LARGE
  DUPLICATE_BODY: 11,     // ERROR_CODE_PROTOCOL_VIOLATION
  PROTOCOL_VIOLATION: 11,
};

// ─── Enums (mirrors of the .proto; value 0 is always *_UNSPECIFIED) ──────────

export const TRAFFIC_CLASS_NAMES = [
  'TRAFFIC_CLASS_UNSPECIFIED', 'TRAFFIC_CLASS_CONTROL', 'TRAFFIC_CLASS_MESSAGING',
  'TRAFFIC_CLASS_SYNC', 'TRAFFIC_CLASS_BULK', 'TRAFFIC_CLASS_EPHEMERAL',
];
export const STREAM_ID_NAMES = [
  'STREAM_ID_UNSPECIFIED', 'STREAM_ID_CONTROL', 'STREAM_ID_MESSAGING',
  'STREAM_ID_SYNC', 'STREAM_ID_BULK', 'STREAM_ID_EPHEMERAL',
];
export const MESSAGE_CLASS_NAMES = [
  'MESSAGE_CLASS_UNSPECIFIED', 'MESSAGE_CLASS_NORMAL', 'MESSAGE_CLASS_SILENT',
  'MESSAGE_CLASS_SYSTEM', 'MESSAGE_CLASS_CONTROL',
];
export const VIEWER_ACTIVITY_NAMES = [
  'VIEWER_ACTIVITY_UNSPECIFIED', 'VIEWER_ACTIVITY_READING',
  'VIEWER_ACTIVITY_TYPING', 'VIEWER_ACTIVITY_UPLOADING',
];
export const SCOPE_KIND_NAMES = [
  'SCOPE_KIND_UNSPECIFIED', 'SCOPE_KIND_CHAT', 'SCOPE_KIND_CHANNEL',
  'SCOPE_KIND_CALL', 'SCOPE_KIND_RUN', 'SCOPE_KIND_ADMIN',
];
export const CRYPTO_CONTROL_KIND_NAMES = [
  'CRYPTO_CONTROL_KIND_UNSPECIFIED', 'CRYPTO_CONTROL_KIND_REKEY',
  'CRYPTO_CONTROL_KIND_MEDIA_KEY', 'CRYPTO_CONTROL_KIND_PREKEY',
  'CRYPTO_CONTROL_KIND_GROUP_OP',
];

export const TRAFFIC_CLASS_EPHEMERAL = 5;

/**
 * An enum value this build does not know is RETAINED AS ITS NUMBER and surfaced
 * as *_UNSPECIFIED — per envelope.proto's decoder contract. So `x` is the number
 * (authoritative, what re-encodes) and `x_name` is what application code should
 * branch on. `*_name` is decode-only; encode reads the number and ignores it.
 */
function surface(names: string[], n: number): string {
  return names[n] ?? names[0];
}

// ─── The oneof body, by field number ─────────────────────────────────────────

/** Every Frame.body field number. Asserted against envelope.proto in the selftest. */
export const BODY_NAMES: Record<number, string> = {
  16: 'client_hello', 17: 'server_hello', 18: 'reauth', 19: 'ping', 20: 'pong',
  21: 'go_away', 22: 'ack', 23: 'error',
  32: 'subscribe', 33: 'unsubscribe',
  48: 'submit_message', 49: 'deliver_message', 50: 'edit_message',
  51: 'delete_message', 52: 'receipt',
  64: 'cursor_sync', 65: 'cursor_batch',
  80: 'presence_update', 81: 'typing_state', 82: 'viewer_state',
  83: 'viewer_list', 84: 'geo_relay',
  96: 'attachment_control', 97: 'device_event', 98: 'crypto_control',
  99: 'call_signal', 100: 'app_event',
  112: 'fragment',
};

/**
 * THE INVARIANT. envelope.proto: "a frame whose traffic_class is EPHEMERAL may
 * carry ONLY typing_state, viewer_state or geo_relay. A crypto_control or
 * device_event in an EPHEMERAL frame is a protocol violation and MUST be refused
 * with ERROR_CODE_PROTOCOL_VIOLATION — never handled leniently."
 *
 * Enforced on the FIELD NUMBER, before and independently of decoding the body,
 * so it holds for all 28 bodies including the ones this build does not type.
 */
export const EPHEMERAL_BODIES = new Set([81, 82, 84]);

// ─── Body shapes ─────────────────────────────────────────────────────────────
//
// proto3 defaults are materialised on decode (absent string → '', absent bool →
// false, absent enum → 0, absent 64-bit → '0'), so a canonical value survives
// decode→encode byte-for-byte.

export interface AppEvent { event?: string; payload_json?: Uint8Array; unknown?: Uint8Array[] }
// Legacy decoded event budget can expand sixfold when JSON escapes controls.
export const APP_EVENT_JSON_MAX = 6 * 256 * 1024;
export const APP_EVENT_LOGICAL_MAX = 2 * 1024 * 1024;
export interface TypingState { chat_id?: string; typing?: boolean; sender_uid?: string; unknown?: Uint8Array[] }
export interface ViewerState {
  chat_id?: string; activity?: number; activity_name?: string;
  leaving?: boolean; resync?: boolean; unknown?: Uint8Array[];
}
export interface GeoRelay {
  scope_kind?: number; scope_kind_name?: string; scope_id?: string; subject_id?: string;
  sealed?: Uint8Array; ended?: boolean; /** int64 JS_STRING */ until_ms?: string;
  sender_uid?: string; unknown?: Uint8Array[];
}
export interface CryptoControl {
  kind?: number; kind_name?: string; chat_id?: string; to_uid?: string;
  payload?: Uint8Array; /** uint64 JS_STRING */ epoch?: string;
  payload_format?: string; unknown?: Uint8Array[];
}
export interface PublicMeta {
  attachment_id?: string; view_once?: boolean; revoked?: boolean; announcement?: boolean;
  audience?: string; silent?: boolean; group_id?: string; gif_url?: string;
  allow_multiple?: boolean; option_count?: number; mention_user_ids?: string[];
  encrypted?: boolean; game?: string; room?: string; unknown?: Uint8Array[];
}
export interface Envelope {
  chat_id?: string; message_id?: string; client_msg_id?: string;
  /** int64 JS_STRING */ server_ts_ms?: string;
  msg_class?: number; msg_class_name?: string;
  /** uint64 JS_STRING */ causal_epoch?: string;
  public_meta?: PublicMeta; unknown?: Uint8Array[];
}
/** Subscribe (32) / Unsubscribe (33) — the SAME two fields in both messages. */
export interface Scope { kind?: number; id?: string; unknown?: Uint8Array[] }
export interface SubmitMessage { envelope?: Envelope; sealed?: Uint8Array; unknown?: Uint8Array[] }
export interface MessageAck { message_id?: string; seq?: string; server_ts_ms?: string; unknown?: Uint8Array[] }
export interface Fragment {
  fragment_id?: string; index?: number; total?: number;
  /** uint64 JS_STRING */ total_bytes?: string;
  chunk?: Uint8Array; last?: boolean; unknown?: Uint8Array[];
}
export interface Cursor {
  chat_id?: string; kind?: number; /** uint64 JS_STRING */ position?: string;
  /** int64 JS_STRING */ updated_at_ms?: string; unknown?: Uint8Array[];
}
export interface CursorSync {
  cursors?: Cursor[]; mutation_continuation?: string; unknown?: Uint8Array[];
}
export interface CursorBatch {
  cursors?: Cursor[]; more?: boolean; continuation?: string;
  mutation_continuation?: string; unknown?: Uint8Array[];
}

export interface Frame {
  request_id?: string;
  /** Number is authoritative. TRAFFIC_CLASS_UNSPECIFIED (0) is refused on the wire. */
  traffic_class?: number;
  traffic_class_name?: string;
  stream?: number;
  stream_name?: string;
  /** uint64 [jstype = JS_STRING] — a DECIMAL STRING. Never a number: see below. */
  seq?: string;
  /** uint64 [jstype = JS_STRING]. */
  depends_on?: string;
  /** Which oneof body is set, e.g. 'crypto_control'. Absent when there is none. */
  body?: string;
  /** The body's field number — authoritative; `body` is derived from it. */
  body_field?: number;
  /** Decoded body, for the six types this build types. */
  value?: TypingState | ViewerState | GeoRelay | CryptoControl | SubmitMessage | Fragment | AppEvent | Scope;
  /** Verbatim body bytes when the type is not typed here. Round-trips exactly. */
  raw?: Uint8Array;
  /** Unrecognised top-level fields, tag+value, in wire order. NEVER dropped. */
  unknown?: Uint8Array[];
}

export interface FrameDecodeResult {
  ok: boolean;
  /** Present when ok. */
  frame?: Frame;
  /** Present when !ok. */
  error?: CodecError;
  /** Present when !ok — the errors.proto ErrorCode to put in an Error frame. */
  errorCode?: number;
  /** Present when !ok — human detail for logs, never for control flow. */
  detail?: string;
}

export interface FrameEncodeResult {
  ok: boolean;
  /** Present when ok. */
  bytes?: Uint8Array;
  /** Present when !ok. */
  error?: CodecError;
  errorCode?: number;
  detail?: string;
}

// ─── Wire primitives ─────────────────────────────────────────────────────────

const TWO64 = 1n << 64n;
const TWO63 = 1n << 63n;

/** Thrown internally, converted to a typed result at the public boundary. */
class Refused extends Error {
  constructor(public code: CodecError, public why: string) { super(`${code}: ${why}`); }
}
const fail = (code: CodecError, why: string): never => { throw new Refused(code, why); };

interface R { b: Uint8Array; p: number; end: number; lim: typeof LIMITS; appEventsV1?: boolean }

/** Varints in tag and length position. Capped at 5 bytes: a longer one there is
 *  not a large number, it is an over-long encoding probing for a mismatch. */
function varint32(r: R): number {
  let out = 0, shift = 1;
  for (let i = 0; i < 5; i++) {
    if (r.p >= r.end) fail('TRUNCATED', 'varint ran past the end');
    const byte = r.b[r.p++];
    out += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return out;
    shift *= 128;
  }
  return fail('VARINT_OVERFLOW', 'varint over 5 bytes in a tag/length');
}

/** Full 64-bit varint. Ten bytes max; the tenth may only carry one value bit. */
function varint64(r: R): bigint {
  let out = 0n, shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (r.p >= r.end) fail('TRUNCATED', 'varint ran past the end');
    const byte = r.b[r.p++];
    out |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return out & (TWO64 - 1n);
    shift += 7n;
  }
  return fail('VARINT_OVERFLOW', 'varint over 10 bytes');
}

function skipVarint(r: R): void {
  for (let i = 0; i < 10; i++) {
    if (r.p >= r.end) fail('TRUNCATED', 'varint ran past the end');
    if ((r.b[r.p++] & 0x80) === 0) return;
  }
  fail('VARINT_OVERFLOW', 'varint over 10 bytes');
}

/** A length-delimited span, as a VIEW. Bounds-checked before it is produced. */
function lenSpan(r: R): Uint8Array {
  const n = varint32(r);
  if (r.p + n > r.end) fail('TRUNCATED', `length ${n} exceeds the remaining ${r.end - r.p}`);
  const out = r.b.subarray(r.p, r.p + n);
  r.p += n;
  return out;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const TOUTF8 = new TextEncoder();

/**
 * BOUND CHECKED IN BYTES, BEFORE THE UTF-8 DECODE — a 4096-byte cap applied to
 * the decoded JS string would let a 3x multi-byte payload through the gate it
 * exists to hold. Invalid UTF-8 is refused rather than replaced: Go's proto3
 * rejects it, and silently substituting U+FFFD here would make the two sides
 * disagree about what the bytes said, which is a parser differential.
 */
function readString(r: R): string {
  const span = lenSpan(r);
  if (span.length > r.lim.max_string_field_bytes) {
    fail('STRING_TOO_LONG', `${span.length} > ${r.lim.max_string_field_bytes}`);
  }
  try { return UTF8.decode(span); } catch { return fail('INVALID_UTF8', `${span.length} bytes`); }
}

function readBytes(r: R, cap: number): Uint8Array {
  const span = lenSpan(r);
  if (span.length > cap) fail('BYTES_TOO_LONG', `${span.length} > ${cap}`);
  return span;
}

function push<T>(into: T[], lim: number, what: string): void {
  if (into.length >= lim) fail('TOO_MANY_ELEMENTS', `${what} over ${lim}`);
}

/** Wire type 3/4 are proto2 groups: not representable in proto3, so refused. */
function skipField(r: R, wire: number): void {
  if (wire === 0) skipVarint(r);
  else if (wire === 1) { if (r.p + 8 > r.end) fail('TRUNCATED', 'fixed64'); r.p += 8; }
  else if (wire === 2) lenSpan(r);
  else if (wire === 5) { if (r.p + 4 > r.end) fail('TRUNCATED', 'fixed32'); r.p += 4; }
  else fail('BAD_WIRE_TYPE', `wire type ${wire}`);
}

/**
 * The unknown-field path. Copies the WHOLE field — tag included — verbatim, and
 * does NOT walk into it. Not walking is the security property: a nested length-
 * delimited field that this build cannot interpret is bytes, so a nesting bomb
 * inside one costs nothing to skip, and re-encoding reproduces it exactly.
 */
function keepUnknown(r: R, tagStart: number, wire: number, into: Uint8Array[]): void {
  push(into, r.lim.max_repeated_elements, 'unknown fields');
  skipField(r, wire);
  into.push(r.b.subarray(tagStart, r.p));
}

/** Reads one field header, refusing field 0 (not a representable field number). */
function tag(r: R): { field: number; wire: number } {
  const t = varint32(r);
  const field = Math.floor(t / 8), wire = t & 7;
  if (field === 0) fail('FIELD_ZERO', 'field number 0');
  return { field, wire };
}

/** Enter a nested message. THE RECURSION LIMIT, envelope.proto: 6. */
function nest(r: R, depth: number): R {
  if (depth > r.lim.max_nesting_depth) {
    fail('NESTING_TOO_DEEP', `depth ${depth} > ${r.lim.max_nesting_depth}`);
  }
  const span = lenSpan(r);
  return { b: span, p: 0, end: span.length, lim: r.lim, appEventsV1: r.appEventsV1 };
}

// ─── Writer ──────────────────────────────────────────────────────────────────

interface W { parts: Uint8Array[]; cur: number[] }
const w = (): W => ({ parts: [], cur: [] });
function wFlush(x: W): void { if (x.cur.length) { x.parts.push(Uint8Array.from(x.cur)); x.cur = []; } }
function wRaw(x: W, b: Uint8Array): void { wFlush(x); x.parts.push(b); }
function wVarint(x: W, n: number): void {
  let v = n;
  while (v >= 128) { x.cur.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  x.cur.push(v);
}
function wVarint64(x: W, v: bigint): void {
  let n = v & (TWO64 - 1n);
  while (n >= 128n) { x.cur.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  x.cur.push(Number(n));
}
function wTag(x: W, field: number, wire: number): void { wVarint(x, field * 8 + wire); }
function wDone(x: W): Uint8Array {
  wFlush(x);
  let n = 0;
  for (const p of x.parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of x.parts) { out.set(p, o); o += p.length; }
  return out;
}
// proto3: a field at its default value is not written.
function wStr(x: W, field: number, s: string): void {
  if (!s) return;
  const b = TOUTF8.encode(s);
  wTag(x, field, 2); wVarint(x, b.length); wRaw(x, b);
}
function wBytes(x: W, field: number, b: Uint8Array): void {
  if (!b || !b.length) return;
  wTag(x, field, 2); wVarint(x, b.length); wRaw(x, b);
}
function wU32(x: W, field: number, n: number): void {
  if (!n) return;
  wTag(x, field, 0); wVarint(x, n);
}
function wBool(x: W, field: number, v: boolean): void {
  if (!v) return;
  wTag(x, field, 0); wVarint(x, 1);
}
/** JS_STRING in, exact bytes out. See the 64-bit note below. */
function wI64(x: W, field: number, s: string): void {
  if (!s || s === '0') return;
  wTag(x, field, 0); wVarint64(x, BigInt(s));
}
/** Always written, even at zero length: presence of a submessage is meaningful
 *  in proto3 and an all-default Envelope must not vanish on re-encode. */
function wSub(x: W, field: number, body: Uint8Array): void {
  wTag(x, field, 2); wVarint(x, body.length); wRaw(x, body);
}
function wUnknown(x: W, u: Uint8Array[]): void { for (const b of u ?? []) wRaw(x, b); }

// ─────────────────────────────────────────────────────────────────────────────
// 64-BIT FIELDS ARE STRINGS, NOT NUMBERS.
//
// envelope.proto marks seq, depends_on, causal_epoch, epoch and the timestamps
// [jstype = JS_STRING] for one reason: Number cannot hold a uint64. 2^53+1
// rounds to 2^53 the instant it becomes a double, and it does so SILENTLY — no
// throw, no NaN, just a sequence number that compares equal to its predecessor
// and a replay window that opens itself. So the wire value is read into a BigInt
// and handed out as a decimal string, and the string is what re-encodes. A
// caller that wants arithmetic converts to BigInt deliberately; there is no path
// through this file where a 64-bit value becomes a double.
// ─────────────────────────────────────────────────────────────────────────────
const u64str = (r: R): string => varint64(r).toString();
const i64str = (r: R): string => { const v = varint64(r); return (v >= TWO63 ? v - TWO64 : v).toString(); };

// ─── Body decoders ───────────────────────────────────────────────────────────
//
// Each is the same skeleton: loop fields, switch on number, anything else goes
// to keepUnknown. Duplicate scalars are LAST-WINS, which is proto3's rule and
// what the Go side will do; deviating from it here would be the differential.

function readAppEvent(r: R): AppEvent {
  const m: AppEvent = { event: '', payload_json: new Uint8Array(), unknown: [] };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.event = readString(r);
    else if (field === 2 && wire === 2) m.payload_json = readBytes(r, r.appEventsV1 ? APP_EVENT_JSON_MAX : r.lim.max_opaque_bytes);
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writeAppEvent(m: AppEvent): Uint8Array {
  const x = w();
  wStr(x, 1, m.event ?? ''); wBytes(x, 2, m.payload_json); wUnknown(x, m.unknown);
  return wDone(x);
}

/**
 * Subscribe (32). ENCODE ONLY, and that asymmetry is deliberate.
 *
 * The server never SENDS a Subscribe — ccwire.go routes 32/33 inbound to
 * s.scope and answers with an Ack (22) — so a reader here would be unreachable
 * code. It would also not be free: __vectors__/codec.json pins
 * `bodiesTypedByTypescriptOnly` at exactly [100], and both Go
 * (internal/ccwire/codec_parity_test.go TestEveryTypedBodyHasVectors) and Rust
 * (services/transport/rust/tests/body.rs every_typed_body_has_vectors) assert
 * that list is [100] and nothing else. Adding 32 to TYPED_BODY would mean
 * widening a guard whose whole job is to stop one-sided body typing — for a
 * body this side can only ever write. So body 32 keeps decoding as opaque
 * `raw`, exactly as it does today, and only the writer is added.
 *
 * Unsubscribe (33) is the same two fields and gets no writer either, because
 * leave_chat still travels as app_event. One is added the day it is sent.
 */
function writeScope(m: Scope): Uint8Array {
  const x = w();
  wU32(x, 1, m.kind ?? 0); wStr(x, 2, m.id ?? '');
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readTypingState(r: R): TypingState {
  const m: TypingState = { chat_id: '', typing: false, sender_uid: '', unknown: [] };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.chat_id = readString(r);
    else if (field === 2 && wire === 0) m.typing = varint64(r) !== 0n;
    else if (field === 3 && wire === 2) m.sender_uid = readString(r);
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writeTypingState(m: TypingState): Uint8Array {
  const x = w();
  wStr(x, 1, m.chat_id ?? ''); wBool(x, 2, !!m.typing); wStr(x, 3, m.sender_uid ?? '');
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readViewerState(r: R): ViewerState {
  const m: ViewerState = { chat_id: '', activity: 0, leaving: false, resync: false, unknown: [] };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.chat_id = readString(r);
    else if (field === 2 && wire === 0) m.activity = Number(varint64(r) & 0xffffffffn);
    else if (field === 3 && wire === 0) m.leaving = varint64(r) !== 0n;
    else if (field === 4 && wire === 0) m.resync = varint64(r) !== 0n;
    else keepUnknown(r, s, wire, m.unknown);
  }
  m.activity_name = surface(VIEWER_ACTIVITY_NAMES, m.activity);
  return m;
}
function writeViewerState(m: ViewerState): Uint8Array {
  const x = w();
  wStr(x, 1, m.chat_id ?? ''); wU32(x, 2, m.activity ?? 0);
  wBool(x, 3, !!m.leaving); wBool(x, 4, !!m.resync);
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readGeoRelay(r: R): GeoRelay {
  const m: GeoRelay = {
    scope_kind: 0, scope_id: '', subject_id: '', sealed: new Uint8Array(0),
    ended: false, until_ms: '0', sender_uid: '', unknown: [],
  };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 0) m.scope_kind = Number(varint64(r) & 0xffffffffn);
    else if (field === 2 && wire === 2) m.scope_id = readString(r);
    else if (field === 3 && wire === 2) m.subject_id = readString(r);
    else if (field === 4 && wire === 2) m.sealed = readBytes(r, r.lim.max_opaque_bytes);
    else if (field === 5 && wire === 0) m.ended = varint64(r) !== 0n;
    else if (field === 6 && wire === 0) m.until_ms = i64str(r);
    else if (field === 7 && wire === 2) m.sender_uid = readString(r);
    else keepUnknown(r, s, wire, m.unknown);
  }
  m.scope_kind_name = surface(SCOPE_KIND_NAMES, m.scope_kind);
  return m;
}
function writeGeoRelay(m: GeoRelay): Uint8Array {
  const x = w();
  wU32(x, 1, m.scope_kind ?? 0); wStr(x, 2, m.scope_id ?? ''); wStr(x, 3, m.subject_id ?? '');
  wBytes(x, 4, m.sealed); wBool(x, 5, !!m.ended); wI64(x, 6, m.until_ms ?? '0');
  wStr(x, 7, m.sender_uid ?? '');
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readCryptoControl(r: R): CryptoControl {
  const m: CryptoControl = {
    kind: 0, chat_id: '', to_uid: '', payload: new Uint8Array(0),
    epoch: '0', payload_format: '', unknown: [],
  };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 0) m.kind = Number(varint64(r) & 0xffffffffn);
    else if (field === 2 && wire === 2) m.chat_id = readString(r);
    else if (field === 3 && wire === 2) m.to_uid = readString(r);
    else if (field === 4 && wire === 2) m.payload = readBytes(r, r.lim.max_opaque_bytes);
    else if (field === 5 && wire === 0) m.epoch = u64str(r);
    else if (field === 6 && wire === 2) m.payload_format = readString(r);
    else keepUnknown(r, s, wire, m.unknown);
  }
  m.kind_name = surface(CRYPTO_CONTROL_KIND_NAMES, m.kind);
  return m;
}
function writeCryptoControl(m: CryptoControl): Uint8Array {
  const x = w();
  wU32(x, 1, m.kind ?? 0); wStr(x, 2, m.chat_id ?? ''); wStr(x, 3, m.to_uid ?? '');
  wBytes(x, 4, m.payload); wI64(x, 5, m.epoch ?? '0'); wStr(x, 6, m.payload_format ?? '');
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readPublicMeta(r: R): PublicMeta {
  const m: PublicMeta = {
    attachment_id: '', view_once: false, revoked: false, announcement: false,
    audience: '', silent: false, group_id: '', gif_url: '', allow_multiple: false,
    option_count: 0, mention_user_ids: [], encrypted: false, game: '', room: '',
    unknown: [],
  };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.attachment_id = readString(r);
    else if (field === 2 && wire === 0) m.view_once = varint64(r) !== 0n;
    else if (field === 3 && wire === 0) m.revoked = varint64(r) !== 0n;
    else if (field === 4 && wire === 0) m.announcement = varint64(r) !== 0n;
    else if (field === 5 && wire === 2) m.audience = readString(r);
    else if (field === 6 && wire === 0) m.silent = varint64(r) !== 0n;
    else if (field === 7 && wire === 2) m.group_id = readString(r);
    else if (field === 8 && wire === 2) m.gif_url = readString(r);
    else if (field === 9 && wire === 0) m.allow_multiple = varint64(r) !== 0n;
    else if (field === 10 && wire === 0) m.option_count = Number(varint64(r) & 0xffffffffn);
    else if (field === 11 && wire === 2) {
      // Bound: max_repeated_elements. Checked BEFORE the element is appended,
      // so a repeated field cannot grow the heap past the cap even by one.
      push(m.mention_user_ids, r.lim.max_repeated_elements, 'mention_user_ids');
      m.mention_user_ids.push(readString(r));
    } else if (field === 12 && wire === 0) m.encrypted = varint64(r) !== 0n;
    else if (field === 13 && wire === 2) m.game = readString(r);
    else if (field === 14 && wire === 2) m.room = readString(r);
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writePublicMeta(m: PublicMeta): Uint8Array {
  const x = w();
  wStr(x, 1, m.attachment_id ?? ''); wBool(x, 2, !!m.view_once); wBool(x, 3, !!m.revoked);
  wBool(x, 4, !!m.announcement); wStr(x, 5, m.audience ?? ''); wBool(x, 6, !!m.silent);
  wStr(x, 7, m.group_id ?? ''); wStr(x, 8, m.gif_url ?? ''); wBool(x, 9, !!m.allow_multiple);
  wU32(x, 10, m.option_count ?? 0);
  for (const id of m.mention_user_ids ?? []) wStr(x, 11, id);
  wBool(x, 12, !!m.encrypted); wStr(x, 13, m.game ?? ''); wStr(x, 14, m.room ?? '');
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readEnvelope(r: R, depth: number): Envelope {
  const m: Envelope = {
    chat_id: '', message_id: '', client_msg_id: '', server_ts_ms: '0',
    msg_class: 0, causal_epoch: '0', unknown: [],
  };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.chat_id = readString(r);
    else if (field === 2 && wire === 2) m.message_id = readString(r);
    else if (field === 3 && wire === 2) m.client_msg_id = readString(r);
    else if (field === 4 && wire === 0) m.server_ts_ms = i64str(r);
    else if (field === 5 && wire === 0) m.msg_class = Number(varint64(r) & 0xffffffffn);
    else if (field === 6 && wire === 0) m.causal_epoch = u64str(r);
    else if (field === 7 && wire === 2) m.public_meta = readPublicMeta(nest(r, depth + 1));
    else keepUnknown(r, s, wire, m.unknown);
  }
  m.msg_class_name = surface(MESSAGE_CLASS_NAMES, m.msg_class);
  return m;
}
function writeEnvelope(m: Envelope): Uint8Array {
  const x = w();
  wStr(x, 1, m.chat_id ?? ''); wStr(x, 2, m.message_id ?? ''); wStr(x, 3, m.client_msg_id ?? '');
  wI64(x, 4, m.server_ts_ms ?? '0'); wU32(x, 5, m.msg_class ?? 0);
  wI64(x, 6, m.causal_epoch ?? '0');
  if (m.public_meta) wSub(x, 7, writePublicMeta(m.public_meta));
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readSubmitMessage(r: R, depth: number): SubmitMessage {
  const m: SubmitMessage = { sealed: new Uint8Array(0), unknown: [] };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.envelope = readEnvelope(nest(r, depth + 1), depth + 1);
    // The one field bounded at max_message_body_bytes rather than
    // max_opaque_bytes: it is the message body, and it arrives reassembled from
    // fragments, so it legitimately exceeds a single frame.
    else if (field === 2 && wire === 2) m.sealed = readBytes(r, r.lim.max_message_body_bytes);
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writeSubmitMessage(m: SubmitMessage): Uint8Array {
  const x = w();
  if (m.envelope) wSub(x, 1, writeEnvelope(m.envelope));
  wBytes(x, 2, m.sealed);
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readFragment(r: R): Fragment {
  const m: Fragment = {
    fragment_id: '', index: 0, total: 0, total_bytes: '0',
    chunk: new Uint8Array(0), last: false, unknown: [],
  };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.fragment_id = readString(r);
    else if (field === 2 && wire === 0) m.index = Number(varint64(r) & 0xffffffffn);
    else if (field === 3 && wire === 0) {
      m.total = Number(varint64(r) & 0xffffffffn);
      if (m.total > r.lim.max_fragments_per_message) {
        fail('TOO_MANY_ELEMENTS', `fragment total ${m.total} > ${r.lim.max_fragments_per_message}`);
      }
    } else if (field === 4 && wire === 0) {
      m.total_bytes = u64str(r);
      // Declared up front, checked BEFORE anything is allocated from it. The
      // reassembler must not be handed a number it would trust.
      const logicalMax = r.appEventsV1 ? APP_EVENT_LOGICAL_MAX : r.lim.max_message_body_bytes;
      if (BigInt(m.total_bytes) > BigInt(logicalMax)) {
        fail('BYTES_TOO_LONG', `total_bytes ${m.total_bytes} > ${logicalMax}`);
      }
    } else if (field === 5 && wire === 2) m.chunk = lenSpan(r);   // bounded by the frame
    else if (field === 6 && wire === 0) m.last = varint64(r) !== 0n;
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writeFragment(m: Fragment): Uint8Array {
  const x = w();
  wStr(x, 1, m.fragment_id ?? ''); wU32(x, 2, m.index ?? 0); wU32(x, 3, m.total ?? 0);
  wI64(x, 4, m.total_bytes ?? '0'); wBytes(x, 5, m.chunk); wBool(x, 6, !!m.last);
  wUnknown(x, m.unknown);
  return wDone(x);
}

function readCursor(r: R): Cursor {
  const m: Cursor = { chat_id: '', kind: 0, position: '0', updated_at_ms: '0', unknown: [] };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) m.chat_id = readString(r);
    else if (field === 2 && wire === 0) m.kind = Number(varint64(r) & 0xffffffffn);
    else if (field === 3 && wire === 0) m.position = u64str(r);
    else if (field === 4 && wire === 0) m.updated_at_ms = i64str(r);
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writeCursor(m: Cursor): Uint8Array {
  const x = w();
  wStr(x, 1, m.chat_id ?? ''); wU32(x, 2, m.kind ?? 0);
  wI64(x, 3, m.position ?? '0'); wI64(x, 4, m.updated_at_ms ?? '0');
  wUnknown(x, m.unknown);
  return wDone(x);
}
function readCursorSync(r: R, depth: number): CursorSync {
  const m: CursorSync = { cursors: [], mutation_continuation: '', unknown: [] };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) {
      push(m.cursors, r.lim.max_repeated_elements, 'cursors');
      m.cursors.push(readCursor(nest(r, depth + 1)));
    } else if (field === 2 && wire === 2) m.mutation_continuation = readString(r);
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writeCursorSync(m: CursorSync): Uint8Array {
  const x = w();
  for (const c of m.cursors ?? []) wSub(x, 1, writeCursor(c));
  wStr(x, 2, m.mutation_continuation ?? ''); wUnknown(x, m.unknown);
  return wDone(x);
}
function readCursorBatch(r: R, depth: number): CursorBatch {
  const m: CursorBatch = { cursors: [], more: false, continuation: '', mutation_continuation: '', unknown: [] };
  while (r.p < r.end) {
    const s = r.p, { field, wire } = tag(r);
    if (field === 1 && wire === 2) {
      push(m.cursors, r.lim.max_repeated_elements, 'cursors');
      m.cursors.push(readCursor(nest(r, depth + 1)));
    } else if (field === 2 && wire === 0) m.more = varint64(r) !== 0n;
    else if (field === 3 && wire === 2) m.continuation = readString(r);
    else if (field === 4 && wire === 2) m.mutation_continuation = readString(r);
    else keepUnknown(r, s, wire, m.unknown);
  }
  return m;
}
function writeCursorBatch(m: CursorBatch): Uint8Array {
  const x = w();
  for (const c of m.cursors ?? []) wSub(x, 1, writeCursor(c));
  wBool(x, 2, !!m.more); wStr(x, 3, m.continuation ?? '');
  wStr(x, 4, m.mutation_continuation ?? ''); wUnknown(x, m.unknown);
  return wDone(x);
}

/** The seven bodies this build decodes. Everything else round-trips as `raw`. */
const TYPED_BODY: Record<number, (r: R, depth: number) => any> = {
  100: (r) => readAppEvent(r),
  48: readSubmitMessage,
  81: (r) => readTypingState(r),
  82: (r) => readViewerState(r),
  84: (r) => readGeoRelay(r),
  98: (r) => readCryptoControl(r),
  112: (r) => readFragment(r),
};
const TYPED_BODY_WRITER: Record<number, (m: any) => Uint8Array> = {
  100: writeAppEvent,
  32: writeScope,   // encode-only; see writeScope for why there is no reader
  48: writeSubmitMessage,
  81: writeTypingState,
  82: writeViewerState,
  84: writeGeoRelay,
  98: writeCryptoControl,
  112: writeFragment,
};

// ─── The invariant ───────────────────────────────────────────────────────────

/** Returns a refusal reason, or '' when the frame is legal. */
function checkInvariants(f: Frame): string {
  // envelope.proto: TRAFFIC_CLASS_UNSPECIFIED "never valid on the wire; refuse".
  if (!f.traffic_class) return 'traffic_class is TRAFFIC_CLASS_UNSPECIFIED';
  if (f.traffic_class === TRAFFIC_CLASS_EPHEMERAL && f.body_field != null
      && !EPHEMERAL_BODIES.has(f.body_field)) {
    return `EPHEMERAL may carry only typing_state/viewer_state/geo_relay, not `
      + `${BODY_NAMES[f.body_field] ?? `field ${f.body_field}`}`;
  }
  return '';
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface CodecOptions {
  /** Negotiated app-event fragments only; other typed body limits stay unchanged. */
  appEventsV1?: boolean;
  /** Negotiated ServerHello.limits.max_frame_bytes. Clamped to the hard ceiling. */
  maxBytes?: number;
  /** A negotiated Limits, overriding any of the defaults DOWNWARD. */
  limits?: Limits;
  /**
   * Nesting level this Frame already sits at. 0 for a frame off the wire; the
   * fragment reassembler passes depth+1 when it re-decodes a reassembled
   * payload, which is what stops a Fragment-in-Fragment bomb from recursing
   * forever. Combined with the submessage counter, the budget is one: 6.
   */
  depth?: number;
}

function resolveLimits(o: CodecOptions): typeof LIMITS {
  if (!o.limits) return LIMITS;
  const out: any = { ...LIMITS };
  // A negotiated limit may only tighten. A peer proposing a LARGER bound than
  // this build compiled with does not get it — negotiation is not authority.
  for (const k of Object.keys(LIMITS)) {
    const v = (o.limits as any)[k];
    if (typeof v === 'number' && v > 0 && v < out[k]) out[k] = v;
  }
  return out;
}

export interface CursorBodyDecodeResult<T> {
  ok: boolean; value?: T; error?: CodecError; errorCode?: number; detail?: string;
}

function decodeCursorBody<T>(buf: Uint8Array, read: (r: R, depth: number) => T,
  opts: CodecOptions): CursorBodyDecodeResult<T> {
  const lim = resolveLimits(opts);
  try {
    return { ok: true, value: read({ b: buf, p: 0, end: buf.length, lim }, opts.depth ?? 1) };
  } catch (e) {
    const x = e as Refused;
    return { ok: false, error: x.code, errorCode: ERROR_CODE[x.code], detail: x.why };
  }
}

export const encodeCursorSync = (m: CursorSync): Uint8Array => writeCursorSync(m);
export const encodeCursorBatch = (m: CursorBatch): Uint8Array => writeCursorBatch(m);
export const decodeCursorSync = (b: Uint8Array, o: CodecOptions = {}): CursorBodyDecodeResult<CursorSync> =>
  decodeCursorBody(b, readCursorSync, o);
export const decodeCursorBatch = (b: Uint8Array, o: CodecOptions = {}): CursorBodyDecodeResult<CursorBatch> =>
  decodeCursorBody(b, readCursorBatch, o);

/** Ack stays opaque in Frame; submission alone interprets its persisted id. */
export function decodeMessageAck(b: Uint8Array): CursorBodyDecodeResult<MessageAck> {
  return decodeCursorBody(b, (r) => {
    const m: MessageAck = { message_id: '', seq: '0', server_ts_ms: '0', unknown: [] };
    while (r.p < r.end) {
      const s = r.p, { field, wire } = tag(r);
      if (field === 1 && wire === 2) m.message_id = readString(r);
      else if (field === 2 && wire === 0) m.seq = u64str(r);
      else if (field === 3 && wire === 0) m.server_ts_ms = i64str(r);
      else keepUnknown(r, s, wire, m.unknown);
    }
    return m;
  }, {});
}

/**
 * Decode one ccwire.v1.Frame from the payload frame.ts handed up.
 *
 * The total-size limit is applied to the WHOLE payload first, so every bound
 * below it is a bound on something already known to be small. Unknown fields are
 * preserved verbatim; unknown enum values keep their number and surface as
 * *_UNSPECIFIED. Malformed input is REFUSED with a typed reason.
 */
export function decodeFrameMessage(buf: Uint8Array, opts: CodecOptions = {}): FrameDecodeResult {
  const lim = resolveLimits(opts);
  const cap = Math.min(opts.maxBytes ?? lim.max_frame_bytes, MAX_FRAME_BYTES);
  const depth = opts.depth ?? 0;

  if (buf.length > cap) {
    return { ok: false, error: 'SIZE_OVER_MAX', errorCode: ERROR_CODE.SIZE_OVER_MAX,
      detail: `${buf.length} > ${cap}` };
  }
  if (depth > lim.max_nesting_depth) {
    return { ok: false, error: 'NESTING_TOO_DEEP', errorCode: ERROR_CODE.NESTING_TOO_DEEP,
      detail: `depth ${depth} > ${lim.max_nesting_depth}` };
  }

  const r: R = { b: buf, p: 0, end: buf.length, lim, appEventsV1: opts.appEventsV1 };
  const f: Frame = {
    request_id: '', traffic_class: 0, stream: 0, seq: '0', depends_on: '0', unknown: [],
  };

  try {
    while (r.p < r.end) {
      const s = r.p, { field, wire } = tag(r);
      if (field === 1 && wire === 2) f.request_id = readString(r);
      else if (field === 2 && wire === 0) f.traffic_class = Number(varint64(r) & 0xffffffffn);
      else if (field === 3 && wire === 0) f.stream = Number(varint64(r) & 0xffffffffn);
      else if (field === 4 && wire === 0) f.seq = u64str(r);
      else if (field === 5 && wire === 0) f.depends_on = u64str(r);
      else if (BODY_NAMES[field] && wire === 2) {
        // A oneof is ONE field. proto3 says last-wins; this refuses instead,
        // because two bodies is a smuggling primitive: if the Go side takes the
        // last and a JS side takes the first, the two disagree about what the
        // peer said while both call it valid.
        if (f.body_field != null) {
          return { ok: false, error: 'DUPLICATE_BODY', errorCode: ERROR_CODE.DUPLICATE_BODY,
            detail: `${BODY_NAMES[f.body_field]} then ${BODY_NAMES[field]}` };
        }
        f.body_field = field;
        f.body = BODY_NAMES[field];
        const dec = TYPED_BODY[field];
        if (dec) f.value = dec(nest(r, depth + 1), depth + 1);
        else f.raw = nest(r, depth + 1).b;   // depth still charged for the skip
      } else keepUnknown(r, s, wire, f.unknown);
    }
  } catch (e) {
    if (e instanceof Refused) {
      return { ok: false, error: e.code, errorCode: ERROR_CODE[e.code], detail: e.why };
    }
    throw e;
  }

  f.traffic_class_name = surface(TRAFFIC_CLASS_NAMES, f.traffic_class);
  f.stream_name = surface(STREAM_ID_NAMES, f.stream);

  const bad = checkInvariants(f);
  if (bad) {
    return { ok: false, error: 'PROTOCOL_VIOLATION', errorCode: ERROR_CODE.PROTOCOL_VIOLATION,
      detail: bad };
  }
  return { ok: true, frame: f };
}

/**
 * Encode a ccwire.v1.Frame.
 *
 * The invariant is checked here TOO, not only on decode — envelope.proto says
 * "enforced at both encode and decode". A bug that produces a CryptoControl on
 * EPHEMERAL should fail on the machine that has the stack trace, not on the peer
 * that only has bytes.
 *
 * The same reasoning covers every bound below: request_id at
 * max_string_field_bytes, the body field number against the closed oneof, and
 * the body at max_message_body_bytes. Each mirrors a refusal Go
 * (internal/ccwire/codec.go) and Rust (transport/rust/src/parse.rs) already make
 * on encode, and each returns the SAME typed error the decode path returns for
 * the same overrun, so a caller's switch does not need a second arm.
 */
export function encodeFrameMessage(f: Frame, opts: CodecOptions = {}): FrameEncodeResult {
  const lim = resolveLimits(opts);
  const cap = Math.min(opts.maxBytes ?? lim.max_frame_bytes, MAX_FRAME_BYTES);

  const bad = checkInvariants(f);
  if (bad) {
    return { ok: false, error: 'PROTOCOL_VIOLATION', errorCode: ERROR_CODE.PROTOCOL_VIOLATION,
      detail: bad };
  }

  let out: Uint8Array;
  try {
    const x = w();
    // BOUNDED ON ENCODE, exactly as on decode. Go refuses here with
    // ErrStringTooLong and Rust with StringTooLong; without the same check a
    // TypeScript bug ships a request_id both peers drop, and the only evidence
    // is bytes on someone else's wire. Measured in BYTES after UTF-8 encoding,
    // because that is what readString bounds and what the peers measure.
    const rid = TOUTF8.encode(f.request_id ?? '').length;
    if (rid > lim.max_string_field_bytes) {
      fail('STRING_TOO_LONG', `request_id ${rid} > ${lim.max_string_field_bytes}`);
    }
    wStr(x, 1, f.request_id ?? '');
    wU32(x, 2, f.traffic_class ?? 0);
    wU32(x, 3, f.stream ?? 0);
    wI64(x, 4, f.seq ?? '0');
    wI64(x, 5, f.depends_on ?? '0');
    if (f.body_field != null) {
      // The oneof is CLOSED. A field number outside it is not a forward-
      // compatible extension: the peer decodes it as a preserved unknown field
      // with no body set, and then refuses the whole frame for having no body.
      // So the refusal belongs here, where the caller's stack trace is.
      if (!BODY_NAMES[f.body_field]) {
        fail('PROTOCOL_VIOLATION', `body field ${f.body_field} is not a ccwire.v1.Frame oneof arm`);
      }
      const writer = TYPED_BODY_WRITER[f.body_field];
      const body = writer && f.value ? writer(f.value) : (f.raw ?? new Uint8Array(0));
      // The whole-frame ceiling below is not a substitute: max_message_body_bytes
      // is LARGER than a frame, because a body arrives reassembled from
      // fragments. Go: ErrBytesTooLong. Rust: BytesTooLong.
      //
      // The appEventsV1 exception is not a loophole — it is the SAME conditional
      // the decode path already carries. readFragment bounds total_bytes at
      // APP_EVENT_LOGICAL_MAX when appEventsV1 is negotiated, and client.ts
      // encodes an app_event at that ceiling precisely so the fragmenter can cut
      // it up. Bounding encode at max_message_body_bytes unconditionally would
      // refuse a body this build then goes on to accept off the wire, which is
      // the asymmetry this whole rule exists to prevent, pointed the other way.
      // With appEventsV1 OFF — the only mode Go and Rust have — the ceiling is
      // exactly max_message_body_bytes, so the three still agree.
      const bodyCap = opts.appEventsV1 ? APP_EVENT_LOGICAL_MAX : lim.max_message_body_bytes;
      if (body.length > bodyCap) {
        fail('BYTES_TOO_LONG', `body ${body.length} > ${bodyCap}`);
      }
      // Unlike every other field, an empty body is WRITTEN: a bare Ping is a
      // zero-byte submessage and dropping it would erase which body was set.
      wTag(x, f.body_field, 2); wVarint(x, body.length); wRaw(x, body);
    }
    wUnknown(x, f.unknown);
    out = wDone(x);
  } catch (e) {
    if (e instanceof Refused) {
      return { ok: false, error: e.code, errorCode: ERROR_CODE[e.code], detail: e.why };
    }
    throw e;
  }

  if (out.length > cap) {
    return { ok: false, error: 'SIZE_OVER_MAX', errorCode: ERROR_CODE.SIZE_OVER_MAX,
      detail: `${out.length} > ${cap}` };
  }
  return { ok: true, bytes: out };
}

export default {};
