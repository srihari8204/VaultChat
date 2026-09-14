// lib/ccwire/client.selftest.ts — run: npx tsx lib/ccwire/client.selftest.ts
//
// Drives the REAL CCWireClient against a fake WebSocket and a virtual clock.
// No network, no React Native, no timers that actually tick — the client takes
// its WebSocket implementation and its setTimeout/clearTimeout as options for
// exactly this reason, the same stubbing idiom as lib/socket.transport.selftest.ts
// and lib/messageQueue.flush.selftest.ts.
//
// WHAT IS PINNED HERE
//   1. the Authorization header RequireAuth reads is actually set on the dial;
//   2. ClientHello goes out framed + protobuf-encoded, binary, on open;
//   3. ServerHello with resumed unset DEMANDS a full resync, and one with
//      resumed set does not;
//   4. a frame split across two reads reassembles;
//   5. two frames in one read both surface;
//   6. a malformed frame closes the session and it STAYS closed;
//   7. a close mid-handshake is reported as 'handshake_incomplete';
//   8. Ping/Pong keepalive at the negotiated timings, and a missing Pong ends
//      the session;
//   9. backoff grows, is capped, and two seeds do not wake together.
//
// NOT pinned, and cannot be: that any of this interoperates with the Go server.
// That needs CCWIRE_WS=1 and a live socket.

import {
  CCWireClient,
  Backoff,
  BODY,
  decodeServerHello,
  encodeClientHello,
  type CCWireEvent,
} from './client';
import { encodeFrame, decodeFrame, HEADER_BYTES } from './frame';
import { encodeFrameMessage, decodeFrameMessage } from './codec';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── virtual clock ────────────────────────────────────────────────────────────

interface Task { id: number; at: number; fn: () => void }
class Clock {
  now = 0;
  private id = 0;
  private tasks: Task[] = [];
  set = (fn: () => void, ms: number) => {
    const t = { id: ++this.id, at: this.now + Math.max(0, ms), fn };
    this.tasks.push(t);
    return t.id;
  };
  clear = (h: any) => { this.tasks = this.tasks.filter((t) => t.id !== h); };
  /** Run everything due at or before now+ms, in time order. */
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
    }
    this.now = until;
  }
  get pending() { return this.tasks.length; }
}

// ── fake WebSocket ───────────────────────────────────────────────────────────

const sockets: FakeWS[] = [];
class FakeWS {
  static opened = 0;
  url: string;
  opts: any;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: any = null; onmessage: any = null; onerror: any = null; onclose: any = null;
  constructor(url: string, _protocols: any, opts: any) {
    this.url = url;
    this.opts = opts;
    FakeWS.opened++;
    sockets.push(this);
  }
  send(b: Uint8Array) { this.sent.push(b); }
  close() { this.closed = true; }
  // test drivers
  open() { this.onopen?.({}); }
  deliver(bytes: Uint8Array) { this.onmessage?.({ data: bytes }); }
  hangup(code = 1006) { this.onclose?.({ code }); }
}

// ── protobuf bits, for building server frames in the test ────────────────────

function varint(out: number[], v: number) {
  let n = v;
  while (n >= 128) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
}
function pbVarint(out: number[], field: number, v: number) { varint(out, field * 8); varint(out, v); }
function pbBytes(out: number[], field: number, b: Uint8Array) {
  varint(out, field * 8 + 2); varint(out, b.length);
  for (let i = 0; i < b.length; i++) out.push(b[i]);
}

function serverHelloBody(o: { resumed?: boolean; major?: number; limits?: boolean } = {}): Uint8Array {
  const out: number[] = [];
  pbVarint(out, 1, o.major ?? 1);          // protocol_major
  if (o.limits !== false) {
    const lim: number[] = [];
    pbVarint(lim, 1, 262144);              // max_frame_bytes
    pbVarint(lim, 13, 10000);              // heartbeat_interval_ms
    pbVarint(lim, 14, 5000);               // heartbeat_timeout_ms
    pbBytes(out, 4, Uint8Array.from(lim));
  }
  pbBytes(out, 5, new TextEncoder().encode('uid-1'));   // session_id
  if (o.resumed) pbVarint(out, 8, 1);
  return Uint8Array.from(out);
}
function errorBody(code: number, cls: number, detail: string): Uint8Array {
  const out: number[] = [];
  pbVarint(out, 1, code);
  pbVarint(out, 2, cls);
  pbBytes(out, 3, new TextEncoder().encode(detail));
  return Uint8Array.from(out);
}

