// lib/termsNegotiation.selftest.ts
//   run: npx tsx lib/termsNegotiation.selftest.ts
//
// protobuf-migration. GET /user/terms negotiates binary protobuf. It is the
// last authenticated cold-start request to move off JSON — TermsGate mounts from
// app/_layout.tsx, so this runs on every single launch.
//
// WHAT THIS HAS TO PROVE, IN ORDER OF HOW BADLY IT WOULD HURT:
//   1. IT FAILS OPEN. lib/terms.ts has always treated every failure as "not
//      outstanding", and a protobuf decode failure must land on that same path.
//      The worst outcome this endpoint can produce is an acceptance screen
//      nobody can dismiss — strictly worse than an acceptance recorded a day
//      later — so garbage bytes, a truncated body and a 500 are all checked to
//      answer false rather than true.
//   2. an opted-in call still works against a server that answers JSON — every
//      deployment before this one does — and costs no extra round trip;
//   3. it decodes the bytes the Go handler really wrote, into the SAME object
//      the JSON path produces, NULLS INCLUDED. acceptedVersion and acceptedAt
//      are `optional` on the wire and proto3 absence arrives as undefined; the
//      decoder maps that to null because the JSON writes null. JSON.stringify
//      DROPS undefined, so the two would look identical through a stringify and
//      differ through `in` — and lib/terms.ts caches this object for the life of
//      the process. Checked with `in` and Object.keys, not only by value.
//   4. the timestamp is verbatim, offset and all. It is a *time.Time through
//      encoding/json (time.RFC3339Nano), NOT httpx.JSTime — the fixture carries
//      a +05:30 offset and a trimmed trailing zero so either mistake shows.
//
// api() cannot be imported under plain Node (@sentry/react-native, expo-router
// and expo-secure-store all reach react-native), so the same three leaves the
// other negotiation selftests stub are stubbed here, through Module._load, and
// lib/terms.ts is require()d AFTER the patch — tsx compiles this to CJS, so a
// top-level import would be hoisted above it. The REAL module is exercised;
// nothing about the decoder is re-implemented here.

import { TermsState as Wire } from './ccwire/gen/ccwire/v1/terms_pb';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
// Key ORDER is deliberately not compared: the JSON path hands back whatever
// order the server wrote, the typed path hands back the decoder's literal, and
// nothing downstream reads this object positionally. Every key and every value
// IS compared, nulls included — and the SET of keys is compared separately
// below, because a null quietly demoted to undefined is invisible to value
// comparison and is the specific failure this endpoint can have.
//
// The bigint arm is carried from the template even though this schema has no
// int64: JSON.stringify THROWS on a BigInt, and a thrown canon() would replace
// the one check that names the problem with a stack trace.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === 'bigint' ? `${x}n`
      : x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x);
function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, canon(actual) === canon(expected), `(got ${canon(actual)}, want ${canon(expected)})`);
}

