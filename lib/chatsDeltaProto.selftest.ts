// lib/chatsDeltaProto.selftest.ts — run: npx tsx lib/chatsDeltaProto.selftest.ts
//
// protobuf-migration batch D, CLIENT half. GET /chats/delta opts into binary
// protobuf by passing a decoder to api(); nothing else about the catch-up
// algorithm moves. This is the highest-consequence payload in the app — it
// carries message rows AND the cursor that decides what is fetched next — so
// what this has to be worth is the governing spec's eight safety rules, each
// exercised against the REAL syncEngine loop:
//
//   1. the COMPLETE page is decoded and validated before any state is applied;
//   2. the Batch A normalisation (wireId/startupMessage) runs BEFORE any
//      numeric filter, compare or sort — syncEngine filters
//      `typeof id === 'number'` and sorts `b.id - a.id`;
//   3. a malformed record surfaces a bounded typed error carrying no payload —
//      it is NOT filtered out, NOT reported as an empty page, NOT "complete";
//   4. the cursor does not pass unprocessed data and no ack is generated for it;
//   5. no retry, and no JSON-fallback re-request of the same GET;
//   6. decode -> durable application -> cursor advancement, in that order;
//   7. valid ids HAVE GAPS — no contiguity requirement is invented;
//   8. a failed refresh keeps the cached messages it already had.
//
// Not mocked: the real syncEngine, the real api() negotiation funnel, the real
// chatService hydration, the real msgIds/startupAdapter boundary. Stubbed at
// the leaves only — react-native/expo, and the four modules that own I/O
// (localDb, receipts, messageNotifications, socket), so every durable write and
// every delivery ack this run would have made is observable.
//
// The bytes under test are produced by a hand-rolled proto writer, NOT by
// @bufbuild/protobuf: a fixture encoded by the library that decodes it agrees
// with itself and with nothing else.
//
// VC_SYNCENGINE points the run at a different module. That is the mutation
// hook, and §M drives it automatically: a disposable copy of syncEngine.ts with
// the `proto:` opt-in stripped must make this suite FAIL.

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}

// ─── fake I/O leaves, observable ────────────────────────────────────────────
type Row = any;
const store = {
  msgs: new Map<string, Map<number, Row>>(),
  meta: new Map<string, string>(),
  cacheCalls: [] as { chatId: string; rows: Row[] }[],
  lookups: [] as { chatId: string; ids: number[] }[],
  acks: [] as { chatId: string; id: number; owner: string }[],
  notifies: [] as string[],
};
const CURSOR_KEY = 'vc_global_sync_cursor';
const rowsOf = (chatId: string) => {
  let m = store.msgs.get(chatId);
  if (!m) { m = new Map(); store.msgs.set(chatId, m); }
  return m;
};
const allIds = () => [...store.msgs.values()].flatMap(m => [...m.keys()]);

const localDbStub = {
  getMeta: async (k: string) => (store.meta.has(k) ? store.meta.get(k)! : null),
  setMeta: async (k: string, v: string) => { store.meta.set(k, v); },
  // Mirrors localDb.ts:1145 — max(MAX(id) over cached rows, stored mark).
  getGlobalSyncCursor: async () => {
    const ids = allIds();
    const m = ids.length ? Math.max(...ids) : 0;
    const fromRows = m ? Number(m) : 0;
    const stored = Number(store.meta.get(CURSOR_KEY) ?? 0) || 0;
    const cursor = Math.max(fromRows, stored);
    if (cursor > stored) store.meta.set(CURSOR_KEY, String(cursor));
    return cursor;
  },
  // Mirrors localDb.ts:1156 — monotonic, finite, > 0.
  noteGlobalSyncCursor: async (id: number) => {
    if (!Number.isFinite(id) || id <= 0) return;
    const stored = Number(store.meta.get(CURSOR_KEY) ?? 0) || 0;
    if (id > stored) store.meta.set(CURSOR_KEY, String(id));
  },
  // Mirrors the real guard: a non-number or id <= 0 is SKIPPED, never written.
  cacheMessages: async (chatId: string, rows: Row[]) => {
    store.cacheCalls.push({ chatId, rows });
    for (const r of rows) {
      if (typeof r?.id !== 'number' || r.id <= 0) continue;
      rowsOf(chatId).set(r.id, r);
    }
  },
  getCachedMessagesByIds: async (chatId: string, ids: number[]) => {
    store.lookups.push({ chatId, ids });
    return ids.map(i => rowsOf(chatId).get(i)).filter(Boolean);
  },
};

