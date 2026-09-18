// lib/chatsCommonNegotiation.selftest.ts — run: npx tsx lib/chatsCommonNegotiation.selftest.ts
//
// protobuf-migration task 4.2. GET /chats/common/{userId} is the first
// operation to negotiate binary protobuf THROUGH lib/api.ts — the single HTTP
// funnel all 331 client contracts share. Task 3.1 proved negotiation on
// /app/version but deliberately avoided this module, so the thing under test
// here is api() itself, not a codec.
//
// WHAT THIS HAS TO PROVE, IN ORDER OF HOW BADLY IT WOULD HURT:
//   1. a call that does NOT opt in is unchanged — same Accept, same headers,
//      same parse. 330 contracts depend on that and none of them are read here;
//   2. an opted-in call decodes the bytes the Go handler really wrote;
//   3. an opted-in call still works when the server answers JSON — every
//      deployment before this one does — and costs no extra round trip.
//
// api() cannot be imported under plain Node: @sentry/react-native, expo-router
// and expo-secure-store all reach react-native, which esbuild refuses. They are
// stubbed through Module._load below rather than mocked behind an indirection,
// because the whole point is to run the REAL funnel. That is why the api import
// is a require() after the patch and not a top-level import — tsx compiles this
// to CJS, so top-level imports would be hoisted above it.

import { CommonGroupsReply } from './ccwire/gen/ccwire/v1/chats_common_pb';
// The decoder the app actually ships — see the note above decodeCommonGroups.
// react-native-free by design, which is the only reason this file can hold it.
import { commonGroupsFromProtobuf } from './ccwire/startupAdapter';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ─── the three react-native leaves api.ts imports ───────────────────────────
const Module = require('module');
const stubs: Record<string, any> = {
  '@sentry/react-native': { setUser() {} },
  'expo-router': { router: { replace() {}, push() {} } },
  'expo-secure-store': {
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
  },
};
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).__DEV__ = false;

// The cast is a TYPE-only reference (erased at runtime, so nothing is loaded
// ahead of the patch above); it keeps api() generic here instead of `any`.
const { api } = require('./api') as typeof import('./api');

// ─── a fetch that answers from a script and records what it was asked ───────
type Call = { url: string; init: any };
const calls: Call[] = [];
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

// ─── the fixture, as Go writes it ───────────────────────────────────────────
// Two groups, chosen so field presence is exercised in both directions.
// internal/routes/chats_common_negotiation_test.go pins these exact bytes and
// this exact JSON from the SAME handler. Semantic agreement alone would let the
// two languages drift onto different field numbers and still both pass; the
// byte pin is what makes them one contract.
const GOLDEN_WIRE =
  '0a110a0863675f616c7068611205416c706861' +
  '0a210a0763675f626574611a1668747470733a2f2f63646e2e746573742f622e706e67';
const GOLDEN_JSON =
  '{"groups":[{"id":"cg_alpha","name":"Alpha","photoURL":null},' +
  '{"id":"cg_beta","name":null,"photoURL":"https://cdn.test/b.png"}]}\n';
const WANT = [
  { id: 'cg_alpha', name: 'Alpha', photoURL: null },
  { id: 'cg_beta', name: null, photoURL: 'https://cdn.test/b.png' },
];

const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map(h => parseInt(h, 16)));

type Groups = { groups: { id: string; name: string | null; photoURL: string | null }[] };

// THE DECODER UNDER TEST IS THE SHIPPED ONE.
//
// This used to be a hand-written copy of the lambda chatService.getCommonGroups
// passed to api(), and it proved the COPY correct. The shipped decoder had no
// coverage at all: `?? null` could become `?? ''` in chatService and every
// suite stayed green, while a group with no name reached the app as "" instead
// of null. Testing a re-implementation is the same false confidence as a
// decoder with no live caller — the defect this endpoint already produced once.
//
// So the decoder now lives in lib/ccwire/startupAdapter, which is deliberately
// free of react-native and therefore loadable here, and BOTH the app and this
// file call that one function. The dynamic import of the generated codec is
// still inside it, so @bufbuild/protobuf stays off the cold-start path.
//
// The wrapper below only COUNTS calls (three assertions below need to know the
// decoder was not reached); it adds no behaviour of its own.
let decodeCalls = 0;
const decodeCommonGroups = (b: Uint8Array): Promise<Groups> => {
  decodeCalls++;
  return commonGroupsFromProtobuf(b);
};

