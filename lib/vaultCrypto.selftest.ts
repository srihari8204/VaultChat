// lib/vaultCrypto.selftest.ts — run: npx tsx lib/vaultCrypto.selftest.ts
//
// The v2 vault format (a random file key wrapped under the PIN) must never cost
// a user a file they already had. These checks run the real functions:
//   • a v1 file (key derived from the PIN) still opens after v2 is set up,
//   • and still opens after the PIN is CHANGED (the case v1 alone lost),
//   • v2 files survive a PIN change because only the wrap is redone,
//   • a wrong PIN opens nothing, and a damaged record opens nothing,
//   • without keys, a new file is refused (never sealed in the weaker v1),
//   • v3/v4 (chunked) round-trip every size and reject tampering/truncation,
//   • v4 binds the file id (two .enc files cannot be swapped), and v3 files
//     written before that still open,
//   • archived keys ("Try an old PIN") open v1, v2 and v4 files read-only,
//   • a seal or open can report progress and be cancelled.

import assert from 'node:assert/strict';

// The only RN import is the getRandomValues polyfill, which Node does not need
// (globalThis.crypto exists). Stub it, then require() the shipping file —
// tsx compiles this to CJS, so the patch is in place before the load.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native-get-random-values') return {};
  return origLoad.call(this, request, ...rest);
};
const {
  vaultEncrypt, vaultDecrypt, newVaultKeys, sealVaultKeys, openVaultKeys,
  vaultFileEncrypt, vaultFileDecrypt, clearVaultKeyCache, VaultKeyMissingError,
  v3SealStream, v3OpenStream, v3PlainSize, v3ChunkCount, v3SealedSize, isV3, V3_CHUNK, V3_HEADER_BYTES,
  V3_MAGIC, VaultCancelledError,
} = require('./vaultCrypto') as typeof import('./vaultCrypto');
const { gcm } = require('@noble/ciphers/aes.js') as typeof import('@noble/ciphers/aes.js');

const OLD = '123456';
const NEW = '9081';

// v1 round-trip is unchanged (lib/cloudBackup depends on it).
const v1 = vaultEncrypt(OLD, 'legacy-bytes');
assert.equal(v1.v, 1);
assert.equal(vaultDecrypt(OLD, v1), 'legacy-bytes');

// First unlock after the upgrade, still under the OLD PIN.
const keys = newVaultKeys(OLD);
const rec = sealVaultKeys(OLD, keys);
assert.equal(rec.v, 2);
const opened = openVaultKeys(OLD, rec);
assert.ok(opened, 'the PIN that sealed the record opens it');
assert.deepEqual(opened!.dek, keys.dek);
assert.equal(openVaultKeys(NEW, rec), null, 'a different PIN opens nothing');
assert.equal(openVaultKeys(OLD, { ...rec, ct: rec.ct.slice(0, -4) + 'AAAA' }), null, 'a damaged record opens nothing');
assert.equal(openVaultKeys(OLD, null), null);

// New files are v2 and open with the keys.
const v2 = vaultFileEncrypt(opened, OLD, 'new-bytes');
assert.equal(v2.v, 2);
assert.equal(vaultFileDecrypt(opened, OLD, v2), 'new-bytes');
assert.equal(vaultFileDecrypt(opened, OLD, v1), 'legacy-bytes', 'v1 opens through the carried legacy key');

// PIN change: re-wrap only. Both formats still open under the NEW PIN.
const rewrapped = sealVaultKeys(NEW, openVaultKeys(OLD, rec)!);
clearVaultKeyCache();
const afterChange = openVaultKeys(NEW, rewrapped);
assert.ok(afterChange, 'the new PIN opens the re-wrapped record');
assert.equal(openVaultKeys(OLD, rewrapped), null, 'the old PIN no longer does');
assert.equal(vaultFileDecrypt(afterChange, NEW, v2), 'new-bytes', 'v2 survives a PIN change');
assert.equal(vaultFileDecrypt(afterChange, NEW, v1), 'legacy-bytes', 'v1 survives a PIN change');

