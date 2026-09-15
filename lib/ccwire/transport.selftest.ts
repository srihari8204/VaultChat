// Run: npx tsx lib/ccwire/transport.selftest.ts
import assert from 'node:assert/strict';
import {
  __resetCCWireForTest,
  ccwireCarrier,
  ccwireClient,
  ccwireDiagnostics,
  ccwireStatus,
  ccwireUrlFor,
  ccwireWebTransportUrl,
  recoverCCWire,
  startCCWire,
  stopCCWire,
} from './transport';
import { encodeFrame, decodeStream } from './frame';
import { decodeFrameMessage, encodeFrameMessage, type Frame } from './codec';

class Wire {
  static all: Wire[] = [];
  onopen: any;
  onmessage: any;
  onclose: any;
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
  hello(appEvents = true, resumed = true) {
    this.onopen({});
    this.receive({ traffic_class: 1, stream: 1, body_field: 17,
      raw: Uint8Array.from([8, 1, ...(appEvents ? [26, 2, 64, 1] : []), ...(resumed ? [64, 1] : [])]) });
  }
}

const timers = new Map<number, { fn: () => void; ms: number }>();
let timerId = 0;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const decodeLast = (wire: Wire): Frame => {
  const stream = decodeStream(wire.sent.at(-1)!);
  assert.equal(stream.error, undefined);
  const decoded = decodeFrameMessage(stream.frames![0]);
  assert.ok(decoded.ok);
  return decoded.frame!;
};

async function main() {
  assert.equal(ccwireUrlFor('https://api.corefinite.com'), 'wss://api.corefinite.com/ccwire/v1');
  assert.equal(ccwireUrlFor('http://10.0.0.2:3002/'), 'ws://10.0.0.2:3002/ccwire/v1');
  assert.equal(ccwireWebTransportUrl('https://api.corefinite.com', 'https://api.corefinite.com/ccwire/v1'), 'https://api.corefinite.com/ccwire/v1');
  assert.equal(ccwireWebTransportUrl('http://10.0.0.2:3002', 'https://10.0.0.2:3002/ccwire/v1'), undefined);

  __resetCCWireForTest();
  startCCWire({
    serverUrl: 'https://example.invalid',
    getToken: () => 'token',
    requireAppEvents: true,
    WebSocketImpl: Wire,
    carrier: 'ws',
    setTimeoutImpl: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeoutImpl: (id: number) => { timers.delete(id); },
  });
  await tick();
  let wire = Wire.all.at(-1)!;
  assert.equal(ccwireStatus(), 'pending');
  wire.hello(true, true);
  await tick();
  assert.equal(ccwireStatus(), 'ready');
  assert.equal(ccwireCarrier(), 'ws');
  assert.equal(ccwireClient()?.ready, true);
  assert.equal(ccwireDiagnostics().carrier, 'ws');

  ccwireClient()?.send({ request_id: ccwireClient()!.nextRequestId(), traffic_class: 1, stream: 1,
    body_field: 100, value: { event: 'typing_start', payload_json: new TextEncoder().encode('{"chatId":"c"}') } });
  assert.equal(decodeLast(wire).body_field, 100);
  stopCCWire('logout');
  assert.equal(wire.closed, true);
  assert.equal(ccwireStatus(), 'off');
  assert.equal(timers.size, 0);

  __resetCCWireForTest();
  let errors: string[] = [];
  startCCWire({
    serverUrl: 'https://example.invalid',
    getToken: () => 'token',
    requireAppEvents: true,
    WebSocketImpl: Wire,
    carrier: 'ws',
    onStatus: (status, detail) => { if (status === 'error') errors.push(detail ?? ''); },
  });
  await tick();
  wire = Wire.all.at(-1)!;
  wire.hello(false, true);
  await tick();
  assert.equal(ccwireStatus(), 'error');
  assert.match(errors.at(-1) ?? '', /app_events_v1 unsupported/);
  assert.equal(wire.closed, true);
  recoverCCWire();
  await tick();
  assert.equal(Wire.all.at(-1), wire, 'unsupported app-events is fatal until app restart/logout');

  __resetCCWireForTest();
  timers.clear();
  console.log('CC-Wire transport: URL mapping, app-event protobuf carrier, teardown, and unsupported-server refusal passed');
}

main().catch((error) => { __resetCCWireForTest(); console.error(error); process.exitCode = 1; });
