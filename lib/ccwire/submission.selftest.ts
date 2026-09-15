// Run: npx tsx lib/ccwire/submission.selftest.ts
import assert from 'node:assert/strict';
import { encodeFrame, decodeStream } from './frame';
import { encodeFrameMessage, decodeFrameMessage, decodeMessageAck, type SubmitMessage } from './codec';
import { startCCWire, stopCCWire, submitCCWireMessage, ccwireDiagnostics, ccwireWebTransportUrl, __resetCCWireForTest, type StartCCWireOptions } from './transport';

class Socket {
  static current: Socket;
  onopen: any; onmessage: any; onclose: any;
  closed = false;
  sent: Uint8Array[] = [];
  constructor() { Socket.current = this; }
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close() { this.closed = true; }
  receive(field: number, raw: number[], request_id = '') {
    const encoded = encodeFrameMessage({ request_id, traffic_class: 1, stream: 1, body_field: field, raw: Uint8Array.from(raw) });
    assert.ok(encoded.ok);
    this.onmessage({ data: encodeFrame(encoded.bytes!) });
  }
}
const timers = new Map<number, { fn: () => void; ms: number }>();
let timerId = 0;
async function ready(options: Partial<StartCCWireOptions> = {}) {
  __resetCCWireForTest();
  timers.clear();
  startCCWire({ serverUrl: 'https://example.invalid', getToken: () => 'token', WebSocketImpl: Socket, carrier: 'rust-ws',
    setTimeoutImpl: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeoutImpl: (id) => { timers.delete(id); }, ...options });
  await Promise.resolve(); await Promise.resolve();
  Socket.current.onopen({});
  Socket.current.receive(17, [8, 1, 64, 1]);
  return Socket.current;
}
function lastSubmit(socket: Socket) {
  const framed = decodeStream(socket.sent.at(-1)!);
  assert.equal(framed.error, undefined);
  const decoded = decodeFrameMessage(framed.frames![0]);
  assert.ok(decoded.ok);
  return decoded.frame!;
}
const payload = { content: 'E2EE:ciphertext-with-private-envelope', type: 'text', clientId: 'stable-client-id', meta: { encrypted: true, mentionUserIds: ['peer'] } };
const canonical = { id: '42', chatId: 'chat-1', senderId: 'me', type: 'text', content: payload.content, expiresAt: '2026-09-16T00:00:00Z', vanishAfterRead: true };

