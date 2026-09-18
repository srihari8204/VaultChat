// Run: npx tsx lib/ccwire/joinEmit.selftest.ts
//
// join_chat off app_event/payload_json and onto the typed body the server has
// always served: Subscribe (32) with SCOPE_KIND_CHAT.
//
// BOTH PATHS ARE ASSERTED, and the second one is the important one: a client
// that does not see typed_app_bodies in the ServerHello must still emit the
// app_event (100) frame it emits today, BYTE FOR BYTE. Shipped clients never
// stop working; the typed body is an addition negotiated by capability bit 9,
// not a replacement.
import assert from 'node:assert/strict';
import { CCWireEventSocket } from './eventsSocket';
import { __resetCCWireForTest, ccwireClient } from './transport';
import { encodeFrame, decodeStream } from './frame';
import { encodeFrameMessage, decodeFrameMessage, type Frame, type AppEvent } from './codec';

// ─── THE CROSS-LANGUAGE BYTE PIN ─────────────────────────────────────────────
//
// The same two hex strings are asserted in Go by
// vaultchat-backend-go/internal/realtime/ccwire_join_parity_test.go
// (ccwireJoinScopeGoldenWire / ccwireJoinFrameGoldenWire). Semantic agreement
// alone would let the two sides drift onto different field numbers and both
// still pass; the bytes are what make them one contract.
//
// Subscribe body, chat "c1": 08 01 (field 1 varint, SCOPE_KIND_CHAT = 1)
//                            12 02 6331 (field 2, 2 bytes, "c1")
const SCOPE_BODY_PIN = '080112026331';
// The whole Frame with request_id "r": 0a0172 (1, "r") 1001 (traffic_class
// CONTROL) 1801 (stream CONTROL) 820206 (field 32, wire 2, 6 bytes) + the body.
// seq and depends_on are proto3 defaults and are not written — a join carries
// no position and must not appear to.
const JOIN_FRAME_PIN = '0a017210011801820206' + SCOPE_BODY_PIN;
// join_call is the same body, one ScopeKind along: SCOPE_KIND_CALL = 3.
// Pinned in Go by ccwire_call_parity_test.go (ccwireCallScopeGoldenWire /
// ccwireCallFrameGoldenWire).
const CALL_SCOPE_BODY_PIN = '080312026331';
const CALL_FRAME_PIN = '0a017210011801820206' + CALL_SCOPE_BODY_PIN;

class Wire {
  static all: Wire[] = [];
  onopen: any; onmessage: any; onclose: any;
  closed = false;
  sent: Uint8Array[] = [];
  constructor() { Wire.all.push(this); }
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close() { this.closed = true; }
  /** typed: append capability field 9 (72,1) to the ServerHello blob. */
  hello(typed: boolean) {
    this.onopen({});
    const encoded = encodeFrameMessage({ traffic_class: 1, stream: 1, body_field: 17,
      raw: Uint8Array.from([8, 1, 26, typed ? 4 : 2, 64, 1, ...(typed ? [72, 1] : []), 64, 1]) });
    assert.ok(encoded.ok, encoded.detail);
    this.onmessage({ data: encodeFrame(encoded.bytes!) });
  }
}
const timers = new Map<number, { fn: () => void; ms: number }>();
let timerId = 0;
const options = { serverUrl: 'https://example.invalid', getToken: () => 'token', WebSocketImpl: Wire,
  setTimeoutImpl: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeoutImpl: (id: number) => { timers.delete(id); } };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function decodeLast(wire: Wire): Frame {
  const stream = decodeStream(wire.sent.at(-1)!);
  assert.equal(stream.error, undefined);
  const decoded = decodeFrameMessage(stream.frames![0]);
  assert.ok(decoded.ok, decoded.detail);
  return decoded.frame!;
}

async function session(typed: boolean) {
  __resetCCWireForTest();
  const socket = new CCWireEventSocket(options, async () => 'terminal');
  const ready = socket.waitUntilReady();
  await tick();
  const wire = Wire.all.at(-1)!;
  wire.hello(typed);
  await ready;
  return { socket, wire };
}

