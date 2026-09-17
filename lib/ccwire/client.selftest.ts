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
//   9. backoff grows, is capped, and two seeds do not wake together;
//  10. an interval shorter than the timeout leaves no heartbeat timer behind,
//      and a silent link still dies at the first deadline;
//  11. a keepalive that cannot be written ends the session instead of quietly
//      disabling liveness detection;
//  12. a negotiated limit under the floor is ignored, a real tightening is not;
//  13. the resume token never reaches the public serverHello or the events;
//  14. an expired or over-capacity fragment set is recoverable, a malformed
//      fragment is still permanent;
//  15. the backoff seed is per-install, including at the lib/socket.ts dialler;
//  16. a resume token survives byte-exactly, whatever bytes it is made of;
//  17. a reported position never steps over an incomplete fragment set, on the
//      heartbeat or in the resume that follows the drop;
//  18. a handshake that does not stay up does not reset the backoff;
//  19. a session that offered no resume reports no inherited positions;
//  20. the resume token is not an own property of the client, and logout
//      clears it;
//  21. an auth close code is an auth close, whatever phase it arrives in.
//
// NOT pinned, and cannot be: that any of this interoperates with the Go server.
// That needs CCWIRE_WS=1 and a live socket.

import {
  CCWireClient,
  Backoff,
  BODY,
  decodeServerHello,
  encodeClientHello,
  seedFromDeviceId,
  type CCWireEvent,
} from './client';
import { encodeFrame, decodeFrame, HEADER_BYTES } from './frame';
import { encodeFrameMessage, decodeFrameMessage } from './codec';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

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

