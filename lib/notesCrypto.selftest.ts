// lib/notesCrypto.selftest.ts — run: npx tsx lib/notesCrypto.selftest.ts
//
// openSealedBytesStrict, which decides whether an unsaved notes draft (and
// the attachments only it names) may be deleted: null ONLY when this device's
// key was read and the blob never opens under it; a key-read failure or a
// missing key throws, so a transient failure can never delete anything.

import assert from 'node:assert/strict';

const store = new Map<string, string>();
let failGet = false;
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'expo-secure-store') {
    return {
      getItemAsync: async (k: string) => { if (failGet) throw new Error('keystore'); return store.get(k) ?? null; },
      setItemAsync: async (k: string, v: string) => { store.set(k, v); },
    };
  }
  return origLoad.call(this, request, ...rest);
};
const nc = require('./notesCrypto') as typeof import('./notesCrypto');

(async () => {
  // No key yet: "not now", never "never".
  await assert.rejects(nc.openSealedBytesStrict('{"v":1,"iv":"AAAA","ct":"AAAA"}'));

  const sealed = await nc.encryptBytesToString(new Uint8Array([1, 2, 3]));   // creates the key
  assert.deepEqual([...(await nc.openSealedBytesStrict(sealed))!], [1, 2, 3]);

  // A transient key-read failure throws (the screen keeps the draft).
  nc.clearNotesKeyCache();
  failGet = true;
  await assert.rejects(nc.openSealedBytesStrict(sealed));
  failGet = false;

  // Sealed under another key, or not a sealed blob: null (can never open here).
  const other = await nc.encryptBytesToString(new Uint8Array([9]));
  nc.clearNotesKeyCache();
  store.set('vc_notes_dek_v1', 'b'.repeat(64));
  assert.equal(await nc.openSealedBytesStrict(other), null);
  assert.equal(await nc.openSealedBytesStrict('not json'), null);

  // The key missing from storage throws too: a backup restore may bring it back.
  nc.clearNotesKeyCache();
  store.clear();
  await assert.rejects(nc.openSealedBytesStrict(other));

  console.log('notesCrypto.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
