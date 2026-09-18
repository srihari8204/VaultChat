// lib/chatsListProto.selftest.ts — run: npx tsx lib/chatsListProto.selftest.ts
//
// protobuf-migration batch C, CLIENT half. GET /chats opts into binary
// protobuf by passing a decoder to api(); everything else about listChats()
// stays where it was. What that has to be worth, in order of blast radius:
//
//   1. the typed path produces the SAME domain list as the JSON path, field
//      for field — because app/(tabs)/chats.tsx hands that list straight to
//      cacheChats(), which persists it verbatim. Any divergence is a rollback
//      break (lib/chatsCacheRollback.selftest.ts is the gate for that);
//   2. the same call still works against a server that answers JSON — every
//      deployment until the Go half ships — at no extra round trip;
//   3. a garbled body degrades like a failed fetch and NOT like an empty list:
//      cacheChats prunes rows missing from what it is given, so returning []
//      would wipe the offline chat list;
//   4. no other api() caller changed.
//
// api() and chatService both reach react-native/expo, which esbuild refuses
// under plain Node. Stubbed through Module._load the same way
// lib/chatsCommonNegotiation.selftest.ts does, so the REAL funnel and the REAL
// listChats() run here — hence the require() after the patch instead of a
// top-level import (tsx compiles to CJS, which hoists imports).
//
// VC_CHATSERVICE overrides which module is exercised. That is the mutation
// hook: point it at a copy with the `proto:` option deleted and the protobuf
// section below must fail.

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}

// ─── react-native / expo leaves ─────────────────────────────────────────────
const Module = require('module');
const stubs: Record<string, any> = {
  '@sentry/react-native': { setUser() {}, captureException() {}, captureMessage() {}, addBreadcrumb() {} },
  'expo-router': { router: { replace() {}, push() {} } },
  'expo-secure-store': {
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
  },
  // iOS so publishChatDirectory (android-only, native module) stays out of the
  // way — it is untouched by this change.
  'react-native': { Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default }, NativeModules: {} },
  'expo-crypto': { randomUUID: () => 'uuid', digestStringAsync: async () => '' },
  'expo-file-system/legacy': {},
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
};
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).__DEV__ = false;

const SERVICE = process.env.VC_CHATSERVICE || './chatService';
const { listChats } = require(SERVICE) as typeof import('./chatService');
const { api } = require('./api') as typeof import('./api');

// ─── a scripted fetch that records what it was asked ────────────────────────
const calls: { url: string; init: any }[] = [];
function serve(status: number, contentType: string, body: Uint8Array | string) {
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  };
}

// ─── fixtures ───────────────────────────────────────────────────────────────
// The JSON body is the literal the Go handler marshals — the same two rows
// lib/chatsCacheRollback.selftest.ts hand-wrote from `chatsListItem`: one
// populated direct chat carrying all three id representations, one group with
// every nullable pointer nil. No omitempty in the struct, so every key is
// present and a nil pointer is an explicit null.
const GOLDEN_JSON = `[{
  "id": "chat-7", "type": "direct", "name": null, "photoURL": null,
  "createdBy": "user-1", "createdAt": "2026-09-01T10:00:00.000Z",
  "updatedAt": "2026-09-18T08:30:00.000Z",
  "lastMessageId": "9412", "lastMessageAt": "2026-09-18T08:30:00.000Z",
  "myRole": "member", "myLastReadId": "9410",
  "muted": false, "pinned": false, "favourite": false, "archived": false,
  "hidden": false, "screenshotMode": "block", "vanishMode": false,
  "unreadCount": 2, "peerUserId": "user-2", "peerName": "Ada",
  "peerPhotoURL": null, "peerOnline": true,
  "peerLastSeenAt": "2026-09-18T08:29:00.000Z",
  "peerLastReadMessageId": 9408, "peerLastDeliveredMessageId": 9412,
  "anonMasked": false, "expiresAt": null
},{
  "id": "chat-8", "type": "group", "name": "Ops", "photoURL": null,
  "createdBy": "user-1", "createdAt": "2026-09-02T10:00:00.000Z",
  "updatedAt": "2026-09-02T10:00:00.000Z",
  "lastMessageId": null, "lastMessageAt": null, "myRole": "owner",
  "myLastReadId": null, "muted": false, "pinned": true, "favourite": false,
  "archived": false, "hidden": false, "screenshotMode": "block",
  "vanishMode": false, "unreadCount": 0, "peerUserId": null, "peerName": null,
  "peerPhotoURL": null, "peerOnline": false, "peerLastSeenAt": null,
  "peerLastReadMessageId": null, "peerLastDeliveredMessageId": null,
  "anonMasked": false, "expiresAt": null
}]`;

