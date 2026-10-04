// lib/vaultCryptoNative.selftest.ts — run: npx tsx lib/vaultCryptoNative.selftest.ts
//
// The v3/v4 chunk cipher runs on native AES-256-GCM (react-native-quick-crypto)
// when the module is present, and on @noble's JS AES-GCM otherwise. The file
// format must not depend on which one sealed a file. Node's own crypto stands
// in for quick-crypto here (it is the same createCipheriv API over OpenSSL):
//   • the build picks the native cipher when it is there and passes the check,
//   • one chunk is byte-for-byte the same from both, for every edge length,
//   • a whole file sealed by one opens with the other, both ways, and two seals
//     with the same header nonce are byte-identical files,
//   • a wrong key, a moved file and a flipped bit fail on the native path too,
//   • a native module that is missing or disagrees with @noble is not used,
//   • progress and cancel still work on the native path,
//   • the in-app speed test reports both ciphers,
//   • the key record's async open/seal (PBKDF2 off the JS thread) read and
//     write the same records as the sync ones.

import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native-get-random-values') return {};
  // quick-crypto's API is Node's: hand the module Node's crypto.
  if (request === 'react-native-quick-crypto') return nodeCrypto;
  return origLoad.call(this, request, ...rest);
};
const {
  chunkCipher, jsChunkCipher, nodeStyleChunkCipher, verifiedChunkCipher,
  v3SealStream, v3OpenStream, V3_CHUNK, VaultCancelledError,
  newVaultKeys, sealVaultKeys, openVaultKeys, sealVaultKeysAsync, openVaultKeysAsync,
} = require('./vaultCrypto') as typeof import('./vaultCrypto');
const { measureSealSpeed, formatMbPerSec, mbPerSec } = require('./vaultCipherSpeed') as typeof import('./vaultCipherSpeed');

const native = chunkCipher();
assert.equal(native.name, 'native', 'with quick-crypto present (and verified), the build uses the native cipher');
assert.equal(chunkCipher(), native, 'the choice is made once');

const rnd = (n: number) => new Uint8Array(nodeCrypto.randomBytes(n));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// One chunk: identical bytes, and each opens the other's.
for (const len of [0, 1, 15, 16, 17, 4096, V3_CHUNK]) {
  const key = rnd(32), iv = rnd(12), aad = rnd(12 + 36), pt = rnd(len);
  const a = jsChunkCipher.seal(key, iv, aad, pt);
  const b = native.seal(key, iv, aad, pt);
  assert.equal(a.length, len + 16);
  assert.ok(eq(a, b), `chunk of ${len} bytes: native and JS ciphertext ‖ tag are identical`);
  assert.ok(eq(native.open(key, iv, aad, a), pt), `native opens JS (${len})`);
  assert.ok(eq(jsChunkCipher.open(key, iv, aad, b), pt), `JS opens native (${len})`);
  // An AAD that is a view into a larger buffer must still be just the AAD.
  const big = rnd(aad.length + 20); big.set(aad, 7);
  assert.ok(eq(native.seal(key, iv, big.subarray(7, 7 + aad.length), pt), a), 'an AAD view is bound as itself');
}

// Whole files through the real stream functions.
const source = (bytes: Uint8Array) => { let at = 0; return (n: number) => { const b = bytes.slice(at, at + n); at += n; return b; }; };
const sink = () => { const parts: Uint8Array[] = []; return { write: (b: Uint8Array) => { parts.push(b.slice()); }, bytes: () => new Uint8Array(Buffer.concat(parts)) }; };

async function seal(dek: Uint8Array, plain: Uint8Array, id: string, cipher: typeof native) {
  const out = sink();
  await v3SealStream(dek, plain.length, source(plain), out.write, id, { cipher });
  return out.bytes();
}
async function open(deks: Uint8Array[], sealed: Uint8Array, id: string, cipher: typeof native) {
  const out = sink();
  await v3OpenStream(deks, sealed.length, source(sealed), out.write, id, { cipher });
  return out.bytes();
}

/** Run `fn` with the RNG returning a fixed 8-byte nonce, so two seals share a header. */
async function withFixedNonce<T>(fn: () => Promise<T>): Promise<T> {
  const c = globalThis.crypto as Crypto;
  const orig = c.getRandomValues.bind(c);
  (c as { getRandomValues: Crypto['getRandomValues'] }).getRandomValues = (<A extends ArrayBufferView | null>(a: A): A => {
    if (a) new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(0x5a);
    return a;
  }) as Crypto['getRandomValues'];
  try { return await fn(); } finally { (c as { getRandomValues: Crypto['getRandomValues'] }).getRandomValues = orig; }
}

