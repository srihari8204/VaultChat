// Run: npx tsx lib/ccwire/recovery.selftest.ts
import assert from 'node:assert/strict';
import { CCWireClient, HANDSHAKE_TIMEOUT_MS } from './client';
import { startCCWire, stopCCWire, recoverCCWire, ccwireStatus, ccwireDiagnostics, __resetCCWireForTest, type StartCCWireOptions } from './transport';
import { encodeFrame } from './frame';
import { encodeFrameMessage } from './codec';

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
class Clock {
  now = 0;
  serial = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => { const id = ++this.serial; this.tasks.set(id, { at: this.now + ms, fn }); return id; };
  clear = (id: number) => { this.tasks.delete(id); };
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const first = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      this.tasks.delete(first[0]); this.now = first[1].at; first[1].fn(); await settle();
    }
    this.now = end;
  }
}
const sockets: Socket[] = [];
class Socket {
  onopen: any; onmessage: any; onclose: any;
  closed = false;
  constructor() { sockets.push(this); }
  send() {}
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  hangup(code = 1006) { this.onclose?.({ code }); }
  hello(major = 1) {
    const frame = encodeFrameMessage({ request_id: '', traffic_class: 1, stream: 1, body_field: 17, raw: Uint8Array.from([8, major, 64, 1]) });
    assert.ok(frame.ok);
    this.onmessage?.({ data: encodeFrame(frame.bytes!) });
  }
}
const current = () => sockets.at(-1)!;
function rig() {
  __resetCCWireForTest(); sockets.length = 0;
  const clock = new Clock();
  const options: StartCCWireOptions = { serverUrl: 'https://example.invalid', getToken: () => 'token', WebSocketImpl: Socket,
    now: () => clock.now, setTimeoutImpl: clock.set, clearTimeoutImpl: clock.clear };
  return { clock, options };
}

async function main() {
  // Offline startup can recover, while repeated platform signals keep one owner.
  {
    const { clock, options } = rig(); startCCWire(options); await settle();
    await clock.advance(HANDSHAKE_TIMEOUT_MS);
    assert.equal(ccwireStatus(), 'error'); assert.ok(current().closed);
    startCCWire(options); await settle(); assert.equal(sockets.length, 1, 'ordinary start cannot bypass failure bound');
    for (let i = 0; i < 100; i++) recoverCCWire();
    await settle(); assert.equal(sockets.length, 2, 'one owner after a platform recovery signal');
    await clock.advance(HANDSHAKE_TIMEOUT_MS); assert.equal(ccwireStatus(), 'error');
    for (let i = 0; i < 100; i++) recoverCCWire();
    assert.equal(clock.tasks.size, 1, 'repeated signals coalesce during cooldown');
    await clock.advance(14999); assert.equal(sockets.length, 2);
    await clock.advance(1); assert.equal(sockets.length, 3, 'one deferred attempt after cooldown');
    await clock.advance(HANDSHAKE_TIMEOUT_MS); recoverCCWire();
    assert.equal(clock.tasks.size, 1);
    stopCCWire('logout'); await clock.advance(60000);
    assert.equal(sockets.length, 3, 'logout cancels deferred recovery');
    assert.equal(ccwireStatus(), 'off'); assert.equal(clock.tasks.size, 0);
  }
  // A lost Hello on a WSS reconnect must time out even after an earlier success.
  {
    const { clock, options } = rig(); startCCWire(options); await settle();
    current().open(); current().hello(); assert.equal(ccwireStatus(), 'ready');
    current().hangup(); await clock.advance(2000); current().open();
    const stalled = current(); assert.equal(ccwireStatus(), 'pending');
    await clock.advance(HANDSHAKE_TIMEOUT_MS);
    assert.ok(stalled.closed, 'reconnect awaiting Hello closed at its deadline');
    await clock.advance(2000); assert.notEqual(current(), stalled);
    current().open(); current().hello(); assert.equal(ccwireStatus(), 'ready');
    assert.equal(clock.tasks.size, 1, 'only heartbeat remains after successful Hello');
    stopCCWire('logout'); assert.equal(clock.tasks.size, 0);
  }
  // Auth and protocol refusals never gain a network-triggered retry loophole.
  for (const denial of ['auth', 'protocol']) {
    const { clock, options } = rig(); startCCWire(options); await settle();
    if (denial === 'auth') {
      for (let i = 0; i < 3; i++) { current().hangup(4401); await clock.advance(2000); }
    } else { current().open(); current().hello(2); }
    assert.equal(ccwireStatus(), 'error'); const before = sockets.length;
    recoverCCWire(); await clock.advance(60000);
    assert.equal(sockets.length, before, `${denial} remains stopped`);
    assert.equal(clock.tasks.size, 0);
  }
  // Closing during backoff cancels all timers, not just the next socket creation.
  {
    const { clock, options } = rig();
    const c = new CCWireClient({ ...options, url: options.serverUrl }); await c.connect();
    current().hangup(); assert.equal(clock.tasks.size, 1);
    c.close(); assert.equal(clock.tasks.size, 0);
  }
  // A timed-out token read cannot create another socket inside a newer attempt.
  {
    const { clock, options } = rig();
    const tokens: ((s: string) => void)[] = [];
    const c = new CCWireClient({ ...options, url: options.serverUrl, getToken: () => new Promise<string>(resolve => tokens.push(resolve)) });
    const oldAttempt = c.connect(); await clock.advance(HANDSHAKE_TIMEOUT_MS + 2000);
    assert.equal(tokens.length, 2);
    tokens[0]('stale-token'); await oldAttempt; await settle();
    assert.equal(sockets.length, 0, 'stale token completion is ignored');
    tokens[1]('fresh-token'); await settle(); assert.equal(sockets.length, 1);
    c.close(); assert.equal(clock.tasks.size, 0);
  }
  // Recovering a failed WSS fallback must not force another WT attempt.
  {
    const { clock, options } = rig();
    startCCWire({ ...options, carrier: 'rust-wt', webSocketFallback: { WebSocketImpl: Socket, carrier: 'rust-ws' } });
    await settle(); await clock.advance(HANDSHAKE_TIMEOUT_MS * 2);
    assert.equal(ccwireStatus(), 'error'); recoverCCWire(); await settle();
    assert.equal(ccwireDiagnostics().carrier, 'rust-ws');
    current().open(); current().hello(); assert.equal(ccwireStatus(), 'ready');
    stopCCWire('logout'); assert.equal(clock.tasks.size, 0);
  }
  __resetCCWireForTest();
  console.log('CC-Wire recovery selftest: PASS');
}
main().catch(error => { __resetCCWireForTest(); console.error(error); process.exitCode = 1; });
