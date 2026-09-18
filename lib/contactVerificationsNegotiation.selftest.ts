// lib/contactVerificationsNegotiation.selftest.ts
//   run: npx tsx lib/contactVerificationsNegotiation.selftest.ts
//
// protobuf-migration. GET /user/contact-verifications negotiates binary
// protobuf.
//
// WHAT THIS HAS TO PROVE, IN ORDER OF HOW BADLY IT WOULD HURT:
//   1. an opted-in call still works against a server that answers JSON — every
//      deployment before this one does — and costs no extra round trip;
//   2. it decodes the bytes the Go handler really wrote, into the SAME array
//      the JSON path produces, in the same order;
//   3. the EMPTY case, which on this endpoint is a ZERO-BYTE body: proto3
//      elides an empty repeated field, and "this user has verified nobody" must
//      not decode to undefined and must not look like a failed call.
//      app/verify-contact.tsx draws an unverified badge from it either way, so a
//      silent failure here is invisible — which is exactly why it is pinned.
//
// api() cannot be imported under plain Node (@sentry/react-native, expo-router
// and expo-secure-store all reach react-native), so the same three leaves
// lib/securityOverviewNegotiation.selftest.ts stubs are stubbed here, through
// Module._load, and lib/verification.ts is require()d AFTER the patch — tsx
// compiles this to CJS, so a top-level import would be hoisted above it. The
// REAL module is exercised; nothing about the decoder is re-implemented here.

import { ContactVerifications as Wire } from './ccwire/gen/ccwire/v1/contact_verifications_pb';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

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

const { getVerifiedContacts } = require('./verification') as typeof import('./verification');

type Call = { url: string; init: any };
const calls: Call[] = [];
function serve(status: number, contentType: string, body: Uint8Array | string) {
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const b = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => new TextDecoder().decode(b),
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      json: async () => JSON.parse(new TextDecoder().decode(b)),
    };
  };
}

// ─── the fixture, as Go writes it ───────────────────────────────────────────
// internal/routes/user_contact_verifications_negotiation_test.go pins these
// exact bytes and this exact JSON from the SAME handler. Semantic agreement
// alone would let the two languages drift onto different field numbers and
// still both pass; the byte pin is what makes them one contract.
//   0a05 + "alice", 0a03 + "bob" — a repeated string writes its tag per element.
const GOLDEN_WIRE = '0a05616c6963650a03626f62';
const GOLDEN_JSON = '{"verified":["alice","bob"]}\n';
const WANT = ['alice', 'bob'];

// No verifications: the JSON is `[]` (the handler seeds the slice, so never
// null) and the protobuf is NOTHING AT ALL.
const EMPTY_JSON = '{"verified":[]}\n';
const EMPTY_WIRE = '';

const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

async function main() {
  console.log('\nContact-verifications content negotiation self-test\n');

  console.log('Against a server that answers JSON — i.e. every server today:');
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  eq('same list, from the unchanged JSON path', await getVerifiedContacts(), WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  ok('offers protobuf', calls[0].init.headers.Accept.includes('application/protobuf'));
  ok('still offers json, so an old server is never broken by it',
    calls[0].init.headers.Accept.includes('application/json'));
  ok('`proto` does not leak into the fetch init', !('proto' in calls[0].init),
    Object.keys(calls[0].init).join(','));

  console.log('\nAgainst a server that answers protobuf:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  const pb = await getVerifiedContacts();
  eq('decodes the bytes the Go handler really wrote', pb, WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  eq('and to the very same array the JSON path produced', pb, JSON.parse(GOLDEN_JSON).verified);
  ok('order is preserved, not sorted', pb[0] === 'alice' && pb[1] === 'bob', pb.join(','));
  ok('and this build encodes them back to the same bytes',
    Array.from(Wire.fromBinary(bytes(GOLDEN_WIRE)).toBinary(),
      (b) => b.toString(16).padStart(2, '0')).join('') === GOLDEN_WIRE);

  console.log('\nAn account that has verified nobody — a zero-byte body:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(EMPTY_WIRE));
  const empty = await getVerifiedContacts();
  eq('decodes to an empty array, not undefined', empty, []);
  eq('and to the same array the JSON path produced', empty, JSON.parse(EMPTY_JSON).verified);
  ok('really is an Array, so .includes() on the screen still works',
    Array.isArray(empty), typeof empty);
  ok('one request', calls.length === 1, `(${calls.length})`);

  console.log('\nAn error is still an error, on the unchanged path:');
  calls.length = 0;
  serve(500, 'application/json; charset=utf-8', '{"error":"Failed to load verifications"}');
  let msg = '';
  try { await getVerifiedContacts(); } catch (e: any) { msg = e?.message; }
  ok('a 500 rejects with the server\'s wording',
    msg === 'Failed to load verifications', `(${msg})`);

  console.log(failures === 0
    ? '\n  All contact-verifications negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