// ─── an INDEPENDENT protobuf encoder ────────────────────────────────────────
// Twelve lines of varint + length-delimited writer, deliberately NOT
// @bufbuild/protobuf: the bytes under test must not be produced by the library
// that decodes them, or the two agree with each other and with nothing else.
// Canonical proto3 rules applied by hand: a non-optional field at its default
// (false, 0, "") is NOT emitted; an absent `optional` is NOT emitted.
const varint = (n: number | bigint): number[] => {
  let v = BigInt(n); const out: number[] = [];
  do { let byte = Number(v & 0x7fn); v >>= 7n; if (v) byte |= 0x80; out.push(byte); } while (v);
  return out;
};
const tag = (f: number, w: number) => varint(f * 8 + w);
const str = (f: number, s: string | null | undefined) => {
  if (!s) return [];
  const u = [...new TextEncoder().encode(s)];
  return [...tag(f, 2), ...varint(u.length), ...u];
};
const int = (f: number, n: number | null | undefined) =>
  (n === null || n === undefined || n === 0 ? [] : [...tag(f, 0), ...varint(n)]);
const bool = (f: number, v: boolean) => (v ? [...tag(f, 0), 1] : []);
const sub = (f: number, body: number[]) => [...tag(f, 2), ...varint(body.length), ...body];

const chat7 = [
  ...str(1, 'chat-7'), ...str(2, 'direct'),
  ...str(5, 'user-1'), ...str(6, '2026-09-01T10:00:00.000Z'),
  ...str(7, '2026-09-18T08:30:00.000Z'),
  ...int(8, 9412), ...str(9, '2026-09-18T08:30:00.000Z'),
  ...str(10, 'member'), ...int(11, 9410),
  ...str(17, 'block'), ...int(19, 2),
  ...str(20, 'user-2'), ...str(21, 'Ada'), ...bool(23, true),
  ...str(24, '2026-09-18T08:29:00.000Z'),
  ...int(25, 9408), ...int(26, 9412),
];
const chat8 = [
  ...str(1, 'chat-8'), ...str(2, 'group'), ...str(3, 'Ops'),
  ...str(5, 'user-1'), ...str(6, '2026-09-02T10:00:00.000Z'),
  ...str(7, '2026-09-02T10:00:00.000Z'),
  ...str(10, 'owner'), ...bool(13, true), ...str(17, 'block'),
];
const WIRE = Uint8Array.from([...sub(1, chat7), ...sub(1, chat8)]);
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map(x => parseInt(x, 16)));

// THE BYTE PIN. Produced by the hand-rolled encoder above, not by the codec.
// These two rows are OURS — chat-7/chat-8, shared with
// lib/chatsCacheRollback.selftest.ts, and load-bearing for the parity checks
// below. The Go handler never encodes them, so this pin is single-language by
// construction; GO_GOLDEN_WIRE below is the cross-language one.
const PIN = '0ab4010a06636861742d3712066469726563742a06757365722d313218323032362d30392d30315431303a30303a30302e3030305a3a18323032362d30392d31385430383a33303a30302e3030305a40c4494a18323032362d30392d31385430383a33303a30302e3030305a52066d656d62657258c2498a0105626c6f636b980102a20106757365722d32aa0103416461b80101c20118323032362d30392d31385430383a32393a30302e3030305ac801c049d001c4490a610a06636861742d38120567726f75701a034f70732a06757365722d313218323032362d30392d30325431303a30303a30302e3030305a3a18323032362d30392d30325431303a30303a30302e3030305a52056f776e657268018a0105626c6f636b';

