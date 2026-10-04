// lib/vaultCrypto.selftest.ts — run: npx tsx lib/vaultCrypto.selftest.ts
//
// The v2 vault format (a random file key wrapped under the PIN) must never cost
// a user a file they already had. These checks run the real functions:
//   • a v1 file (key derived from the PIN) still opens after v2 is set up,
//   • and still opens after the PIN is CHANGED (the case v1 alone lost),
//   • v2 files survive a PIN change because only the wrap is redone,
//   • a wrong PIN opens nothing, and a damaged record opens nothing,
//   • without keys, new files fall back to v1 rather than failing.

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
  vaultFileEncrypt, vaultFileDecrypt, clearVaultKeyCache,
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

// No keys (record unopenable): v1 still opens with the PIN entered, new files
// fall back to v1, and a v2 file reports why it cannot open.
assert.equal(vaultFileDecrypt(null, OLD, v1), 'legacy-bytes');
const fallback = vaultFileEncrypt(null, NEW, 'fallback');
assert.equal(fallback.v, 1);
assert.equal(vaultFileDecrypt(null, NEW, fallback), 'fallback');
assert.throws(() => vaultFileDecrypt(null, NEW, v2), /vault key/);
assert.throws(() => vaultFileDecrypt(afterChange, NEW, vaultEncrypt('5555', 'x')), /earlier PIN/);

console.log('vaultCrypto.selftest: all checks passed');