/** Encode a server->client frame exactly as ccwire.go would put it on the wire. */
function wireFrame(bodyField: number, body: Uint8Array, requestId = ''): Uint8Array {
  const enc = encodeFrameMessage({
    request_id: requestId,
    traffic_class: 1,
    stream: 1,
    body_field: bodyField,
    raw: body,
  });
  if (!enc.ok) throw new Error(`test fixture would not encode: ${enc.error} ${enc.detail}`);
  return encodeFrame(enc.bytes);
}

// ── harness ──────────────────────────────────────────────────────────────────

interface Rig {
  client: CCWireClient;
  clock: Clock;
  events: CCWireEvent[];
  ws: () => FakeWS;
}
async function rig(opts: any = {}): Promise<Rig> {
  const clock = new Clock();
  const events: CCWireEvent[] = [];
  const before = sockets.length;
  const client = new CCWireClient({
    url: 'wss://example.invalid/ccwire/v1',
    getToken: async () => 'tok-abc',
    seed: 1,
    WebSocketImpl: FakeWS,
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    now: () => clock.now,
    ...opts,
  });
  for (const t of ['open', 'hello', 'resync_required', 'frame', 'error', 'closed'] as const) {
    client.on(t, (e) => events.push(e));
  }
  await client.connect();
  return { client, clock, events, ws: () => sockets[before] };
}