// THE CROSS-LANGUAGE BYTE PIN. Unlike PIN above, this string is not ours: it is
// copied character for character from chatsListGoldenWire in
// internal/routes/chats_list_negotiation_test.go, where it is the hex of what
// the REAL Go handler wrote for chatsListPinRow(). Rebuilding that same row here
// with the hand-rolled encoder is what makes the two languages one contract:
// if the handler's JSTime format moves, or a field stops being set, or a field
// number drifts, the Go bytes change and this comparison fails.
//
// The row: id "pin", type "direct", both ISO timestamps 2026-03-04T05:06:07.890Z,
// last_message_id 9412 (#8), my_role "member" (#10), muted (#12),
// screenshot_mode "block" (#17), unread_count 7 (#19),
// peer_last_read_message_id 9410 (#25). Everything else absent or proto3-elided.
const GO_PIN_ISO = '2026-03-04T05:06:07.890Z';
const goPinRow = [
  ...str(1, 'pin'), ...str(2, 'direct'),
  ...str(6, GO_PIN_ISO), ...str(7, GO_PIN_ISO),
  ...int(8, 9412), ...str(10, 'member'), ...bool(12, true),
  ...str(17, 'block'), ...int(19, 7), ...int(25, 9410),
];
const GO_PIN_WIRE = Uint8Array.from(sub(1, goPinRow));
const GO_GOLDEN_WIRE =
  '0a5d0a0370696e12066469726563743218323032362d30332d30345430353a30363a30372e3839305a' +
  '3a18323032362d30332d30345430353a30363a30372e3839305a40c44952066d656d62657260018a0105626c6f636b980107c801c249';

// ─── comparison helpers ─────────────────────────────────────────────────────
const canon = (v: any): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
      : x);
function describe(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}
function diffShape(a: any, b: any): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    const inA = k in a, inB = k in b;
    if (inA !== inB) { out.push(`${k}: ${inA ? 'JSON only' : 'proto only'}`); continue; }
    if (describe(a[k]) !== describe(b[k])) out.push(`${k}: JSON ${describe(a[k])} vs proto ${describe(b[k])}`);
    else if (canon(a[k]) !== canon(b[k])) out.push(`${k}: JSON ${canon(a[k])} vs proto ${canon(b[k])}`);
  }
  return out;
}

