// lib/ccwire/codec.selftest.ts — run: npx tsx lib/ccwire/codec.selftest.ts
//
// Conformance + hostile-input tests for the ccwire.v1.Frame codec.
//
// frame.selftest.ts covers the layer that decides whether a peer can make us
// ALLOCATE. This file covers the layer that decides whether a peer can make us
// MISUNDERSTAND: an unknown field that gets dropped on a relay, an enum value a
// build has never heard of, a oneof with two bodies so that two implementations
// disagree about which one was sent, a sequence number one past 2^53, and the
// EPHEMERAL invariant that keeps a key update out of the droppable class.
//
// Every hostile case below is built from raw bytes, not from the encoder — an
// encoder cannot produce most of them, which is exactly why they must be tested.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  encodeFrameMessage, decodeFrameMessage,
  LIMITS, BODY_NAMES, EPHEMERAL_BODIES, ERROR_CODE, TRAFFIC_CLASS_EPHEMERAL,
  type Frame, type FrameDecodeResult, type FrameEncodeResult,
  type CryptoControl, type GeoRelay, type SubmitMessage, type TypingState,
  type ViewerState, type Fragment,
} from './codec';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Narrowing through a parameter is reliable under strictNullChecks:false;
 *  an inline ternary on the result is not. Same helper shape as frame.selftest. */
