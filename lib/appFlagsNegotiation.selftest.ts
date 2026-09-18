// lib/appFlagsNegotiation.selftest.ts
//   run: npx tsx lib/appFlagsNegotiation.selftest.ts
//
// protobuf-migration. GET /app/flags — the kill switch, and the last
// unauthenticated request on the cold-start path — negotiates binary protobuf.
//
// WHAT THIS HAS TO PROVE, IN ORDER OF HOW BADLY IT WOULD HURT:
//
//   1. A DECODE FAILURE MUST NOT CLEAR THE KILL SWITCHES. flagsFromProtobuf()
//      returns null — never `{}` — for bytes it cannot read, and remoteFlags.ts
//      only assigns on a non-null result. `{}` there would mean "the server says
//      nothing is switched off", so a truncated response, a proxy that mangled
//      the body, or a content-type that lied would SILENTLY RE-ENABLE a feature
//      an operator killed during an incident. Nothing would report an error.
//      This is the highest-consequence check in the file.
//   2. NO REMOTE ENABLE. appFlags() deletes every `true` before serialising, so
//      a flag an operator set to true must appear in NEITHER representation.
//      That asymmetry — the server can only turn things OFF — is the entire
//      safety argument for leaving this endpoint unauthenticated.
//   3. EQUIVALENCE. For the same killed flags the two paths must produce an
//      IDENTICAL object, and therefore an identical persisted cache string:
//      vaultchat.remoteFlags.v1 holds JSON.stringify(snapshot), and a cold start
//      with no network reads it back. If the representations disagreed, which
//      features are alive would depend on which one the last launch happened to
//      get.
//   4. THE EMPTY ANSWER. Nothing killed ⇒ an empty repeated field ⇒ proto3
//      writes NOTHING. A zero-byte body is a complete answer meaning `{}`, not a
//      failure, and the length is asserted on both sides.
//
// The REAL lib/remoteFlags.ts is exercised — the guard being tested is a branch
// inside it, so re-implementing the flow here would test nothing. It reaches
// AsyncStorage, which is stubbed through Module._load with an in-memory store
// the checks below read back; tsx compiles this to CJS, so remoteFlags is
// require()d AFTER the patch rather than imported at the top.
//
// The module memoises its snapshot and its in-flight load for the life of the
// process, which is correct in the app and useless in a test, so each scenario
// drops it from require.cache and gets a fresh one.

import { AppFlags as Wire } from './ccwire/gen/ccwire/v1/app_flags_pb';
import { flagsFromProtobuf, APP_FLAGS_ACCEPT, sanitizeFlags, resolveFlag } from './remoteFlagPolicy';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
// Key ORDER is not compared by eq(): nothing downstream reads this object
// positionally. Order IS compared separately, as the persisted cache STRING,
// because that string is what a cold start reads back and it is where an
// unsorted wire would show up.
//
// bigint-safe for the same reason backupMetaNegotiation.selftest.ts is: this
// message carries only strings today, but JSON.stringify THROWS on a BigInt, and
// a canon() that throws reports a stack trace instead of the one check that
// names the problem. `${x}n` keeps it legible AND keeps it a failure.
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
const store = new Map<string, string>();
const stubs: Record<string, any> = {
  // __esModule matters: without it the CJS interop tsx emits for
  // `import AsyncStorage from '...'` hands back the whole stub object, so
  // AsyncStorage.getItem is undefined, every access throws, and remoteFlags.ts
  // swallows it exactly as it swallows a corrupt cache — the persistence checks
  // would then pass against a store that was never written.
  '@react-native-async-storage/async-storage': {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  },
};
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).__DEV__ = false;

const CACHE_KEY = 'vaultchat.remoteFlags.v1';

/** A remoteFlags.ts with its module-level snapshot and in-flight load cleared. */
function freshRemoteFlags(): typeof import('./remoteFlags') {
  for (const k of Object.keys(require.cache)) {
    if (/remoteFlags|remoteFlagPolicy/.test(k)) delete require.cache[k];
  }
  return require('./remoteFlags');
}

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
// internal/routes/app_flags_negotiation_test.go pins these exact bytes and this
// exact JSON from the SAME handler, with VAULTCHAT_REMOTE_FLAGS set to
// {"mini.games": false, "call.video": false}. Semantic agreement alone would let
// the two languages drift onto different field numbers, or onto different
// orders, and still both pass; the byte pin is what makes them one contract.
//
//   0a is `repeated string disabled = 1`, then the length, then the name in
//   UTF-8. SORTED — "call.video" before "mini.games" — because Go randomises map
//   iteration while encoding/json sorts object keys, and disabledNames() sorts
//   so the two representations cannot disagree.
const GOLDEN_WIRE = '0a0a63616c6c2e766964656f' + '0a0a6d696e692e67616d6573';
const GOLDEN_JSON =
  '{"flags":{"call.video":false,"mini.games":false},' +
  '"note":"false disables a feature; true is ignored. This endpoint cannot enable anything."}\n';
