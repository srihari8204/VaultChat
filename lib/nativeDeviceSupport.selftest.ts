const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), 'utf8');
const androidAbis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const rustTriples = ['aarch64-linux-android', 'armv7-linux-androideabi', 'i686-linux-android', 'x86_64-linux-android'];

for (const file of [
  'plugins/crypto-core-android/build.gradle',
  'plugins/crypto-core-android/CMakeLists.txt',
  'plugins/transport-core-android/build.gradle',
  'plugins/transport-core-android/CMakeLists.txt',
  'plugins/vaultbeam-core-android/build.gradle',
  'plugins/vaultbeam-core-android/CMakeLists.txt',
]) {
  const src = read(file);
  for (const abi of androidAbis) assert.ok(src.includes(abi), `${file} must include ${abi}`);
  for (const triple of rustTriples) assert.ok(src.includes(triple), `${file} must include ${triple}`);
}

const cryptoFacade = read('services/crypto/index.ts');
assert.ok(cryptoFacade.includes("'ts' | 'rust'"), 'crypto backend must remain switchable');
assert.ok(cryptoFacade.includes("default 'ts'"), 'TS crypto must remain the default worldwide fallback');
assert.ok(cryptoFacade.includes('initNativeCrypto()') && cryptoFacade.includes('breadcrumb'), 'native crypto failure must fall back instead of crashing');
assert.ok(cryptoFacade.includes("cryptoBackend(): 'ts' | 'rust'"), 'QA diagnostics must expose the active crypto backend');

const nativeCrypto = read('services/crypto/native/CryptoCore.ts');
assert.ok(nativeCrypto.includes("NitroModules.createHybridObject('CryptoCore')"), 'Rust crypto must connect to Hermes through Nitro/JSI');
assert.ok(nativeCrypto.includes('selfCheck'), 'native crypto must self-check before use');

const nativeSocket = read('lib/ccwire/nativeSocket.ts');
assert.ok(nativeSocket.includes("Platform.OS !== 'android'"), 'Android Rust transport must be optional, not required on iOS');
assert.ok(nativeSocket.includes('return undefined'), 'missing native transport must degrade to platform WebSocket');
assert.ok(nativeSocket.includes('supportsWebTransport'), 'WebTransport must be capability-gated');

const socket = read('lib/socket.ts');
assert.ok(socket.includes("carrier: webTransport ? 'rust-wt' : webSocket ? 'rust-ws' : 'ws'"), 'carrier order must be WT, native WS, then platform WS');
assert.ok(socket.includes('webSocketFallback:'), 'WebTransport must have WebSocket fallback');
assert.ok(!socket.includes('socket.io-client'), 'new mobile runtime must not depend on socket.io-client');

const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.dependencies && pkg.dependencies['socket.io-client'], undefined, 'mobile package must not depend on socket.io-client');
assert.ok(pkg.scripts && pkg.scripts['build:android:apk'], 'full Android release build script must stay available');
assert.ok(pkg.scripts && pkg.scripts['build:android:apk:arm64'], 'fast arm64 device-install build script must stay available');

const app = read('app.json');
assert.ok(app.includes('com.facebook.hermes.**'), 'release shrinker rules must keep Hermes bridge classes');
assert.ok(app.includes('com.margelo.nitro.**'), 'release shrinker rules must keep Nitro bridge classes');
assert.ok(!read('package-lock.json').includes('node_modules/socket.io-client'), 'lockfile must not install socket.io-client');

console.log('Native device support: Rust/Hermes bridge, ABI coverage, CC-Wire fallback, and Socket.IO removal checks passed');