async function main() {
  console.log('\nGET /chats protobuf opt-in self-test\n');
  console.log(`(exercising ${SERVICE})\n`);

  console.log('The wire bytes are pinned, and both encoders agree on them:');
  ok('hand-rolled encoder reproduces the pin', hex(WIRE) === PIN, `\n      got  ${hex(WIRE)}\n      want ${PIN}`);
  {
    const { ChatListReply } = await import('./ccwire/gen/ccwire/v1/chats_list_pb');
    const back = ChatListReply.fromBinary(WIRE);
    ok('the generated codec re-encodes the pin byte-identically', hex(back.toBinary()) === PIN, hex(back.toBinary()));
    ok('an absent optional decodes to undefined, never ""', back.chats[1].lastMessageId === undefined,
      JSON.stringify(back.chats[1].lastMessageId));
    ok('a non-optional int64 at 0 decodes to 0, not absence', Number(back.chats[1].unreadCount) === 0);
  }

  console.log('\nAnd the CROSS-LANGUAGE pin — the exact bytes the Go handler wrote:');
  {
    ok('this fixture encodes to chatsListGoldenWire, character for character',
      hex(GO_PIN_WIRE) === GO_GOLDEN_WIRE,
      `\n      ts ${hex(GO_PIN_WIRE)}\n      go ${GO_GOLDEN_WIRE}`);
    const { ChatListReply } = await import('./ccwire/gen/ccwire/v1/chats_list_pb');
    const back = ChatListReply.fromBinary(bytesOf(GO_GOLDEN_WIRE));
    ok('the generated codec re-encodes the Go bytes byte-identically',
      hex(back.toBinary()) === GO_GOLDEN_WIRE, hex(back.toBinary()));
    const c = back.chats[0];
    ok('…and reads back the values the Go fixture set',
      back.chats.length === 1 && c.id === 'pin' && c.type === 'direct'
      && c.createdAt === GO_PIN_ISO && c.updatedAt === GO_PIN_ISO
      && Number(c.lastMessageId) === 9412 && c.myRole === 'member' && c.muted === true
      && c.screenshotMode === 'block' && Number(c.unreadCount) === 7
      && Number(c.peerLastReadMessageId) === 9410,
      JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
    ok('…and the fields Go left absent are absent here too, never "" or 0',
      c.name === undefined && c.photoUrl === undefined && c.createdBy === undefined
      && c.lastMessageAt === undefined && c.myLastReadId === undefined
      && c.peerLastDeliveredMessageId === undefined && c.expiresAt === undefined);
  }

  console.log('\nThe JSON path, unchanged — this is the reference:');
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  const viaJson = await listChats();
  ok('two chats', viaJson.length === 2, String(viaJson.length));
  ok('one request', calls.length === 1, String(calls.length));
  ok('opting in still OFFERS json', String(calls[0].init.headers.Accept).includes('application/json'),
    calls[0].init.headers.Accept);
  ok('…and offers protobuf', String(calls[0].init.headers.Accept).includes('application/protobuf'),
    calls[0].init.headers.Accept);
  ok('`proto` never leaks into the fetch init', !('proto' in calls[0].init), Object.keys(calls[0].init).join(','));

  console.log('\nThe protobuf path produces the SAME list, field for field:');
  calls.length = 0;
  serve(200, 'application/protobuf', WIRE);
  const viaProto = await listChats();
  // Guarded: with the opt-in removed, api() hands the binary body to its text
  // path and this is a garbled string — the mutation must read as failures,
  // not as a stack trace from the shape diff below.
  ok('two chats', Array.isArray(viaProto) && viaProto.length === 2,
    Array.isArray(viaProto) ? String(viaProto.length) : `not a list: ${typeof viaProto}`);
  if (!Array.isArray(viaProto) || viaProto.length !== 2) {
    console.log(`\n  ${failures} FAILED (protobuf was not decoded — is the \`proto\` option still wired?)\n`);
    process.exit(1);
  }
  ok('one request — the server\'s answer decides, no probe', calls.length === 1, String(calls.length));
  const d0 = diffShape(viaJson[0], viaProto[0]);
  const d1 = diffShape(viaJson[1], viaProto[1]);
  ok('populated row identical to the JSON path', d0.length === 0, d0.join(' | '));
  ok('empty row identical to the JSON path', d1.length === 0, d1.join(' | '));
  ok('the whole list is identical', canon(viaJson) === canon(viaProto));
  // Named explicitly, because these are the three id representations one row
  // carries and the thing most likely to move under a typed path.
  ok('lastMessageId is still a STRING (userBigStr)', typeof (viaProto[0] as any).lastMessageId === 'string',
    describe((viaProto[0] as any).lastMessageId));
  ok('myLastReadId is still a STRING', typeof (viaProto[0] as any).myLastReadId === 'string',
    describe((viaProto[0] as any).myLastReadId));
  ok('peerLastReadMessageId is still a NUMBER', typeof viaProto[0].peerLastReadMessageId === 'number',
    describe(viaProto[0].peerLastReadMessageId));
  ok('unreadCount is a number, not a bigint', typeof viaProto[0].unreadCount === 'number',
    typeof viaProto[0].unreadCount);
  ok('photoURL, not protoc\'s photoUrl', 'photoURL' in viaProto[0] && !('photoUrl' in (viaProto[0] as any)),
    Object.keys(viaProto[0]).filter(k => /photo/i.test(k)).join(','));
  // JSON.stringify DROPS undefined, so an absent optional that stayed undefined
  // would silently lose its key in the cache. cacheChats persists the row with
  // exactly this call.
  ok('every key survives JSON.stringify (what cacheChats persists)',
    canon(JSON.parse(JSON.stringify(viaProto))) === canon(JSON.parse(JSON.stringify(viaJson))));
  ok('empty chat: lastMessageId is null, never 0 or ""', viaProto[1].lastMessageId === null,
    JSON.stringify(viaProto[1].lastMessageId));
  ok('empty chat: peer pointers are null KEYS, not absent',
    'peerLastReadMessageId' in viaProto[1] && viaProto[1].peerLastReadMessageId === null,
    JSON.stringify(viaProto[1].peerLastReadMessageId));

  console.log('\nA malformed body degrades like a failed fetch, not like an empty list:');
  for (const [label, body] of [
    ['truncated mid-field', WIRE.slice(0, 40)],
    ['garbage', Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff])],
  ] as [string, Uint8Array][]) {
    calls.length = 0;
    serve(200, 'application/protobuf', body);
    let out: any = 'NO THROW'; let err: any = null;
    try { out = await listChats(); } catch (e) { err = e; }
    ok(`${label}: rejects instead of returning a list`, err !== null && out === 'NO THROW',
      JSON.stringify(out));
    ok(`${label}: never resolves to [] — cacheChats would prune the cache to nothing`,
      !Array.isArray(out) || out.length !== 0);
    ok(`${label}: an ordinary Error the existing catch already handles`,
      err instanceof Error && err?.constructor?.name !== 'SessionEndedError', String(err?.constructor?.name));
    ok(`${label}: NO second GET — the bytes are spent, there is nothing to retry with`,
      calls.length === 1, String(calls.length));
  }
  // The cache is written by the caller, not by listChats, and only on the
  // resolve path. Read from source rather than restated, so a caller that
  // starts caching on failure breaks this instead of the user's chat list.
  {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const TSX = readFileSync(join(__dirname, '..', 'app', '(tabs)', 'chats.tsx'), 'utf8');
    const load = TSX.match(/const loadList = useCallback\([\s\S]*?\n  \}, \[\]\);/)?.[0] ?? '';
    ok('chats.tsx caches only AFTER listChats resolved', load.indexOf('await listChats()') < load.indexOf('cacheChats(list)')
      && load.indexOf('cacheChats(list)') < load.indexOf('} catch'), 'loadList not found or reordered');
    ok('the failure branch does not touch the cache',
      !load.slice(load.indexOf('} catch (')).includes('cacheChats'));
  }

  console.log('\nEvery other api() caller is untouched:');
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', '{"ok":true}');
  await api('/chats/anything-else');
  ok('a call with no decoder asks for JSON and nothing else',
    calls[0].init.headers.Accept === 'application/json', calls[0].init.headers.Accept);
  ok('no protobuf anywhere in its headers', !JSON.stringify(calls[0].init.headers).includes('protobuf'));

  console.log('\nErrors still come back as errors on the opted-in call:');
  calls.length = 0;
  serve(403, 'application/json; charset=utf-8', '{"error":"not_permitted"}');
  let msg = '';
  try { await listChats(); } catch (e: any) { msg = e?.message; }
  ok('a 403 rejects with the server\'s wording', msg === 'not_permitted', msg);

  console.log(failures === 0 ? '\n  All GET /chats protobuf checks passed\n' : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