async function main() {
  // ── a client on a typed server sends Subscribe (32) ──────────────────────
  {
    const { socket, wire } = await session(true);
    socket.emit('join_chat', { chatId: 'c1' });
    const frame = decodeLast(wire);
    assert.equal(frame.body_field, 32, 'a typed server must receive Subscribe, not app_event');
    // Body 32 has no reader on this side by design (see writeScope in codec.ts),
    // so it comes back as verbatim bytes — which is exactly what the pin wants.
    assert.equal(hex(frame.raw!), SCOPE_BODY_PIN, 'Subscribe body drifted from the pin');

    // Same class and stream the app_event form used, and unsequenced: a join
    // must not appear to carry a position, because the server sequences only
    // what it SENDS (ccwire_seq.go) and nothing here may move a cursor.
    assert.equal(frame.traffic_class, 1);
    assert.equal(frame.stream, 1);
    assert.equal(frame.seq, '0');
    assert.equal(frame.depends_on, '0');

    // No chatId, no frame at all — never a Subscribe with an empty scope id,
    // which the server answers PAYLOAD_INVALID.
    let before = wire.sent.length;
    socket.emit('join_chat', {});
    assert.equal(wire.sent.length, before, 'a join without a chatId must not go on the wire');

    // Only join_chat moves. leave_chat still travels as app_event and still
    // deletes the same s.subs key server-side, so the pair composes.
    before = wire.sent.length;
    socket.emit('leave_chat', { chatId: 'c1' });
    assert.equal(wire.sent.length, before + 1);
    assert.equal(decodeLast(wire).body_field, 100, 'leave_chat stays on app_event');
    assert.equal((decodeLast(wire).value as AppEvent).event, 'leave_chat');

    // channel_join is deliberately NOT migrated: same wire shape, different
    // policy (ungated on both transports).
    socket.emit('channel_join', { channelId: 'ch1' });
    assert.equal(decodeLast(wire).body_field, 100, 'channel_join stays on app_event');

    // THE BYTE PIN, from the same encoder the client uses, with a fixed
    // request_id so the string is stable across sessions.
    const pinned = encodeFrameMessage({ request_id: 'r', traffic_class: 1, stream: 1,
      body_field: 32, value: { kind: 1, id: 'c1' } });
    assert.ok(pinned.ok, pinned.detail);
    assert.equal(hex(pinned.bytes!), JOIN_FRAME_PIN, 'the Subscribe frame drifted from the Go pin');

    // ── join_call takes the same door, kind 3 ──────────────────────────────
    socket.emit('join_call', { chatId: 'c1' });
    const call = decodeLast(wire);
    assert.equal(call.body_field, 32, 'a typed server must receive Subscribe for join_call');
    assert.equal(hex(call.raw!), CALL_SCOPE_BODY_PIN, 'the CALL scope body drifted from the pin');
    assert.equal(call.traffic_class, 1);
    assert.equal(call.stream, 1);
    assert.equal(call.seq, '0');

    // leave_call stays on app_event, like leave_chat: handlers.go's leave_call
    // emits call_peer_left and deletes the same s.subs key the typed join set.
    socket.emit('leave_call', { chatId: 'c1' });
    assert.equal(decodeLast(wire).body_field, 100, 'leave_call stays on app_event');
    assert.equal((decodeLast(wire).value as AppEvent).event, 'leave_call');

    const pinnedCall = encodeFrameMessage({ request_id: 'r', traffic_class: 1, stream: 1,
      body_field: 32, value: { kind: 3, id: 'c1' } });
    assert.ok(pinnedCall.ok, pinnedCall.detail);
    assert.equal(hex(pinnedCall.bytes!), CALL_FRAME_PIN, 'the CALL Subscribe frame drifted from the Go pin');
    socket.disconnect();
  }

  // ── a client on a server without the bit: byte-identical app_event ───────
  {
    const { socket, wire } = await session(false);
    socket.emit('join_chat', { chatId: 'c1' });
    const bytes = wire.sent.at(-1)!;
    const frame = decodeLast(wire);
    assert.equal(frame.body_field, 100, 'a server without typed_app_bodies must still get app_event');
    assert.equal((frame.value as AppEvent).event, 'join_chat');

    // BYTE-IDENTICAL to what the pre-migration build emitted: same request_id
    // (the only per-session part), class 1, stream 1, body 100, JSON payload.
    const expected = encodeFrameMessage({ request_id: frame.request_id, traffic_class: 1, stream: 1,
      body_field: 100,
      value: { event: 'join_chat', payload_json: new TextEncoder().encode(JSON.stringify({ chatId: 'c1' })) } });
    assert.ok(expected.ok, expected.detail);
    assert.deepEqual(Array.from(bytes), Array.from(encodeFrame(expected.bytes!)),
      'the fallback frame changed — an already-shipped client would see different bytes');

    // join_call falls back the same way, byte for byte.
    socket.emit('join_call', { chatId: 'c1' });
    const callBytes = wire.sent.at(-1)!;
    const callFrame = decodeLast(wire);
    assert.equal(callFrame.body_field, 100, 'a server without typed_app_bodies must still get app_event');
    assert.equal((callFrame.value as AppEvent).event, 'join_call');
    const expectedCall = encodeFrameMessage({ request_id: callFrame.request_id, traffic_class: 1, stream: 1,
      body_field: 100,
      value: { event: 'join_call', payload_json: new TextEncoder().encode(JSON.stringify({ chatId: 'c1' })) } });
    assert.ok(expectedCall.ok, expectedCall.detail);
    assert.deepEqual(Array.from(callBytes), Array.from(encodeFrame(expectedCall.bytes!)),
      'the join_call fallback frame changed — a shipped client would see different bytes');
    socket.disconnect();
  }

  // ── fail safe: an absent bit is not a present one ────────────────────────
  {
    const { socket, wire } = await session(true);
    (ccwireClient() as any).serverHello.typedAppBodies = undefined;
    socket.emit('join_chat', { chatId: 'c1' });
    assert.equal(decodeLast(wire).body_field, 100,
      'an absent typed_app_bodies bit must fall back to app_event');
    socket.disconnect();
  }

  __resetCCWireForTest();
  assert.equal(timers.size, 0, 'no timer survives teardown');
  console.log('CC-Wire join emit: Subscribe (32) when advertised, byte-identical app_event otherwise, pinned to the Go bytes');
}
main().catch((error) => { __resetCCWireForTest(); console.error(error); process.exitCode = 1; });
