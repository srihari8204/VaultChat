// lib/retiredKeys.ts — storage keys whose owning feature was deleted.
//
// WHY THIS EXISTS, AND WHY IT IS A LIST RATHER THAN FOUR DELETE CALLS
//
// Deleting a feature deletes the code that WRITES its keys. It does not delete
// the keys, and it deletes the only code that could — the feature's own "clear"
// or "revoke" function goes with the screen. What is left is data nothing can
// read and nothing can remove, sitting on every device that ever opened it.
//
// That has now happened twice in this repo. `usage.go` still carries the note
// from the first time, when MemoryShield was removed. The second time was the
// two VaultID identity systems on 2026-09-22 — and those left PRIVATE KEYS in
// SecureStore, which is the worst version of this: key material with no owner,
// no reader, and no route to deletion.
//
// So the fix is not four delete calls in a startup file where the next person
// will not think to look. It is a NAMED PLACE. Delete a feature, add its keys
// here, and the cleanup is someone else's solved problem.
//
// purgeAccountData() does NOT cover these. It cannot: SecureStore has no
// enumeration, so it deletes only what it can name, and a key belonging to a
// feature that no longer exists is exactly what nobody remembers to name.

// NO TOP-LEVEL REACT-NATIVE IMPORTS. AsyncStorage and SecureStore are pulled
// in inside purgeRetiredKeys() instead, so this module's top level stays pure
// and `retiredKeys.selftest.ts` can import the list under tsx. Importing them
// up here makes the list unreadable without a device, which is the one place
// the check that matters — "is this key still in use?" — has to run.

export interface RetiredKey {
  key: string;
  /** Which store holds it. SecureStore needs one call per key; AsyncStorage takes a batch. */
  store: 'secure' | 'async';
  /** When the owning feature was removed. */
  retired: string;
  /** What wrote it, so a reader can judge whether deleting it is safe. */
  why: string;
}

/**
 * ONLY keys whose owning feature IS GONE.
 *
 * Never list a key that live code still reads — `retiredKeys.selftest.ts`
 * fails the build-time check if you do, by scanning the source for it.
 *
 * Deliberately NOT here: `vc_miniapp_todos`. The Todo List was removed in the
 * same session, but that key holds text the USER wrote. Deleting a feature is
 * reversible; deleting what someone typed is not. It stays until it is decided
 * on its own terms.
 */
export const RETIRED_KEYS: readonly RetiredKey[] = [
  {
    key: 'vc_did_ed25519_priv',
    store: 'secure',
    retired: '2026-09-22',
    why: 'Ed25519 PRIVATE KEY of the did:key VaultID (lib/decentralizedId.ts, removed). revokeDid() was the only thing that could delete it and went with the module.',
  },
  {
    key: 'vc_did_record',
    store: 'async',
    retired: '2026-09-22',
    why: 'Public DID metadata alongside the key above — did, displayName, created.',
  },
  {
    key: 'vaultchat_private_key',
    store: 'secure',
    retired: '2026-09-22',
    why: 'secp256k1 PRIVATE KEY of the Ethereum-format VaultID (constants/vaultID.ts, removed). destroyVaultID() went with it.',
  },
  {
    key: 'vaultchat_vault_id',
    store: 'async',
    retired: '2026-09-22',
    why: 'The VaultID record for the key above — address, tag, trust score.',
  },
];

/**
 * Delete every retired key. Best-effort, never throws, safe to call repeatedly.
 *
 * RUNS ON EVERY LAUNCH, not once behind a "已 done" flag. A flag would be a
 * fifth piece of orphaned state, and the delete is four no-ops once the keys
 * are gone. It also self-heals the case that actually matters: SecureStore is
 * unavailable while the device is locked, so a first attempt can fail through
 * no fault of ours and the next launch simply finishes the job.
 *
 * ponytail: runs forever. Drop this call, and the entries above, once enough
 * releases have shipped that every active install has passed through one.
 *
 * @returns how many deletes were attempted — for logging, not for control flow.
 */
export async function purgeRetiredKeys(): Promise<number> {
  const async_ = RETIRED_KEYS.filter(k => k.store === 'async').map(k => k.key);
  const secure = RETIRED_KEYS.filter(k => k.store === 'secure').map(k => k.key);

  if (async_.length) {
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.multiRemove(async_);
    } catch {}
  }
  // One call each: SecureStore has no batch form, and one failure must not
  // skip the rest — the next key might be the private one. The import sits
  // inside the loop's try for the same reason the loop does.
  for (const key of secure) {
    try {
      const SecureStore = await import('expo-secure-store');
      await SecureStore.deleteItemAsync(key);
    } catch {}
  }
  return async_.length + secure.length;
}

export default {};