const why = (r: FrameDecodeResult | FrameEncodeResult): string =>
  (r.ok ? '' : `${r.error} ${r.detail ?? ''}`);

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// ── raw protobuf byte builders (hostile input is hand-assembled) ─────────────
const cat = (...xs: number[][]): number[] => [].concat(...xs as any);
function varint(n: number | bigint): number[] {
  let v = BigInt(n), out: number[] = [];
  while (v >= 128n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return out;
}
const T = (field: number, wire: number): number[] => varint(field * 8 + wire);
const VF = (field: number, n: number | bigint): number[] => [...T(field, 0), ...varint(n)];
const LF = (field: number, body: number[]): number[] => [...T(field, 2), ...varint(body.length), ...body];
const SF = (field: number, s: string): number[] => LF(field, [...new TextEncoder().encode(s)]);
const EPH = VF(2, TRAFFIC_CLASS_EPHEMERAL);
const CTRL = VF(2, 1);   // TRAFFIC_CLASS_CONTROL

const hex = (u: Uint8Array): string => Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');

console.log('\nCC-Wire v1 Frame codec\n');

// ─────────────────────────────────────────────────────────────────────────────
console.log('The schema is the spec — the codec must not drift from it:');
{
  const src = readFileSync(join(HERE, '..', '..', 'proto', 'ccwire', 'v1', 'envelope.proto'), 'utf8');
  const oneof = src.slice(src.indexOf('oneof body {'), src.indexOf('}', src.indexOf('oneof body {')));
  const fromProto: Record<number, string> = {};
  for (const m of oneof.matchAll(/^\s*\w+\s+(\w+)\s*=\s*(\d+);/gm)) fromProto[Number(m[2])] = m[1];
  const n = Object.keys(fromProto).length;
  check(`envelope.proto declares ${n} oneof bodies`, n === 27, `found ${n}`);
  const mismatched = Object.keys(fromProto).filter((k) => fromProto[k] !== BODY_NAMES[k]);
  check('every body field number in BODY_NAMES matches envelope.proto',
    mismatched.length === 0 && Object.keys(BODY_NAMES).length === n,
    mismatched.join() || `codec has ${Object.keys(BODY_NAMES).length}`);
  // The invariant is stated in prose in the .proto; assert the set we enforce.
  check('EPHEMERAL_BODIES is exactly typing_state/viewer_state/geo_relay',
    [...EPHEMERAL_BODIES].map((f) => BODY_NAMES[f]).sort().join() ===
    'geo_relay,typing_state,viewer_state');
}
{
  const src = readFileSync(join(HERE, '..', '..', 'proto', 'ccwire', 'v1', 'capabilities.proto'), 'utf8');
  // Each LIMITS number is copied from a trailing comment on a Limits field.
  const pairs: [string, number][] = [
    ['max_frame_bytes', LIMITS.max_frame_bytes],
    ['max_opaque_bytes', LIMITS.max_opaque_bytes],
    ['max_message_body_bytes', LIMITS.max_message_body_bytes],
    ['max_nesting_depth', LIMITS.max_nesting_depth],
    ['max_repeated_elements', LIMITS.max_repeated_elements],
    ['max_string_field_bytes', LIMITS.max_string_field_bytes],
    ['max_fragments_per_message', LIMITS.max_fragments_per_message],
  ];
  let bad = '';
  for (const [name, want] of pairs) {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\d+[^/]*//\\s*(\\d+)`));
    if (!m || Number(m[1]) !== want) bad += `${name}(${m ? m[1] : 'absent'}!=${want}) `;
  }
  check('every LIMITS value matches capabilities.proto', !bad, bad);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nRound trip, one per typed body:');
function roundTrip(name: string, f: Frame, inspect: (g: Frame) => boolean): void {
  const e = encodeFrameMessage(f);
  if (!e.ok) { check(name, false, why(e)); return; }
  const d = decodeFrameMessage(e.bytes);
  if (!d.ok) { check(name, false, why(d)); return; }
  const again = encodeFrameMessage(d.frame);
  check(name, inspect(d.frame) && again.ok && hex(again.bytes) === hex(e.bytes),
    again.ok ? 'decoded value differs' : why(again));
}
roundTrip('typing_state', {
  traffic_class: TRAFFIC_CLASS_EPHEMERAL, stream: 5, request_id: 'req-1',
  body_field: 81, value: { chat_id: 'c1', typing: true, sender_uid: 'u1' } as TypingState,
}, (g) => g.body === 'typing_state' && (g.value as TypingState).typing === true
      && (g.value as TypingState).chat_id === 'c1' && g.request_id === 'req-1');

roundTrip('viewer_state', {
  traffic_class: TRAFFIC_CLASS_EPHEMERAL, stream: 5,
  body_field: 82, value: { chat_id: 'c1', activity: 2, leaving: false, resync: true } as ViewerState,
}, (g) => (g.value as ViewerState).activity === 2
      && (g.value as ViewerState).activity_name === 'VIEWER_ACTIVITY_TYPING'
      && (g.value as ViewerState).resync === true);

roundTrip('geo_relay', {
  traffic_class: TRAFFIC_CLASS_EPHEMERAL, stream: 5,
  body_field: 84, value: {
    scope_kind: 1, scope_id: 'chat-9', subject_id: 'trip-3',
    sealed: Uint8Array.from([9, 8, 7]), ended: true, until_ms: '-1', sender_uid: 'u2',
  } as GeoRelay,
}, (g) => (g.value as GeoRelay).ended === true
      // int64 is SIGNED: -1 on the wire is ten 0xff bytes, and must come back -1,
      // not 18446744073709551615.
      && (g.value as GeoRelay).until_ms === '-1'
      && (g.value as GeoRelay).scope_kind_name === 'SCOPE_KIND_CHAT');

roundTrip('crypto_control', {
  traffic_class: 1, stream: 1, seq: '7',
  body_field: 98, value: {
    kind: 1, chat_id: 'c1', to_uid: 'u3', payload: Uint8Array.from([1, 2, 3, 4]),
    epoch: '42', payload_format: 'vc-x3dh-1',
  } as CryptoControl,
}, (g) => (g.value as CryptoControl).kind_name === 'CRYPTO_CONTROL_KIND_REKEY'
      && (g.value as CryptoControl).epoch === '42'
      && (g.value as CryptoControl).payload.length === 4);

roundTrip('submit_message (Frame > SubmitMessage > Envelope > PublicMeta)', {
  traffic_class: 2, stream: 2, seq: '1', depends_on: '3',
  body_field: 48, value: {
    envelope: {
      chat_id: 'c1', client_msg_id: 'idem-1', server_ts_ms: '1757808000000',
      msg_class: 1, causal_epoch: '5',
      public_meta: { attachment_id: 'a1', silent: true, option_count: 4,
        mention_user_ids: ['u1', 'u2', 'u3'], game: 'ludo', room: 'r1' },
    },
    sealed: Uint8Array.from([0, 1, 2, 3, 4, 5]),
  } as SubmitMessage,
}, (g) => {
  const s = g.value as SubmitMessage;
  return s.envelope.public_meta.mention_user_ids.length === 3
    && s.envelope.public_meta.mention_user_ids[2] === 'u3'
    && s.envelope.msg_class_name === 'MESSAGE_CLASS_NORMAL'
    && s.envelope.server_ts_ms === '1757808000000'
    && s.sealed.length === 6;
});

roundTrip('fragment', {
  traffic_class: 4, stream: 4,
  body_field: 112, value: {
    fragment_id: 'F1', index: 2, total: 16, total_bytes: '1048576',
    chunk: Uint8Array.from([7, 7, 7]), last: false,
  } as Fragment,
}, (g) => (g.value as Fragment).total === 16 && (g.value as Fragment).total_bytes === '1048576');

{
  // A body this build does not type must survive VERBATIM, not be dropped and
  // not be guessed at. This is what keeps an older client from silently
  // destroying a newer one's traffic on any relay path.
  const raw = Uint8Array.from(cat(SF(1, 'msg-77'), VF(2, 99)));
  const e = encodeFrameMessage({ traffic_class: 1, stream: 1, body_field: 22, raw });
  const d = e.ok ? decodeFrameMessage(e.bytes) : null;
  check('an UNIMPLEMENTED body (ack) round-trips as opaque bytes',
    !!d && d.ok && d.frame.body === 'ack' && d.frame.value === undefined
      && hex(d.frame.raw) === hex(raw), d ? why(d) : why(e));
}
{
  // proto3 serialises an empty message to nothing; the body must still be
  // present, or "which body was set" is lost.
  const e = encodeFrameMessage({ traffic_class: 1, stream: 1, body_field: 19 });
  const d = e.ok ? decodeFrameMessage(e.bytes) : null;
  check('a zero-length body (bare Ping) keeps its identity', !!d && d.ok && d.frame.body === 'ping');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n64-bit fields are strings, because a double is not a uint64:');
{
  const past = '9007199254740993';            // 2^53 + 1
  check('...and 2^53+1 is genuinely unrepresentable as a double',
    String(Number(past)) === '9007199254740992');
  const e = encodeFrameMessage({ traffic_class: 1, stream: 1, seq: past, depends_on: past });
  const d = e.ok ? decodeFrameMessage(e.bytes) : null;
  check('seq above 2^53 survives a round trip EXACTLY',
    !!d && d.ok && d.frame.seq === past, d ? `${d.ok ? d.frame.seq : why(d)}` : why(e));
  check('depends_on above 2^53 survives a round trip EXACTLY',
    !!d && d.ok && d.frame.depends_on === past);
}
{
  const max = '18446744073709551615';         // 2^64 - 1
  const e = encodeFrameMessage({ traffic_class: 1, stream: 1, seq: max });
  const d = e.ok ? decodeFrameMessage(e.bytes) : null;
  check('uint64 max round-trips exactly', !!d && d.ok && d.frame.seq === max,
    d && d.ok ? d.frame.seq : '');
  check('...and never became a number on the way through',
    !!d && d.ok && typeof d.frame.seq === 'string');
}
{
  // Raw bytes, not our own encoder: the value a hostile peer would send.
  const bytes = Uint8Array.from(cat(CTRL, VF(4, 9007199254740993n)));
  const d = decodeFrameMessage(bytes);
  check('a 2^53+1 seq read straight off the wire is exact',
    d.ok && d.frame.seq === '9007199254740993', why(d));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nUnknown fields are PRESERVED (never dropped, never rejected):');
{
  const unknownTop = SF(200, 'from-a-newer-build');
  const bytes = Uint8Array.from(cat(CTRL, VF(3, 1), unknownTop, VF(4, 5)));
  const d = decodeFrameMessage(bytes);
  check('an unknown top-level field decodes without rejecting the frame', d.ok, why(d));
  check('...and is retained verbatim', d.ok && d.frame.unknown.length === 1
    && hex(d.frame.unknown[0]) === hex(Uint8Array.from(unknownTop)));
  const e = d.ok ? encodeFrameMessage(d.frame) : null;
  check('...and re-encoding puts it back on the wire',
    !!e && e.ok && hex(e.bytes).includes(hex(Uint8Array.from(unknownTop))), e ? why(e) : '');
  const again = e && e.ok ? decodeFrameMessage(e.bytes) : null;
  check('...and it survives a SECOND round trip (a relay cannot erase it)',
    !!again && again.ok && again.frame.unknown.length === 1);
}
{
  // Unknown fields inside a nested message must survive too, or the guarantee
  // only holds for the outermost hop.
  const pm = cat(SF(1, 'a1'), SF(77, 'future-meta'));
  const env = LF(7, pm);
  const sub = LF(1, env);
  const bytes = Uint8Array.from(cat(VF(2, 2), LF(48, sub)));
  const d = decodeFrameMessage(bytes);
  const meta = d.ok ? (d.frame.value as SubmitMessage).envelope.public_meta : null;
  check('an unknown field three levels down is retained', !!meta && meta.unknown.length === 1, why(d));
  const e = d.ok ? encodeFrameMessage(d.frame) : null;
  check('...and re-encodes byte-identically', !!e && e.ok && hex(e.bytes) === hex(bytes),
    e && e.ok ? hex(e.bytes) : why(e));
}
{
  // A nesting bomb hiding inside an unknown field costs nothing: unknown fields
  // are copied, never walked.
  let inner = SF(1, 'x');
  for (let i = 0; i < 200; i++) inner = LF(1, inner);
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, LF(201, inner))));
  check('200-deep nesting inside an UNKNOWN field is copied, not walked',
    d.ok && d.frame.unknown.length === 1, why(d));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nUnknown enum values keep their number and surface as *_UNSPECIFIED:');
{
  const bytes = Uint8Array.from(cat(VF(2, 99), VF(3, 200)));
  const d = decodeFrameMessage(bytes);
  check('an unknown TrafficClass is not rejected', d.ok, why(d));
  check('...its number is retained', d.ok && d.frame.traffic_class === 99);
  check('...and it surfaces as TRAFFIC_CLASS_UNSPECIFIED to application code',
    d.ok && d.frame.traffic_class_name === 'TRAFFIC_CLASS_UNSPECIFIED');
  check('...an unknown StreamId behaves the same way',
    d.ok && d.frame.stream === 200 && d.frame.stream_name === 'STREAM_ID_UNSPECIFIED');
  const e = d.ok ? encodeFrameMessage(d.frame) : null;
  check('...and re-encoding writes 99 back, not 0',
    !!e && e.ok && hex(e.bytes) === hex(bytes), e ? why(e) : '');
}
{
  const body = LF(98, cat(VF(1, 250)));    // CryptoControlKind = 250
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, body)));
  const cc = d.ok ? d.frame.value as CryptoControl : null;
  check('an unknown enum in a NESTED body behaves identically',
    !!cc && cc.kind === 250 && cc.kind_name === 'CRYPTO_CONTROL_KIND_UNSPECIFIED', why(d));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nDuplicate fields:');
{
  // proto3's rule is last-wins for a scalar. Matching it is not laxity — the Go
  // side will do this, and doing anything else here is the parser differential.
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, SF(1, 'first'), SF(1, 'second'))));
  check('a duplicate scalar is last-wins, per proto3', d.ok && d.frame.request_id === 'second', why(d));
  const d2 = decodeFrameMessage(Uint8Array.from(cat(CTRL, VF(4, 1), VF(4, 9007199254740993n))));
  check('...including a 64-bit scalar', d2.ok && d2.frame.seq === '9007199254740993');
}
{
  // A oneof with two bodies is a smuggling primitive, not a duplicate scalar:
  // if one implementation takes the first and another takes the last, both call
  // the frame valid and they disagree about what it said.
  const two = cat(CTRL, LF(81, SF(1, 'c1')), LF(98, VF(1, 1)));
  const d = decodeFrameMessage(Uint8Array.from(two));
  check('TWO oneof bodies in one frame are REFUSED, not last-wins',
    !d.ok && d.error === 'DUPLICATE_BODY', why(d) || 'accepted');
  check('...with ERROR_CODE_PROTOCOL_VIOLATION (11)', !d.ok && d.errorCode === 11);
  const same = decodeFrameMessage(Uint8Array.from(cat(CTRL, LF(81, SF(1, 'a')), LF(81, SF(1, 'b')))));
  check('...even when it is the SAME body twice', !same.ok && same.error === 'DUPLICATE_BODY');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nBounds — every one of them refuses, none of them truncate:');
{
  const ok = 'a'.repeat(LIMITS.max_string_field_bytes);
  const over = 'a'.repeat(LIMITS.max_string_field_bytes + 1);
  check(`a string at the cap (${LIMITS.max_string_field_bytes} B) is accepted`,
    decodeFrameMessage(Uint8Array.from(cat(CTRL, SF(1, ok)))).ok);
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, SF(1, over))));
  check('one byte over the cap is refused', !d.ok && d.error === 'STRING_TOO_LONG', why(d) || 'accepted');
}
{
  // The cap is in BYTES and is checked BEFORE the UTF-8 decode. 2048 emoji are
  // 2048 JS chars but 8192 bytes — a cap applied to the decoded string would
  // let 2x the budget through the gate that exists to hold it.
  const emoji = '😀'.repeat(2048);           // 8192 bytes, 4096 UTF-16 units
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, SF(1, emoji))));
  check('the string cap is measured in BYTES, not JS characters',
    !d.ok && d.error === 'STRING_TOO_LONG', why(d) || 'accepted 8192 bytes');
}
{
  const bad = cat(CTRL, T(1, 2), varint(3), [0xff, 0xfe, 0xfd]);
  const d = decodeFrameMessage(Uint8Array.from(bad));
  check('invalid UTF-8 in a string is refused, not replaced with U+FFFD',
    !d.ok && d.error === 'INVALID_UTF8', why(d) || 'accepted');
}
{
  const ids: number[] = [];
  for (let i = 0; i <= LIMITS.max_repeated_elements; i++) ids.push(...SF(11, 'u'));
  const d = decodeFrameMessage(Uint8Array.from(cat(VF(2, 2), LF(48, LF(1, LF(7, ids))))));
  check(`a repeated field over max_repeated_elements (${LIMITS.max_repeated_elements}) is refused`,
    !d.ok && d.error === 'TOO_MANY_ELEMENTS', why(d) || 'accepted');
}
{
  const payload = new Array(LIMITS.max_opaque_bytes + 1).fill(0);
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, LF(98, LF(4, payload)))),
    { maxBytes: 2 * 1024 * 1024 });
  check(`an opaque payload over max_opaque_bytes (${LIMITS.max_opaque_bytes}) is refused`,
    !d.ok && d.error === 'BYTES_TOO_LONG', why(d) || 'accepted');
}
{
  const d = decodeFrameMessage(new Uint8Array(LIMITS.max_frame_bytes + 1));
  check(`a payload over the negotiated max_frame_bytes (${LIMITS.max_frame_bytes}) is refused first`,
    !d.ok && d.error === 'SIZE_OVER_MAX' && d.errorCode === 7, why(d) || 'accepted');
}
{
  // Negotiation may only tighten. A peer that proposes a LARGER limit than this
  // build compiled with does not get it: a negotiation is not an authorization.
  const big = Uint8Array.from(cat(CTRL, SF(1, 'a'.repeat(2000))));
  check('a negotiated limit can tighten a bound',
    !decodeFrameMessage(big, { limits: { max_string_field_bytes: 512 } }).ok);
  check('...but can never loosen one',
    !decodeFrameMessage(Uint8Array.from(cat(CTRL, SF(1, 'a'.repeat(5000)))),
      { limits: { max_string_field_bytes: 999999 } }).ok);
}
{
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, LF(112, VF(3, 17)))));
  check(`Fragment.total over max_fragments_per_message (${LIMITS.max_fragments_per_message}) is refused`,
    !d.ok && d.error === 'TOO_MANY_ELEMENTS', why(d) || 'accepted');
  const d2 = decodeFrameMessage(Uint8Array.from(cat(CTRL, LF(112, VF(4, 1048577)))));
  check('Fragment.total_bytes is checked against max_message_body_bytes BEFORE any alloc',
    !d2.ok && d2.error === 'BYTES_TOO_LONG', why(d2) || 'accepted');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\nNesting is bounded at max_nesting_depth (${LIMITS.max_nesting_depth}):`);
{
  // Submessage nesting: Frame(d) > SubmitMessage(d+1) > Envelope(d+2) >
  // PublicMeta(d+3). At depth 0 that is 3 and always fits; the budget is spent
  // by the fragment-reassembly depth the frame arrived at.
  const deep = Uint8Array.from(cat(VF(2, 2), LF(48, LF(1, LF(7, SF(1, 'a1'))))));
  check('the schema max nest (PublicMeta at 3) is accepted at depth 0',
    decodeFrameMessage(deep).ok);
  check('...accepted at depth 3 (3 + 3 = 6, the limit exactly)',
    decodeFrameMessage(deep, { depth: 3 }).ok, why(decodeFrameMessage(deep, { depth: 3 })));
  const d = decodeFrameMessage(deep, { depth: 4 });
  check('...and REFUSED at depth 4 (PublicMeta would land at 7)',
    !d.ok && d.error === 'NESTING_TOO_DEEP', why(d) || 'accepted');
}
{
  // Fragment-in-Fragment: each reassembly re-enters the decoder one level down.
  // Without a shared budget this recurses until the stack gives out.
  const frameOf = (chunk: Uint8Array): Uint8Array => {
    const e = encodeFrameMessage({
      traffic_class: 4, stream: 4, body_field: 112,
      value: { fragment_id: 'F', index: 0, total: 1, last: true, chunk } as Fragment,
    });
    return e.ok ? e.bytes : new Uint8Array(0);
  };
  let bomb = frameOf(Uint8Array.from([1]));
  for (let i = 0; i < 9; i++) bomb = frameOf(bomb);

  let depth = 0, last: FrameDecodeResult = null;
  for (let cur = bomb; ;) {
    last = decodeFrameMessage(cur, { depth, maxBytes: 2 * 1024 * 1024 });
    if (!last.ok || last.frame.body !== 'fragment') break;
    cur = (last.frame.value as Fragment).chunk;
    depth++;
  }
  check('a Fragment-in-Fragment bomb is stopped by the shared depth budget',
    !last.ok && last.error === 'NESTING_TOO_DEEP', why(last) || 'ran to completion');
  check(`...after at most max_nesting_depth levels (stopped at ${depth})`,
    depth <= LIMITS.max_nesting_depth);
}
{
  const d = decodeFrameMessage(new Uint8Array(0), { depth: 7 });
  check('a frame handed in already past the limit is refused before parsing',
    !d.ok && d.error === 'NESTING_TOO_DEEP', why(d) || 'accepted');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTHE EPHEMERAL INVARIANT — a key update is never droppable:');
{
  for (const field of [81, 82, 84]) {
    const d = decodeFrameMessage(Uint8Array.from(cat(EPH, LF(field, []))));
    if (!d.ok) { check(`EPHEMERAL may carry ${BODY_NAMES[field]}`, false, why(d)); }
  }
  check('EPHEMERAL may carry typing_state, viewer_state and geo_relay', true);
}
{
  // The one the spec names explicitly. Refused, with the code the spec names —
  // never "handled leniently", never downgraded to a different class on the fly.
  const bytes = Uint8Array.from(cat(EPH, LF(98, cat(VF(1, 1), SF(2, 'c1')))));
  const d = decodeFrameMessage(bytes);
  check('a crypto_control in an EPHEMERAL frame is REFUSED',
    !d.ok && d.error === 'PROTOCOL_VIOLATION', why(d) || 'ACCEPTED — key update is droppable!');
  check('...with ERROR_CODE_PROTOCOL_VIOLATION (11), as envelope.proto requires',
    !d.ok && d.errorCode === 11 && d.errorCode === ERROR_CODE.PROTOCOL_VIOLATION);
  check('...and no body is handed to the caller', !d.ok && d.frame === undefined);
}
{
  const d = decodeFrameMessage(Uint8Array.from(cat(EPH, LF(97, VF(1, 1)))));
  check('a device_event in an EPHEMERAL frame is refused the same way',
    !d.ok && d.error === 'PROTOCOL_VIOLATION', why(d) || 'accepted');
}
{
  // The rule is enforced on the FIELD NUMBER, so it covers all 27 bodies —
  // including the ones this build does not decode. A body added later cannot
  // sneak onto EPHEMERAL just because no one wrote a decoder for it yet.
  let leaked = '';
  for (const f of Object.keys(BODY_NAMES).map(Number)) {
    if (EPHEMERAL_BODIES.has(f)) continue;
    const d = decodeFrameMessage(Uint8Array.from(cat(EPH, LF(f, []))));
    if (d.ok) leaked += `${BODY_NAMES[f]} `;
  }
  check('ALL 24 non-ephemeral bodies are refused on EPHEMERAL, typed or not', !leaked, leaked);
}
{
  // "enforced at both encode and decode" — our own bug should fail here, where
  // there is a stack trace, not at the peer, where there are only bytes.
  const e = encodeFrameMessage({
    traffic_class: TRAFFIC_CLASS_EPHEMERAL, stream: 5,
    body_field: 98, value: { kind: 1, epoch: '1' } as CryptoControl,
  });
  check('ENCODING a crypto_control as EPHEMERAL is refused too',
    !e.ok && e.error === 'PROTOCOL_VIOLATION', why(e) || 'encoded it anyway');
}
{
  const d = decodeFrameMessage(Uint8Array.from(cat(VF(3, 1), SF(1, 'r'))));
  check('TRAFFIC_CLASS_UNSPECIFIED is refused — "never valid on the wire"',
    !d.ok && d.error === 'PROTOCOL_VIOLATION', why(d) || 'accepted class 0');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nMalformed wire input is refused, not "handled leniently":');
{
  const cases: [string, number[], string][] = [
    ['a truncated length-delimited field', cat(CTRL, T(1, 2), varint(50), [1, 2, 3]) as any, 'TRUNCATED'],
    ['a tag that runs off the end', [...CTRL, 0x80], 'TRUNCATED'],
    ['field number 0', [0x00, 0x01], 'FIELD_ZERO'],
    ['a proto2 group (wire type 3)', [...CTRL, ...T(9, 3)], 'BAD_WIRE_TYPE'],
    ['an over-long varint', [...CTRL, ...T(4, 0), 0x80, 0x80, 0x80, 0x80, 0x80,
      0x80, 0x80, 0x80, 0x80, 0x80, 0x01], 'VARINT_OVERFLOW'],
    ['a truncated fixed64', [...CTRL, ...T(9, 1), 1, 2, 3], 'TRUNCATED'],
  ];
  for (const [name, raw, want] of cases) {
    const d = decodeFrameMessage(Uint8Array.from(raw as any));
    check(name + ` → ${want}`, !d.ok && d.error === want, why(d) || 'accepted');
  }
}
{
  // A known field arriving with the wrong wire type is not a known field. It
  // must not be coerced; it goes to the unknown path or is refused, never
  // reinterpreted as the typed field it is impersonating.
  const d = decodeFrameMessage(Uint8Array.from(cat(CTRL, VF(1, 7))));   // request_id as varint
  check('a known field with the wrong wire type is not coerced',
    d.ok && d.frame.request_id === '' && d.frame.unknown.length === 1, why(d));
}

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all CC-Wire codec checks passed\n');
process.exit(failures ? 1 : 0);