const Module = require('module');
const stubs: Record<string, any> = {
  '@sentry/react-native': { setUser() {}, captureException() {}, captureMessage() {}, addBreadcrumb() {} },
  'expo-router': { router: { replace() {}, push() {} } },
  'expo-secure-store': {
    getItemAsync: async () => TOKEN,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
  },
  'react-native': {
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
    NativeModules: {},
    AppState: { addEventListener() {} },
  },
  'expo-crypto': { randomUUID: () => 'uuid', digestStringAsync: async () => '' },
  'expo-file-system/legacy': {},
  'expo-notifications': {},
  '@react-native-async-storage/async-storage': { default: { getItem: async () => null, setItem: async () => {} } },
  './localDb': localDbStub,
  './receipts': {
    markDeliveredDurable: async (chatId: string, id: number, owner: string) => {
      store.acks.push({ chatId, id, owner });
    },
    readPointers: async () => [],
  },
  './messageNotifications': {
    notifyBatch: async (chatId: string) => { store.notifies.push(chatId); },
    invalidateDirectory() {},
  },
  './socket': { addPersistentListener() {}, onConnectionState() {} },
};
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).__DEV__ = false;

// ─── identity ───────────────────────────────────────────────────────────────
const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (sub: string) => `${b64({ alg: 'none' })}.${b64({ sub })}.sig`;
const USER_1 = tokenFor('user-1');
const USER_2 = tokenFor('user-2');
let TOKEN: string | null = USER_1;

const ENGINE_PATH = process.env.VC_SYNCENGINE || './syncEngine';
const engine = require(ENGINE_PATH) as typeof import('./syncEngine');

// SWITCH ACCOUNTS THE WAY THE APP DOES, NOT BY WRITING SECURESTORE BEHIND api.ts.
//
// api.ts memoises the access token (lib/api.ts:34) and drops that cache inside
// setTokens/clearTokens — synchronously, before either function's first await.
// Nothing in the app writes vc_access_token by any other route, so the cache is
// coherent there; but a test that only moves the SecureStore stub leaves
// getAccessToken() serving the old token forever, and the account guard in
// syncEngine/api has nothing to bite on.
const apiMod = require('./api') as typeof import('./api');
function setToken(next: string | null) {
  TOKEN = next;
  void (next ? apiMod.setTokens(next, next) : apiMod.clearTokens());
}

// ─── a scripted fetch that records what it was asked ────────────────────────
type Served = { status?: number; type: string; body: Uint8Array | string; before?: () => void };
const requests: string[] = [];
let queue: Served[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  requests.push(String(url));
  const s = queue.shift();
  if (!s) throw new Error(`selftest: unscripted request ${url}`);
  s.before?.();
  const bytes = typeof s.body === 'string' ? new TextEncoder().encode(s.body) : s.body;
  const status = s.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? s.type : null) },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    lastInit: init,
  } as any;
};
const PROTO = 'application/protobuf';
const JSONT = 'application/json; charset=utf-8';

function reset(cursor = 0) {
  store.msgs.clear(); store.meta.clear();
  store.cacheCalls = []; store.lookups = []; store.acks = []; store.notifies = [];
  requests.length = 0; queue = []; setToken(USER_1);
  if (cursor) store.meta.set(CURSOR_KEY, String(cursor));
}

/** One full drain, surfacing the error the engine would otherwise swallow. */
async function drain(): Promise<any> {
  try { await engine.resyncRequired(); return null; } catch (e) { return e; }
}