(async () => {
  const dek = rnd(32);
  const ID = 'f_1730000000000_abc';
  for (const size of [0, 1, V3_CHUNK - 1, V3_CHUNK, V3_CHUNK + 1, 2 * V3_CHUNK + 12345]) {
    const plain = rnd(size);
    const byJs = await seal(dek, plain, ID, jsChunkCipher);
    const byNative = await seal(dek, plain, ID, native);
    assert.ok(eq(await open([dek], byJs, ID, native), plain), `native opens a JS-sealed file (${size})`);
    assert.ok(eq(await open([dek], byNative, ID, jsChunkCipher), plain), `JS opens a native-sealed file (${size})`);
    // Same header nonce → the two files are the same bytes.
    const [fa, fb] = await withFixedNonce(async () => [await seal(dek, plain, ID, jsChunkCipher), await seal(dek, plain, ID, native)]);
    assert.ok(eq(fa, fb), `the whole file is byte-identical from both ciphers (${size})`);
  }

  // Failures stay failures on the native path.
  const plain = rnd(V3_CHUNK + 99);
  const sealed = await seal(dek, plain, ID, native);
  await assert.rejects(open([rnd(32)], sealed, ID, native), /could not be opened/, 'wrong key');
  await assert.rejects(open([dek], sealed, 'f_other', native), /moved from another entry/, 'another entry id');
  const flipped = sealed.slice(); flipped[flipped.length - 3] ^= 1;
  await assert.rejects(open([dek], flipped, ID, native), /damaged/, 'a flipped bit in the last chunk');
  assert.ok(eq(await open([rnd(32), dek], sealed, ID, native), plain), 'the key ring still finds the right key');

  // Progress and cancel on the native path.
  const seen: string[] = [];
  await v3SealStream(dek, 2 * V3_CHUNK + 1, source(new Uint8Array(2 * V3_CHUNK + 1)), () => {}, ID, { cipher: native, onProgress: (d, t) => seen.push(`${d}/${t}`) });
  assert.deepEqual(seen, ['1/3', '2/3', '3/3']);
  let calls = 0;
  await assert.rejects(
    v3SealStream(dek, 2 * V3_CHUNK, source(new Uint8Array(2 * V3_CHUNK)), () => {}, ID, { cipher: native, cancelled: () => ++calls > 1 }),
    (e: unknown) => e instanceof VaultCancelledError,
  );

  // A missing or wrong native module is never used.
  assert.equal(verifiedChunkCipher(nodeStyleChunkCipher({
    createCipheriv: () => { throw new Error('NitroModules not found'); },
    createDecipheriv: () => { throw new Error('NitroModules not found'); },
  })), null, 'a module that throws is not used');
  const ignoresAad = nodeStyleChunkCipher({
    createCipheriv: (a, k, iv) => { const c = nodeCrypto.createCipheriv(a as 'aes-256-gcm', k, iv); return { setAAD: () => c, update: (b) => c.update(b), final: () => c.final(), getAuthTag: () => c.getAuthTag() }; },
    createDecipheriv: (a, k, iv) => { const d = nodeCrypto.createDecipheriv(a as 'aes-256-gcm', k, iv); return { setAAD: () => d, setAuthTag: (t) => d.setAuthTag(t), update: (b) => d.update(b), final: () => d.final() }; },
  });
  assert.equal(verifiedChunkCipher(ignoresAad), null, 'a module that drops the AAD (different bytes) is not used');
  const acceptsAnything = { ...native, open: (_k: Uint8Array, _iv: Uint8Array, _a: Uint8Array, ct: Uint8Array) => ct.slice(0, ct.length - 16) };
  assert.equal(verifiedChunkCipher(acceptsAnything), null, 'a cipher that does not check the tag is not used');
  assert.equal(verifiedChunkCipher(jsChunkCipher), jsChunkCipher);

  // Key records: async and sync PBKDF2 are interchangeable.
  const keys = newVaultKeys('2468');
  const syncRec = sealVaultKeys('2468', keys);
  const asyncRec = await sealVaultKeysAsync('2468', keys);
  assert.ok(eq((await openVaultKeysAsync('2468', syncRec))!.dek, keys.dek), 'async opens a sync-sealed record');
  assert.ok(eq(openVaultKeys('2468', asyncRec)!.dek, keys.dek), 'sync opens an async-sealed record');
  assert.equal(await openVaultKeysAsync('1357', asyncRec), null, 'a wrong PIN opens nothing (async)');
  assert.equal(await openVaultKeysAsync('2468', { ...asyncRec, ct: asyncRec.ct.slice(0, -4) + 'AAAA' }), null, 'a damaged record opens nothing (async)');
  assert.equal(await openVaultKeysAsync('2468', null), null);

  // The speed test: both ciphers, cancel, formatting.
  const n = await measureSealSpeed(2);
  assert.equal(n.cipher, 'native');
  assert.equal(n.bytes, 2 * V3_CHUNK);
  assert.ok(n.mbPerSec > 0);
  const j = await measureSealSpeed(1, { cipher: jsChunkCipher });
  assert.equal(j.cipher, 'js');
  let k = 0;
  await assert.rejects(measureSealSpeed(3, { cancelled: () => ++k > 1 }), (e: unknown) => e instanceof VaultCancelledError);
  let t = 0;
  const fixed = await measureSealSpeed(1, { now: () => (t += 50) });
  assert.equal(fixed.ms, 50);
  assert.equal(formatMbPerSec(fixed.mbPerSec), '21 MB/s');   // 1.048576 MB in 50 ms
  assert.equal(mbPerSec(10e6, 0), Infinity);
  assert.equal(formatMbPerSec(Infinity), 'over 1,000 MB/s');
  assert.equal(formatMbPerSec(312.4), '312 MB/s');
  assert.equal(formatMbPerSec(4.84), '4.8 MB/s');
  assert.equal(formatMbPerSec(0.623), '0.62 MB/s');

  console.log(`vaultCryptoNative selftest: OK (native ${formatMbPerSec(n.mbPerSec)}, JS ${formatMbPerSec(j.mbPerSec)} on this machine)`);
})().catch((e) => { console.error(e); process.exit(1); });
