// lib/vaultKeyStore.selftest.ts — run: npx tsx lib/vaultKeyStore.selftest.ts
//
// The vault key record's data-loss rules, against an in-memory SecureStore:
//   • a key is created silently only when no file on disk needs one; a missing
//     record with keyed files is 'lost' (Android drops SecureStore values when
//     its keystore key is invalidated) and nothing is written,
//   • "New key" archives the old record under a name kept in an index, and
//     never replaces a record the PIN opens; a failed index write changes nothing,
//   • "Try an old PIN" re-wraps archived (and current) records under the
//     current PIN, and a PIN change carries the archives along.

import assert from 'node:assert/strict';

const store = new Map<string, string>();
let failGet = false;
let failSetFor: string | null = null;
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'react-native-get-random-values') return {};
  // Node's native PBKDF2 stands in for quick-crypto (same API, same bytes), so
  // the 100k-iteration wraps do not take minutes in pure JS.
  if (request === 'react-native-quick-crypto') return require('node:crypto');
  if (request === 'expo-secure-store') {
    return {
      getItemAsync: async (k: string) => { if (failGet) throw new Error('keystore'); return store.get(k) ?? null; },
      setItemAsync: async (k: string, v: string) => { if (failSetFor && k.startsWith(failSetFor)) throw new Error('write'); store.set(k, v); },
    };
  }
  return origLoad.call(this, request, ...rest);
};
const ks = require('./vaultKeyStore') as typeof import('./vaultKeyStore');

const OLD = '1357';
const NEW = '86420';
const NEWER = '97531';
const none = async () => false;
const some = async () => true;
const same = (a: { dek: Uint8Array } | null | undefined, b: { dek: Uint8Array } | null | undefined) =>
  !!a && !!b && Buffer.from(a.dek).equals(Buffer.from(b.dek));

(async () => {
  // Key-dependent files on disk but no record: never mint a replacement.
  let r = await ks.unlockVaultKeys(OLD, some);
  assert.equal(r.keys, null);
  assert.equal(r.miss, 'lost');
  assert.equal(store.size, 0, 'nothing written when the key is lost');
  r = await ks.unlockVaultKeys(OLD, async () => { throw new Error('dir'); });
  assert.equal(r.miss, 'storage', 'cannot tell → do not mint');
  assert.equal(store.size, 0);

  // First use: no record, no keyed files → a key is created.
  r = await ks.unlockVaultKeys(OLD, none);
  assert.ok(r.keys, 'first use creates the key');
  const first = r.keys!;
  assert.deepEqual([r.older.length, r.lockedArchives], [0, 0]);
  assert.ok(same((await ks.unlockVaultKeys(OLD, some)).keys, first), 'the same key opens next time');

  // SecureStore failure is 'storage', never "no record".
  failGet = true;
  assert.equal((await ks.unlockVaultKeys(OLD, none)).miss, 'storage');
  failGet = false;

  // A PIN reset elsewhere: the record does not open with NEW.
  r = await ks.unlockVaultKeys(NEW, none);
  assert.equal(r.miss, 'pin');
  assert.ok(same((await ks.unlockVaultKeys(OLD, none)).keys, first), 'the record was left alone');

  // replaceVaultKeys never replaces a record the PIN opens.
  assert.ok(same(await ks.replaceVaultKeys(OLD), first));
  assert.equal(store.get('vault_key_v2_archive'), undefined, 'no archive when nothing is replaced');

  // A failed index write changes nothing.
  failSetFor = 'vault_key_v2_archive';
  await assert.rejects(ks.replaceVaultKeys(NEW));
  failSetFor = null;
  assert.ok(same((await ks.unlockVaultKeys(OLD, none)).keys, first), 'current record untouched after a failed archive');

  // New key under NEW: the old record is archived and listed in the index.
  const second = await ks.replaceVaultKeys(NEW);
  assert.ok(!same(second, first));
  const index = JSON.parse(store.get('vault_key_v2_archive')!) as string[];
  assert.ok(index.length >= 1 && index.every((n) => store.has(n)), 'archive names are discoverable');
  r = await ks.unlockVaultKeys(NEW, some);
  assert.ok(same(r.keys, second));
  assert.equal(r.older.length, 0);
  assert.equal(r.lockedArchives, index.length, 'the screen can offer "Try an old PIN"');

  // Try an old PIN: wrong PIN recovers nothing; OLD re-wraps the archive under NEW.
  assert.equal(await ks.tryOldVaultPin('0000', NEW), 0);
  assert.ok(await ks.tryOldVaultPin(OLD, NEW) >= 1);
  r = await ks.unlockVaultKeys(NEW, some);
  assert.ok(same(r.keys, second), 'the current key is unchanged');
  assert.ok(r.older.some((k) => same(k, first)), 'the archived key now opens with the current PIN');
  assert.equal(r.lockedArchives, 0);

  // A PIN change re-wraps the current record AND the archives.
  await ks.rewrapVaultKeys(NEW, NEWER);
  r = await ks.unlockVaultKeys(NEWER, some);
  assert.ok(same(r.keys, second));
  assert.ok(r.older.some((k) => same(k, first)), 'archives follow a PIN change');
  assert.equal((await ks.unlockVaultKeys(NEW, some)).miss, 'pin');

  // The PIN-reset case recovers the CURRENT record too.
  store.clear();
  const k1 = (await ks.unlockVaultKeys(OLD, none)).keys;
  assert.equal((await ks.unlockVaultKeys(NEW, some)).miss, 'pin');
  assert.equal(await ks.tryOldVaultPin(OLD, NEW), 1);
  assert.ok(same((await ks.unlockVaultKeys(NEW, some)).keys, k1), 'the old PIN brings the key back under the new one');

  // A damaged record is 'damaged', kept, and archived by "New key".
  store.clear();
  store.set('vault_key_v2', '{not json');
  assert.equal((await ks.unlockVaultKeys(OLD, none)).miss, 'damaged');
  assert.equal(store.get('vault_key_v2'), '{not json', 'never replaced on unlock');
  await ks.replaceVaultKeys(OLD);
  const idx2 = JSON.parse(store.get('vault_key_v2_archive')!) as string[];
  assert.equal(store.get(idx2[0]), '{not json', 'the damaged record is archived as it was');
  assert.equal((await ks.unlockVaultKeys(OLD, some)).lockedArchives, 1);

  console.log('vaultKeyStore.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