interface HelloOpts {
  resumed?: boolean; major?: number; limits?: boolean; appEvents?: boolean;
  /** Limits the server proposes, when the defaults are not what is under test. */
  frameBytes?: number; hbInterval?: number; hbTimeout?: number;
  /** Capabilities.resumption, and the credential it comes with. */
  resumption?: boolean; resumeToken?: string;
}
function serverHelloBody(o: HelloOpts = {}): Uint8Array {
  const out: number[] = [];
  pbVarint(out, 1, o.major ?? 1);          // protocol_major
  if (o.limits !== false) {
    const lim: number[] = [];
    pbVarint(lim, 1, o.frameBytes ?? 262144);      // max_frame_bytes
    pbVarint(lim, 13, o.hbInterval ?? 10000);      // heartbeat_interval_ms
    pbVarint(lim, 14, o.hbTimeout ?? 5000);        // heartbeat_timeout_ms
    pbBytes(out, 4, Uint8Array.from(lim));
  }
  pbBytes(out, 5, new TextEncoder().encode('uid-1'));   // session_id
  if (o.resumeToken) pbBytes(out, 6, new TextEncoder().encode(o.resumeToken));
  if (o.appEvents || o.resumption) {
    const caps: number[] = [];
    pbVarint(caps, 1, 1);                  // fragmentation
    if (o.resumption) pbVarint(caps, 2, 1);        // resumption
    if (o.appEvents) pbVarint(caps, 8, 1);         // app_events_v1
    pbBytes(out, 3, Uint8Array.from(caps));
  }
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

/** A server->client frame carrying a stream and a sequence number. */
function seqFrame(bodyField: number, body: Uint8Array, stream: number, seq: string): Uint8Array {
  const enc = encodeFrameMessage({
    request_id: '',
    traffic_class: 1,
    stream,
    seq,
    body_field: bodyField,
    raw: body,
  });
  if (!enc.ok) throw new Error(`test fixture would not encode: ${enc.error} ${enc.detail}`);
  return encodeFrame(enc.bytes);
}

/** Read the StreamCursor entries out of a Ping body the client just sent. */
function progressOf(pingBody: Uint8Array): { stream: number; seq: string }[] {
  const out: { stream: number; seq: string }[] = [];
  let i = 0;
  const vi = (): bigint => {
    let v = 0n, shift = 0n;
    for (;;) {
      const b = pingBody[i++];
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
    }
  };
  while (i < pingBody.length) {
    const tag = Number(vi());
    if ((tag >>> 3) !== 2 || (tag & 7) !== 2) throw new Error('unexpected field in Ping body');
    const len = Number(vi());
    const end = i + len;
    let stream = 0; let seq = '0';
    while (i < end) {
      const t = Number(vi());
      const v = vi();
      if ((t >>> 3) === 1) stream = Number(v);
      if ((t >>> 3) === 2) seq = v.toString();
    }
    out.push({ stream, seq });
  }
  return out;
}

/**
 * The StreamCursor entries on ONE field of a control body — Ping.progress is
 * field 2, ClientHello.resume_from is field 8. Unlike progressOf above this one
 * skips fields it does not recognise instead of refusing them, because a
 * ClientHello carries several others.
 */
function cursorsOn(body: Uint8Array, field: number): { stream: number; seq: string }[] {
  const out: { stream: number; seq: string }[] = [];
  let i = 0;
  const vi = (): bigint => {
    let v = 0n, shift = 0n;
    for (;;) {
      const b = body[i++];
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
    }
  };
  while (i < body.length) {
    const tag = Number(vi());
    const wire = tag & 7;
    if (wire === 0) { vi(); continue; }
    if (wire !== 2) throw new Error(`unexpected wire type ${wire}`);
    const len = Number(vi());
    const end = i + len;
    if ((tag >>> 3) !== field) { i = end; continue; }
    let stream = 0; let seq = '0';
    while (i < end) {
      const t = Number(vi());
      const v = vi();
      if ((t >>> 3) === 1) stream = Number(v);
      if ((t >>> 3) === 2) seq = v.toString();
    }
    out.push({ stream, seq });
  }
  return out;
}

/** The ClientHello body out of one framed message this client sent. */
function clientHelloBody(raw: Uint8Array): Uint8Array {
  const f = decodeFrame(raw, { maxBytes: 262144 });
  if (!f.ok) throw new Error(`not a frame: ${f.error}`);
  const m = decodeFrameMessage(f.payload!, { maxBytes: 262144 });
  if (!m.ok || m.frame.body_field !== BODY.client_hello) throw new Error('not a ClientHello');
  return m.frame.raw ?? new Uint8Array(0);
}

/** The body of the most recent Ping this client sent. */
function lastPingBody(ws: FakeWS): Uint8Array {
  for (let i = ws.sent.length - 1; i >= 0; i--) {
    const f = decodeFrame(ws.sent[i], { maxBytes: 262144 });
    if (!f.ok) continue;
    const m = decodeFrameMessage(f.payload!, { maxBytes: 262144 });
    if (m.ok && m.frame.body_field === BODY.ping) return m.frame.raw ?? new Uint8Array(0);
  }
  throw new Error('no Ping was sent');
}

/** The request_id of the most recent Ping this client sent, to answer it. */
function lastPingId(ws: FakeWS): string {
  for (let i = ws.sent.length - 1; i >= 0; i--) {
    const f = decodeFrame(ws.sent[i], { maxBytes: 262144 });
    if (!f.ok) continue;
    const m = decodeFrameMessage(f.payload!, { maxBytes: 262144 });
    if (m.ok && m.frame.body_field === BODY.ping) return m.frame.request_id ?? '';
  }
  throw new Error('no Ping was sent');
}

/** One Fragment (body 112) frame, the shape transport.ts splits app events into. */
function fragmentFrame(
  o: { id: string; index: number; total: number; totalBytes: number; chunk: Uint8Array; last?: boolean },
  seq = '1',
): Uint8Array {
  const frag: number[] = [];
  pbBytes(frag, 1, new TextEncoder().encode(o.id));   // fragment_id
  pbVarint(frag, 2, o.index);
  pbVarint(frag, 3, o.total);
  pbVarint(frag, 4, o.totalBytes);
  pbBytes(frag, 5, o.chunk);
  if (o.last ?? (o.index === o.total - 1)) pbVarint(frag, 6, 1);
  return seqFrame(112, Uint8Array.from(frag), 1, seq);
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
async function handshaken(o: HelloOpts = {}) {
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

  // 10 — positions: the half of resume that lives on this side.
  {
    // A sequenced frame must reach Ping.progress. Without it the server never
    // releases what it retained, and on reconnect it has a token naming the
    // session but no position to replay from — so it refuses and the client
    // full-resyncs, every time.
    const r = await handshaken({ resumed: true });
    r.ws().deliver(seqFrame(100, new Uint8Array(0), 2, '41'));
    r.clock.advance(10_000);   // one heartbeat
    const p = progressOf(lastPingBody(r.ws()));
    check('a delivered frame is reported in Ping.progress',
      p.length === 1 && p[0].stream === 2 && p[0].seq === '41', JSON.stringify(p));
  }

  {
    // THE FRAGMENT carries the seq, not the app_event inside it: the inner
    // message is encoded once and then split, so it has none of its own.
    // Recording only the reassembled frame loses the position of every
    // fragmented event — and for a client whose traffic is mostly fragmented,
    // that means nothing to report and every resume refused.
    const r = await handshaken({ resumed: true, appEvents: true });
    const eventBody: number[] = [];
    pbBytes(eventBody, 1, new TextEncoder().encode('echo'));
    pbBytes(eventBody, 2, new TextEncoder().encode('{}'));
    const inner = encodeFrameMessage({
      request_id: '', traffic_class: 1, stream: 1, body_field: 100,
      raw: Uint8Array.from(eventBody),
    }, { maxBytes: 2 << 20, appEventsV1: true });
    if (!inner.ok) throw new Error('inner app_event would not encode');
    const frag: number[] = [];
    pbBytes(frag, 1, new TextEncoder().encode('frag-1'));   // fragment_id
    pbVarint(frag, 2, 0);                                   // index
    pbVarint(frag, 3, 1);                                   // total
    pbVarint(frag, 4, inner.bytes.length);                  // total_bytes
    pbBytes(frag, 5, inner.bytes);                          // chunk
    pbVarint(frag, 6, 1);                                   // last
    r.ws().deliver(seqFrame(112, Uint8Array.from(frag), 1, '77'));
    r.clock.advance(10_000);
    const p = progressOf(lastPingBody(r.ws()));
    check('a FRAGMENT frame reports its own sequence number',
      p.some((c) => c.stream === 1 && c.seq === '77'), JSON.stringify(p));
  }

  {
    // Positions belong to the session that produced them. A server answering
    // resumed=false has started a NEW session whose sequence numbers begin
    // again at 1; carrying the old ones forward makes the next reconnect offer
    // a resume_from far ahead of anything that session sent, which the server
    // refuses as a future cursor. One un-resumed connection would poison every
    // resume after it, for the life of the process.
    const r = await handshaken({ resumed: true });
    r.ws().deliver(seqFrame(100, new Uint8Array(0), 2, '5000'));
    r.clock.advance(10_000);
    check('positions are tracked while resumed',
      progressOf(lastPingBody(r.ws())).length === 1);

    // Reconnect, and this time the server refuses the resume.
    r.ws().hangup(1006);
    const c = r.events.filter((e) => e.type === 'closed').pop() as any;
    r.clock.advance(c.retryInMs + 1);
    // connect() awaits getToken, so the dial lands a microtask later.
    await new Promise((res) => setImmediate(res));
    const next = sockets[sockets.length - 1];
    next.open();
    next.deliver(wireFrame(BODY.server_hello, serverHelloBody({ resumed: false })));
    next.sent.length = 0;
    r.clock.advance(10_000);
    check('resumed=false clears the positions of the dead session',
      progressOf(lastPingBody(next)).length === 0,
      JSON.stringify(progressOf(lastPingBody(next))));
  }

  {
    // A KEEPALIVE DEADLINE THAT WAS FORGOTTEN, NOT CLEARED.
    //
    // heartbeat_interval_ms and heartbeat_timeout_ms are read independently and
    // never compared, so an interval SHORTER than the timeout is reachable.
    // Beat 1 arms a deadline at t=6s; beat 2 at t=2s replaces the handle while
    // that timer is still armed. Every Pong then clears the handle we kept —
    // and the forgotten one fires at 6s into a session that has been answering
    // all along.
    const r = await rig();
    r.ws().open();
    r.ws().deliver(wireFrame(BODY.server_hello,
      serverHelloBody({ resumed: true, hbInterval: 1000, hbTimeout: 5000 })));
    // One Pong slower than the interval is the whole setup: beat 2 goes out
    // before beat 1 has been answered.
    r.clock.advance(1000);
    r.clock.advance(1000);
    for (let i = 0; i < 8; i++) {
      r.ws().deliver(wireFrame(BODY.pong, new Uint8Array(0), lastPingId(r.ws())));
      r.clock.advance(1000);
    }
    check('an answered link is never torn down by a stale heartbeat deadline',
      r.client.state === 'open' && !r.events.some((e) => e.type === 'closed'),
      JSON.stringify(r.events.filter((e) => e.type === 'closed')));

    // …and a link that stops answering must still die, at the FIRST deadline.
    const r2 = await rig();
    r2.ws().open();
    r2.ws().deliver(wireFrame(BODY.server_hello,
      serverHelloBody({ resumed: true, hbInterval: 1000, hbTimeout: 5000 })));
    r2.clock.advance(7000);
    check('a silent link still times out when the interval is the shorter one',
      r2.events.some((e) => e.type === 'closed' && e.reason === 'heartbeat_timeout'),
      r2.client.state);
    // The retry this close scheduled has already begun awaiting a token; left
    // running it would dial into the NEXT test's socket list.
    r2.client.close('end of case');
  }

  {
    // A KEEPALIVE THAT CANNOT BE WRITTEN IS THE END OF THE SESSION.
    //
    // Bailing out of the beat left neither timer armed: no Ping, no Pong
    // deadline, no liveness detection at all, and the client sat in 'open' on a
    // socket that may already be dead. An encode refusal never touches the
    // socket, so nothing else reports it either.
    const r = await handshaken({ resumed: true });
    r.client.maxFrameBytes = 1;
    r.clock.advance(10_000);
    const c = r.events.filter((e) => e.type === 'closed')[0];
    check('a keepalive that cannot be written ends the session',
      c?.reason === 'transport', `${c?.reason} / state ${r.client.state}`);
    check('and is retried, not made permanent',
      c?.willRetry === true && r.client.fatal === false);
    check('no live session is left behind a dead heartbeat', r.client.state === 'closed');
  }

  {
    // NEGOTIATED LIMITS HAVE A FLOOR. `max_frame_bytes: 1` tightens by the
    // letter of the rule and makes every frame this client writes — the
    // keepalive included — unencodable, which is how the heartbeat above came
    // to be reachable in the first place.
    const out: number[] = [];
    pbVarint(out, 1, 1);
    const lim: number[] = [];
    pbVarint(lim, 1, 1);
    pbBytes(out, 4, Uint8Array.from(lim));
    const floored = decodeServerHello(Uint8Array.from(out));
    check('a limit below the floor is ignored, never adopted',
      floored.limits?.max_frame_bytes === undefined, String(floored.limits?.max_frame_bytes));

    const r = await rig();
    r.ws().open();
    r.ws().deliver(wireFrame(BODY.server_hello, serverHelloBody({ resumed: true, frameBytes: 1 })));
    check('the client keeps its own frame cap', r.client.maxFrameBytes === 262144,
      String(r.client.maxFrameBytes));
    const before = r.ws().sent.length;
    r.clock.advance(10_000);
    check('and the keepalive still goes out', r.ws().sent.length === before + 1);

    // A real tightening is still honoured — the floor is a sanity bound, not a
    // refusal to negotiate.
    const r2 = await rig();
    r2.ws().open();
    r2.ws().deliver(wireFrame(BODY.server_hello, serverHelloBody({ resumed: true, frameBytes: 65536 })));
    check('a tightening above the floor is still adopted', r2.client.maxFrameBytes === 65536,
      String(r2.client.maxFrameBytes));
  }

  {
    // THE CREDENTIAL DOES NOT LIVE ON A PUBLIC FIELD. `serverHello` is reachable
    // through ccwireClient() and documented for diagnostics, which is exactly
    // what a crash reporter serialises — and nothing ever clears it.
    const r = await rig();
    r.ws().open();
    r.ws().deliver(wireFrame(BODY.server_hello,
      serverHelloBody({ resumed: true, resumption: true, resumeToken: 'rt-secret' })));
    check('the resume token is not on the public serverHello',
      !JSON.stringify(r.client.serverHello).includes('rt-secret'),
      JSON.stringify(r.client.serverHello));
    check('nor on the hello event handed to listeners',
      !JSON.stringify(r.events.filter((e) => e.type === 'hello')).includes('rt-secret'));

    // …and the private copy still does the job the token exists for.
    r.ws().hangup(1006);
    const c = r.events.filter((e) => e.type === 'closed').pop() as any;
    r.clock.advance(c.retryInMs + 1);
    await new Promise((res) => setImmediate(res));
    const next = sockets[sockets.length - 1];
    next.open();
    check('the next ClientHello still carries the token',
      Buffer.from(next.sent[0]).includes('rt-secret'));
  }

  {
    // A REASSEMBLY HICCUP IS NOT A PROTOCOL VIOLATION. down('protocol') sets
    // fatal, which transport.ts reports as recoverable=false — CC-Wire never
    // restarts for the rest of the app session. A backgrounded app has its JS
    // timers throttled, so the expiry sweep never runs and the last fragment
    // lands 40 s late: `now` moves, the clock's tasks do not.
    let clockRef: Clock = null;
    let skew = 0;
    const r = await rig({ now: () => clockRef.now + skew });
    clockRef = r.clock;
    r.ws().open();
    r.ws().deliver(wireFrame(BODY.server_hello, serverHelloBody({ resumed: true, appEvents: true })));
    const half = new Uint8Array(8).fill(7);
    r.ws().deliver(fragmentFrame({ id: 'frag-late', index: 0, total: 2, totalBytes: 16, chunk: half }));
    skew = 40_000;
    r.ws().deliver(fragmentFrame({ id: 'frag-late', index: 1, total: 2, totalBytes: 16, chunk: half }));
    check('an expired partial set does not kill realtime for the session',
      r.client.fatal === false && r.client.state === 'open',
      `${r.client.state} fatal=${r.client.fatal}`);
    r.ws().deliver(wireFrame(BODY.ack, Uint8Array.from([8, 1])));
    check('and the session keeps delivering frames afterwards',
      r.events.filter((e) => e.type === 'frame').length === 1);

    // The checks that catch genuinely malformed input are untouched: `last` on
    // an index that is not the final one is something no correct server sends.
    const r2 = await handshaken({ resumed: true, appEvents: true });
    r2.ws().deliver(fragmentFrame({ id: 'frag-bad', index: 0, total: 2, totalBytes: 16, chunk: half, last: true }));
    check('a malformed fragment is still a permanent protocol violation',
      r2.events.some((e) => e.type === 'closed' && e.reason === 'protocol') && r2.client.fatal === true,
      `${r2.client.fatal}`);
  }

  {
    // BACKOFF JITTER IS PER-INSTALL OR IT IS NOT JITTER. Left unset the seed
    // defaults to 1, mulberry32(1) draws one fixed value, and every handset
    // rebuilds the same ladder — the thundering herd the sticky factor exists
    // to prevent, reassembled.
    check('two device ids give two seeds',
      seedFromDeviceId('device-a') !== seedFromDeviceId('device-b'));
    check('the same device id is stable', seedFromDeviceId('device-a') === seedFromDeviceId('device-a'));
    check('two installs do not share a backoff ladder',
      new Backoff({ seed: seedFromDeviceId('device-a') }).factor
      !== new Backoff({ seed: seedFromDeviceId('device-b') }).factor);
    check('no device id still means no shared constant',
      seedFromDeviceId() !== seedFromDeviceId());

    // The dialler in the app is the one that mattered: transport.ts forwards
    // seed and the client defaults it to 1, so a call site that omits it puts
    // the whole fleet on one ladder.
    const src = readFileSync(join(HERE, '..', 'socket.ts'), 'utf8');
    check('lib/socket.ts passes a per-install seed to CC-Wire',
      /seed:\s*seedFromDeviceId\(/.test(src));
  }

  {
    // resume_token is `bytes`. A lenient UTF-8 decode substitutes U+FFFD, and
    // the token that goes back out is then one the server never issued: the
    // resume is refused with no error anywhere, for the life of the install.
    const raw = Uint8Array.from([0x74, 0x6f, 0xff, 0x6b]);   // not valid UTF-8
    const out: number[] = [];
    pbVarint(out, 1, 1);
    pbBytes(out, 6, raw);
    const h = decodeServerHello(Uint8Array.from(out));
    const hello = encodeClientHello('dev-1', { token: h.resumeToken });
    check('a resume token survives byte-exactly into the next ClientHello',
      Buffer.from(hello).includes(Buffer.from(raw)), Buffer.from(hello).toString('hex'));

    // An ASCII token is byte-for-byte what it always was on the wire.
    const ascii = decodeServerHello(serverHelloBody({ resumeToken: 'tok-1' }));
    check('an ASCII token is unchanged', ascii.resumeToken === 'tok-1', ascii.resumeToken);
    check('and session_id still decodes as text', ascii.sessionId === 'uid-1', ascii.sessionId);
  }

  {
    // A POSITION MUST NEVER STEP OVER A HOLE.
    //
    // Recording only at completion stops the FRAGMENTS from advancing the
    // position; it does not stop anything else. Fragment 0 of 2 lands at
    // stream 1 seq 10, an ordinary frame lands at seq 12, and the reported
    // position was 12 — a promise covering two fragments the app never saw.
    // The socket then drops, down() throws the partial set away, the resume
    // asks to replay from 13, and the server is free to release 10 and 11. The
    // event is gone, silently and for good.
    const r = await handshaken({ resumed: true, appEvents: true, resumption: true, resumeToken: 'rt-frag' });
    const half = new Uint8Array(8).fill(7);
    r.ws().deliver(fragmentFrame({ id: 'frag-hole', index: 0, total: 2, totalBytes: 16, chunk: half }, '10'));
    r.ws().deliver(seqFrame(BODY.ack, Uint8Array.from([8, 1]), 1, '12'));
    r.clock.advance(10_000);
    const p = progressOf(lastPingBody(r.ws()));
    check('an incomplete fragment set holds Ping.progress back to its gap',
      p.length === 1 && p[0].stream === 1 && p[0].seq === '9', JSON.stringify(p));

    // …and the drop must not release it. resume_from is built from the same
    // positions AFTER the partial set has been discarded, so the ceiling has to
    // have been folded in before it went.
    r.ws().hangup(1006);
    const c = r.events.filter((e) => e.type === 'closed').pop() as any;
    r.clock.advance(c.retryInMs + 1);
    await new Promise((res) => setImmediate(res));
    const next = sockets[sockets.length - 1];
    next.open();
    const from = cursorsOn(clientHelloBody(next.sent[0]), 8);
    check('and the resume asks to replay from the gap, not from after it',
      from.length === 1 && from[0].stream === 1 && from[0].seq === '9', JSON.stringify(from));
    r.client.close('end of case');

    // A COMPLETED set releases the ceiling, or the stream's position would
    // stall at the first fragmented event for the life of the session.
    const r2 = await handshaken({ resumed: true, appEvents: true });
    const eventBody: number[] = [];
    pbBytes(eventBody, 1, new TextEncoder().encode('echo'));
    pbBytes(eventBody, 2, new TextEncoder().encode('{}'));
    const inner = encodeFrameMessage({
      request_id: '', traffic_class: 1, stream: 1, body_field: 100, raw: Uint8Array.from(eventBody),
    }, { maxBytes: 2 << 20, appEventsV1: true });
    if (!inner.ok) throw new Error('inner app_event would not encode');
    const cut = Math.floor(inner.bytes.length / 2);
    const whole = { id: 'frag-whole', total: 2, totalBytes: inner.bytes.length };
    r2.ws().deliver(fragmentFrame({ ...whole, index: 0, chunk: inner.bytes.subarray(0, cut) }, '10'));
    r2.ws().deliver(fragmentFrame({ ...whole, index: 1, chunk: inner.bytes.subarray(cut) }, '11'));
    r2.ws().deliver(seqFrame(BODY.ack, Uint8Array.from([8, 1]), 1, '12'));
    r2.clock.advance(10_000);
    const done = progressOf(lastPingBody(r2.ws()));
    check('a completed set stops holding the position back',
      done.length === 1 && done[0].seq === '12', JSON.stringify(done));
  }

  {
    // A COMPLETED HANDSHAKE IS NOT A HEALTHY SESSION.
    //
    // backoff.reset() on ServerHello meant a server that answers the handshake
    // and then drops the socket — a load balancer killing it just after the
    // upgrade, a server crash-looping after it replies — was redialled forever
    // at the bottom of the ladder: six hello-then-drop rounds all ~407ms apart,
    // about 2.5 dials a second per handset for as long as the app is
    // foregrounded, against 407/814/1627/3254/6508/13017 when no ServerHello
    // arrives at all.
    const r = await rig();
    const delays: number[] = [];
    let ws = r.ws();
    for (let i = 0; i < 6; i++) {
      ws.open();
      ws.deliver(wireFrame(BODY.server_hello, serverHelloBody({ resumed: true })));
      ws.hangup(1006);
      const c = r.events.filter((e) => e.type === 'closed').pop() as any;
      delays.push(c.retryInMs);
      r.clock.advance(c.retryInMs + 1);
      await new Promise((res) => setImmediate(res));
      ws = sockets[sockets.length - 1];
    }
    check('a handshake that does not stay up still ramps the backoff',
      delays.every((d, i) => i === 0 || d > delays[i - 1]), delays.join(','));
    r.client.close('end of case');

    // …and the ramp must still collapse for a session that was genuinely
    // healthy, or every real reconnect would inherit the last outage's delay.
    const r2 = await handshaken({ resumed: true });
    r2.clock.advance(10_000);                       // the first Ping goes out
    r2.ws().deliver(wireFrame(BODY.pong, new Uint8Array(0), lastPingId(r2.ws())));
    r2.ws().hangup(1006);
    const healthy = r2.events.filter((e) => e.type === 'closed').pop() as any;
    check('a session that answered a Pong reconnects from the short delay',
      healthy?.retryInMs === delays[0], `${healthy?.retryInMs} vs ${delays[0]}`);
    r2.client.close('end of case');
  }

  {
    // A SESSION THAT ASKED NOTHING CANNOT HAVE BEEN ANSWERED.
    //
    // resume_from is gated on holding a token. Ping.progress was gated on
    // nothing, and streamSeq was cleared only on resumed=false — so a
    // connection that offered no token and was told resumed:true inherited the
    // dead session's cursors and reported them on its first heartbeat. The new
    // session numbers from 1, which makes that a future cursor: the same
    // "client's own memory fed back as a position" the ClientHello note in
    // client.ts is written about. Today's server never sets resumed, so this is
    // a trap rather than an outage.
    const r = await handshaken({ resumed: true });   // no resumption: no token is kept
    r.ws().deliver(seqFrame(100, new Uint8Array(0), 1, '500'));
    r.clock.advance(10_000);
    check('positions are reported while the session that produced them is up',
      progressOf(lastPingBody(r.ws())).length === 1);

    r.ws().hangup(1006);
    const c = r.events.filter((e) => e.type === 'closed').pop() as any;
    r.clock.advance(c.retryInMs + 1);
    await new Promise((res) => setImmediate(res));
    const next = sockets[sockets.length - 1];
    next.open();
    check('a ClientHello with no token offers no positions either',
      cursorsOn(clientHelloBody(next.sent[0]), 8).length === 0);
    next.deliver(wireFrame(BODY.server_hello, serverHelloBody({ resumed: true })));
    next.sent.length = 0;
    r.clock.advance(10_000);
    const p = progressOf(lastPingBody(next));
    check('and resumed:true on a session that offered nothing reports nothing',
      p.length === 0, JSON.stringify(p));
    r.client.close('end of case');
  }

  {
    // THE CREDENTIAL IS NOT AN OWN PROPERTY OF THE CLIENT.
    //
    // TypeScript's `private` is a compile-time annotation and nothing more: the
    // field is an ordinary enumerable property at runtime. ccwireClient() in
    // transport.ts hands this object out "for diagnostics", which is exactly
    // what a crash reporter or a state dump serialises — so stripping the token
    // from the public serverHello moved the hazard one field over rather than
    // removing it, and close() left the token live afterwards.
    const r = await rig();
    r.ws().open();
    r.ws().deliver(wireFrame(BODY.server_hello,
      serverHelloBody({ resumed: true, resumption: true, resumeToken: 'rt-dump' })));
    check('the token is not readable as a property of the client',
      (r.client as any).resumeToken === undefined, String((r.client as any).resumeToken));
    check('nor present in a state dump of it',
      !JSON.stringify(r.client).includes('rt-dump'), JSON.stringify(r.client));
    check('nor in its own keys', !Object.keys(r.client).some((k) => (r.client as any)[k] === 'rt-dump'));
    r.client.close('logout');
    check('and logout leaves nothing behind for the next reader',
      !JSON.stringify(r.client).includes('rt-dump'));
  }

  {
    // AUTH IS TOLD BY THE CLOSE CODE, NOT BY THE PHASE.
    //
    // ccwire.go's refuse() sends its 1008 AFTER the upgrade has succeeded, so
    // an expired token is refused while this client is still 'handshaking'.
    // Testing the phase first reported that as handshake_incomplete — "the
    // server went away", not "your credential is stale" — and eventsSocket.ts
    // refreshes the access token only for a reason containing 'auth'. The
    // refresh never fired: the client spent its retry budget re-offering the
    // same dead token and surfaced 'CC-Wire unavailable'.
    const r = await rig();
    r.ws().open();
    r.ws().hangup(1008);
    const c = r.events.filter((e) => e.type === 'closed')[0];
    check('a 1008 AFTER the upgrade is an auth refusal, not an incomplete handshake',
      c?.reason === 'auth', c?.reason);

    const r2 = await rig();
    r2.ws().open();
    r2.ws().hangup(4401);
    check('and so is a 4401 after the upgrade',
      r2.events.filter((e) => e.type === 'closed')[0]?.reason === 'auth',
      r2.events.filter((e) => e.type === 'closed')[0]?.reason);

    // A close with no code to go on is still the handshake failing, which is
    // what the phase was there to say.
    const r3 = await rig();
    r3.ws().open();
    r3.ws().hangup(1006);
    check('an uncoded close mid-handshake is still handshake_incomplete',
      r3.events.filter((e) => e.type === 'closed')[0]?.reason === 'handshake_incomplete',
      r3.events.filter((e) => e.type === 'closed')[0]?.reason);
    r.client.close('end of case'); r2.client.close('end of case'); r3.client.close('end of case');
  }

  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
