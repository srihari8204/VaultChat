// Run: npx tsx lib/ccwire/eventsSocket.selftest.ts
import assert from 'node:assert/strict';
import { CCWireEventSocket } from './eventsSocket';
import { decodeServerHello, encodeClientHello } from './client';
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
  hello(capable = true, resumed = true) {
    this.onopen({});
    this.receive({ traffic_class: 1, stream: 1, body_field: 17,
      raw: Uint8Array.from([8, 1, ...(capable ? [26, 2, 64, 1] : []), ...(resumed ? [64, 1] : [])]) });
  }
  event(event: string, payload: any) {
    this.receive({ traffic_class: 1, stream: 1, body_field: 100,
      value: { event, payload_json: new TextEncoder().encode(JSON.stringify(payload)) } });
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
  assert.ok(decoded.ok);
  return decoded.frame!;
}
async function main() {
  // The capability blob is pinned BYTE-EXACT on purpose: it is the one place a
  // capability can be added or dropped by accident, and a wrong offer is
  // invisible at runtime (the server's reply is an intersection, so an
  // unsupported offer just silently does nothing).
  //
  //   26 = field 3 (capabilities), wire 2   06 = length
  //    8,1  = field 1 fragmentation
  //   16,1  = field 2 resumption      <- added with CC-Wire session resume
  //   64,1  = field 8 app_events_v1
  //
  // Update this deliberately, never to make a failure go away.
  assert.ok(
    Buffer.from(encodeClientHello()).includes(Buffer.from([26, 6, 8, 1, 16, 1, 64, 1])),
    'ClientHello capability blob changed — update this constant deliberately',
  );
  assert.equal(decodeServerHello(Uint8Array.from([8, 1, 26, 2, 64, 1])).appEventsV1, true);
  assert.equal(!!decodeServerHello(Uint8Array.from([8, 1])).appEventsV1, false);
  __resetCCWireForTest();
  const socket = new CCWireEventSocket(options, async () => 'terminal');
  let connects = 0;
  socket.on('connect', () => { connects++; socket.emit('join_chat', { chatId: 'room' }); });
  const first = socket.waitUntilReady();
  assert.equal(socket.waitUntilReady(), first);
  await tick();
  let wire = Wire.all.at(-1)!;
  wire.hello();
  await first;
  assert.equal(socket.connected, true);
  assert.equal(connects, 1);
  assert.ok(ccwireClient()?.ready, 'typed submissions share the same live singleton');
  let frame = decodeLast(wire);
  assert.equal(frame.body_field, 100);
  assert.equal((frame.value as AppEvent).event, 'join_chat');
  let received: any;
  const handler = (payload: any) => { received = payload; };
  socket.on('new_message', handler);
  wire.event('new_message', { id: 42, content: 'sealed' });
  assert.deepEqual(received, { id: 42, content: 'sealed' });
  socket.off('new_message', handler);
  wire.event('new_message', { id: 43 });
  assert.equal(received.id, 42);
  let once = 0;
  socket.once('message_read', () => once++);
  wire.event('message_read', {}); wire.event('message_read', {});
  assert.equal(once, 1);
  wire.event('connect', {});
  assert.equal(connects, 1, 'wire cannot spoof lifecycle');
  const before = wire.sent.length;
  socket.emit('typing_start', { chatId: 'room' });
  assert.equal(wire.sent.length, before + 1);
  socket.emit('huge', { value: 'x'.repeat(1600000) });
  assert.equal(wire.sent.length, before + 1, 'oversized events are bounded');
  socket.disconnect();
  assert.equal(wire.closed, true);
  socket.emit('typing_start', { chatId: 'room' });
  assert.equal(wire.sent.length, before + 1, 'no stale offline queue');
  const second = socket.waitUntilReady();
  await tick();
  wire = Wire.all.at(-1)!;
  wire.hello(); await second;
  assert.equal(connects, 2, 'same facade restores connect listeners');
  assert.equal(Wire.all.filter((s) => !s.closed).length, 1, 'one active carrier');
  socket.disconnect();
  socket.removeAllListeners();
  assert.equal(timers.size, 0, 'no heartbeat survives teardown');

  const oldServer = new CCWireEventSocket(options, async () => 'terminal');
  const refused = oldServer.waitUntilReady();
  await tick();
  wire = Wire.all.at(-1)!;
  wire.hello(false);
  await assert.rejects(refused, /app_events_v1 unsupported/);
  assert.equal(wire.closed, true, 'legacy fallback must first close CC-Wire');
  oldServer.disconnect();
  assert.equal(timers.size, 0);
  let finishSync!: () => void;
  const resync = new CCWireEventSocket({ ...options,
    onResyncRequired: () => new Promise<void>((resolve) => { finishSync = resolve; }) }, async () => 'terminal');
  const pendingResync = resync.waitUntilReady();
  await tick();
  Wire.all.at(-1)!.hello(true, false);
  await pendingResync;
  assert.equal(ccwireClient()?.ready, false, 'typed submission waits for durable resync');
  finishSync(); await tick();
  assert.equal(ccwireClient()?.ready, true, 'durable sync completion enables typed submission');
  resync.disconnect();
  let refreshes = 0;
  const expiring = new CCWireEventSocket(options, async () => { refreshes++; return 'ok'; });
  const authenticated = expiring.waitUntilReady();
  await tick(); Wire.all.at(-1)!.hello(); await authenticated;
  for (let expiry = 1; expiry <= 2; expiry++) {
    Wire.all.at(-1)!.onclose({ code: 4401 });
    await tick();
    const refreshed = expiring.waitUntilReady();
    await tick();
    Wire.all.at(-1)!.hello();
    await refreshed;
    assert.equal(refreshes, expiry, 'each successful connection permits its next token refresh');
  }
  Wire.all.at(-1)!.onclose({ code: 4401 });
  await tick();
  await tick();
  Wire.all.at(-1)!.onclose({ code: 4401 });
  await tick();
  assert.equal(refreshes, 3, 'repeated refusal without a successful hello cannot loop refresh');
  expiring.disconnect();
  const cancelled = new CCWireEventSocket(options, async () => 'terminal');
  const cancelledWait = cancelled.waitUntilReady();
  await tick();
  cancelled.disconnect();
  await assert.rejects(cancelledWait, /Connection closed/);
  assert.equal(timers.size, 0, 'cancelled handshake retains no timers');
  __resetCCWireForTest();
  console.log('CC-Wire event facade: negotiation, payloads, lifecycle, bounds, single carrier and legacy refusal passed');
}
main().catch((error) => { __resetCCWireForTest(); console.error(error); process.exitCode = 1; });
