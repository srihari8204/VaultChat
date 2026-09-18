// lib/backupMetaNegotiation.selftest.ts
//   run: npx tsx lib/backupMetaNegotiation.selftest.ts
//
// protobuf-migration. GET /user/backup/meta negotiates binary protobuf.
//
// WHAT THIS HAS TO PROVE, IN ORDER OF HOW BADLY IT WOULD HURT:
//   1. an opted-in call still works against a server that answers JSON — every
//      deployment before this one does — and costs no extra round trip;
//   2. it decodes the bytes the Go handler really wrote, into the SAME object
//      the JSON path produces — including the SHAPE of the no-backup answer,
//      which is `{exists:false}` with three keys ABSENT, not null and not zero.
//      app/restore-backup.tsx renders "sizeBytes bytes, messageCount messages"
//      off those keys, so a zero invented by the typed path would offer to
//      restore a backup that does not exist;
//   3. the mirror, which is the case a plain (non-optional) schema would lose:
//      a backup that really is 0 bytes / 0 messages must arrive PRESENT-and-zero.
//   4. sizeBytes stays a NUMBER. int64 generates as bigint, and a bigint reaches
//      JSON.stringify as a TypeError and reaches `${}` as "1234567n" — the
//      decoder narrows it, because the typed path adapts to the runtime type
//      rather than the other way round.
//
// api() cannot be imported under plain Node (@sentry/react-native, expo-router
// and expo-secure-store all reach react-native), and lib/cloudBackup.ts reaches
// a good deal further — react-native-fs, AsyncStorage, expo-sqlite through
// localDb, the e2ee session. All of them are stubbed through Module._load, and
// lib/cloudBackup.ts is require()d AFTER the patch — tsx compiles this to CJS,
// so a top-level import would be hoisted above it. The REAL module is
// exercised; nothing about the decoder is re-implemented here.

import { BackupMeta as Wire } from './ccwire/gen/ccwire/v1/backup_meta_pb';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
// Key ORDER is deliberately not compared: the JSON path hands back whatever
// order the server wrote, the typed path hands back the decoder's literal, and
// nothing downstream reads this object positionally. Every key and every value
// IS compared — and the SET of keys is compared separately below, because that
// is the part this endpoint can get wrong.
//
// The bigint arm is not decoration: JSON.stringify THROWS on a BigInt, so a
// decoder that forgot to narrow sizeBytes would blow this file up here instead
// of reporting the one check that names the problem. Rendering it as "1234567n"
// keeps the failure legible AND keeps it a failure — it can never compare equal
// to the number the JSON path produces.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === 'bigint' ? `${x}n`
      : x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x);
function eq(name: string, actual: unknown, expected: unknown) {
  // canon() for the DETAIL too, not JSON.stringify: see above — a stray bigint
  // must be reported, not thrown.
  ok(name, canon(actual) === canon(expected), `(got ${canon(actual)}, want ${canon(expected)})`);
}

const Module = require('module');
const noop = () => {};
const stubs: Record<string, any> = {
  '@sentry/react-native': { setUser: noop },
  'expo-router': { router: { replace: noop, push: noop } },
  'expo-secure-store': {
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
  },
  '@dr.pogodin/react-native-fs': {
    DocumentDirectoryPath: '/tmp', mkdir: async () => {}, writeFile: async () => {},
    readFile: async () => '', exists: async () => false, unlink: async () => {},
  },
  '@react-native-async-storage/async-storage': {
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
  },
  'react-native': { Platform: { OS: 'android', select: (o: any) => o.android ?? o.default } },
  // cloudBackup.ts's own heavy leaves. cloudBackupMeta() touches none of them —
  // it is api() and the decoder and nothing else — but a CJS require pulls the
  // whole module graph in, and expo-sqlite/expo-modules-core cannot initialise
  // outside a React Native runtime. Stubbed by the exact specifier the module
  // writes, so the file under test is still the REAL one.
  './backupSecretKeys': { isSecretBackupKey: () => false },
  './vaultCrypto': { vaultEncrypt: noop, vaultDecrypt: noop },
  './backupCrypto': {
    readE2EEHeader: noop, stampE2EEHeader: noop, newHeader: noop, backupSecret: noop,
    generateRecoveryKey: noop, passwordProblem: () => null,
  },
  './localDb': { exportAll: noop, importAll: noop },
  './storageRoots': { BACKUP_ROOT: '/tmp/backup', ensureDir: async () => {} },
  '../services/crypto/e2eeSession.rn': { e2eeGetCached: noop, e2eeCachePlaintext: noop },
  '../db/financeBackup': { buildBackup: noop, restoreBackup: noop },
  './googleDrive': { driveUpload: noop, driveDownload: noop },
};
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, ...rest);
};
(globalThis as any).__DEV__ = false;

