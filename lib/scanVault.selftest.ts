// lib/scanVault.selftest.ts — run: npx tsx lib/scanVault.selftest.ts
//
// Doc Scanner's at-rest key and file rules, against in-memory SecureStore,
// AsyncStorage and file system:
//   • the scan key is never replaced while a sealed list exists: a key that
//     reads back empty fails closed ('keyLost'), writes nothing, and is read
//     again on the next call (a transient miss recovers);
//   • encryptFileTo checks the encrypted copy decrypts back to its source
//     before the caller deletes the plaintext, and removes a bad copy.

import assert from 'node:assert/strict';

const secure = new Map<string, string>();
const async = new Map<string, string>();
const files = new Map<string, string>();   // uri → base64
let corruptWritesTo: string | null = null;
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native-get-random-values') return {};
  if (request === 'react-native-quick-crypto' || request === '@dr.pogodin/react-native-fs') throw new Error('not in node');
  if (request === 'expo-secure-store') {
    return {
      getItemAsync: async (k: string) => secure.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
    };
  }
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: { getItem: async (k: string) => async.get(k) ?? null, setItem: async (k: string, v: string) => { async.set(k, v); } } };
  }
  if (request === 'expo-file-system/legacy') {
    return {
      cacheDirectory: 'file:///cache/',
      documentDirectory: 'file:///doc/',
      EncodingType: { Base64: 'base64' },
      makeDirectoryAsync: async () => {},
      getInfoAsync: async (u: string) => (files.has(u) ? { exists: true, size: Buffer.from(files.get(u)!, 'base64').length } : { exists: false }),
      readAsStringAsync: async (u: string) => { if (!files.has(u)) throw new Error('ENOENT ' + u); return files.get(u)!; },
      writeAsStringAsync: async (u: string, b64: string) => {
        // Simulates a storage fault that truncates the written ciphertext.
        files.set(u, corruptWritesTo && u.startsWith(corruptWritesTo) ? b64.slice(0, Math.max(4, b64.length - 8)) : b64);
      },
      deleteAsync: async (u: string) => { for (const k of [...files.keys()]) if (k === u || k.startsWith(u)) files.delete(k); },
    };
  }
  return origLoad.call(this, request, ...rest);
};
const sv = require('./scanVault') as typeof import('./scanVault');
const { RecentListUnavailable } = require('./media/scanRecent') as typeof import('./media/scanRecent');

(async () => {
  // First use, nothing sealed: a key is minted and a sealed value round-trips.
  const sealed = await sv.sealJson([{ id: 'a' }]);
  assert.equal(secure.size, 1, 'key stored on first use');
  const keyHex = [...secure.values()][0];
  assert.deepEqual(await sv.openJson(sealed), [{ id: 'a' }]);
  async.set(sv.SCAN_RECENT_KEY, sealed);

  // The key reads back empty while the sealed list exists (keystore
  // invalidated, restore, or a transient miss). Re-require a fresh module so
  // the cached key is not used.
  delete require.cache[require.resolve('./scanVault')];
  const sv2 = require('./scanVault') as typeof import('./scanVault');
  secure.clear();
  await assert.rejects(sv2.openJson(sealed), (e: unknown) => e instanceof RecentListUnavailable && e.reason === 'keyLost');
  await assert.rejects(sv2.sealJson([]), (e: unknown) => e instanceof RecentListUnavailable && e.reason === 'keyLost');
  assert.equal(secure.size, 0, 'no key minted over the lost one');
  // The miss was transient: the key is back, and the next call reads it again.
  secure.set('vc_docscan_key', keyHex);
  assert.deepEqual(await sv2.openJson(sealed), [{ id: 'a' }]);

  // After a reset (list removed) a new key may be minted.
  delete require.cache[require.resolve('./scanVault')];
  const sv3 = require('./scanVault') as typeof import('./scanVault');
  secure.clear();
  async.delete(sv3.SCAN_RECENT_KEY);
  await sv3.sealJson([]);
  assert.equal(secure.size, 1);

  // encryptFileTo: good copy → key returned, check copy cleaned up, decrypts to the source.
  const src = 'file:///cache/print.pdf';
  files.set(src, Buffer.from('%PDF-1.4 scan bytes '.repeat(50)).toString('base64'));
  const mk = await sv3.encryptFileTo(src, 'file:///doc/VaultScans/1.vcs');
  assert.ok(files.has('file:///doc/VaultScans/1.vcs'));
  assert.ok(![...files.keys()].some(k => k.includes('/vt_scan_')), 'decrypt check copy removed');
  const out = await sv3.decryptToTemp('file:///doc/VaultScans/1.vcs', mk, 'x.pdf');
  assert.equal(files.get(out), files.get(src));

  // A copy that does not decrypt is reported and removed; the plaintext stays.
  corruptWritesTo = 'file:///doc/VaultScans/2';
  await assert.rejects(sv3.encryptFileTo(src, 'file:///doc/VaultScans/2.vcs'));
  assert.ok(!files.has('file:///doc/VaultScans/2.vcs'), 'bad encrypted copy removed');
  assert.ok(files.has(src), 'plaintext untouched');

  console.log('scanVault selftest: all passed');
})().catch(e => { console.error(e); process.exit(1); });
