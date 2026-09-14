// lib/ccwire/frame.ts — CC-Wire v1 length-prefixed framing.
//
// STATUS: NOT WIRED. Nothing imports this from the app. The live transport is
// still Socket.IO v4 with JSON payloads (lib/socket.ts). This is Stage 2 of the
// rollout plan — "Protobuf framing and binary-WebSocket parity in ISOLATED
// testing" — and it must not be switched on until the conformance harness and a
// parity soak have both passed.
//
// WHAT THIS LAYER IS
//
//   u8  framing_version
//   u32 length (big-endian)
//   ... length bytes of opaque payload (a serialized ccwire.v1.Frame)
//
// It is deliberately protobuf-AGNOSTIC: the payload is bytes. That separation is
// the point — the bound on `length` has to be enforced BEFORE any buffer is
// allocated, which means before a protobuf decoder is ever handed the input. A
// decoder that allocates from a client-declared length is the classic
// memory-exhaustion bug, and no amount of schema care fixes it afterwards.
//
// WHY BIG-ENDIAN: network byte order, and it makes a hexdump readable when
// debugging a capture. WHY u32 AND NOT varint: a varint length can itself be
// malformed or over-long, so it needs its own bounds check before the check it
// exists to perform. A fixed 4-byte header cannot.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: malformed input is REFUSED, never
// "handled leniently". Every rejection is a typed reason, never a throw with a
// string, so the caller can decide between dropping the frame and dropping the
// connection without parsing an error message.

/** Wire framing version. Bumped only for a breaking change to THIS header. */
export const FRAMING_VERSION = 1;

/** Bytes before the payload: 1 version + 4 length. */
export const HEADER_BYTES = 5;

/**
 * Hard ceiling on a single frame, independent of negotiation.
 *
 * Derived from the current system rather than picked: the server already caps a
 * socket frame at 2 MB (internal/realtime/server.go) and an HTTP body at 2 MB
 * (internal/httpx), and the largest legitimate application payload is a message
 * content field capped at 1,000,000 runes. A negotiated max may be LOWER than
 * this; it may never be higher.
 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Smallest frame that could carry anything. A zero-length payload is legal
 * (a bare Ping serializes to nothing in proto3), so the floor is the header.
 */
export const MIN_FRAME_BYTES = HEADER_BYTES;

/** Why a frame was refused. Typed so callers branch on a value, not a string. */
export type FrameError =
  | 'INCOMPLETE'          // fewer bytes than the header, or than length claims
  | 'BAD_VERSION'         // framing version we do not speak
  | 'LENGTH_OVER_MAX'     // declared length exceeds the configured ceiling
  | 'LENGTH_OVERFLOW'     // declared length is not a usable number
  | 'TRAILING_BYTES';     // buffer contained more than the frame it declared

/**
 * Deliberately ONE interface with optional fields, not a discriminated union.
 *
 * tsconfig.json sets `strict: false` and `strictNullChecks: false` for this
 * project. Discriminated-union narrowing REQUIRES strictNullChecks — without it
 * `if (!r.ok) { r.error }` does not narrow and fails to compile. A union here
 * would look cleaner and would not build.
 *
 * So: check `ok` first, then read the fields that belong to that outcome. Do
 * not "tidy" this back into `DecodeOk | DecodeErr` unless the project turns
 * strictNullChecks on, which is a much larger change.
 */
export interface DecodeResult {
  ok: boolean;
  /** Present when ok. */
  version?: number;
  /** Present when ok. A VIEW into the input buffer, never a copy. */
  payload?: Uint8Array;
  /** Present when ok — bytes consumed, so a stream reader can advance. */
  consumed?: number;
  /** Present when !ok. */
  error?: FrameError;
  /** Present when !ok — human detail for logs, never for control flow. */
  detail?: string;
}

/**
 * Encode one frame.
 *
 * Throws only for a programming error on OUR side (an oversized payload we
 * produced). Remote input never reaches this function.
 */