const { cloudBackupMeta } = require('./cloudBackup') as typeof import('./cloudBackup');

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
// internal/routes/user_backup_meta_negotiation_test.go pins these exact bytes
// and this exact JSON from the SAME handler. Semantic agreement alone would let
// the two languages drift onto different field numbers and still both pass; the
// byte pin is what makes them one contract.
//   0801 exists, 1087ad4b size_bytes=1234567, 182a message_count=42,
//   2218 + the 24-byte ISO timestamp.
const GOLDEN_WIRE = '08011087ad4b182a2218323032362d30332d30345430353a30363a30372e3839305a';
const GOLDEN_JSON =
  '{"exists":true,"messageCount":42,"sizeBytes":1234567,"updatedAt":"2026-03-04T05:06:07.890Z"}\n';
const WANT = { exists: true, sizeBytes: 1234567, messageCount: 42, updatedAt: '2026-03-04T05:06:07.890Z' };

// No backup at all: proto3 elides every field, so the body is EMPTY.
const ABSENT_JSON = '{"exists":false}\n';
const ABSENT_WIRE = '';

// A backup that exists and is empty. 1000 and 1800 are the two bytes each that
// an explicit zero costs — the whole reason the schema says `optional`.
const EMPTY_BACKUP_WIRE = '0801100018002218323032362d30332d30345430353a30363a30372e3839305a';
const EMPTY_BACKUP_JSON =
  '{"exists":true,"messageCount":0,"sizeBytes":0,"updatedAt":"2026-03-04T05:06:07.890Z"}\n';

const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const keys = (o: object) => Object.keys(o).sort().join(',');