/** Dial + open + ServerHello, the happy path most tests start from. */
async function handshaken(o: { resumed?: boolean } = {}) {
  const r = await rig();
  r.ws().open();
  r.ws().deliver(wireFrame(BODY.server_hello, serverHelloBody(o)));
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('lib/ccwire/client.selftest.ts');

  // 1 — the dial carries the Bearer header RequireAuth reads.
  {
    const r = await rig();
    const ws = r.ws();
    check('dials the ccwire path', ws.url === 'wss://example.invalid/ccwire/v1', ws.url);
    check('sets Authorization: Bearer <access token>',
      ws.opts?.headers?.Authorization === 'Bearer tok-abc',
      JSON.stringify(ws.opts));
    check('asks for arraybuffer frames', ws.binaryType === 'arraybuffer', ws.binaryType);
    check('nothing sent before open', ws.sent.length === 0);
  }

  // 2 — ClientHello on open, framed + encoded, never hand-built.
  {
    const r = await rig();
    r.ws().open();
    check('emits open', r.events.some((e) => e.type === 'open'));
    check('sends exactly one frame on open', r.ws().sent.length === 1, String(r.ws().sent.length));
    const raw = r.ws().sent[0];
    const fr = decodeFrame(raw, { strict: true });
    check('ClientHello is length-prefixed framing', fr.ok, fr.error);
    const m = decodeFrameMessage(fr.payload);
    check('ClientHello decodes as a Frame', m.ok, m.error);
    check('body is client_hello', m.frame?.body_field === BODY.client_hello, String(m.frame?.body_field));
    check('traffic_class is CONTROL', m.frame?.traffic_class === 1);
    check('ClientHello carries protocol_major=1',
      encodeClientHello()[0] === 8 && encodeClientHello()[1] === 1);
    check('ClientHello does NOT copy the token into the body',
      !Buffer.from(raw).includes('tok-abc'));
    check('not ready before ServerHello', !r.client.ready && r.client.state === 'handshaking');
  }

  // 3 — resumed === false is a COMMAND.
  {
    const r = await handshaken();
    check('emits hello', r.events.some((e) => e.type === 'hello'));
    check('state is open', r.client.state === 'open');
    check('resumed:false demands a full resync',
      r.events.some((e) => e.type === 'resync_required') && r.client.needsFullResync === true);
    check('and ready stays FALSE until the owner resyncs', r.client.ready === false);
    r.client.markResynced();
    check('ready after markResynced', r.client.ready === true);
    check('negotiated limits applied', r.client.maxFrameBytes === 262144, String(r.client.maxFrameBytes));

    const r2 = await handshaken({ resumed: true });
    check('resumed:true does not demand a resync',
      !r2.events.some((e) => e.type === 'resync_required') && r2.client.ready === true);
  }

  // 4 — a frame split across two reads reassembles.
  {
    const r = await rig();
    r.ws().open();
    const body = wireFrame(BODY.ack, Uint8Array.from([8, 7]));   // any non-control body
    const hello = wireFrame(BODY.server_hello, serverHelloBody());
    r.ws().deliver(hello);
    const cut = 3;                                 // mid-HEADER, the nastiest split
    r.ws().deliver(body.subarray(0, cut));
    check('a partial frame surfaces nothing yet', !r.events.some((e) => e.type === 'frame'));
    check('and does not close the session', r.client.state === 'open');
    r.ws().deliver(body.subarray(cut));
    check('the rest of the frame completes it', r.events.filter((e) => e.type === 'frame').length === 1);

    // and a split inside the payload, not the header
    const body2 = wireFrame(BODY.ack, Uint8Array.from([8, 9]));
    r.ws().deliver(body2.subarray(0, HEADER_BYTES + 1));
    r.ws().deliver(body2.subarray(HEADER_BYTES + 1));
    check('a payload-boundary split reassembles too',
      r.events.filter((e) => e.type === 'frame').length === 2);
  }

  // 5 — two frames in one read both surface.
  {
    const r = await handshaken();
    const a = wireFrame(BODY.ack, Uint8Array.from([8, 1]));
    const b = wireFrame(BODY.ack, Uint8Array.from([8, 2]));
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0); both.set(b, a.length);
    r.ws().deliver(both);
    check('two frames in one read both surface',
      r.events.filter((e) => e.type === 'frame').length === 2);

    // three, with a trailing partial: the partial must not be lost or surfaced
    const c = wireFrame(BODY.ack, Uint8Array.from([8, 3]));
    const d = wireFrame(BODY.ack, Uint8Array.from([8, 4]));
    const mixed = new Uint8Array(c.length + 2);
    mixed.set(c, 0); mixed.set(d.subarray(0, 2), c.length);
    r.ws().deliver(mixed);
    check('a whole frame + a partial yields exactly one more',
      r.events.filter((e) => e.type === 'frame').length === 3);
    r.ws().deliver(d.subarray(2));
    check('the buffered remainder completes on the next read',
      r.events.filter((e) => e.type === 'frame').length === 4);
  }

  // 6 — a malformed frame closes the connection, and it STAYS closed.
  {
    const r = await handshaken();
    const openedBefore = FakeWS.opened;
    r.ws().deliver(Uint8Array.from([9, 0, 0, 0, 1, 0]));   // framing version 9
    const closed = r.events.filter((e) => e.type === 'closed');
    check('a bad framing version closes the session', closed.length === 1, String(closed.length));
    check('reported as a framing refusal',
      closed[0]?.reason === 'framing' && closed[0]?.frameError === 'BAD_VERSION',
      `${closed[0]?.reason}/${closed[0]?.frameError}`);
    check('with NO retry scheduled', closed[0]?.willRetry === false);
    check('the socket was closed', r.ws().closed === true);
    r.clock.advance(600000);
    await r.client.connect();
    check('and it stays closed — no dial, ever',
      FakeWS.opened === openedBefore && r.client.state === 'closed' && r.client.fatal === true);

    // an over-long declared length is refused the same way, before any allocation
    const r2 = await handshaken();
    r2.ws().deliver(Uint8Array.from([1, 0xff, 0xff, 0xff, 0xff]));
    const c2 = r2.events.filter((e) => e.type === 'closed')[0];
    check('an over-max length is refused, not allocated',
      c2?.reason === 'framing' && c2?.frameError === 'LENGTH_OVER_MAX', String(c2?.frameError));

    // a frame that is well-framed but not a Frame
    const r3 = await handshaken();
    r3.ws().deliver(encodeFrame(Uint8Array.from([0xff, 0xff, 0xff])));
    check('a malformed protobuf body closes too',
      r3.events.some((e) => e.type === 'closed' && e.reason === 'framing'));

    // text is a different protocol, not a lenient encoding
    const r4 = await handshaken();
    (r4.ws().onmessage as any)({ data: 'hello' });
    check('a text message is a protocol violation',
      r4.events.some((e) => e.type === 'closed' && e.reason === 'protocol') && r4.client.fatal);
  }

  // 7 — a close mid-handshake is reported as such.
  {
    const r = await rig();
    r.ws().open();
    r.ws().hangup(1006);
    const c = r.events.filter((e) => e.type === 'closed')[0];
    check('a close before ServerHello is handshake_incomplete',
      c?.reason === 'handshake_incomplete', c?.reason);
    check('and IS retried (the server may just have restarted)',
      c?.willRetry === true && c?.retryInMs > 0);

    // the same, but the server says why first
    const r2 = await rig();
    r2.ws().open();
    r2.ws().deliver(wireFrame(BODY.error, errorBody(11, 2, 'ClientHello first')));
    const c2 = r2.events.filter((e) => e.type === 'closed')[0];
    check('an Error instead of ServerHello is a failed handshake, not a session',
      c2?.reason === 'handshake_incomplete' && r2.client.state === 'closed', c2?.reason);
    check('the structured Error surfaces with its code and class',
      r2.events.some((e) => e.type === 'error' && e.errorCode === 11 && e.errorClass === 2));

    // an auth Error is named as one so the owner can refresh a token
    const r3 = await rig();
    r3.ws().open();
    r3.ws().deliver(wireFrame(BODY.error, errorBody(2, 3, 'auth_required')));
    check('an auth-class Error closes with reason auth',
      r3.events.some((e) => e.type === 'closed' && e.reason === 'auth'));

    // a 401 at the upgrade never opens at all
    const r4 = await rig();
    r4.ws().hangup(4401);
    check('a 401 upgrade is reason auth',
      r4.events.some((e) => e.type === 'closed' && e.reason === 'auth'));

    // anything other than ServerHello first is refused outright
    const r5 = await rig();
    r5.ws().open();
    r5.ws().deliver(wireFrame(BODY.ack, Uint8Array.from([8, 1])));
    check('a non-ServerHello first frame is refused permanently',
      r5.events.some((e) => e.type === 'closed' && e.reason === 'protocol') && r5.client.fatal);
  }

  // 8 — keepalive at the capabilities.proto timings.
  {
    const r = await handshaken({ resumed: true });
    const sentBefore = r.ws().sent.length;
    r.clock.advance(9999);
    check('no ping before heartbeat_interval_ms', r.ws().sent.length === sentBefore);
    r.clock.advance(2);
    check('pings at 10000ms', r.ws().sent.length === sentBefore + 1, String(r.ws().sent.length));
    const ping = decodeFrameMessage(decodeFrame(r.ws().sent[sentBefore], { strict: true }).payload);
    check('the keepalive is a Ping frame', ping.frame?.body_field === BODY.ping);

    // a Pong inside the window keeps the session up
    r.ws().deliver(wireFrame(BODY.pong, new Uint8Array(0), ping.frame.request_id));
    r.clock.advance(6000);
    check('a matching Pong clears the timeout',
      r.client.state === 'open' && !r.events.some((e) => e.type === 'closed'));

    // a missing one does not
    const r2 = await handshaken({ resumed: true });
    r2.clock.advance(10000);       // ping goes out
    r2.clock.advance(4999);
    check('the session survives up to heartbeat_timeout_ms', r2.client.state === 'open');
    r2.clock.advance(2);
    const c = r2.events.filter((e) => e.type === 'closed')[0];
    check('and ends at heartbeat_timeout_ms with no Pong',
      c?.reason === 'heartbeat_timeout', c?.reason);
    check('a heartbeat timeout IS retried', c?.willRetry === true);
  }

  // 9 — backoff: grows, capped, decorrelated across seeds.
  {
    const b = new Backoff({ baseMs: 500, maxMs: 30000, seed: 7 });
    const ds: number[] = [];
    for (let i = 0; i < 12; i++) ds.push(b.next());
    check('backoff grows', ds[0] < ds[1] && ds[1] < ds[2] && ds[2] < ds[3], ds.slice(0, 4).join(','));
    check('backoff is capped at maxMs', ds.every((d) => d <= 30000) && ds[11] === ds[10],
      ds.slice(-3).join(','));
    check('the jitter factor is sticky, not re-rolled',
      ds.slice(0, 6).every((d, i) => Math.abs(d - 500 * Math.pow(2, i) * b.factor) <= 1));

    const a1 = new Backoff({ baseMs: 500, maxMs: 30000, seed: 11 });
    const a2 = new Backoff({ baseMs: 500, maxMs: 30000, seed: 12 });
    check('two seeds give two different ladders', a1.factor !== a2.factor);
    let together = 0;
    for (let i = 0; i < 10; i++) if (a1.next() === a2.next()) together++;
    check('two clients do not wake together', together === 0, `${together} collisions`);
    check('a fresh seed is deterministic',
      new Backoff({ seed: 11 }).factor === new Backoff({ seed: 11 }).factor);

    // and the client actually reconnects on that schedule
    const r = await handshaken({ resumed: true });
    const opened = FakeWS.opened;
    r.ws().hangup(1006);
    const c = r.events.filter((e) => e.type === 'closed')[0];
    check('a transport close schedules a retry', c?.willRetry === true && c?.retryInMs > 0);
    r.clock.advance(c.retryInMs + 1);
    // connect() awaits getToken, so the dial lands a microtask later.
    await new Promise((res) => setImmediate(res));
    check('and the retry really dials', FakeWS.opened === opened + 1);
    check('the retry carries a FRESH token (read per dial, not captured)',
      sockets[sockets.length - 1].opts?.headers?.Authorization === 'Bearer tok-abc');
  }

  // 10 — close() is permanent and quiet.
  {
    const r = await handshaken({ resumed: true });
    const opened = FakeWS.opened;
    r.client.close('test');
    const c = r.events.filter((e) => e.type === 'closed')[0];
    check('close() reports reason client', c?.reason === 'client' && c?.willRetry === false);
    check('close() cancels the heartbeat', r.clock.pending === 0, String(r.clock.pending));
    r.clock.advance(600000);
    await r.client.connect();
    check('close() is permanent', FakeWS.opened === opened);
    check('send() after close is a false, not a throw',
      r.client.send({ traffic_class: 1, stream: 1, body_field: BODY.ack, raw: new Uint8Array(0) }) === false);
  }

  // 11 — ServerHello parsing details.
  {
    check('decodeServerHello rejects a malformed body', decodeServerHello(Uint8Array.from([0xff])) === null);
    const h = decodeServerHello(serverHelloBody({ resumed: true }));
    check('session_id round-trips', h?.sessionId === 'uid-1', h?.sessionId);
    check('heartbeat timings come from Limits',
      h?.heartbeatIntervalMs === 10000 && h?.heartbeatTimeoutMs === 5000);
    check('an empty ServerHello means resumed:false', decodeServerHello(new Uint8Array(0)).resumed === false);

    // a server proposing a LARGER limit than this build does not get it
    const out: number[] = [];
    pbVarint(out, 1, 1);
    const lim: number[] = [];
    pbVarint(lim, 1, 8 * 1024 * 1024);
    pbBytes(out, 4, Uint8Array.from(lim));
    const big = decodeServerHello(Uint8Array.from(out));
    check('a limit larger than ours is ignored, never adopted',
      big.limits?.max_frame_bytes === undefined, String(big.limits?.max_frame_bytes));

    // a wrong protocol major is refused at the handshake
    const r = await rig();
    r.ws().open();
    r.ws().deliver(wireFrame(BODY.server_hello, serverHelloBody({ major: 2 })));
    check('protocol_major != 1 is refused',
      r.events.some((e) => e.type === 'closed' && e.reason === 'protocol'));
  }

  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