// No keys (record unopenable): v1 still opens with the PIN entered, a v2 file
// reports why it cannot open, and a NEW file is refused rather than sealed in
// the constant-salt v1 format (round 4: fail closed, never weaker crypto).
assert.equal(vaultFileDecrypt(null, OLD, v1), 'legacy-bytes');
assert.throws(() => vaultFileEncrypt(null, NEW, 'fallback'), (e: any) => e instanceof VaultKeyMissingError);
assert.throws(() => vaultFileDecrypt(null, NEW, v2), /vault key/);
assert.throws(() => vaultFileDecrypt(afterChange, NEW, vaultEncrypt('5555', 'x')), /earlier PIN/);

// ── v3: chunked streaming ────────────────────────────────────────────────
// In-memory source/sink standing in for the file handles app/vault uses.
function source(bytes: Uint8Array) {
  let pos = 0;
  return (n: number) => { const b = bytes.slice(pos, pos + n); pos += b.length; return b; };
}
function sink() {
  const parts: Uint8Array[] = [];
  return {
    write: (b: Uint8Array) => { parts.push(b); },
    bytes: () => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; },
  };
}
const ID = 'vault_1700000000000_abc123';
async function seal(dek: Uint8Array, plain: Uint8Array, id = ID) {
  const out = sink();
  await v3SealStream(dek, plain.length, source(plain), out.write, id);
  return out.bytes();
}
async function open(dek: Uint8Array | Uint8Array[], sealed: Uint8Array, id = ID) {
  const out = sink();
  await v3OpenStream(Array.isArray(dek) ? dek : [dek], sealed.length, source(sealed), out.write, id);
  return out.bytes();
}
// A round-4 'VCV3' file (aad = header only), built by hand the way round 4 wrote it.
function sealV3Legacy(dek: Uint8Array, plain: Uint8Array) {
  assert.ok(plain.length <= V3_CHUNK, 'one-chunk helper');
  const header = new Uint8Array(V3_HEADER_BYTES);
  header.set(V3_MAGIC, 0);
  header.set([1, 2, 3, 4, 5, 6, 7, 8], 4);
  const iv = new Uint8Array(12);
  iv.set(header.subarray(4, 12), 0);
  new DataView(iv.buffer).setUint32(8, 0x80000000);
  const ct = gcm(dek, iv, header).encrypt(plain);
  const out = new Uint8Array(header.length + ct.length);
  out.set(header, 0); out.set(ct, header.length);
  return out;
}

