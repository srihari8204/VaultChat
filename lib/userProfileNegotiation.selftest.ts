// lib/userProfileNegotiation.selftest.ts
//   run: npx tsx lib/userProfileNegotiation.selftest.ts
//
// protobuf-migration. GET /user/profile negotiates binary protobuf. It is the
// authenticated shell's FIRST authenticated read — app/_layout.tsx reaches it
// through authService.isSetupComplete(), and three screens repeat it — so it
// runs on essentially every launch.
//
// WHAT THIS HAS TO PROVE, IN ORDER OF HOW BADLY IT WOULD HURT:
//   1. an opted-in call still works against a server that answers JSON — every
//      deployment before this one does — and costs no extra round trip. That
//      is the fallback: the decoder is an OFFER, the server decides;
//   2. it decodes the bytes the Go handler really wrote into the SAME object
//      the JSON path produces — key for key, type for type, nulls included.
//      Checked with Object.keys and `in`, not only by value: `photoURL:
//      undefined` compares equal to `photoURL: null` through a stringify and
//      is a different object to everything else;
//   3. those nulls survive writeCache. app/(tabs)/profile.tsx persists this row
//      with writeCache('my-profile') and paints from it on the next cold open;
//      JSON.stringify DROPS an undefined, so a demoted key silently disappears
//      from the cache and only from the typed path;
//   4. `photoURL` keeps its capital URL, which protoc-gen-es does not;
//   5. an empty `status` stays "" and does not collapse into null — "cleared"
//      and "never set" are different states and the proto `optional` exists to
//      keep them apart.
//
// api() cannot be imported under plain Node (@sentry/react-native, expo-router
// and expo-secure-store all reach react-native), so the same three leaves the
// other negotiation selftests stub are stubbed here, through Module._load, and
// lib/api is require()d AFTER the patch — tsx compiles this to CJS, so a
// top-level import would be hoisted above it.
//
// The call exercised is api('/user/profile', { proto: profileFromProtobuf }) —
// literally the line the four GET call sites now run. The REAL api() and the
// REAL decoder are used; nothing is re-implemented here. authService itself is
// not require()d because it drags in Google Sign-In and AsyncStorage, which
// would test the stubs rather than the negotiation.

import { UserProfile as Wire } from './ccwire/gen/ccwire/v1/user_profile_pb';
import { profileFromProtobuf } from './userProfilePolicy';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
// Key ORDER is deliberately not compared: the JSON path hands back whatever
// order the server wrote (Go sorts map keys), the typed path hands back the
// decoder's literal, and nothing downstream reads this object positionally.
// Every key and every value IS compared, nulls included — and the SET of keys
// is compared separately below, because a null quietly demoted to undefined is
// invisible to value comparison and is the specific failure this endpoint can
// have.
//
// The bigint arm is carried from the template even though this schema has no
// int64 (face_count is int32): JSON.stringify THROWS on a BigInt, and a thrown
// canon() would replace the one check that names the problem with a stack
// trace.
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
    // A real access token: /user/profile is authenticated, and api() would
    // otherwise take the signed-out path instead of issuing the request.
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

const { api } = require('./api') as typeof import('./api');
type Profile = import('./userProfilePolicy').UserProfile;
const getProfile = () => api<Profile>('/user/profile', { proto: profileFromProtobuf });

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

// ─── the fixtures ───────────────────────────────────────────────────────────
// The bytes are PINNED as a literal rather than encoded at run time, and the
// JSON beside each one is spelled out with Go's sorted map keys, so this file
// fails if either representation moves. Semantic agreement alone would let the
// two sides drift onto different field numbers and still both pass.
//
// Timestamps carry httpx.JSTime's exact output — UTC, three digits of
// milliseconds, literal Z (userProfileTimeLayout, user.go:309). NOT
// RFC3339Nano: /user/terms uses that for its own documented reason, and mixing
// the two gives a cached string that can never match itself.
//
// Note 4200 near the middle: `status` is PRESENT AND EMPTY and costs two
// bytes, while a NULL status would cost none. That is the distinction the
// `optional` exists for.
const GOLDEN_WIRE =
  '0a08755f376633613931' +
  '121261646140636f726566696e6974652e636f6d' +
  '1a0c416461204c6f76656c616365' +
  '220d2b3931393837363534333231302a2668747470733a2f2f6170692e636f7265' +
  '66696e6974652e636f6d2f66696c65732f702e6a7067' +
  '320c7630613162326333643465353a0a313939302d30322d31314200' +
  '48015218323032362d30332d30345430353a30363a30372e3839305a' +
  '5a06676f6f676c6560016802' +
  '7218323032362d30332d30315430393a31303a31312e3030305a' +
  '7a18323032362d30312d30325430333a30343a30352e3030305a';
const GOLDEN_JSON =
  '{"authProvider":"google","createdAt":"2026-01-02T03:04:05.000Z","dob":"1990-02-11",' +
  '"email":"ada@corefinite.com","emailVerifiedAt":"2026-03-01T09:10:11.000Z","faceCount":2,' +
  '"hasPin":true,"id":"u_7f3a91","lastSeen":"2026-03-04T05:06:07.890Z","name":"Ada Lovelace",' +
  '"online":true,"phone":"+919876543210",' +
  '"photoURL":"https://api.corefinite.com/files/p.jpg","status":"",' +
  '"vaultId":"v0a1b2c3d4e5"}\n';

// A brand-new account, which is the row that actually ships nulls: signup is
// phone-first and everything vaulted is still nil. proto3 writes nothing at all
// for those fields — only the id and the NOT NULL created_at are on the wire.
const SPARSE_WIRE =
  '0a08755f6e65773030317a18323032362d30392d32305430303a30303a30302e3030305a';
