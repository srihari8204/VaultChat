// Run: npx tsx lib/ccwire/typingState.selftest.ts
//
// TYPED TypingState (body 81), BOTH FORMS, ONE APP-FACING EVENT.
//
// The Go server already builds body 81 for typing_start/typing_stop
// (ccwire_messages.go, `case "typing_start", "typing_stop"`) and already serves
// it inbound (serveBody -> s.typing). The client routed neither: it sent
// typing through app_event (100) as JSON and only ever decoded 100.
//
// What this proves:
//   1. a typed 81 frame reaches the app as ('typing_start'|'typing_stop',
//      {uid, chatId}) — the SAME name and the SAME payload shape the JSON form
//      produces, so no consumer changes;
//   2. the app_event (100) JSON form still works, unchanged, side by side;
//   3. the client still EMITS the JSON form, because no ServerHello capability
//      signals that the server serves typed app-domain bodies inbound. There is
//      nothing to negotiate against, so nothing is guessed. See the header note
//      in the emit section below.
//   4. a typing frame — decoded or dropped — moves no delivery/read cursor.
import assert from 'node:assert/strict';
import { CCWireEventSocket } from './eventsSocket';
import { __resetCCWireForTest, ccwireClient } from './transport';
import { encodeFrame, decodeStream } from './frame';
import { encodeFrameMessage, decodeFrameMessage, type Frame, type AppEvent } from './codec';

class Wire {
  static all: Wire[] = [];
  onopen: any; onmessage: any; onclose: any;
  closed = false;
  sent: Uint8Array[] = [];
  constructor() { Wire.all.push(this); }
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close() { this.closed = true; }
  receive(frame: Frame) {
    const encoded = encodeFrameMessage(frame);
    assert.ok(encoded.ok, encoded.detail);
    this.onmessage({ data: encodeFrame(encoded.bytes!) });
  }
  hello() {
    this.onopen({});
    // 8,1 protocol_major; 26,2,64,1 capabilities{app_events_v1}; 64,1 resumed.
    this.receive({ traffic_class: 1, stream: 1, body_field: 17,
      raw: Uint8Array.from([8, 1, 26, 2, 64, 1, 64, 1]) });
  }
  /** The legacy form: app_event (100) carrying string-named JSON. */
  json(event: string, payload: any) {
    this.receive({ traffic_class: 1, stream: 1, body_field: 100,
      value: { event, payload_json: new TextEncoder().encode(JSON.stringify(payload)) } });
  }
  /** The typed form: TypingState (81) on EPHEMERAL, exactly as Go builds it. */
  typed(chat_id: string, typing: boolean, sender_uid: string, seq = '0') {
    this.receive({ traffic_class: 5, stream: 5, seq, body_field: 81,
      value: { chat_id, typing, sender_uid } });
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

async function main() {
  __resetCCWireForTest();
  const socket = new CCWireEventSocket(options, async () => 'terminal');
  const seen: Array<[string, any]> = [];
  socket.on('typing_start', (p: any) => seen.push(['typing_start', p]));
  socket.on('typing_stop', (p: any) => seen.push(['typing_stop', p]));

  const ready = socket.waitUntilReady();
  await tick();
  const wire = Wire.all.at(-1)!;
  wire.hello();
  await ready;

  // ── 1. the typed form decodes ────────────────────────────────────────────
  wire.typed('c1', true, 'typer');
  wire.typed('c1', false, 'typer');
  assert.deepEqual(seen, [
    ['typing_start', { uid: 'typer', chatId: 'c1' }],
    ['typing_stop', { uid: 'typer', chatId: 'c1' }],
  ], 'typed TypingState must arrive as the same app event as the JSON form');

  // ── 2. the JSON form is unchanged and INDISTINGUISHABLE at the app ───────
  seen.length = 0;
  wire.json('typing_start', { uid: 'typer', chatId: 'c1' });
  wire.json('typing_stop', { uid: 'typer', chatId: 'c1' });
  assert.deepEqual(seen, [
    ['typing_start', { uid: 'typer', chatId: 'c1' }],
    ['typing_stop', { uid: 'typer', chatId: 'c1' }],
  ], 'the app_event fallback must keep working exactly as today');

  // A typed frame with no chat_id names no room, so it is dropped rather than
  // dispatched to every open chat. It must also not be mistaken for an event.
  seen.length = 0;
  wire.typed('', true, 'typer');
  assert.equal(seen.length, 0, 'a TypingState without chat_id is not routable');

  // Another named event still reaches the facade after a typing frame — the
  // 81 branch returns early and must not swallow the 100 path.
  let other = 0;
  socket.on('new_message', () => other++);
  wire.json('new_message', { id: 1 });
  assert.equal(other, 1, 'the app_event path survives alongside the typed one');

  // ── 3. NO CURSOR MOVES ───────────────────────────────────────────────────
  // EPHEMERAL is unsequenced by construction on the server (ccwire_seq.go
  // `sequenced()` excludes it), and the client only records a position for a
  // sequenced frame. Both the decoded frame and the DROPPED one must leave
  // Ping.progress empty — a dropped typing indicator must never be reported as
  // delivered.
  const cursors = (ccwireClient() as any)?.streamSeq ?? {};
  assert.deepEqual(cursors, {}, 'typing frames advanced a delivery cursor');

  // ── 4. EMIT still uses the JSON form, and that is deliberate ─────────────
  // ServerHello.capabilities has one bit relevant to application bodies —
  // app_events_v1 (8) — and it means the OPPOSITE of what a typed emit needs:
  // it says the server speaks app_event JSON. Fields 1-8 are all assigned and
  // Capabilities.experimental (15) is specified INERT ("echoed back unmodified
  // but never activated"). No bit says "this server serves typed app-domain
  // bodies inbound", so there is nothing to negotiate against, and emitting
  // typed 81 would be guessing. The client therefore keeps sending body 100.
  const before = wire.sent.length;
  socket.emit('typing_start', { chatId: 'c1', uid: 'me' });
  assert.equal(wire.sent.length, before + 1);
  const out = decodeLast(wire);
  assert.equal(out.body_field, 100, 'un-negotiated: typing must still go out as app_event');
  assert.equal((out.value as AppEvent).event, 'typing_start');

  socket.disconnect();
  socket.removeAllListeners();
  assert.equal(timers.size, 0, 'no timer survives teardown');
  __resetCCWireForTest();
  console.log('CC-Wire TypingState(81): typed decode, app_event fallback, no cursor movement, JSON emit un-negotiated — passed');
}

main().catch((error) => { __resetCCWireForTest(); console.error(error); process.exitCode = 1; });
