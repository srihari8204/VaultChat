// Run: npx tsx lib/ccwire/typingEmit.selftest.ts
//
// The EMIT half of the typing migration. transport.ts already decodes inbound
// body 81; this covers the gate in eventsSocket.emit: typed body 81 out only
// when the SERVER advertised typed_app_bodies, and byte-identical app_event
// (100) otherwise.
import assert from 'node:assert/strict';
import { CCWireEventSocket } from './eventsSocket';
import { __resetCCWireForTest } from './transport';
import { encodeFrame, decodeStream } from './frame';
import { encodeFrameMessage, decodeFrameMessage, type Frame, type AppEvent, type TypingState } from './codec';

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
  // ── typed server: typing becomes body 81 ─────────────────────────────────
  {
    const { socket, wire } = await session(true);
    socket.emit('typing_start', { chatId: 'room-7', uid: 'someone-else' });
    let frame = decodeLast(wire);
    assert.equal(frame.body_field, 81, 'a typed server must receive TypingState, not app_event');
    let t = frame.value as TypingState;
    assert.equal(t.chat_id, 'room-7');
    assert.equal(t.typing, true);
    // sender_uid is server-derived (ccwire_messages.go typing() uses s.d.uid,
    // and DecodeTyping never reads field 3). Sending one would be spoofable.
    assert.equal(t.sender_uid, '', 'the client must never assert a sender_uid');

    socket.emit('typing_stop', { chatId: 'room-7' });
    frame = decodeLast(wire);
    assert.equal(frame.body_field, 81);
    t = frame.value as TypingState;
    assert.equal(t.typing, false);
    assert.equal(t.chat_id, 'room-7');

    // EPHEMERAL/unsequenced: the frame carries no seq and no depends_on, and it
    // rides the same class/stream the app_event form used, so nothing about the
    // server's cursor bookkeeping (ccwire.go noteSentLocked, which only ever
    // reads the seq of frames the SERVER sent) can be moved by it.
    assert.equal(frame.seq, '0', 'a typing frame must be unsequenced');
    assert.equal(frame.depends_on, '0');
    assert.equal(frame.traffic_class, 1);
    assert.equal(frame.stream, 1);

    // Only typing changes here. join_chat also leaves the app_event path now
    // (body 32, lib/ccwire/joinEmit.selftest.ts owns that); everything else
    // stays on 100.
    const before = wire.sent.length;
    socket.emit('message_read', { chatId: 'room-7' });
    assert.equal(wire.sent.length, before + 1);
    assert.equal(decodeLast(wire).body_field, 100, 'only typing_*/join_chat leave the app_event path');
    socket.emit('new_message', { id: 1 });
    assert.equal(decodeLast(wire).body_field, 100);
    socket.disconnect();
  }

  // ── old server: byte-identical app_event ─────────────────────────────────
  {
    const { socket, wire } = await session(false);
    socket.emit('typing_start', { chatId: 'room-7', uid: 'me' });
    const bytes = wire.sent.at(-1)!;
    const frame = decodeLast(wire);
    assert.equal(frame.body_field, 100, 'a server without typed_app_bodies must still get app_event');
    assert.equal((frame.value as AppEvent).event, 'typing_start');

    // BYTE-IDENTICAL to what the pre-gate build emitted: the same request_id
    // (the only per-session part), class 1, stream 1, body 100, JSON payload.
    const expected = encodeFrameMessage({ request_id: frame.request_id, traffic_class: 1, stream: 1,
      body_field: 100,
      value: { event: 'typing_start', payload_json: new TextEncoder().encode(JSON.stringify({ chatId: 'room-7', uid: 'me' })) } });
    assert.ok(expected.ok, expected.detail);
    assert.deepEqual(Array.from(bytes), Array.from(encodeFrame(expected.bytes!)),
      'the fallback frame changed — an old server would see different bytes');

    socket.emit('join_chat', { chatId: 'room-7' });
    assert.equal(decodeLast(wire).body_field, 100);
    socket.disconnect();
  }

  // ── fail safe: typedAppBodies forced undefined ───────────────────────────
  {
    const { socket, wire } = await session(true);
    const { ccwireClient } = await import('./transport');
    (ccwireClient() as any).serverHello.typedAppBodies = undefined;
    socket.emit('typing_start', { chatId: 'room-7' });
    assert.equal(decodeLast(wire).body_field, 100,
      'an absent typed_app_bodies bit must fall back to app_event');
    socket.disconnect();
  }

  __resetCCWireForTest();
  assert.equal(timers.size, 0, 'no timer survives teardown');
  console.log('CC-Wire typing emit: typed body 81 when advertised, byte-identical app_event otherwise, unsequenced, no client sender_uid');
}
main().catch((error) => { __resetCCWireForTest(); console.error(error); process.exitCode = 1; });