async function main() {
  console.log('\nBackup-meta content negotiation self-test\n');

  console.log('Against a server that answers JSON — i.e. every server today:');
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', GOLDEN_JSON);
  eq('same meta, from the unchanged JSON path', await cloudBackupMeta(), WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  ok('offers protobuf', calls[0].init.headers.Accept.includes('application/protobuf'));
  ok('still offers json, so an old server is never broken by it',
    calls[0].init.headers.Accept.includes('application/json'));
  ok('`proto` does not leak into the fetch init', !('proto' in calls[0].init),
    Object.keys(calls[0].init).join(','));

  console.log('\nAgainst a server that answers protobuf:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(GOLDEN_WIRE));
  const pb = await cloudBackupMeta();
  eq('decodes the bytes the Go handler really wrote', pb, WANT);
  ok('one request', calls.length === 1, `(${calls.length})`);
  eq('and to the very same object the JSON path produced', pb, JSON.parse(GOLDEN_JSON));
  ok('sizeBytes is a number, not the generated bigint',
    typeof pb.sizeBytes === 'number', typeof pb.sizeBytes);
  ok('and this build encodes it back to the same bytes',
    Array.from(Wire.fromBinary(bytes(GOLDEN_WIRE)).toBinary(),
      (b) => b.toString(16).padStart(2, '0')).join('') === GOLDEN_WIRE);

  console.log('\nNo backup — the keys must be ABSENT, not null and not zero:');
  calls.length = 0;
  serve(200, 'application/protobuf', bytes(ABSENT_WIRE));
  const absent = await cloudBackupMeta();
  eq('decodes to exists:false alone', absent, { exists: false });
  eq('and to the same object the JSON path produced', absent, JSON.parse(ABSENT_JSON));
  ok('exactly one key, as the JSON has', keys(absent) === 'exists', keys(absent));
  // The failure this rules out: `sizeBytes: undefined` would pass an `eq` above
  // and a JSON.stringify round trip, and still be a different object.
  ok("no 'sizeBytes' key at all", !('sizeBytes' in absent));
  ok("no 'messageCount' key at all", !('messageCount' in absent));
  ok("no 'updatedAt' key at all", !('updatedAt' in absent));
  ok('a zero-byte body is one request, not a failure', calls.length === 1, `(${calls.length})`);

  console.log('\nA backup that exists and is empty — every zero is a CHOICE:');
  serve(200, 'application/protobuf', bytes(EMPTY_BACKUP_WIRE));
  const emptyBackup = await cloudBackupMeta();
  eq('present-and-zero survives the wire', emptyBackup, JSON.parse(EMPTY_BACKUP_JSON));
  ok('sizeBytes is present and 0', 'sizeBytes' in emptyBackup && emptyBackup.sizeBytes === 0,
    canon(emptyBackup));
  ok('messageCount is present and 0',
    'messageCount' in emptyBackup && emptyBackup.messageCount === 0);
  // The distinction the whole schema rests on, stated once, in one line.
  ok('and it is a DIFFERENT object from "no backup"',
    keys(emptyBackup) !== keys(absent), `${keys(emptyBackup)} vs ${keys(absent)}`);

  console.log('\nThe decoded object still survives JSON.stringify:');
  // Screens pass this object around and restore-backup.tsx holds it in state;
  // a stray bigint would throw here rather than at the decode.
  let stringified = '';
  try { stringified = JSON.stringify(pb); } catch (e: any) { stringified = `THREW: ${e?.message}`; }
  ok('no bigint escapes the decoder', stringified.startsWith('{'), stringified);

  console.log('\nA non-answer is distinguishable from "there is no backup":');
  calls.length = 0;
  serve(500, 'application/json; charset=utf-8', '{"error":"Failed"}');
  const failed = await cloudBackupMeta();
  // `exists: false` is UNCHANGED, so every caller that only reads `exists`
  // behaves exactly as before. `unavailable` is the new part.
  eq('a 500 still answers exists:false', failed.exists, false);
  ok('a 500 is flagged unavailable', failed.unavailable === true, String(failed.unavailable));

  // THE REGRESSION THIS PINS. app/(tabs)/chats.tsx writes the once-per-install
  // flag `vc_restore_prompted`. It used to write it BEFORE reading `exists`, so
  // a reinstall whose first launch was offline marked itself prompted against a
  // non-answer and never offered the backup again — the user's entire history,
  // silently not offered, for the life of that install. Offline right after a
  // reinstall is the common case.
  //
  // A real answer must stay UNFLAGGED, or the screen would stop asking forever
  // in the opposite direction.
  calls.length = 0;
  serve(200, 'application/json; charset=utf-8', '{"exists":false}');
  const genuinelyNone = await cloudBackupMeta();
  ok('a real "no backup" is NOT flagged unavailable',
    genuinelyNone.exists === false && !('unavailable' in genuinelyNone),
    JSON.stringify(genuinelyNone));

  // Undecodable protobuf is the second way in, and the one this migration added.
  //
  // `0a7f` is chosen deliberately and is worth understanding: it is field 1
  // (`bool exists`) arriving with the LENGTH-DELIMITED wire type, claiming 127
  // bytes that are not there. protobuf-es does NOT throw on it — it decodes to
  // exactly `{ exists: true }`. So a truncated body, or one rewritten by a
  // proxy, announces a cloud backup that may not exist and offers a restore
  // that cannot succeed. Only the decoder's invariant check catches it.
  calls.length = 0;
  serve(200, 'application/protobuf', bytes('0a7f'));
  const garbled = await cloudBackupMeta();
  ok('a truncated body that silently decodes to exists:true is REFUSED',
    garbled.unavailable === true && garbled.exists === false, JSON.stringify(garbled));

  // The ones protobuf-es does reject on its own, for contrast — all four must
  // land on the same non-answer, never on a half-built object.
  for (const [hex, why] of [
    ['08', 'a tag with nothing after it'],
    ['ffffffff0f', 'an illegal tag'],
    ['3c68746d6c3e', '<html> from a captive portal'],
  ] as const) {
    calls.length = 0;
    serve(200, 'application/protobuf', bytes(hex));
    const bad = await cloudBackupMeta();
    ok(`${why} is a non-answer`, bad.unavailable === true, JSON.stringify(bad));
  }

  console.log(failures === 0
    ? '\n  All backup-meta negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