(async () => {
  const dek = opened!.dek;
  const sizes = [0, 1, V3_CHUNK - 1, V3_CHUNK, V3_CHUNK + 1, 2 * V3_CHUNK, 2 * V3_CHUNK + 777];
  for (const n of sizes) {
    const plain = new Uint8Array(n);
    for (let i = 0; i < n; i++) plain[i] = (i * 31 + 7) & 0xff;
    const sealed = await seal(dek, plain);
    assert.ok(isV3(sealed), `v3 magic (${n} bytes)`);
    assert.equal(sealed.length, V3_HEADER_BYTES + n + 16 * v3ChunkCount(n), `sealed size (${n} bytes)`);
    assert.equal(v3SealedSize(n), sealed.length, `v3SealedSize (${n} bytes)`);
    assert.equal(new TextDecoder().decode(sealed.subarray(0, 4)), 'VCV4', 'new files are v4 (id-bound)');
    assert.equal(v3PlainSize(sealed.length), n, `plain size from sealed size (${n} bytes)`);
    assert.deepEqual(await open(dek, sealed), plain, `round trip (${n} bytes)`);
  }

  const plain = new Uint8Array(2 * V3_CHUNK + 10).fill(9);
  const sealed = await seal(dek, plain);
  // Wrong key, a flipped bit, a dropped final chunk and a dropped middle chunk all fail.
  await assert.rejects(open(newVaultKeys(NEW).dek, sealed), /could not be opened/);
  const flipped = sealed.slice(); flipped[V3_HEADER_BYTES + 5] ^= 1;
  await assert.rejects(open(dek, flipped), /could not be opened/);
  const noTail = sealed.slice(0, V3_HEADER_BYTES + 2 * (V3_CHUNK + 16));
  await assert.rejects(open(dek, noTail), /damaged/, 'truncating at a chunk boundary is caught by the LAST flag');
  const spliced = new Uint8Array(sealed.length - (V3_CHUNK + 16));
  spliced.set(sealed.subarray(0, V3_HEADER_BYTES + V3_CHUNK + 16), 0);
  spliced.set(sealed.subarray(V3_HEADER_BYTES + 2 * (V3_CHUNK + 16)), V3_HEADER_BYTES + V3_CHUNK + 16);
  await assert.rejects(open(dek, spliced), /damaged/);
  // A source that runs short is refused, never sealed as a shorter file.
  await assert.rejects(v3SealStream(dek, 100, source(new Uint8Array(50)), () => {}, ID), /changed/);

  // v4 binds the file id: the bytes of one entry's file do not open under another
  // entry's id (two .enc files swapped on disk both fail), and an id is required.
  const a = await seal(dek, new Uint8Array([1, 2, 3]), 'vault_a');
  await assert.rejects(open(dek, a, 'vault_b'), /could not be opened/, 'swapped files are refused');
  assert.deepEqual(await open(dek, a, 'vault_a'), new Uint8Array([1, 2, 3]));
  await assert.rejects(v3SealStream(dek, 1, source(new Uint8Array(1)), () => {}, ''), /id is missing/);
  // Round-4 VCV3 files (no id in the AAD) still open, under any entry id.
  const legacy = sealV3Legacy(dek, new Uint8Array([4, 5, 6]));
  assert.ok(isV3(legacy));
  assert.deepEqual(await open(dek, legacy, 'whatever'), new Uint8Array([4, 5, 6]), 'VCV3 still opens');
  const legacyFlip = legacy.slice(); legacyFlip[V3_HEADER_BYTES] ^= 1;
  await assert.rejects(open(dek, legacyFlip), /could not be opened/);

  // Archived keys: after "New key", files sealed under the old key open once an
  // old PIN has recovered that key — tried after the current key, all formats.
  const newer = newVaultKeys(NEW);
  const oldFile = await seal(dek, new Uint8Array([7, 7, 7]));
  await assert.rejects(open(newer.dek, oldFile), /sealed with another key/);
  assert.deepEqual(await open([newer.dek, dek], oldFile), new Uint8Array([7, 7, 7]), 'v4 opens with an archived key');
  const twoChunk = await seal(dek, new Uint8Array(V3_CHUNK + 5).fill(3));
  assert.equal((await open([newer.dek, dek], twoChunk)).length, V3_CHUNK + 5, 'the matching key is kept for later chunks');
  assert.throws(() => vaultFileDecrypt(newer, NEW, v2), /another vault key/);
  assert.equal(vaultFileDecrypt(newer, NEW, v2, [opened!]), 'new-bytes', 'v2 opens with an archived key');
  assert.equal(vaultFileDecrypt(null, '0000', v1, [opened!]), 'legacy-bytes', 'v1 opens with an archived legacy key');

  // Progress and cancel.
  const seen: string[] = [];
  const out2 = sink();
  await v3SealStream(dek, 2 * V3_CHUNK + 1, source(new Uint8Array(2 * V3_CHUNK + 1)), out2.write, ID, { onProgress: (d, t) => seen.push(`${d}/${t}`) });
  assert.deepEqual(seen, ['1/3', '2/3', '3/3']);
  let calls = 0;
  await assert.rejects(
    v3SealStream(dek, 2 * V3_CHUNK, source(new Uint8Array(2 * V3_CHUNK)), () => {}, ID, { cancelled: () => ++calls > 1 }),
    (e: any) => e instanceof VaultCancelledError,
  );
  const sealed2 = out2.bytes();
  await assert.rejects(
    v3OpenStream([dek], sealed2.length, source(sealed2), () => {}, ID, { cancelled: () => true }),
    (e: any) => e instanceof VaultCancelledError,
  );
  // v1/v2 files are JSON, never mistaken for v3.
  assert.equal(isV3(new TextEncoder().encode(JSON.stringify(v2))), false);

  console.log('vaultCrypto.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