// ─── an INDEPENDENT protobuf encoder ────────────────────────────────────────
const enc = (s: string) => [...new TextEncoder().encode(s)];
const varint = (n: number | bigint): number[] => {
  let v = BigInt.asUintN(64, BigInt(n)); const out: number[] = [];
  do { let byte = Number(v & 0x7fn); v >>= 7n; if (v) byte |= 0x80; out.push(byte); } while (v);
  return out;
};
const tag = (f: number, w: number) => varint(f * 8 + w);
const len = (f: number, u: number[]) => [...tag(f, 2), ...varint(u.length), ...u];
const S  = (f: number, s: string) => (s ? len(f, enc(s)) : []);                    // implicit presence
const OS = (f: number, s?: string) => (s === undefined ? [] : len(f, enc(s)));     // explicit presence
const I  = (f: number, n: number) => (n === 0 ? [] : [...tag(f, 0), ...varint(n)]);
const OI = (f: number, n?: number) => (n === undefined ? [] : [...tag(f, 0), ...varint(n)]);
const B  = (f: number, v: boolean) => (v ? [...tag(f, 0), 1] : []);
const SUB = (f: number, body: number[]) => [...tag(f, 2), ...varint(body.length), ...body];

type Fix = {
  id?: number; chatId?: string; senderId?: string; type?: string; content?: string;
  meta?: number[]; replyToId?: number; editedAt?: string; deletedAt?: string;
  createdAt?: string; expiresAt?: string; vanish?: boolean;
};
// `id` omitted means the field is absent on the wire, i.e. proto3 default "0" —
// exactly what a server bug or a truncated writer produces.
const msg = (f: Fix): number[] => [
  ...OI(1, f.id),
  ...S(2, f.chatId ?? 'chat-1'),
  ...S(3, f.senderId ?? 'user-2'),
  ...S(4, f.type ?? 'text'),
  ...OS(5, f.content),
  ...(f.meta ? len(6, f.meta) : []),
  ...OI(7, f.replyToId),
  ...OS(8, f.editedAt),
  ...OS(9, f.deletedAt),
  ...S(10, f.createdAt ?? '2026-09-18T08:00:00.000Z'),
  ...OS(11, f.expiresAt),
  ...B(12, !!f.vanish),
];
type ReplyFix = {
  messages?: number[][]; nextSince?: number; more?: boolean; cont?: string;
  mutations?: number[][]; mutCursor?: string; serverTime?: string;
};
const reply = (r: ReplyFix): Uint8Array => Uint8Array.from([
  ...(r.messages ?? []).flatMap(m => SUB(1, m)),
  ...I(2, r.nextSince ?? 0),
  ...B(3, !!r.more),
  ...S(4, r.cont ?? ''),
  ...(r.mutations ?? []).flatMap(m => SUB(5, m)),
  ...S(6, r.mutCursor ?? ''),
  ...S(7, r.serverTime ?? '2026-09-18T09:00:00.000Z'),
]);

// ─── THE CROSS-LANGUAGE BYTE PIN ────────────────────────────────────────────
// This hex is not ours: it is copied character for character from
// chatsDeltaGoldenWire in internal/routes/chats_delta_negotiation_test.go, where
// it is the hex of what the REAL Go handler wrote for chatsDeltaPinRows().
// Rebuilding the same reply here with the hand-rolled writer above is what makes
// the two languages one contract rather than two independent readings of the
// schema: if the handler's JSTime format moves, a field stops being set, or a
// field number drifts, the Go bytes change and this comparison fails.
const GO_PIN_MSG = msg({
  id: 9412, chatId: 'c_1', senderId: 'u1', type: 'text',
  content: 'hi', meta: enc('{"a":1}'), replyToId: 9400,
  createdAt: '2026-03-04T05:06:07.890Z', vanish: true,
});
const GO_PIN_WIRE = reply({
  messages: [GO_PIN_MSG], nextSince: 9414, more: true, cont: 'c1.',
  mutCursor: 'm1.', serverTime: '2026-03-04T05:06:10.000Z',
});
const GO_GOLDEN_WIRE =
  '0a3e08c4491203635f311a0275312204746578742a02686932077b2261223a317d38b849' +
  '5218323032362d30332d30345430353a30363a30372e3839305a600110c6491801220363312e32036d312e' +
  '3a18323032362d30332d30345430353a30363a31302e3030305a';
const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map(x => parseInt(x, 16)));

// ─── comparison helpers ─────────────────────────────────────────────────────
const canon = (v: any): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
      : x);
const cachedIds = (chatId = 'chat-1') => [...rowsOf(chatId).keys()].sort((a, b) => a - b);
const cursor = () => Number(store.meta.get(CURSOR_KEY) ?? 0);