const SPARSE_JSON =
  '{"authProvider":null,"createdAt":"2026-09-20T00:00:00.000Z","dob":null,"email":null,' +
  '"emailVerifiedAt":null,"faceCount":0,"hasPin":false,"id":"u_new001","lastSeen":null,' +
  '"name":null,"online":false,"phone":null,"photoURL":null,"status":null,"vaultId":null}\n';

const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const keys = (o: object) => Object.keys(o).sort().join(',');
const types = (o: any) =>
  Object.keys(o).sort().map((k) => `${k}:${o[k] === null ? 'null' : typeof o[k]}`).join(',');

async function main() {
  console.log('\nUser-profile content negotiation self-test\n');

  console.log('Against a server that answers JSON — i.e. every server today:');
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  const js = await getProfile();
  eq('same profile, from the unchanged JSON path', js, JSON.parse(GOLDEN_JSON));
  ok('one request', calls.length === 1, `(${calls.length})`);
  ok('offers protobuf', calls[0].init.headers.Accept.includes('application/protobuf'));
  ok('STILL OFFERS JSON, so an old server is never broken by opting in',
    calls[0].init.headers.Accept.includes('application/json'));
  ok('`proto` does not leak into the fetch init', !('proto' in calls[0].init),
    Object.keys(calls[0].init).join(','));

  console.log('\nAgainst a server that answers protobuf:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  const pb = await getProfile();
  ok('one request', calls.length === 1, `(${calls.length})`);
  eq('decodes to the very same object the JSON path produced', pb, JSON.parse(GOLDEN_JSON));
  ok('key for key — all fifteen', keys(pb) === keys(JSON.parse(GOLDEN_JSON)),
    `${keys(pb)} vs ${keys(JSON.parse(GOLDEN_JSON))}`);
  ok('and type for type', types(pb) === types(JSON.parse(GOLDEN_JSON)),
    `${types(pb)} vs ${types(JSON.parse(GOLDEN_JSON))}`);
  ok('photoURL keeps its capital URL — protoc-gen-es spells it photoUrl',
    'photoURL' in pb && !('photoUrl' in (pb as any)), keys(pb));
  ok('faceCount is a number, not a string or a bigint', typeof pb.faceCount === 'number',
    `${typeof pb.faceCount}`);
  ok('an empty status stays "", it does not collapse to null', pb.status === '',
    `${String(pb.status)} (${typeof pb.status})`);
  ok('timestamps are httpx.JSTime verbatim — UTC, 3ms digits, literal Z',
    pb.lastSeen === '2026-03-04T05:06:07.890Z' && pb.createdAt === '2026-01-02T03:04:05.000Z',
    `${String(pb.lastSeen)} / ${pb.createdAt}`);
  ok('and this build encodes the fixture back to the same bytes',
    Array.from(Wire.fromBinary(bytes(GOLDEN_WIRE)).toBinary(),
      (b) => b.toString(16).padStart(2, '0')).join('') === GOLDEN_WIRE);

  console.log('\nA brand-new account — the keys must be NULL, not undefined:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(SPARSE_WIRE));
  const sparse = await getProfile();
  eq('decodes to the same object the JSON path produced', sparse, JSON.parse(SPARSE_JSON));
  ok('fifteen keys, exactly as the JSON has', keys(sparse) === keys(JSON.parse(SPARSE_JSON)),
    `${keys(sparse)} vs ${keys(JSON.parse(SPARSE_JSON))}`);
  ok('and the same types, nulls included', types(sparse) === types(JSON.parse(SPARSE_JSON)),
    `${types(sparse)} vs ${types(JSON.parse(SPARSE_JSON))}`);
  // The failure this rules out, and the reason value comparison is not enough:
  // `email: undefined` passes every eq() above — canon() drops it on BOTH
  // sides — and is still a different object to `in` and to Object.keys.
  for (const k of ['email', 'name', 'phone', 'photoURL', 'vaultId', 'dob', 'status',
    'lastSeen', 'authProvider', 'emailVerifiedAt'] as const) {
    ok(`${k} is present and null, not undefined`,
      k in sparse && sparse[k] === null, `${String(sparse[k])} (${typeof sparse[k]})`);
  }
  ok('online/hasPin are false, not missing', sparse.online === false && sparse.hasPin === false);
  // The real failure mode: writeCache('my-profile', p) round-trips through
  // JSON.stringify, which erases an undefined key entirely.
  const cached = JSON.parse(JSON.stringify(sparse));
  ok('survives writeCache with every key intact',
    keys(cached) === keys(JSON.parse(SPARSE_JSON)), keys(cached));
  eq('and with the same values', cached, JSON.parse(SPARSE_JSON));

  console.log('\nBad bytes and errors stay on the paths the call sites already handle:');
  for (const [name, body] of [
    ['garbage bytes', bytes('ffffffffffffffff')],
    ['a truncated message', bytes(GOLDEN_WIRE.slice(0, 30))],
    ['HTML from a captive portal, labelled protobuf', '<html>login here</html>'],
  ] as [string, Uint8Array | string][]) {
    serve(200, 'application/protobuf', body);
    let threw = false;
    try { await getProfile(); } catch { threw = true; }
    // Rejecting is the point: it looks exactly like a failed fetch, so
    // isSetupComplete() returns false and the profile tab keeps its cache.
    // A default-filled object would look like a real, empty profile.
    ok(`${name} → rejects, like a failed fetch`, threw);
  }
  serve(500, 'application/json; charset=utf-8', '{"error":"Failed to fetch profile"}');
  let msg = '';
  try { await getProfile(); } catch (e: any) { msg = e?.message; }
  ok("a 500 rejects with the server's wording, unchanged",
    msg === 'Failed to fetch profile', `(${msg})`);

  console.log(failures === 0
    ? '\n  All user-profile negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
