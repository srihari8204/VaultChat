// scripts/bench/vault-cipher.ts — run: npx tsx scripts/bench/vault-cipher.ts [MiB]
//
// MB/s of the vault's v3/v4 chunk cipher at its real chunk size (1 MiB):
// @noble's pure-JS AES-256-GCM (lib/vaultCrypto jsChunkCipher, the fallback)
// against native AES-256-GCM through the createCipheriv API
// (nodeStyleChunkCipher — on a phone that is react-native-quick-crypto, here
// it is Node's own crypto, i.e. OpenSSL on this CPU). Seal and open are timed
// separately; the bytes are checked to be identical first.
//
// WHAT THIS CAN AND CANNOT TELL YOU: it is a desktop CPU running V8 with a JIT.
// A phone's Hermes runs @noble far slower (no JIT), and its OpenSSL uses the
// ARMv8 AES instructions, so read the ratio, not the numbers. The phone's own
// number comes from Vault Features → "Test encryption speed".

import nodeCrypto from 'node:crypto';

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'react-native-get-random-values') return {};
  return origLoad.call(this, request, ...rest);
};
const { jsChunkCipher, nodeStyleChunkCipher, verifiedChunkCipher, V3_CHUNK } =
  require('../../lib/vaultCrypto') as typeof import('../../lib/vaultCrypto');

const mib = Math.max(1, Number(process.argv[2]) || 64);
const native = verifiedChunkCipher(nodeStyleChunkCipher(nodeCrypto));
if (!native) throw new Error('Node crypto did not match @noble: the comparison would be meaningless.');

const key = new Uint8Array(nodeCrypto.randomBytes(32));
const aad = new Uint8Array(nodeCrypto.randomBytes(12 + 32));
const pt = new Uint8Array(nodeCrypto.randomBytes(V3_CHUNK));
const ivFor = (i: number) => { const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, i); return iv; };

function bench(c: typeof jsChunkCipher, chunks: number) {
  for (let i = 0; i < 2; i++) c.open(key, ivFor(i), aad, c.seal(key, ivFor(i), aad, pt));   // warm-up
  const sealed: Uint8Array[] = [];
  let t = performance.now();
  for (let i = 0; i < chunks; i++) sealed.push(c.seal(key, ivFor(i), aad, pt));
  const sealMs = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < chunks; i++) c.open(key, ivFor(i), aad, sealed[i]);
  const openMs = performance.now() - t;
  const mb = (chunks * V3_CHUNK) / 1e6;
  return { seal: mb / (sealMs / 1000), open: mb / (openMs / 1000), sealMs, openMs };
}

const a = jsChunkCipher.seal(key, ivFor(0), aad, pt);
const b = native.seal(key, ivFor(0), aad, pt);
if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) throw new Error('ciphertexts differ');

// @noble is slow enough that a smaller run gives a stable number.
const jsChunks = Math.min(mib, 32);
const js = bench(jsChunkCipher, jsChunks);
const nat = bench(native, mib);
const f = (v: number) => v.toFixed(1).padStart(8);
console.log(`vault chunk cipher, 1 MiB chunks, Node ${process.version} (${process.arch})`);
console.log(`  @noble (JS)        ${String(jsChunks).padStart(3)} MiB  seal ${f(js.seal)} MB/s  open ${f(js.open)} MB/s`);
console.log(`  native (OpenSSL)   ${String(mib).padStart(3)} MiB  seal ${f(nat.seal)} MB/s  open ${f(nat.open)} MB/s`);
console.log(`  native / JS        seal ×${(nat.seal / js.seal).toFixed(0)}  open ×${(nat.open / js.open).toFixed(0)}`);
