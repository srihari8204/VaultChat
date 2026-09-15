// Run: npx tsx lib/ccwire/appEventFragments.selftest.ts
import assert from 'node:assert/strict';
import { AppEventFragments } from './appEventFragments';
import CCWireClient from './client';
import { encodeFrame, decodeStream } from './frame';
import { encodeFrameMessage, decodeFrameMessage, APP_EVENT_LOGICAL_MAX, type Fragment, type AppEvent } from './codec';

const part = (index: number, chunk: number[], extra: Partial<Fragment> = {}): Fragment => ({
  fragment_id: 'a', index, total: 2, total_bytes: '4', chunk: Uint8Array.from(chunk), last: index === 1, ...extra,
});
const r = new AppEventFragments();
assert.equal(r.accept(part(1, [3, 4]), 0), null);
assert.deepEqual(r.accept(part(0, [1, 2]), 1), Uint8Array.from([1, 2, 3, 4]));
assert.equal(r.bytes, 0);
r.accept(part(0, [1, 2]), 0);
assert.throws(() => r.accept(part(0, [1, 2]), 1), /invalid/);
assert.equal(r.size, 0);
r.accept(part(0, [1, 2]), 0);
assert.throws(() => r.accept(part(1, [3, 4]), 30000), /expired/);
assert.equal(r.bytes, 0);
for (const invalid of [
  { total: 17 }, { index: 2 }, { last: true }, { total_bytes: String(APP_EVENT_LOGICAL_MAX + 1) },
  { total_bytes: '-1' }, { total_bytes: 'NaN' }, { fragment_id: '' }, { chunk: new Uint8Array() },
]) assert.throws(() => r.accept(part(0, [1], invalid), 0), /invalid/);
for (let i = 0; i < 8; i++) r.accept(part(0, [1], { fragment_id: String(i) }), 0);
assert.throws(() => r.accept(part(0, [1], { fragment_id: 'ninth' }), 0), /invalid/);
r.expire(30000); assert.equal(r.size, 0); assert.equal(r.bytes, 0);
r.accept(part(0, [], { fragment_id: 'large', total_bytes: String(APP_EVENT_LOGICAL_MAX), chunk: new Uint8Array(1200000) }), 0);
assert.throws(() => r.accept(part(0, [], { fragment_id: 'other', total_bytes: String(APP_EVENT_LOGICAL_MAX), chunk: new Uint8Array(1200000) }), 0), /invalid/);
assert.equal(r.bytes, 1200000);
r.clear(); assert.equal(r.bytes, 0);

class Wire {
  static current: Wire;
  onopen: any; onmessage: any; onclose: any;
  sent: Uint8Array[] = [];
  constructor() { Wire.current = this; }
  send(b: Uint8Array) { this.sent.push(b); }
  close() {}
}
const timers = new Map<number, { fn: () => void; ms: number }>();
let timerId = 0;
async function main() {
  const client = new CCWireClient({ url: 'wss://example.invalid/ccwire/v1', getToken: () => 'test', WebSocketImpl: Wire,
    setTimeoutImpl: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeoutImpl: (id) => { timers.delete(id); } });
  await client.connect();
  const wire = Wire.current;
  wire.onopen({});
  const hello = encodeFrameMessage({ traffic_class: 1, stream: 1, body_field: 17,
    raw: Uint8Array.from([8, 1, 26, 4, 8, 1, 64, 1, 64, 1]) });
  assert.ok(hello.ok);
  wire.onmessage({ data: encodeFrame(hello.bytes!) });
  // Accepted legacy strings: each <192KiB; total decoded content <256KiB.
  // JSON escaping expands this payload above1MiB; a192/256KiB wire cap drops it.
  const payload = { to: 'peer', a: '\u0000'.repeat(190 * 1024), b: '\u0000'.repeat(60 * 1024) };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  assert.ok(json.length > 1024 * 1024);
  const before = wire.sent.length;
  assert.equal(client.send({ request_id: 'large', traffic_class: 1, stream: 1, body_field: 100,
    value: { event: 'webrtc_offer', payload_json: json } }), true);
  const fragments = wire.sent.slice(before);
  assert.ok(fragments.length > 4 && fragments.length <= 16);
  for (const bytes of fragments) {
    assert.ok(bytes.length <= 262144 + 5, 'physical frame cap unchanged');
    const decoded = decodeFrameMessage(decodeStream(bytes).frames![0], { appEventsV1: true });
    assert.ok(decoded.ok); assert.equal(decoded.frame!.body_field, 112);
  }
  let delivered: AppEvent | undefined;
  client.on('frame', (event) => { if (event.frame?.body_field === 100) delivered = event.frame.value as AppEvent; });
  for (const bytes of [...fragments].reverse()) wire.onmessage({ data: bytes });
  assert.equal(delivered?.event, 'webrtc_offer');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(delivered?.payload_json)), payload);
  assert.equal((client as any).appFragments.bytes, 0);
  wire.onmessage({ data: fragments[0] });
  assert.ok((client as any).appFragments.bytes > 0);
  wire.onclose({ code: 1006 });
  assert.equal((client as any).appFragments.bytes, 0, 'network failure frees partial event');
  assert.equal((client as any).fragmentTimer, null);
  client.close(); assert.equal(timers.size, 0, 'teardown clears retry/reassembly/heartbeat timers');
  console.log('App-event fragmentation passed: escaped legacy payload, physical bounds, out-of-order, duplicates, expiry, aggregate budget and network cleanup');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