const WANT = { 'call.video': false, 'mini.games': false };
// What both paths must persist, byte for byte, under vaultchat.remoteFlags.v1.
const WANT_CACHE = '{"call.video":false,"mini.games":false}';

// mini.games killed, call.video and chat.search set to TRUE in the env. The
// trues are gone from both representations before they reach the wire.
const ENABLE_ATTEMPT_WIRE = '0a0a6d696e692e67616d6573';
const ENABLE_ATTEMPT_JSON =
  '{"flags":{"mini.games":false},' +
  '"note":"false disables a feature; true is ignored. This endpoint cannot enable anything."}\n';

// Nothing killed. proto3 elides an empty repeated field, so the body is EMPTY.
const EMPTY_WIRE = '';
const EMPTY_JSON =
  '{"flags":{},' +
  '"note":"false disables a feature; true is ignored. This endpoint cannot enable anything."}\n';

// A length prefix of 127 with nothing behind it. Truncation is the realistic
// failure — a proxy that cut the body, a connection that died mid-response —
// and it is indistinguishable from "no flags" to anything that treats a decode
// error as an empty answer.
const GARBAGE_WIRE = '0a7f';

const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function main() {
  console.log('\nApp-flags content negotiation self-test\n');

  console.log('Against a server that answers JSON — i.e. every server today:');
  store.clear();
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  const jsonFlags = await freshRemoteFlags().loadRemoteFlags();
  eq('same kill switches, from the unchanged JSON path', jsonFlags, WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  ok('offers protobuf', calls[0].init.headers.Accept.includes('application/protobuf'));
  ok('still offers json, so an old server is never broken by it',
    calls[0].init.headers.Accept.includes('application/json'));
  ok('and that is exactly APP_FLAGS_ACCEPT',
    calls[0].init.headers.Accept === APP_FLAGS_ACCEPT, calls[0].init.headers.Accept);
  const jsonCache = store.get(CACHE_KEY);
  ok('persists the snapshot for the next cold start', jsonCache === WANT_CACHE, String(jsonCache));

  console.log('\nAgainst a server that answers protobuf:');
  store.clear();
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  const pbApi = freshRemoteFlags();
  const pbFlags = await pbApi.loadRemoteFlags();
  eq('decodes the bytes the Go handler really wrote', pbFlags, WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  // EQUIVALENCE, stated the two ways that matter: the decoded object, and the
  // string that survives to the next launch.
  eq('and to the very same object the JSON path produced', pbFlags, jsonFlags);
  ok('and to the very same persisted cache string, byte for byte',
    store.get(CACHE_KEY) === jsonCache, `${store.get(CACHE_KEY)} vs ${jsonCache}`);
  ok('every value is a literal false, never a truthy anything',
    Object.values(pbFlags).every((v) => v === false), canon(pbFlags));
  ok('flagEnabled() honours it', pbApi.flagEnabled('mini.games', true) === false);
  ok('and leaves a flag nobody killed alone', pbApi.flagEnabled('chat.search', true) === true);

  console.log('\nSORTED NAMES — the byte pin the Go test asserts too:');
  ok('this build encodes the sorted names to the pinned bytes',
    hex(new Wire({ disabled: ['call.video', 'mini.games'] }).toBinary()) === GOLDEN_WIRE,
    hex(new Wire({ disabled: ['call.video', 'mini.games'] }).toBinary()));
  ok('and round-trips the handler bytes back to themselves',
    hex(Wire.fromBinary(bytes(GOLDEN_WIRE)).toBinary()) === GOLDEN_WIRE);
  // If disabledNames() lost its sort, Go would emit this instead — a different
  // string, so the pin above is the thing that catches it.
  ok('an unsorted wire is a DIFFERENT byte string, so the pin bites',
    hex(new Wire({ disabled: ['mini.games', 'call.video'] }).toBinary()) !== GOLDEN_WIRE);
  // …and the client's own output order follows the wire order, which is why it
  // has to be the sorted one for the cache strings to match.
  ok('the rebuilt object keys follow the wire order',
    Object.keys((await flagsFromProtobuf(bytes(GOLDEN_WIRE)))!).join(',') === 'call.video,mini.games');

  console.log('\nNo flags killed — ZERO BYTES is the answer, not a failure:');
  store.clear();
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(EMPTY_WIRE));
  const emptyApi = freshRemoteFlags();
  const empty = await emptyApi.loadRemoteFlags();
  ok('the typed body really is zero bytes', bytes(EMPTY_WIRE).length === 0,
    `${bytes(EMPTY_WIRE).length}`);
  eq('and decodes to {}', empty, {});
  ok('not undefined, not null', empty !== undefined && empty !== null);
  ok('a zero-byte body is one request, not a failure', calls.length === 1, `(${calls.length})`);
  eq('the JSON path says the same thing', sanitizeFlags(JSON.parse(EMPTY_JSON).flags), {});
  ok('and persists the same empty snapshot', store.get(CACHE_KEY) === '{}', String(store.get(CACHE_KEY)));
  ok('so nothing is switched off', emptyApi.flagEnabled('mini.games', true) === true);

  console.log('\nNO REMOTE ENABLE — a `true` reaches neither representation:');
  store.clear();
  serve(200, 'application/protobuf', bytes(ENABLE_ATTEMPT_WIRE));
  const pbEnable = await freshRemoteFlags().loadRemoteFlags();
  serve(200, 'application/json; charset=utf-8', ENABLE_ATTEMPT_JSON);
  const jsEnable = await freshRemoteFlags().loadRemoteFlags();
  eq('typed path: mini.games alone', pbEnable, { 'mini.games': false });
  eq('json path: mini.games alone', jsEnable, { 'mini.games': false });
  ok("'call.video' is absent from the typed path", !('call.video' in pbEnable), canon(pbEnable));
  ok("'call.video' is absent from the JSON path", !('call.video' in jsEnable), canon(jsEnable));
  ok("'chat.search' is absent from the typed path", !('chat.search' in pbEnable));
  ok("'chat.search' is absent from the JSON path", !('chat.search' in jsEnable));
  // The consequence, not just the shape: a flag an operator "enabled" remotely
  // cannot switch a feature the build does not have.
  ok('and even if one did arrive, a remote true cannot turn on what the build ships off',
    resolveFlag('call.video', false, { 'call.video': true }) === false);

  console.log('\nA BODY THAT WILL NOT DECODE MUST NOT CLEAR THE KILL SWITCHES:');
  // The strict half of the contract, before the integration half: null, not {}.
  const decoded = await flagsFromProtobuf(bytes(GARBAGE_WIRE));
  ok('flagsFromProtobuf returns null for garbage', decoded === null, canon(decoded));
  ok('and specifically NOT {} — {} would mean "nothing is switched off"',
    decoded === null && canon(decoded) !== '{}');

  // And now the whole path: yesterday's kill switch is in the cache, today's
  // response is unreadable, and mini.games must STILL be off.
  store.clear();
  store.set(CACHE_KEY, '{"mini.games":false}');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(GARBAGE_WIRE));
  const rescued = freshRemoteFlags();
  const after = await rescued.loadRemoteFlags();
  eq('the persisted snapshot survives an undecodable response', after, { 'mini.games': false });
  ok('the cache on disk is untouched', store.get(CACHE_KEY) === '{"mini.games":false}',
    String(store.get(CACHE_KEY)));
  ok('mini.games is STILL off — the whole point of this file',
    rescued.flagEnabled('mini.games', true) === false);
  ok('the request was made; it is the ASSIGNMENT that was skipped',
    calls.length === 1, `(${calls.length})`);

  console.log('\nEverything else that fails still leaves the cache alone:');
  for (const [label, run] of [
    ['a 500', () => serve(500, 'application/json; charset=utf-8', '{"error":"nope"}')],
    ['a network error', () => { (globalThis as any).fetch = async () => { throw new Error('offline'); }; }],
    ['a body that is not JSON either', () => serve(200, 'application/json; charset=utf-8', 'not json')],
  ] as [string, () => void][]) {
    store.clear();
    store.set(CACHE_KEY, '{"mini.games":false}');
    run();
    const api = freshRemoteFlags();
    eq(`${label} keeps yesterday's kill switch`, await api.loadRemoteFlags(), { 'mini.games': false });
    ok(`${label} leaves the cache string alone`,
      store.get(CACHE_KEY) === '{"mini.games":false}', String(store.get(CACHE_KEY)));
  }

  console.log(failures === 0
    ? '\n  All app-flags negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
