// lib/vaultKeyStore.ts — where the Vault's wrapped file key lives (SecureStore).
//
// The crypto is in lib/vaultCrypto (v2 section, Node-tested); this file is only
// the persistence, kept separate so vaultCrypto stays free of native imports.
//
// DATA-LOSS RULES:
//   • A record that exists is NEVER replaced by a fresh one. If the PIN entered
//     cannot open it (the PIN was reset somewhere that could not re-wrap it),
//     the vault opens without the v2 key: older v1 files still open, new files
//     fall back to v1, and the record is left alone in case it is ever needed.
//   • Only a successful open under the OLD PIN re-wraps under the new one.
//   • New files need the key (lib/vaultCrypto no longer falls back to the
//     constant-salt v1 format). When the record cannot be opened, the user may
//     start a NEW key: the old record is first copied to an archive entry and
//     never deleted, so an old PIN that comes back can still be tried.

import * as SecureStore from 'expo-secure-store';
import {
  newVaultKeys, openVaultKeys, sealVaultKeys,
  type VaultKeyRecord, type VaultKeys,
} from './vaultCrypto';

const KEY = 'vault_key_v2';

/** undefined = no record; null = a record that does not parse (kept, never
 *  replaced). A SecureStore read failure throws. */
async function readRecord(): Promise<VaultKeyRecord | null | undefined> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as VaultKeyRecord; } catch { return null; }
}

/** Why `keys` is null: SecureStore failed, the record is unreadable, or this PIN cannot open it. */
export type VaultKeyMiss = 'storage' | 'damaged' | 'pin';

/**
 * The vault keys for a PIN pinStore has already verified. Creates the record
 * on first use. `keys` is null when a record exists but this PIN cannot open
 * it, or when SecureStore could not be read or written (never treated as "no
 * record"); `miss` says which, so the screen can tell the user the real cause.
 */
export async function unlockVaultKeys(pin: string): Promise<{ keys: VaultKeys | null; miss?: VaultKeyMiss }> {
  let rec: VaultKeyRecord | null | undefined;
  try { rec = await readRecord(); } catch { return { keys: null, miss: 'storage' }; }
  if (rec === null) return { keys: null, miss: 'damaged' };
  if (rec !== undefined) {
    const keys = openVaultKeys(pin, rec);
    return keys ? { keys } : { keys: null, miss: 'pin' };
  }
  const keys = newVaultKeys(pin);
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(sealVaultKeys(pin, keys)));
  } catch {
    return { keys: null, miss: 'storage' };
  }
  return { keys };
}

/**
 * Re-wrap the vault key from `oldPin` to `newPin` — call BEFORE the new PIN is
 * stored. No record, or one `oldPin` cannot open, is left untouched. Throws when
 * SecureStore cannot be read or written, so the caller aborts the PIN change
 * rather than strand the key under a PIN that no longer exists.
 */
export async function rewrapVaultKeys(oldPin: string, newPin: string): Promise<void> {
  const keys = openVaultKeys(oldPin, await readRecord());
  if (!keys) return;
  await SecureStore.setItemAsync(KEY, JSON.stringify(sealVaultKeys(newPin, keys)));
}

/**
 * Start a new vault key for `pin` when the existing record cannot be opened
 * (this PIN did not seal it, or it is damaged). The existing record is copied
 * to `vault_key_v2_prev_<time>` FIRST and the copy is never deleted; if that
 * copy cannot be written nothing changes. Files sealed under the old key stay
 * listed and stay unreadable with this PIN, exactly as before; v1 files still
 * open with the PIN that sealed them.
 */
export async function replaceVaultKeys(pin: string): Promise<VaultKeys> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (raw) {
    // Never replace a record this PIN can open.
    let rec: VaultKeyRecord | null = null;
    try { rec = JSON.parse(raw) as VaultKeyRecord; } catch { /* damaged: archive it */ }
    const current = openVaultKeys(pin, rec);
    if (current) return current;
    await SecureStore.setItemAsync(`${KEY}_prev_${Date.now()}`, raw);
  }
  const keys = newVaultKeys(pin);
  await SecureStore.setItemAsync(KEY, JSON.stringify(sealVaultKeys(pin, keys)));
  return keys;
}
