// lib/vaultKeyStore.selftest.ts — run: npx tsx lib/vaultKeyStore.selftest.ts
//
// The vault key record's data-loss rules, against an in-memory SecureStore:
//   • a key is created silently only when no file on disk needs one; a missing
//     record with keyed files is 'lost' (Android drops SecureStore values when
//     its keystore key is invalidated) and nothing is written,
//   • "New key" archives the old record under a name kept in an index, and
//     never replaces a record the PIN opens; a failed index write changes nothing,
//   • "Try an old PIN" re-wraps archived (and current) records under the
//     current PIN, and a PIN change carries the archives along,
//   • a PIN change is all or nothing (the round-5 probe, rerate5/J R1): a
//     failed staging write or PIN save leaves every record under the PIN still
//     in use; a failed move after the save is finished by the next unlock,
//   • a damaged archive index blocks nothing and loses no name it still holds,
//   • the wrong-old-PIN limit lives in storage, not in the screen,
//   • a failed New key says whether an archive entry was written,
//   • K1 (rerate7/J): a copy an unfinished PIN change left staged is finished
//     by the next change, and "Try an old PIN" accepts the PIN it was staged
//     under; concurrent tries are counted one by one.

import assert from 'node:assert/strict';

const store = new Map<string, string>();
let failGet = false;
let failSetFor: string | null = null;
let failSet: ((k: string) => boolean) | null = null;
let failDel = false;
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
      setItemAsync: async (k: string, v: string) => {
        if ((failSetFor && k.startsWith(failSetFor)) || failSet?.(k)) throw new Error('write');
        store.set(k, v);
      },
      deleteItemAsync: async (k: string) => { if (failDel) throw new Error('delete'); store.delete(k); },
    };
  }
  return origLoad.call(this, request, ...rest);
};
const ks = require('./vaultKeyStore') as typeof import('./vaultKeyStore');
const vc = require('./vaultCrypto') as typeof import('./vaultCrypto');

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
  await ks.changePinWithVaultKeys(NEW, NEWER, async () => {});
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

  // ── PIN change is all or nothing (rerate5/J_probe_rewrap: R1) ──────────
  const P0 = '1111', P1 = '2222', P2 = '3333';
  const staged = () => [...store.keys()].filter((k) => k.endsWith('_next'));
  const fresh = async () => {
    store.clear();
    const k1 = (await ks.unlockVaultKeys(P0, none)).keys!;
    const k2 = await ks.replaceVaultKeys(P1);              // k1 archived (under P0), k2 under P1
    assert.equal(await ks.tryOldVaultPin(P0, P1), 1);      // archive now under P1
    return { k1, k2 };
  };
  const opensWith = async (pin: string, k: { k1: { dek: Uint8Array }; k2: { dek: Uint8Array } }) => {
    const u = await ks.unlockVaultKeys(pin, some);
    return same(u.keys, k.k2) && u.older.some((o) => same(o, k.k1)) && u.lockedArchives === 0;
  };
  let saved: string | null = null;
  const savePin = async (pin: string) => { saved = pin; };

  // Case A of the probe: an archive's staging write fails → nothing changed.
  let k = await fresh();
  failSetFor = 'vault_key_v2_prev_';
  saved = null;
  await assert.rejects(ks.changePinWithVaultKeys(P1, P2, savePin));
  failSetFor = null;
  assert.equal(saved, null, 'the PIN is not saved when staging fails');
  assert.ok(await opensWith(P1, k), 'key and archive still open with the PIN in use');
  assert.equal((await ks.unlockVaultKeys(P2, some)).miss, 'pin', 'nothing opens with the rejected PIN');
  assert.deepEqual(staged(), [], 'staged copies discarded');

  // The PIN save fails → staged copies dropped, records untouched.
  k = await fresh();
  await assert.rejects(ks.changePinWithVaultKeys(P1, P2, async () => { throw new Error('save'); }));
  assert.ok(await opensWith(P1, k));
  assert.equal((await ks.unlockVaultKeys(P2, some)).miss, 'pin');
  assert.deepEqual(staged(), []);

  // Success: everything moves to the new PIN, nothing left staged.
  k = await fresh();
  assert.equal(await ks.changePinWithVaultKeys(P1, P2, savePin), true);
  assert.equal(saved, P2);
  assert.ok(await opensWith(P2, k));
  assert.equal((await ks.unlockVaultKeys(P1, some)).miss, 'pin');
  assert.deepEqual(staged(), []);

  // The PIN saved, then moving the current record fails: the next unlock with
  // the new PIN opens the staged copy and finishes the move.
  k = await fresh();
  failSet = (key) => key === 'vault_key_v2';
  assert.equal(await ks.changePinWithVaultKeys(P1, P2, savePin), false, 'a copy was left staged');
  failSet = null;
  assert.ok(await opensWith(P2, k), 'the key opens with the PIN actually in use');
  assert.deepEqual(staged(), [], 'the unlock finished the move');
  assert.ok(await opensWith(P2, k), 'and it stays finished');

  // The app dies between saving the PIN and committing: same recovery.
  k = await fresh();
  await ks.stageVaultRewrap(P1, P2);
  assert.ok(await opensWith(P1, k), 'staged copies change nothing before the PIN is saved');
  assert.ok(await opensWith(P2, k), 'after the save, the new PIN finishes the change');
  assert.deepEqual(staged(), []);

  // A leftover staged copy (its discard failed) can never replace a record
  // that changed since: it names the record it was made from.
  k = await fresh();
  failDel = true;
  await assert.rejects(ks.changePinWithVaultKeys(P1, P2, async () => { throw new Error('save'); }));
  failDel = false;
  assert.ok(staged().length > 0, 'leftovers stayed');
  const k3 = await ks.replaceVaultKeys(P0);                  // current record replaced (P1's archived)
  const left = await ks.unlockVaultKeys(P2, some);
  assert.equal(left.miss, 'pin', 'the stale copy of the old record is not used for the new one');
  assert.ok(same((await ks.unlockVaultKeys(P0, some)).keys, k3), 'the new record is untouched');
  assert.ok(left.older.some((o) => same(o, k.k1)), 'an archive copy (same key, never changes) may finish');

  // ── Damaged archive index (probe case B) ───────────────────────────────
  store.clear();
  const d1 = (await ks.unlockVaultKeys(P0, none)).keys!;
  const d2 = await ks.replaceVaultKeys(P1);
  const goodIndex = store.get('vault_key_v2_archive')!;
  const archived = (JSON.parse(goodIndex) as string[])[0];
  store.set('vault_key_v2_archive', goodIndex.slice(0, -1));   // truncated JSON
  assert.deepEqual(ks.parseArchiveIndex(goodIndex.slice(0, -1)), { names: [archived], damaged: true });
  assert.deepEqual(ks.parseArchiveIndex('{bad'), { names: [], damaged: true });
  assert.deepEqual(ks.parseArchiveIndex(null), { names: [], damaged: false });
  // PIN change works, and carries the salvaged archive along.
  assert.equal(await ks.changePinWithVaultKeys(P1, P2, savePin), true);
  r = await ks.unlockVaultKeys(P2, some);
  assert.ok(same(r.keys, d2), 'the current key opens with the new PIN');
  assert.equal(r.archiveIndexDamaged, true, 'the screen is told once');
  assert.equal(r.lockedArchives, 1, 'the salvaged archive is still offered');
  assert.ok([...store.keys()].some((n) => n.startsWith('vault_key_v2_archive_damaged_')), 'the damaged index is kept aside');
  assert.deepEqual(JSON.parse(store.get('vault_key_v2_archive')!), [archived], 'and rebuilt');
  assert.equal((await ks.unlockVaultKeys(P2, some)).archiveIndexDamaged, false);
  // Try an old PIN and New key are not blocked by a damaged index.
  store.set('vault_key_v2_archive', '{bad');
  assert.equal(await ks.tryOldVaultPin(P0, P2), 0, 'nothing salvageable, nothing thrown');
  store.set('vault_key_v2_archive', goodIndex.slice(0, -1));
  assert.equal(await ks.tryOldVaultPin(P0, P2), 1, 'the salvaged archive opens with the old PIN');
  assert.ok((await ks.unlockVaultKeys(P2, some)).older.some((o) => same(o, d1)));
  store.set('vault_key_v2_archive', '{bad');
  await ks.replaceVaultKeys(P0);                              // P0 cannot open d2's record: archived
  const idx3 = JSON.parse(store.get('vault_key_v2_archive')!) as string[];
  assert.equal(idx3.length, 1, 'a new index is written');
  assert.ok(same(vc.openVaultKeys(P2, JSON.parse(store.get(idx3[0])!)), d2), 'with the replaced key in it');

  // ── The wrong-old-PIN limit is stored, so a re-lock does not reset it ──
  store.clear();
  await ks.unlockVaultKeys(P0, none);
  await ks.replaceVaultKeys(P1);
  const t0 = 1_000_000;
  for (let i = 0; i < ks.OLD_PIN_TRIES; i++) assert.equal(await ks.tryOldVaultPin('9999', P1, t0 + i), 0);
  assert.equal((await ks.oldVaultPinTries(t0 + 10)).left, 0);
  await assert.rejects(ks.tryOldVaultPin(P0, P1, t0 + 10), ks.OldPinLimitError, 'even the right old PIN waits');
  // (a re-lock is a new screen state; the count is in storage, so it holds)
  await assert.rejects(ks.tryOldVaultPin(P0, P1, t0 + 20), ks.OldPinLimitError);
  const after = t0 + ks.OLD_PIN_TRIES - 1 + ks.OLD_PIN_WAIT_MS;
  assert.equal((await ks.oldVaultPinTries(after)).left, ks.OLD_PIN_TRIES, 'the wait ends');
  assert.equal(await ks.tryOldVaultPin(P0, P1, after), 1);
  assert.equal((await ks.oldVaultPinTries(after)).left, ks.OLD_PIN_TRIES, 'a success resets the count');
  failSetFor = 'vault_key_v2_old_pin_tries';
  await assert.rejects(ks.tryOldVaultPin('9999', P1, after), 'an uncountable try is refused, not run');
  failSetFor = null;

  // ── A failed New key says what it did ─────────────────────────────────
  store.clear();
  await ks.unlockVaultKeys(P0, none);
  failSet = (key) => key === 'vault_key_v2';                  // the new record's write
  await assert.rejects(ks.replaceVaultKeys(P1), (e: unknown) => e instanceof ks.VaultNewKeyError && e.archived);
  failSet = null;
  assert.ok((await ks.unlockVaultKeys(P0, some)).keys, 'the current key is unchanged');
  store.clear();
  await ks.unlockVaultKeys(P0, none);
  failSetFor = 'vault_key_v2_archive';
  await assert.rejects(ks.replaceVaultKeys(P1), (e: unknown) => e instanceof ks.VaultNewKeyError && !e.archived);
  failSetFor = null;
  assert.deepEqual([...store.keys()].filter((n) => n.includes('_prev_')), [], 'no unlisted archive copy left');

  // An archive name is never reused, even when the clock repeats a stamp.
  store.clear();
  await ks.unlockVaultKeys(P0, none);
  const realNow = Date.now;
  Date.now = () => 42;
  store.set('vault_key_v2_prev_42', 'older');
  store.set('vault_key_v2_archive', JSON.stringify(['vault_key_v2_prev_42']));
  await ks.replaceVaultKeys(P1);
  Date.now = realNow;
  assert.equal(store.get('vault_key_v2_prev_42'), 'older', 'the older archive is kept');
  assert.deepEqual(JSON.parse(store.get('vault_key_v2_archive')!), ['vault_key_v2_prev_42', 'vault_key_v2_prev_43']);

  // ── K1 (rerate7/J_probe_staged): a copy an unfinished PIN change left ──
  // P0 → P1 saved P1 but the copy was never moved (the app died), then
  // P1 → P2 before the vault was opened: the second change finishes the first.
  store.clear();
  const s0 = (await ks.unlockVaultKeys(P0, none)).keys!;
  await ks.stageVaultRewrap(P0, P1);
  assert.equal(await ks.changePinWithVaultKeys(P1, P2, savePin), true);
  assert.ok(same((await ks.unlockVaultKeys(P2, some)).keys, s0), 'the key opens with the PIN in use');
  assert.deepEqual(staged(), [], 'nothing left staged');
  // The same with an archive along.
  k = await fresh();
  await ks.stageVaultRewrap(P1, P2);
  assert.equal(await ks.changePinWithVaultKeys(P2, P0, savePin), true);
  assert.ok(await opensWith(P0, k), 'key and archive follow both changes');
  // Finishing the earlier move fails: this change stops, nothing is lost.
  store.clear();
  const s1 = (await ks.unlockVaultKeys(P0, none)).keys!;
  await ks.stageVaultRewrap(P0, P1);
  failSet = (key) => key === 'vault_key_v2';
  saved = null;
  await assert.rejects(ks.changePinWithVaultKeys(P1, P2, savePin));
  failSet = null;
  assert.equal(saved, null, 'the PIN is not saved');
  assert.ok(same((await ks.unlockVaultKeys(P1, some)).keys, s1), 'the PIN in use still opens it (and finishes the move)');
  // The PIN was then reset WITHOUT a re-wrap (no change ran): "Try an old
  // PIN" with the PIN just before (the staged one) recovers it in one try.
  store.clear();
  const s2 = (await ks.unlockVaultKeys(P0, none)).keys!;
  await ks.stageVaultRewrap(P0, P1);
  assert.equal((await ks.unlockVaultKeys(P2, some)).miss, 'pin');
  const t1 = 5_000_000;
  assert.equal(await ks.tryOldVaultPin(P1, P2, t1), 1, 'the PIN just before recovers the key');
  assert.ok(same((await ks.unlockVaultKeys(P2, some)).keys, s2));
  assert.deepEqual(staged(), [], 'the staged copy is dropped once used');
  assert.equal((await ks.oldVaultPinTries(t1)).left, ks.OLD_PIN_TRIES, 'no try was spent');

  // Two tries at once (a double keypad fire) are run one after the other, so
  // both are counted.
  store.clear();
  await ks.unlockVaultKeys(P0, none);
  await ks.replaceVaultKeys(P1);
  assert.deepEqual(await Promise.all([ks.tryOldVaultPin('9999', P1, t1), ks.tryOldVaultPin('8888', P1, t1)]), [0, 0]);
  assert.equal((await ks.oldVaultPinTries(t1)).left, ks.OLD_PIN_TRIES - 2, 'each try counted once');

  // ── A damaged index that cuts a name short inside its digits ──────────
  store.clear();
  await ks.unlockVaultKeys(P0, none);
  await ks.replaceVaultKeys(P1);
  const real = (JSON.parse(store.get('vault_key_v2_archive')!) as string[])[0];
  const cut = `["${real.slice(0, -3)}`;
  store.set('vault_key_v2_archive', cut);
  r = await ks.unlockVaultKeys(P1, some);
  assert.equal(r.archiveIndexDamaged, true);
  assert.equal(r.lockedArchives, 0, 'a listed name with no stored record is not offered as locked');
  assert.deepEqual(JSON.parse(store.get('vault_key_v2_archive')!), [real.slice(0, -3)], 'the name is kept as it reads');
  assert.ok([...store.entries()].some(([n, v]) => n.startsWith('vault_key_v2_archive_damaged_') && v === cut), 'the damaged index is kept aside');
  assert.ok(store.has(real), 'the archive itself is untouched');

  console.log('vaultKeyStore.selftest: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