async function main() {
  console.log('\nGET /chats/delta protobuf opt-in self-test\n');
  console.log(`(exercising ${ENGINE_PATH})\n`);

  // ── §0. the wiring, read from source ──────────────────────────────────────
  {
    const { readFileSync } = require('node:fs');
    const SRC = readFileSync(require.resolve('./syncEngine'), 'utf8');
    const sites = SRC.match(/api<Delta>\([^;]*?\{[^}]*\}\)/gs) ?? [];
    ok('both /chats/delta requests offer protobuf', sites.length === 2
      && sites.every((s: string) => s.includes('proto: decodeDelta')), `${sites.length} call sites`);
    const specs = [...SRC.matchAll(/\bimport\('([^']+)'\)/g)].map((m: any) => m[1]);
    ok('the generated DeltaReply is reached by dynamic import',
      specs.includes('./ccwire/gen/ccwire/v1/chats_delta_pb'), specs.join(', '));
    ok('no dynamic import carries a .js suffix (Metro cannot resolve one, tsc will not catch it)',
      specs.length > 0 && specs.every((s: string) => !s.endsWith('.js')), specs.join(', '));
    // The engine issues exactly one GET per page and never re-requests a page
    // it failed to decode; §3 and §5 prove that behaviourally. Here, only that
    // nothing hand-rolls a second Accept header to go back for JSON.
    ok('no second, JSON-only request is constructed anywhere in the engine',
      !/Accept/.test(SRC), 'an Accept header appeared in syncEngine.ts');
  }

  // ── §0b. the CROSS-LANGUAGE pin: the exact bytes the Go handler wrote ─────
  console.log('\n§0b the cross-language byte pin — chatsDeltaGoldenWire:');
  {
    ok('this fixture encodes to chatsDeltaGoldenWire, character for character',
      hexOf(GO_PIN_WIRE) === GO_GOLDEN_WIRE,
      `\n      ts ${hexOf(GO_PIN_WIRE)}\n      go ${GO_GOLDEN_WIRE}`);
    const { DeltaReply } = await import('./ccwire/gen/ccwire/v1/chats_delta_pb');
    const back = DeltaReply.fromBinary(bytesOf(GO_GOLDEN_WIRE));
    ok('the generated codec re-encodes the Go bytes byte-identically',
      hexOf(back.toBinary()) === GO_GOLDEN_WIRE, hexOf(back.toBinary()));
    const m0 = back.messages[0];
    ok('…and reads back the values the Go fixture set',
      back.messages.length === 1 && Number(m0.id) === 9412 && m0.chatId === 'c_1'
      && m0.senderId === 'u1' && m0.type === 'text' && m0.content === 'hi'
      && new TextDecoder().decode(m0.metaJson!) === '{"a":1}'
      && Number(m0.replyToId) === 9400 && m0.createdAt === '2026-03-04T05:06:07.890Z'
      && m0.vanishAfterRead === true && Number(back.nextSince) === 9414 && back.more === true
      && back.syncContinuation === 'c1.' && back.nextMutationCursor === 'm1.'
      && back.serverTime === '2026-03-04T05:06:10.000Z' && back.mutations.length === 0,
      canon(back.toJson()));
    ok('…and the fields Go left absent are absent here too, never "" ',
      m0.editedAt === undefined && m0.deletedAt === undefined && m0.expiresAt === undefined);

    // Strongest form: the REAL engine drains the REAL server bytes.
    reset(9400);
    queue.push({ type: PROTO, body: bytesOf(GO_GOLDEN_WIRE) });
    queue.push({ type: PROTO, body: reply({ messages: [], nextSince: 9414 }) });
    const e = await drain();
    ok('the real engine drains the real Go bytes without error', e === null, String(e?.message ?? e));
    ok('…storing the pinned row under its own chat id',
      canon(cachedIds('c_1')) === canon([9412]), canon(cachedIds('c_1')));
    ok('…and advancing the cursor to the server\'s next_since', cursor() === 9414, String(cursor()));
  }

  // ── §1. the recovery case: prior cursor 6, server maximum 8 ───────────────
  console.log('\n§1 prior cursor 6, server maximum 8 — the established recovery case:');
  reset(6);
  queue.push({ type: PROTO, body: reply({
    messages: [msg({ id: 7, content: 'seven' }), msg({ id: 8, content: 'eight' })],
    nextSince: 8,
  }) });
  let err = await drain();
  ok('the drain completes', err === null, String(err?.message ?? err));
  ok('one request — the server\'s answer decides, no probe', requests.length === 1, requests.join(' '));
  ok('asked from the lookback window, not from 6', requests[0].includes('since=0'), requests[0]);
  ok('both rows are durable', canon(cachedIds()) === canon([7, 8]), canon(cachedIds()));
  ok('the cursor advanced to the server maximum', cursor() === 8, String(cursor()));
  ok('ids arrive as NUMBERS (rule 2 — cacheMessages skips anything else)',
    store.cacheCalls.every(c => c.rows.every(r => typeof r.id === 'number')));
  ok('delivery acked at 8', canon(store.acks) === canon([{ chatId: 'chat-1', id: 8, owner: 'user-1' }]),
    canon(store.acks));

  // ── §2. multiple pages, duplicate rows, VALID ID GAPS ─────────────────────
  console.log('\n§2 multiple pages, duplicates across pages, and valid id GAPS:');
  reset(6);
  queue.push({ type: PROTO, body: reply({ messages: [msg({ id: 7 }), msg({ id: 9 }), msg({ id: 12 })], nextSince: 12, more: true }) });
  queue.push({ type: PROTO, body: reply({ messages: [msg({ id: 12 }), msg({ id: 40 })], nextSince: 40, more: true }) });
  queue.push({ type: PROTO, body: reply({ messages: [], nextSince: 40 }) });
  err = await drain();
  ok('the drain completes across pages', err === null, String(err?.message ?? err));
  ok('three requests, then the empty page terminates it', requests.length === 3, String(requests.length));
  ok('gaps 8, 10-11 and 13-39 are NOT treated as missing data',
    canon(cachedIds()) === canon([7, 9, 12, 40]), canon(cachedIds()));
  ok('the duplicate row upserts, it does not duplicate', rowsOf('chat-1').size === 4, String(rowsOf('chat-1').size));
  ok('the cursor is the server\'s nextSince, never clamped to a contiguous run (rule 7)',
    cursor() === 40, String(cursor()));
  ok('the empty final page does not rewind or re-ack', store.acks.filter(a => a.id === 40).length === 1,
    canon(store.acks));
  ok('page 2 resumed from page 1\'s cursor', requests[1].includes('since=12'), requests[1]);

  // ── §3. an invalid id in the MIDDLE of an otherwise valid page ────────────
  console.log('\n§3 one unusable id mid-page — the page is REFUSED, not trimmed:');
  for (const [label, bad] of [
    ['absent id (proto3 default "0")', msg({ content: 'secret-plaintext' })],
    ['negative id (the local import band)', msg({ id: -5, content: 'secret-plaintext' })],
    ['empty chatId', msg({ id: 99, chatId: '', content: 'secret-plaintext' })],
    ['meta that is not JSON', msg({ id: 99, meta: enc('{not json') })],
    ['meta that is not UTF-8', msg({ id: 99, meta: [0xff, 0xfe, 0xfd] })],
  ] as [string, number[]][]) {
    reset(6);
    rowsOf('chat-1').set(3, { id: 3, chatId: 'chat-1', content: 'already here' });
    queue.push({ type: PROTO, body: reply({ messages: [msg({ id: 7 }), bad, msg({ id: 9 })], nextSince: 9 }) });
    err = await drain();
    ok(`${label}: a typed error is surfaced — sync is NOT reported complete`,
      err?.name === 'DeltaDecodeError', `${err?.name}: ${err?.message}`);
    ok(`${label}: the message names the array and index and NOTHING from the row`,
      typeof err?.message === 'string' && !err.message.includes('secret-plaintext')
      && !err.message.includes('-5') && !/\bmessages\[1\]\b.*(chat-1|user-2)/.test(err.message),
      err?.message);
    ok(`${label}: the valid rows around it are NOT applied (rule 1)`,
      store.cacheCalls.length === 0, canon(store.cacheCalls.map(c => c.rows.map((r: Row) => r.id))));
    ok(`${label}: the cursor does not move (rule 4)`, cursor() === 6, String(cursor()));
    ok(`${label}: no delivery ack is generated (rule 4)`, store.acks.length === 0, canon(store.acks));
    ok(`${label}: the cached list is intact (rule 8)`, canon(cachedIds()) === canon([3]), canon(cachedIds()));
    ok(`${label}: NO second GET — no retry, no JSON fallback (rule 5)`,
      requests.length === 1, String(requests.length));
  }

  // ── §3b. a mutation row is held to the same rule ──────────────────────────
  reset(6);
  queue.push({ type: PROTO, body: reply({
    messages: [msg({ id: 7 })],
    mutations: [msg({ id: 4, editedAt: '2026-09-18T08:10:00.000Z' }), msg({ content: 'x' })],
    nextSince: 7,
  }) });
  err = await drain();
  ok('a bad MUTATION row refuses the page too', err?.name === 'DeltaDecodeError', String(err?.message));
  ok('…naming the mutations array', String(err?.message).includes('mutations[1]'), String(err?.message));
  ok('…and nothing was applied', store.cacheCalls.length === 0 && cursor() === 6, String(cursor()));

  // ── §4. an empty page on its own terminates cleanly ───────────────────────
  console.log('\n§4 an empty page terminates cleanly:');
  reset(6);
  queue.push({ type: PROTO, body: reply({ messages: [], nextSince: 0 }) });
  err = await drain();
  ok('no error', err === null, String(err?.message ?? err));
  ok('one request', requests.length === 1, String(requests.length));
  ok('nothing written, cursor unmoved', store.cacheCalls.length === 0 && cursor() === 6, String(cursor()));
  ok('an empty page never advances the cursor to nextSince=0', cursor() === 6);

  // ── §5. a malformed body ──────────────────────────────────────────────────
  console.log('\n§5 a malformed body degrades like a failed fetch:');
  for (const [label, body] of [
    ['truncated mid-field', reply({ messages: [msg({ id: 7 })], nextSince: 7 }).slice(0, 9)],
    ['garbage', Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff])],
  ] as [string, Uint8Array][]) {
    reset(6);
    rowsOf('chat-1').set(3, { id: 3, chatId: 'chat-1', content: 'keep me' });
    rowsOf('chat-1').set(4, { id: 4, chatId: 'chat-1', content: 'keep me too' });
    queue.push({ type: PROTO, body });
    err = await drain();
    ok(`${label}: rejects instead of reporting an empty page`, err !== null, 'no error');
    ok(`${label}: the cache is NOT erased (rule 8)`, canon(cachedIds()) === canon([3, 4]), canon(cachedIds()));
    ok(`${label}: NO second GET (rule 5)`, requests.length === 1, String(requests.length));
    ok(`${label}: the cursor is untouched`, cursor() === 6, String(cursor()));
    ok(`${label}: no ack`, store.acks.length === 0, canon(store.acks));
  }

  // ── §6. account switch / logout mid-response ──────────────────────────────
  console.log('\n§6 account switch mid-response cancels without writing:');
  for (const [label, next] of [['switch to another account', USER_2], ['logout', null]] as [string, string | null][]) {
    reset(6);
    queue.push({
      type: PROTO,
      body: reply({ messages: [msg({ id: 7 }), msg({ id: 8 })], nextSince: 8 }),
      before: () => setToken(next),
    });
    err = await drain();
    ok(`${label}: the drain is refused`, err !== null, 'no error');
    ok(`${label}: nothing was cached`, store.cacheCalls.length === 0,
      canon(store.cacheCalls.map(c => c.rows.map((r: Row) => r.id))));
    ok(`${label}: the cursor did not move`, cursor() === 6, String(cursor()));
    ok(`${label}: no ack was generated for the other account`, store.acks.length === 0, canon(store.acks));
  }
  setToken(USER_1);

  // ── §7. local id bands the server never sends SURVIVE a sync ──────────────
  console.log('\n§7 negative imported ids and optimistic id-0 bubbles survive:');
  reset(6);
  rowsOf('chat-1').set(-123, { id: -123, chatId: 'chat-1', content: 'Exit-Kit import' });
  rowsOf('chat-1').set(0, { id: 0, chatId: 'chat-1', content: 'optimistic bubble' });
  queue.push({ type: PROTO, body: reply({ messages: [msg({ id: 7 }), msg({ id: 8 })], nextSince: 8 }) });
  err = await drain();
  ok('the sync succeeds', err === null, String(err?.message ?? err));
  ok('the imported negative row is still there', rowsOf('chat-1').get(-123)?.content === 'Exit-Kit import');
  ok('the optimistic id-0 bubble is still there', rowsOf('chat-1').get(0)?.content === 'optimistic bubble');
  ok('sync added, it did not replace', canon(cachedIds()) === canon([-123, 0, 7, 8]), canon(cachedIds()));
  ok('the local bands were never offered to the decrypt-skip lookup',
    store.lookups.every(l => l.ids.every(i => i > 0)), canon(store.lookups));
  ok('the cursor is the server\'s, unpolluted by local ids', cursor() === 8, String(cursor()));

  // ── §8. PARITY: the typed page equals the JSON page, field for field ──────
  console.log('\n§8 the typed path produces the SAME domain rows as the JSON path:');
  const META = { attachmentId: 'att-9', filename: 'x.pdf' };
  const PROTO_PAGE = reply({
    messages: [
      msg({ id: 7, content: 'hello', meta: enc(JSON.stringify(META)), replyToId: 5,
            createdAt: '2026-09-18T08:00:00.000Z', vanish: true }),
      msg({ id: 8, createdAt: '2026-09-18T08:01:00.000Z', editedAt: '2026-09-18T08:02:00.000Z',
            deletedAt: '2026-09-18T08:03:00.000Z', expiresAt: '2026-09-19T08:00:00.000Z' }),
    ],
    nextSince: 8,
  });
  // The literal the Go handler marshals: no omitempty on chatsPublicMsg, so
  // every key is present and a nil pointer is an explicit null.
  const JSON_PAGE = JSON.stringify({
    messages: [
      { id: '7', chatId: 'chat-1', senderId: 'user-2', type: 'text', content: 'hello',
        meta: META, replyToId: '5', editedAt: null, deletedAt: null,
        createdAt: '2026-09-18T08:00:00.000Z', expiresAt: null, vanishAfterRead: true },
      { id: '8', chatId: 'chat-1', senderId: 'user-2', type: 'text', content: null,
        meta: null, replyToId: null, editedAt: '2026-09-18T08:02:00.000Z',
        deletedAt: '2026-09-18T08:03:00.000Z', createdAt: '2026-09-18T08:01:00.000Z',
        expiresAt: '2026-09-19T08:00:00.000Z', vanishAfterRead: false },
    ],
    nextSince: 8, more: false, syncContinuation: '', mutations: [],
    nextMutationCursor: '', serverTime: '2026-09-18T09:00:00.000Z',
  });
  const runPage = async (type: string, body: Uint8Array | string) => {
    reset(6);
    queue.push({ type, body });
    const e = await drain();
    return { e, rows: store.cacheCalls.flatMap(c => c.rows), cur: cursor(), acks: [...store.acks], reqs: requests.length };
  };
  const viaJson = await runPage(JSONT, JSON_PAGE);
  const viaProto = await runPage(PROTO, PROTO_PAGE);
  ok('the JSON path still works, untouched', viaJson.e === null && viaJson.rows.length === 2,
    String(viaJson.e?.message ?? viaJson.rows.length));
  ok('the protobuf path applied the same number of rows', viaProto.rows.length === 2,
    String(viaProto.e?.message ?? viaProto.rows.length));
  ok('the rows are identical, field for field',
    canon(viaProto.rows) === canon(viaJson.rows), `\n      json  ${canon(viaJson.rows)}\n      proto ${canon(viaProto.rows)}`);
  ok('every key survives JSON.stringify (what cacheMessages persists)',
    canon(JSON.parse(JSON.stringify(viaProto.rows))) === canon(JSON.parse(JSON.stringify(viaJson.rows))));
  ok('same cursor', viaProto.cur === viaJson.cur && viaProto.cur === 8, String(viaProto.cur));
  ok('same acks', canon(viaProto.acks) === canon(viaJson.acks), canon(viaProto.acks));
  ok('same request count', viaProto.reqs === viaJson.reqs && viaProto.reqs === 1, String(viaProto.reqs));
  // By id, not by index: hydration hands cacheMessages the page newest-first.
  const byId = (id: number) => viaProto.rows.find((r: Row) => r.id === id);
  ok('meta round-trips as the exact object, not a Uint8Array',
    canon(byId(7)?.meta) === canon(META), canon(byId(7)?.meta));
  ok('absent meta is null, matching the JSON path — never undefined or ""',
    byId(8)?.meta === null, JSON.stringify(byId(8)?.meta));
  ok('absent content is null', byId(8)?.content === null, JSON.stringify(byId(8)?.content));
  ok('replyToId is a NUMBER when present', byId(7)?.replyToId === 5,
    JSON.stringify(byId(7)?.replyToId));
  ok('absent replyToId is null, never 0 (message 0 is nobody\'s reply target)',
    byId(8)?.replyToId === null, JSON.stringify(byId(8)?.replyToId));

  // ── §9. an unsafe cursor is still refused on the typed path ───────────────
  console.log('\n§9 the cursor gate still bites on the typed path:');
  for (const [label, n] of [
    ['an id past 2^53-1', 9007199254740995],
    ['a page whose cursor does not advance', 0],
  ] as [string, number][]) {
    reset(6);
    queue.push({ type: PROTO, body: reply({ messages: [msg({ id: 7 })], nextSince: n }) });
    err = await drain();
    ok(`${label}: refused`, /did not advance/.test(String(err?.message)), String(err?.message));
    ok(`${label}: the durable mark did not move`, cursor() === 6, String(cursor()));
    ok(`${label}: the rows were still stored first (rule 6)`, cachedIds().includes(7), canon(cachedIds()));
  }

  // ── §10. a server that answers JSON, and every other caller ───────────────
  console.log('\n§10 negotiation:');
  reset(6);
  let accept = '';
  queue.push({ type: JSONT, body: JSON_PAGE, before: () => {} });
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (u: string, init: any) => { accept = init?.headers?.Accept; return origFetch(u, init); };
  err = await drain();
  (globalThis as any).fetch = origFetch;
  ok('opting in still OFFERS json', String(accept).includes('application/json'), accept);
  ok('…and offers protobuf', String(accept).includes('application/protobuf'), accept);
  ok('a JSON answer needs no second request', requests.length === 1, String(requests.length));
  ok('and is applied exactly as before', cursor() === 8 && cachedIds().length === 2, String(cursor()));

  console.log(failures === 0 ? '\n  All GET /chats/delta protobuf checks passed\n' : `\n  ${failures} FAILED\n`);
}

