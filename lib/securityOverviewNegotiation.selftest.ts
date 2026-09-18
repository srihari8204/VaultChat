// lib/securityOverviewNegotiation.selftest.ts — run: npx tsx lib/securityOverviewNegotiation.selftest.ts
//
// protobuf-migration task 4.3. GET /user/security-overview is the first
// operation in the USER domain to negotiate binary protobuf.
//
// WHAT THIS HAS TO PROVE, IN ORDER OF HOW BADLY IT WOULD HURT:
//   1. an opted-in call still works against a server that answers JSON — every
//      deployment before this one does — and costs no extra round trip;
//   2. it decodes the bytes the Go handler really wrote, into the SAME object
//      the JSON path produces, nulls included;
//   3. a NULL settings flag stays null all the way through JSON.stringify —
//      app/dashboard.tsx persists this object with writeCache('dashboard'), and
//      stringify DROPS an undefined, which would turn "never chosen" into a
//      missing key and then into "off" on the next cold open.
//
// api() cannot be imported under plain Node (@sentry/react-native, expo-router
// and expo-secure-store all reach react-native), so the same three leaves
// lib/chatsCommonNegotiation.selftest.ts stubs are stubbed here, through
// Module._load, and lib/security.ts is require()d AFTER the patch — tsx
// compiles this to CJS, so a top-level import would be hoisted above it. The
// REAL module is exercised; nothing about the decoder is re-implemented here.

import { SecurityOverview as Wire } from './ccwire/gen/ccwire/v1/security_overview_pb';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
// Key ORDER is deliberately not compared: the JSON path hands back whatever
// order the server wrote, the typed path hands back the decoder's literal, and
// nothing downstream reads this object positionally. Every key and every value
// IS compared, nulls included — that is the part that matters.
//
// The bigint arm is not decoration: JSON.stringify THROWS on a BigInt, so a
// decoder that forgot to narrow an int64 field would blow this file up here
// instead of reporting the one check that names the problem. Rendering it as
// "1234567n" keeps the failure legible AND keeps it a failure — it can never
// compare equal to the number the JSON path produces.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === 'bigint' ? `${x}n`
      : x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x);
function eq(name: string, actual: unknown, expected: unknown) {
  // canon() for the DETAIL too, not JSON.stringify: see above — a stray bigint
  // must be reported, not thrown.
  ok(name, canon(actual) === canon(expected),
    `(got ${canon(actual)}, want ${canon(expected)})`);
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

const { getSecurityOverview } = require('./security') as typeof import('./security');

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
// internal/routes/user_security_overview_negotiation_test.go pins these exact
// bytes and this exact JSON from the SAME handler (securityOverviewPinRow).
// Semantic agreement alone would let the two languages drift onto different
// field numbers and still both pass; the byte pin is what makes them one
// contract. Note 1000 at the end: readReceipts is PRESENT AND FALSE and costs
// two bytes, while lastSeenVisible is NULL and costs none.
const GOLDEN_WIRE =
  '080310022001' +
  '2a18323032362d30332d30345430353a30363a30372e3839305a' +
  '320408011000';
const GOLDEN_JSON =
  '{"accountCreatedAt":"2026-03-04T05:06:07.890Z","activeSessions":3,"blockedContacts":0,' +
  '"e2eeKeyPublished":true,"linkedDevices":2,' +
  '"settings":{"discoverable":true,"lastSeenVisible":null,"readReceipts":false}}\n';
const WANT = {
  activeSessions: 3,
  linkedDevices: 2,
  blockedContacts: 0,
  e2eeKeyPublished: true,
  accountCreatedAt: '2026-03-04T05:06:07.890Z',
  settings: { discoverable: true, readReceipts: false, lastSeenVisible: null },
};

// A brand-new account: no key, no counts, no settings chosen, no createdAt.
// Proto3 writes nothing at all for it except the settings envelope.
const EMPTY_JSON =
  '{"accountCreatedAt":null,"activeSessions":0,"blockedContacts":0,"e2eeKeyPublished":false,' +
  '"linkedDevices":0,"settings":{"discoverable":null,"lastSeenVisible":null,"readReceipts":null}}\n';
const EMPTY_WIRE = '3200';
const WANT_EMPTY = {
  activeSessions: 0, linkedDevices: 0, blockedContacts: 0, e2eeKeyPublished: false,
  accountCreatedAt: null,
  settings: { discoverable: null, readReceipts: null, lastSeenVisible: null },
};

const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

async function main() {
  console.log('\nSecurity-overview content negotiation self-test\n');

  console.log('Against a server that answers JSON — i.e. every server today:');
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  eq('same overview, from the unchanged JSON path', await getSecurityOverview(), WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  ok('offers protobuf', calls[0].init.headers.Accept.includes('application/protobuf'));
  ok('still offers json, so an old server is never broken by it',
    calls[0].init.headers.Accept.includes('application/json'));
  ok('`proto` does not leak into the fetch init', !('proto' in calls[0].init),
    Object.keys(calls[0].init).join(','));

  console.log('\nAgainst a server that answers protobuf:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  const pb = await getSecurityOverview();
  eq('decodes the bytes the Go handler really wrote', pb, WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  eq('and to the very same object the JSON path produced', pb, JSON.parse(GOLDEN_JSON));

  console.log('\nThe three-state settings survive the wire:');
  const decoded = Wire.fromBinary(bytes(GOLDEN_WIRE));
  ok('an explicit false is PRESENT and false', decoded.settings?.readReceipts === false,
    JSON.stringify(decoded.settings?.readReceipts));
  ok('a NULL flag is ABSENT, not false', decoded.settings?.lastSeenVisible === undefined,
    JSON.stringify(decoded.settings?.lastSeenVisible));
  ok('and this build encodes them back to the same bytes',
    Array.from(decoded.toBinary(), (b) => b.toString(16).padStart(2, '0')).join('') === GOLDEN_WIRE);

  console.log('\nAbsence becomes null, never undefined — the cache depends on it:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(EMPTY_WIRE));
  const empty = await getSecurityOverview();
  eq('a brand-new account decodes to all-null, not all-false', empty, WANT_EMPTY);
  eq('and to the same object the JSON path produced', empty, JSON.parse(EMPTY_JSON));
  // The real failure mode: writeCache('dashboard', ov) round-trips through
  // JSON.stringify, which erases an undefined key entirely.
  const cached = JSON.parse(JSON.stringify(empty));
  ok('settings.discoverable survives writeCache as an explicit null',
    'discoverable' in cached.settings && cached.settings.discoverable === null,
    JSON.stringify(cached.settings));
  ok('so does lastSeenVisible',
    'lastSeenVisible' in cached.settings && cached.settings.lastSeenVisible === null);
  ok('and so does accountCreatedAt',
    'accountCreatedAt' in cached && cached.accountCreatedAt === null);

  console.log('\nAn error is still an error, on the unchanged path:');
  calls.length = 0;
  serve(500, 'application/json; charset=utf-8', '{"error":"Failed to load security overview"}');
  let msg = '';
  try { await getSecurityOverview(); } catch (e: any) { msg = e?.message; }
  ok('a 500 rejects with the server\'s wording',
    msg === 'Failed to load security overview', `(${msg})`);

  console.log(failures === 0
    ? '\n  All security-overview negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
