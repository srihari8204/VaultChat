// lib/appVersionNegotiation.selftest.ts — run: npx tsx lib/appVersionNegotiation.selftest.ts
//
// protobuf-migration task 3.1. GET /app/version is the first operation that can
// answer in binary, and the client must read EITHER representation into the
// same gate — because a server that never heard of protobuf (every deployment
// before this one) keeps answering JSON, and because falling back to "no usable
// answer" is what keeps a bad decode from locking every user out.
//
// The fetch wrapper itself (lib/appVersion.ts) cannot be loaded under Node —
// expo-constants drags in react-native — so, exactly as appVersion.selftest.ts
// already does, this exercises the parsing half that lives in appVersionPolicy.
// The server half is proven in Go: internal/routes/appversion_negotiation_test.go.

import { AppVersionGate } from './ccwire/gen/ccwire/v1/app_version_pb';
import {
  APP_VERSION_ACCEPT, gateFromJson, gateFromProtobuf, verdictFor, type VersionGate,
} from './appVersionPolicy';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}`);
}
function eqGate(name: string, actual: VersionGate | null, expected: VersionGate | null) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `(got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const want: VersionGate = {
  minBuild: 24, adviseBuild: 30,
  updateUrl: 'https://example.test/update',
  message: 'Security fix in 1.2.16',
};

// What the Go handler writes for each representation, for the same config.
const pbBytes = new AppVersionGate({
  minBuild: BigInt(24), adviseBuild: BigInt(30),
  updateUrl: want.updateUrl, message: want.message,
}).toBinary();

// The bytes the Go handler actually produced for that config, pinned there too
// (appversion_negotiation_test.go, const goldenWire). Semantic agreement alone
// would let the two sides drift onto different field numbers and still both
// "pass"; the byte pin is what makes them one contract.
const GOLDEN_WIRE = '0818101e1a1b68747470733a2f2f6578616d706c652e746573742f757064617465221653656375726974792066697820696e20312e322e3136';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const jsonBody = JSON.stringify({
  adviseBuild: 30, message: want.message, minBuild: 24, updateUrl: want.updateUrl,
}) + '\n';

// tsx transpiles selftests to CJS, so no top-level await.
async function main() {
  console.log('\nApp-version content negotiation self-test\n');

  console.log('Both representations decode to the same gate:');
  eqGate('protobuf', await gateFromProtobuf(pbBytes), want);
  eqGate('json (the path every existing server takes)', gateFromJson(jsonBody), want);
  ok('and therefore to the same verdict',
    verdictFor(23, await gateFromProtobuf(pbBytes)) === 'blocked' &&
    verdictFor(23, gateFromJson(jsonBody)) === 'blocked');

  console.log('\nThe client reads the bytes the Go handler really wrote:');
  ok('this build encodes them identically', hex(pbBytes) === GOLDEN_WIRE, `(got ${hex(pbBytes)})`);
  eqGate('and decodes the server\'s own bytes to the same gate',
    await gateFromProtobuf(Uint8Array.from(
      (GOLDEN_WIRE.match(/../g) ?? []).map((h) => parseInt(h, 16)))), want);

  console.log('\nThe request asks for both, so an old server is never broken by it:');
  ok('offers protobuf', APP_VERSION_ACCEPT.includes('application/protobuf'));
  ok('still offers json', APP_VERSION_ACCEPT.includes('application/json'));

  console.log('\nAn unconfigured server blocks nobody in either representation:');
  const emptyGate: VersionGate = { minBuild: 0, adviseBuild: 0, updateUrl: '', message: '' };
  eqGate('empty protobuf message', await gateFromProtobuf(new AppVersionGate({}).toBinary()), emptyGate);
  eqGate('json zeros', gateFromJson('{"minBuild":0,"adviseBuild":0,"updateUrl":"","message":""}'), emptyGate);
  ok('neither blocks', verdictFor(1, emptyGate) === 'ok');

  console.log('\nGarbage is "no usable answer", never a lockout:');
  eqGate('a captive portal\'s HTML', gateFromJson('<html>Sign in to WiFi</html>'), null);
  eqGate('truncated protobuf', await gateFromProtobuf(pbBytes.slice(0, 3)), null);
  eqGate('JSON bytes mislabelled as protobuf',
    await gateFromProtobuf(new TextEncoder().encode(jsonBody)), null);
  ok('null means allowed', verdictFor(1, null) === 'ok');

  console.log('\nA protobuf gate is not weakened by the trip through bigint:');
  const big = new AppVersionGate({ minBuild: BigInt(2147483647), adviseBuild: BigInt(2147483647) }).toBinary();
  const decodedBig = await gateFromProtobuf(big);
  ok('int32-max versionCode survives exactly', decodedBig?.minBuild === 2147483647,
    `(got ${decodedBig?.minBuild})`);
  ok('and still blocks an older build', verdictFor(2147483646, decodedBig) === 'blocked');

  console.log(failures === 0
    ? '\n  All app-version negotiation checks passed\n'
    : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);

}

void main();