// ── §M. the mutation: strip the opt-in and this suite must FAIL ─────────────
async function proveItBites(): Promise<void> {
  const { readFileSync, writeFileSync, rmSync } = require('node:fs');
  const { execFile } = require('node:child_process');
  const path = require('node:path');
  const src = require.resolve('./syncEngine');
  const copy = path.join(path.dirname(src), 'syncEngineNoProto.disposable.ts');
  const mutated = readFileSync(src, 'utf8').split(', proto: decodeDelta').join('');
  if (mutated === readFileSync(src, 'utf8')) {
    failures++;
    console.log('  ✗ §M could not strip the opt-in — is `proto: decodeDelta` still the wiring?');
    return;
  }
  writeFileSync(copy, mutated);
  try {
    const code: number = await new Promise((resolve) => {
      execFile(process.execPath, [require.resolve('tsx/cli'), __filename], {
        cwd: path.resolve(path.dirname(src), '..'),
        env: { ...process.env, VC_SYNCENGINE: './syncEngineNoProto.disposable' },
        timeout: 180_000, maxBuffer: 16 << 20,
      }, (e: any, stdout: string) => {
        const lines = String(stdout).split('\n').filter(l => l.includes('✗')).slice(0, 3);
        for (const l of lines) console.log(`      (mutant) ${l.trim()}`);
        resolve(e ? (e.code ?? 1) : 0);
      });
    });
    ok('§M with the `proto:` opt-in removed, this suite FAILS', code !== 0, `mutant exited ${code}`);
  } finally {
    rmSync(copy, { force: true });
  }
}

main()
  .then(async () => {
    if (!process.env.VC_SYNCENGINE) {
      console.log('\n§M proving the test bites:');
      await proveItBites();
      console.log(failures === 0 ? '\n  All checks passed (mutation included)\n' : `\n  ${failures} FAILED\n`);
    }
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => { console.error(e); process.exit(1); });
