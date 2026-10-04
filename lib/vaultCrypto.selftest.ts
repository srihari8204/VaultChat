// lib/vaultCrypto.selftest.ts — run: npx tsx lib/vaultCrypto.selftest.ts
//
// The v2 vault format (a random file key wrapped under the PIN) must never cost
// a user a file they already had. These checks run the real functions:
//   • a v1 file (key derived from the PIN) still opens after v2 is set up,
//   • and still opens after the PIN is CHANGED (the case v1 alone lost),
//   • v2 files survive a PIN change because only the wrap is redone,
//   • a wrong PIN opens nothing, and a damaged record opens nothing,
//   • without keys, a new file is refused (never sealed in the weaker v1),
//   • v3 (chunked) round-trips every size and rejects tampering/truncation.

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
  v3SealStream, v3OpenStream, v3PlainSize, v3ChunkCount, isV3, V3_CHUNK, V3_HEADER_BYTES,
} = require('./vaultCrypto') as typeof import('./vaultCrypto');

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
async function seal(dek: Uint8Array, plain: Uint8Array) {
  const out = sink();
  await v3SealStream(dek, plain.length, source(plain), out.write);
  return out.bytes();
}
async function open(dek: Uint8Array, sealed: Uint8Array) {
  const out = sink();
  await v3OpenStream(dek, sealed.length, source(sealed), out.write);
  return out.bytes();
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
  await assert.rejects(open(dek, noTail), /could not be opened/, 'truncating at a chunk boundary is caught by the LAST flag');
  const spliced = new Uint8Array(sealed.length - (V3_CHUNK + 16));
  spliced.set(sealed.subarray(0, V3_HEADER_BYTES + V3_CHUNK + 16), 0);
  spliced.set(sealed.subarray(V3_HEADER_BYTES + 2 * (V3_CHUNK + 16)), V3_HEADER_BYTES + V3_CHUNK + 16);
  await assert.rejects(open(dek, spliced), /could not be opened/);
  // A source that runs short is refused, never sealed as a shorter file.
  await assert.rejects(v3SealStream(dek, 100, source(new Uint8Array(50)), () => {}), /changed/);
  // v1/v2 files are JSON, never mistaken for v3.
  assert.equal(isV3(new TextEncoder().encode(JSON.stringify(v2))), false);

  console.log('vaultCrypto.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