async function main() {
  console.log('\nChats groups-in-common content negotiation self-test\n');

  console.log('A call that does not opt in is byte-identical to before:');
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  const plain = await api<Groups>('/chats/common/u2');
  eq('parses the JSON exactly as it always did', plain.groups, WANT);
  eq('asks for JSON and nothing else', calls[0].init.headers.Accept, 'application/json');
  ok('sends no protobuf header at all',
    !JSON.stringify(calls[0].init.headers).includes('protobuf'),
    JSON.stringify(calls[0].init.headers));
  ok('one request', calls.length === 1, `(${calls.length})`);

  // A proxy rewriting Content-Type is not hypothetical — appVersion.ts calls
  // that out as the reason it branches on the answer rather than the request.
  // A caller that never opted in must not be handed to a decoder it does not
  // have: it takes the same text path it took before this change existed.
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  let mislabelled: any; let threw = '';
  try { mislabelled = await api('/chats/common/u2'); } catch (e: any) { threw = String(e?.message); }
  ok('a protobuf Content-Type on a call that did not opt in is still the old text path',
    threw === '' && typeof mislabelled === 'string', `(threw ${threw}, got ${typeof mislabelled})`);

  console.log('\nAn opted-in call offers protobuf without demanding it:');
  calls.length = 0; decodeCalls = 0;
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  const pb = await api<Groups>('/chats/common/u2', { proto: decodeCommonGroups });
  eq('decodes the bytes the Go handler really wrote', pb.groups, WANT);
  ok('offers protobuf', calls[0].init.headers.Accept.includes('application/protobuf'));
  ok('still offers json, so an old server is never broken by it',
    calls[0].init.headers.Accept.includes('application/json'));
  ok('one request', calls.length === 1, `(${calls.length})`);
  ok('`proto` does not leak into the fetch init', !('proto' in calls[0].init),
    Object.keys(calls[0].init).join(','));

  console.log('\nThe same opted-in call against a server that answers JSON:');
  calls.length = 0; decodeCalls = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  const fallback = await api<Groups>('/chats/common/u2', { proto: decodeCommonGroups });
  eq('same groups, from the unchanged JSON path', fallback.groups, WANT);
  ok('the decoder was never called', decodeCalls === 0, `(${decodeCalls})`);
  ok('and it cost no extra round trip', calls.length === 1, `(${calls.length})`);

  console.log('\nThe two representations carry the same values:');
  eq('protobuf', (await decodeCommonGroups(bytes(GOLDEN_WIRE))).groups, JSON.parse(GOLDEN_JSON).groups);

  // NULL, NOT "" AND NOT A MISSING KEY — checked on the SHIPPED decoder, by
  // identity and by `in`, because JSON.stringify hides both mistakes that
  // matter here: it renders undefined by dropping the key (so `eq` above would
  // still pass for a conditional key against a JSON row that has it), and "" is
  // a different value the eq would catch but the app would not, since
  // contact-info renders a falsy name either way and only a cache write shows
  // the difference. `?? ''` and `if (g.name !== undefined)` both die here.
  const shipped = (await commonGroupsFromProtobuf(bytes(GOLDEN_WIRE))).groups;
  ok('shipped decoder: absent photo_url is exactly null, not ""',
    shipped[0].photoURL === null, JSON.stringify(shipped[0].photoURL));
  ok('shipped decoder: absent name is exactly null, not ""',
    shipped[1].name === null, JSON.stringify(shipped[1].name));
  ok('shipped decoder: the null keys are PRESENT, as the JSON writes them',
    'photoURL' in shipped[0] && 'name' in shipped[1],
    Object.keys(shipped[0]).join(',') + ' / ' + Object.keys(shipped[1]).join(','));
  eq('shipped decoder: same keys as the JSON row, in the same order',
    shipped.map(g => Object.keys(g).join(',')),
    (JSON.parse(GOLDEN_JSON).groups as any[]).map(g => Object.keys(g).join(',')));
  const decoded = CommonGroupsReply.fromBinary(bytes(GOLDEN_WIRE));
  ok('a group with no photo is ABSENT, not ""', decoded.groups[0].photoUrl === undefined,
    JSON.stringify(decoded.groups[0].photoUrl));
  ok('a group with no name is ABSENT, not ""', decoded.groups[1].name === undefined,
    JSON.stringify(decoded.groups[1].name));
  ok('and this build encodes them back to the same bytes',
    Array.from(decoded.toBinary(), b => b.toString(16).padStart(2, '0')).join('') === GOLDEN_WIRE);

  console.log('\nNo groups in common is the usual answer, in both:');
  eq('empty protobuf message', (await decodeCommonGroups(new Uint8Array(0))).groups, []);
  eq('empty json array', JSON.parse('{"groups":[]}').groups, []);

  console.log('\nAn error is still an error, on the unchanged path:');
  calls.length = 0; decodeCalls = 0;
  serve(403, 'application/json; charset=utf-8', '{"error":"not_permitted"}');
  let msg = '';
  try { await api<Groups>('/chats/common/u2', { proto: decodeCommonGroups }); }
  catch (e: any) { msg = e?.message; }
  ok('a 403 rejects with the server\'s wording', msg === 'not_permitted', `(${msg})`);
  ok('the decoder was never called', decodeCalls === 0, `(${decodeCalls})`);

  console.log(failures === 0
    ? '\n  All chats groups-in-common negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
