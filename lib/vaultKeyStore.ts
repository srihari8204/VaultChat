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

/**
 * The vault keys for a PIN pinStore has already verified. Creates the record
 * on first use. `keys` is null when a record exists but this PIN cannot open
 * it, or when SecureStore could not be read (never treated as "no record").
 */
export async function unlockVaultKeys(pin: string): Promise<{ keys: VaultKeys | null }> {
  let rec: VaultKeyRecord | null | undefined;
  try { rec = await readRecord(); } catch { return { keys: null }; }
  if (rec !== undefined) return { keys: openVaultKeys(pin, rec) };
  const keys = newVaultKeys(pin);
  await SecureStore.setItemAsync(KEY, JSON.stringify(sealVaultKeys(pin, keys)));
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