const Module = require('module');
const stubs: Record<string, any> = {
  '@sentry/react-native': { setUser() {} },
  'expo-router': { router: { replace() {}, push() {} } },
  'expo-secure-store': {
    // A real access token, so hasSession() is true: fetchTermsState() returns
    // null WITHOUT a request when nobody is signed in, and every check below
    // would then pass vacuously.
    getItemAsync: async (k: string) => (k === 'vc_access_token' ? 'token' : null),
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

const terms = require('./terms') as typeof import('./terms');
const { fetchTermsState, termsNeedAcceptance, resetTermsCache } = terms;

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

// ─── the fixtures, as Go writes them ────────────────────────────────────────
// internal/routes/user_terms_negotiation_test.go pins these exact bytes and this
// exact JSON from the SAME handler. Semantic agreement alone would let the two
// languages drift onto different field numbers and still both pass; the byte pin
// is what makes them one contract.
//
//   0a07 required_version "2026-09", 1207 accepted_version "2026-03",
//   1a1c + 28 bytes of the timestamp VERBATIM — "+05:30" is in there, which is
//   where an httpx.JSTime "fix" changes the bytes — 2001 outstanding=true,
//   2a20 + the 32-byte URL.
const GOLDEN_WIRE =
  '0a07323032362d30391207323032362d3033' +
  '1a1c323032362d30332d30345430353a30363a30372e38392b30353a333020012a20' +
  '68747470733a2f2f6170692e636f726566696e6974652e636f6d2f7465726d73';
const GOLDEN_JSON =
  '{"acceptedAt":"2026-03-04T05:06:07.89+05:30","acceptedVersion":"2026-03",' +
  '"outstanding":true,"requiredVersion":"2026-09",' +
  '"url":"https://api.corefinite.com/terms"}\n';
const WANT = {
  requiredVersion: '2026-09',
  acceptedVersion: '2026-03',
  acceptedAt: '2026-03-04T05:06:07.89+05:30',
  outstanding: true,
  url: 'https://api.corefinite.com/terms',
};

// A user who has never accepted anything: fields 2 and 3 are simply not on the
// wire, and the JSON spells both of them null.
const NEVER_WIRE =
  '0a07323032362d30392001' +
  '2a2068747470733a2f2f6170692e636f726566696e6974652e636f6d2f7465726d73';
const NEVER_JSON =
  '{"acceptedAt":null,"acceptedVersion":null,"outstanding":true,' +
  '"requiredVersion":"2026-09","url":"https://api.corefinite.com/terms"}\n';

const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const keys = (o: object) => Object.keys(o).sort().join(',');

async function main() {
  console.log('\nTerms content negotiation self-test\n');

  console.log('Against a server that answers JSON — i.e. every server today:');
  calls.length = 0;
  resetTermsCache();
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  const js = await fetchTermsState(true);
  eq('same state, from the unchanged JSON path', js, WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  ok('offers protobuf', calls[0].init.headers.Accept.includes('application/protobuf'));
  ok('still offers json, so an old server is never broken by it',
    calls[0].init.headers.Accept.includes('application/json'));
  ok('`proto` does not leak into the fetch init', !('proto' in calls[0].init),
    Object.keys(calls[0].init).join(','));

  console.log('\nAgainst a server that answers protobuf:');
  calls.length = 0;
  resetTermsCache();
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  const pb = (await fetchTermsState(true))!;
  eq('decodes the bytes the Go handler really wrote', pb, WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  eq('and to the very same object the JSON path produced', pb, JSON.parse(GOLDEN_JSON));
  ok('same key set as the JSON, outstanding included',
    keys(pb) === keys(JSON.parse(GOLDEN_JSON)), `${keys(pb)} vs ${keys(JSON.parse(GOLDEN_JSON))}`);
  // THE TIMESTAMP, spelled out. encoding/json writes RFC3339Nano: the +05:30
  // offset survives (pgx can hand back a non-UTC location) and the trailing zero
  // of .890 is trimmed. httpx.JSTime would have written
  // "2026-03-03T23:36:07.890Z" — different offset, different digits, silently.
  ok('acceptedAt is byte-identical to encoding/json, offset and all',
    pb.acceptedAt === '2026-03-04T05:06:07.89+05:30', String(pb.acceptedAt));
  ok('and this build encodes it back to the same bytes',
    Array.from(Wire.fromBinary(bytes(GOLDEN_WIRE)).toBinary(),
      (b) => b.toString(16).padStart(2, '0')).join('') === GOLDEN_WIRE);
  ok('outstanding computed locally agrees with the server', terms.termsOutstanding(pb) === true);

  console.log('\nNever accepted — the keys must be NULL, not undefined:');
  calls.length = 0;
  resetTermsCache();
  serve(200, 'application/protobuf', bytes(NEVER_WIRE));
  const never = (await fetchTermsState(true))!;
  eq('decodes to the same object the JSON path produced', never, JSON.parse(NEVER_JSON));
  ok('five keys, exactly as the JSON has', keys(never) === keys(JSON.parse(NEVER_JSON)),
    `${keys(never)} vs ${keys(JSON.parse(NEVER_JSON))}`);
  // The failure this rules out, and the reason value comparison is not enough:
  // `acceptedVersion: undefined` passes every eq() above — canon() drops it on
  // BOTH sides — and is still a different object to `in` and to Object.keys.
  ok("'acceptedVersion' key exists", 'acceptedVersion' in never);
  ok('and it is null, not undefined', never.acceptedVersion === null,
    `${String(never.acceptedVersion)} (${typeof never.acceptedVersion})`);
  ok("'acceptedAt' key exists", 'acceptedAt' in never);
  ok('and it is null, not undefined', never.acceptedAt === null,
    `${String(never.acceptedAt)} (${typeof never.acceptedAt})`);
  ok('survives a cache round trip with both keys intact',
    keys(JSON.parse(JSON.stringify(never))) === keys(JSON.parse(NEVER_JSON)),
    keys(JSON.parse(JSON.stringify(never))));
  ok('still outstanding — nothing was accepted', terms.termsOutstanding(never) === true);
  ok('and it is not an "update", it is a first acceptance',
    terms.termsAreAnUpdate(never) === false);

  console.log('\nFAIL OPEN — the one thing that must never go wrong:');
  // A screen nobody can dismiss is worse than an acceptance recorded a day
  // later, so every one of these answers "not outstanding".
  for (const [name, body] of [
    ['garbage bytes', bytes('ffffffffffffffff')],
    ['a truncated message', bytes(GOLDEN_WIRE.slice(0, 20))],
    ['an empty body labelled protobuf', bytes('')],
    ['HTML from a captive portal', '<html>login here</html>'],
  ] as [string, Uint8Array | string][]) {
    resetTermsCache();
    serve(200, 'application/protobuf', body);
    const state = await fetchTermsState(true);
    resetTermsCache();
    serve(200, 'application/protobuf', body);
    const need = await termsNeedAcceptance();
    ok(`${name} → NOT outstanding`, need === false,
      `needAcceptance=${need} state=${canon(state)}`);
  }
  resetTermsCache();
  serve(500, 'application/json; charset=utf-8', '{"error":"Failed"}');
  eq('a 500 is still null, unchanged', await fetchTermsState(true), null);
  resetTermsCache();
  serve(500, 'application/protobuf', bytes(GOLDEN_WIRE));
  ok('a 500 carrying valid protobuf is still NOT outstanding',
    (await termsNeedAcceptance()) === false);

  console.log(failures === 0
    ? '\n  All terms negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