export function encodeFrame(payload: Uint8Array, maxBytes: number = MAX_FRAME_BYTES): Uint8Array {
  const cap = Math.min(maxBytes, MAX_FRAME_BYTES);
  if (payload.length > cap) {
    throw new Error(`ccwire: refusing to encode ${payload.length} bytes, cap is ${cap}`);
  }
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = FRAMING_VERSION;
  // u32 big-endian, written by hand so this file has no DataView/endianness
  // surprises across Hermes, Node and a Go reader.
  out[1] = (payload.length >>> 24) & 0xff;
  out[2] = (payload.length >>> 16) & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out[4] = payload.length & 0xff;
  out.set(payload, HEADER_BYTES);
  return out;
}

/**
 * Decode one frame from the head of `buf`.
 *
 * NEVER ALLOCATES BEFORE VALIDATING. The declared length is checked against the
 * ceiling AND against how many bytes are actually present, in that order,
 * before a payload view is produced. `payload` is a subarray — a view, not a
 * copy — so a 2 MB frame does not become 4 MB of resident memory.
 *
 * `strict` refuses a buffer carrying more than the single frame it declared;
 * a stream reader wants that off, a message-oriented transport wants it on
 * (a WebSocket message carrying two frames is a framing bug, not a feature).
 */
export function decodeFrame(
  buf: Uint8Array,
  opts: { maxBytes?: number; strict?: boolean } = {},
): DecodeResult {
  const cap = Math.min(opts.maxBytes ?? MAX_FRAME_BYTES, MAX_FRAME_BYTES);

  if (buf.length < HEADER_BYTES) {
    return { ok: false, error: 'INCOMPLETE', detail: `${buf.length} < ${HEADER_BYTES}` };
  }

  const version = buf[0];
  if (version !== FRAMING_VERSION) {
    // Not a downgrade path: an unknown framing version is refused outright.
    // Capability negotiation happens INSIDE a frame we can already parse.
    return { ok: false, error: 'BAD_VERSION', detail: `got ${version}, speak ${FRAMING_VERSION}` };
  }

  // Reassemble as an UNSIGNED 32-bit value. `<<` is signed in JS, so a length
  // with the top bit set would come back negative and sail past a `> cap`
  // check — hence the >>> 0.
  const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;

  if (!Number.isSafeInteger(len)) {
    return { ok: false, error: 'LENGTH_OVERFLOW', detail: String(len) };
  }
  if (len > cap) {
    // THE CHECK THIS FILE EXISTS FOR: refused before any allocation.
    return { ok: false, error: 'LENGTH_OVER_MAX', detail: `${len} > ${cap}` };
  }

  const end = HEADER_BYTES + len;
  if (buf.length < end) {
    return { ok: false, error: 'INCOMPLETE', detail: `need ${end}, have ${buf.length}` };
  }
  if (opts.strict && buf.length > end) {
    return { ok: false, error: 'TRAILING_BYTES', detail: `${buf.length - end} extra` };
  }

  return { ok: true, version, payload: buf.subarray(HEADER_BYTES, end), consumed: end };
}

/**
 * Pull as many whole frames as a stream buffer currently holds.
 *
 * Returns the frames plus the number of bytes consumed, so the caller keeps the
 * remainder for the next read. A malformed frame stops the scan and is reported
 * — the caller decides whether to drop the connection, because resynchronising
 * a length-prefixed stream after a bad length is not possible: the next byte
 * offset is unknowable.
 */
export function decodeStream(
  buf: Uint8Array,
  opts: { maxBytes?: number } = {},
): { frames: Uint8Array[]; consumed: number; error?: FrameError } {
  const frames: Uint8Array[] = [];
  let off = 0;
  for (;;) {
    const r = decodeFrame(buf.subarray(off), { maxBytes: opts.maxBytes });
    if (!r.ok) {
      // INCOMPLETE is not an error at stream level — it means "await more bytes".
      return r.error === 'INCOMPLETE'
        ? { frames, consumed: off }
        : { frames, consumed: off, error: r.error };
    }
    frames.push(r.payload);
    off += r.consumed;
    if (off >= buf.length) return { frames, consumed: off };
  }
}

export default {};