async function main() {
  let socket = await ready();
  let reads = 0, posts = 0;
  const http: any = async (path: string, options?: any) => {
    if (options?.method === 'POST') { posts++; assert.deepEqual(options.json, payload); return canonical; }
    reads++; assert.equal(path, '/chats/chat-1/messages?before=43&limit=1'); return [canonical];
  };
  const send = submitCCWireMessage('chat-1', payload, http);
  const frame = lastSubmit(socket);
  assert.equal(frame.body_field, 48);
  const submitted = frame.value as SubmitMessage;
  assert.equal(submitted.envelope!.client_msg_id, payload.clientId);
  assert.equal(new TextDecoder().decode(submitted.sealed), payload.content);
  assert.deepEqual(submitted.envelope!.public_meta!.mention_user_ids, ['peer']);
  socket.receive(22, [10, 2, 52, 50], 'wrong-request');
  assert.equal(reads, 0);
  socket.receive(49, [], frame.request_id); // live delivery belongs solely to Socket.IO
  assert.equal(reads, 0);
  socket.receive(22, [10, 2, 52, 50], frame.request_id);
  assert.deepEqual(await send, { message: canonical, transport: 'ccwire-rust-ws' });
  assert.equal(posts, 0);
  assert.equal(ccwireDiagnostics().acknowledged, 1);

  for (const extra of [{ type: 'image' }, { replyToId: 12 }, { meta: { revoked: true } }, { meta: { audience: {} } }]) {
    const before = socket.sent.length;
    const request = { ...payload, ...extra };
    let calls = 0;
    const result = await submitCCWireMessage('chat-1', request as any, (async (_path: string, opts: any) => {
      calls++; assert.deepEqual(opts.json, request); return canonical;
    }) as any);
    assert.equal(result.transport, 'http'); assert.equal(calls, 1); assert.equal(socket.sent.length, before);
  }

  // Lost Ack after commit: one sequential fallback, byte-identical payload/key.
  socket = await ready(); reads = 0; posts = 0;
  const lost = submitCCWireMessage('chat-1', payload, http);
  const lostFrame = lastSubmit(socket);
  [...timers.values()].find((t) => t.ms === 12000)!.fn();
  assert.equal((await lost).transport, 'http');
  assert.equal(posts, 1); assert.equal(reads, 0);
  socket.receive(22, [10, 2, 52, 50], lostFrame.request_id);
  assert.equal(posts, 1); assert.equal(ccwireDiagnostics().acknowledged, 0);

  // Connection loss releases the request immediately into the same fallback.
  socket = await ready(); posts = 0;
  const dropped = submitCCWireMessage('chat-1', payload, http);
  socket.onclose({ code: 1006 });
  assert.equal((await dropped).transport, 'http'); assert.equal(posts, 1);

  // Account switch must never replay an old user's message with a new token.
  socket = await ready(); posts = 0;
  const logout = submitCCWireMessage('chat-1', payload, http);
  stopCCWire('logout');
  await assert.rejects(logout, /session ended/i); assert.equal(posts, 0);
  assert.equal(ccwireDiagnostics().status, 'off');
  startCCWire({ serverUrl: 'https://example.invalid', getToken: () => 'new-account-token', WebSocketImpl: Socket,
    setTimeoutImpl: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeoutImpl: (id) => { timers.delete(id); } });
  await Promise.resolve(); await Promise.resolve();
  Socket.current.onopen({});
  Socket.current.receive(17, [8, 1, 64, 1]);
  assert.equal(ccwireDiagnostics().status, 'ready');

  // A malformed Ack is not success; REST remains the authority.
  socket = await ready(); posts = 0;
  const malformed = submitCCWireMessage('chat-1', payload, http);
  socket.receive(22, [10, 8, 52], lastSubmit(socket).request_id);
  assert.equal((await malformed).transport, 'http'); assert.equal(posts, 1);
  assert.equal(decodeMessageAck(Uint8Array.from([10, 8, 52])).ok, false);

  // A canonical lookup cannot return a neighbouring row as this message.
  socket = await ready(); posts = 0;
  const wrongRow = submitCCWireMessage('chat-1', payload, (async (path: string, options?: any) => options ? http(path, options) : [{ ...canonical, id: '41' }]) as any);
  socket.receive(22, [10, 2, 52, 50], lastSubmit(socket).request_id);
  assert.equal((await wrongRow).transport, 'http'); assert.equal(posts, 1);

  // Concurrent direct sends correlate to their own Ack, even in reverse order.
  socket = await ready();
  const lookup: any = async (path: string) => [{ ...canonical, id: path.includes('before=44') ? '43' : '42' }];
  const first = submitCCWireMessage<any>('chat-1', payload, lookup);
  const firstRequest = lastSubmit(socket).request_id;
  const second = submitCCWireMessage<any>('chat-1', { ...payload, clientId: 'second-id' }, lookup);
  const secondRequest = lastSubmit(socket).request_id;
  assert.notEqual(firstRequest, secondRequest);
  socket.receive(22, [10, 2, 52, 51], secondRequest);
  socket.receive(22, [10, 2, 52, 50], firstRequest);
  assert.equal((await first).message.id, '42');
  assert.equal((await second).message.id, '43');

  // Explicit policy/payload refusals and rate limits do not gain a REST retry.
  for (const [code, status] of [[5, 403], [6, 429], [8, 400]]) {
    socket = await ready(); posts = 0;
    const denied = submitCCWireMessage('chat-1', payload, http);
    socket.receive(23, [8, code, 16, 1], lastSubmit(socket).request_id);
    await assert.rejects(denied, (error: any) => error.status === status);
    assert.equal(posts, 0);
  }

  assert.equal(ccwireWebTransportUrl('https://api.example.com'), undefined);
  assert.equal(ccwireWebTransportUrl('https://api.example.com', 'https://api.example.com:4443/ccwire/wt/v1'), 'https://api.example.com:4443/ccwire/wt/v1');
  for (const url of ['http://api.example.com/wt', 'https://other.example.com/wt', 'https://user@api.example.com/wt',
    'https://api.example.com/wt?token=secret', 'https://api.example.com/wt#fragment', '/ccwire/wt/v1']) {
    assert.equal(ccwireWebTransportUrl('https://api.example.com', url), undefined);
  }

  // WT gets one attempt; close pending requests before constructing WSS.
  socket = await ready({ carrier: 'rust-wt', webSocketFallback: { WebSocketImpl: Socket, carrier: 'rust-ws' } });
  assert.equal(ccwireDiagnostics().carrier, 'rust-wt');
  posts = 0;
  const handover = submitCCWireMessage('chat-1', payload, http);
  socket.onclose({ code: 1006 });
  assert.equal(socket.closed, true);
  assert.equal((await handover).transport, 'http');
  assert.equal(posts, 1);
  await Promise.resolve(); await Promise.resolve();
  const fallbackSocket = Socket.current;
  assert.notEqual(fallbackSocket, socket);
  fallbackSocket.onopen({});
  fallbackSocket.receive(17, [8, 1, 64, 1]);
  assert.equal(ccwireDiagnostics().carrier, 'rust-ws');
  assert.equal(ccwireDiagnostics().status, 'ready');

  // A silent WT handshake is bounded too, without waiting for native events.
  __resetCCWireForTest(); timers.clear();
  startCCWire({ serverUrl: 'https://example.invalid', getToken: () => 'token', WebSocketImpl: Socket, carrier: 'rust-wt',
    webSocketFallback: { WebSocketImpl: Socket, carrier: 'rust-ws' },
    setTimeoutImpl: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeoutImpl: (id) => { timers.delete(id); } });
  await Promise.resolve(); await Promise.resolve();
  socket = Socket.current;
  [...timers.values()].find((t) => t.ms === 15000)!.fn();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(socket.closed, true);
  assert.notEqual(Socket.current, socket);
  assert.equal(ccwireDiagnostics().carrier, 'rust-ws');

  __resetCCWireForTest();
  console.log('CC-Wire submission checks passed: protobuf, canonical Ack, metadata fallback, lost Ack, disconnect, logout, malformed Ack.');
}
main().catch((error) => { __resetCCWireForTest(); console.error(error); process.exitCode = 1; });
