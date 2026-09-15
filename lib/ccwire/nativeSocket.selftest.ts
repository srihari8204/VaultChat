import assert from 'node:assert/strict';
import { createNativeWebSocketImpl, getNativeWebSocketImpl } from './nativeSocket';
import { MAX_FRAME_BYTES } from './frame';

async function main() {
  let listener: (event: any) => void = () => {};
  let removed = 0, acknowledged = 0, closed = 0;
  let accepted = true, sent = '';
  const NativeSocket = createNativeWebSocketImpl({
    create: () => 7,
    connect: (id, url, token) => { assert.equal(id, 7); assert.equal(url, 'wss://example.test/ccwire/v1'); assert.equal(token, 'secret'); },
    send: (_, bytes) => { sent = bytes; return accepted; },
    acknowledge: () => { acknowledged++; },
    close: () => { closed++; },
  }, { addListener: (_, cb) => { listener = cb; return { remove: () => { removed++; } }; } });
  assert.throws(() => new NativeSocket('ws://example.test', [], { headers: { Authorization: 'Bearer secret' } }));
  const ws = new NativeSocket('wss://example.test/ccwire/v1', [], { headers: { Authorization: 'Bearer secret' } });
  assert.throws(() => ws.send(new Uint8Array([1])));
  let opens = 0, closes = 0;
  ws.onopen = () => { opens++; };
  ws.onclose = () => { closes++; };
  listener({ id: 8, kind: 0 });
  assert.equal(opens, 0);
  listener({ id: 7, kind: 0 });
  assert.equal(opens, 1);
  ws.send(new Uint8Array([9, 0, 255, 1, 9]).subarray(1, 4));
  assert.equal(sent, 'AP8B');
  ws.onmessage = ({ data }) => assert.deepEqual(new Uint8Array(data), new Uint8Array([0, 255, 1]));
  listener({ id: 7, kind: 1, data: sent });
  assert.equal(acknowledged, 1);
  accepted = false;
  assert.throws(() => ws.send(new Uint8Array([1])), /queue full/);
  assert.throws(() => ws.send(new Uint8Array(MAX_FRAME_BYTES + 6)), /size/);
  ws.close();
  await Promise.resolve();
  listener({ id: 7, kind: 2, code: 1006 });
  assert.equal(ws.readyState, 3);
  assert.equal(closes, 1);
  assert.equal(removed, 1);
  assert.ok(closed > 0);
  assert.equal(getNativeWebSocketImpl(), undefined); // Node / Expo Go has no module.
  assert.equal(getNativeWebSocketImpl('https://example.test:4443/ccwire/wt/v1'), undefined);
  let target = '';
  const nativeWt = { create: () => 9, connect: (_id: number, url: string) => { target = url; }, send: () => true, acknowledge: () => {}, close: () => {} };
  const emitterWt = { addListener: () => ({ remove: () => {} }) };
  const WT = createNativeWebSocketImpl(nativeWt, emitterWt, 'https://example.test:4443/ccwire/wt/v1');
  const wt = new WT('wss://example.test/ccwire/v1', [], { headers: { Authorization: 'Bearer secret' } });
  assert.equal(target, 'https://example.test:4443/ccwire/wt/v1');
  assert.equal(wt.protocol, 'webtransport');
  wt.close();
  for (const endpoint of ['https://other.test/ccwire', 'http://example.test/ccwire', 'https://user@example.test/ccwire', 'https://example.test/ccwire?token=x']) {
    const Bad = createNativeWebSocketImpl(nativeWt, emitterWt, endpoint);
    assert.throws(() => new Bad('wss://example.test/ccwire/v1', [], { headers: { Authorization: 'Bearer secret' } }), /endpoint/);
  }
  console.log('native Rust socket adapter selftest passed');
}
void main();
