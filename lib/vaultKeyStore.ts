// lib/vaultKeyStore.ts — where the Vault's wrapped file key lives (SecureStore).
//
// The crypto is in lib/vaultCrypto (v2 section, Node-tested); this file is only
// the persistence, kept separate so vaultCrypto stays free of native imports.
// Tested by lib/vaultKeyStore.selftest.ts (SecureStore stubbed in memory).
//
// DATA-LOSS RULES:
//   • A record that exists is NEVER replaced by a fresh one. If the PIN entered
//     cannot open it (the PIN was reset somewhere that could not re-wrap it),
//     the vault opens without the key: v1 files still open with the PIN, ADDING
//     is paused (lib/vaultCrypto never falls back to the constant-salt v1
//     format), and the record is left alone.
//   • A MISSING record is not proof there never was one: Android's secure
//     storage returns nothing (and drops the value) when its keystore key is
//     invalidated. A key is created silently only when no file on disk depends
//     on one; otherwise the vault reports the key as lost.
//   • Only a successful open under the OLD PIN re-wraps under the new one.
//   • The user may start a NEW key when the record cannot be opened. The old
//     record is first copied to an archive entry whose name is kept in an index
//     (ARCHIVE_INDEX), and archive entries are never deleted. Every unlock tries
//     the PIN against them, and "Try an old PIN" (tryOldVaultPin) re-wraps any
//     record an old PIN opens under the current PIN, so its files open again.

import * as SecureStore from 'expo-secure-store';
import {
  newVaultKeys, openVaultKeys, sealVaultKeys,
  type VaultKeyRecord, type VaultKeys,
} from './vaultCrypto';

const KEY = 'vault_key_v2';
/** JSON list of the SecureStore names of archived key records. */
const ARCHIVE_INDEX = 'vault_key_v2_archive';

/** undefined = no record; null = a record that does not parse (kept, never
 *  replaced). A SecureStore read failure throws. */
async function readRecord(name: string = KEY): Promise<VaultKeyRecord | null | undefined> {
  const raw = await SecureStore.getItemAsync(name);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as VaultKeyRecord; } catch { return null; }
}

/** Names of archived records. Throws when SecureStore fails or the index is
 *  damaged, so a caller never writes a fresh index over the real one. */
async function archiveNames(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(ARCHIVE_INDEX);
  if (!raw) return [];
  const list: unknown = JSON.parse(raw);
  if (!Array.isArray(list) || !list.every((n) => typeof n === 'string')) throw new Error('The list of old vault keys is damaged.');
  return list;
}

/**
 * Why `keys` is null: SecureStore failed, the record is unreadable, this PIN
 * cannot open it, or it is gone while files sealed with it are still on disk.
 */
export type VaultKeyMiss = 'storage' | 'damaged' | 'pin' | 'lost';

export interface VaultUnlock {
  /** The key new files are sealed with; null when it could not be opened. */
  keys: VaultKeys | null;
  miss?: VaultKeyMiss;
  /** Archived keys this PIN opens: tried after `keys`, only for reading. */
  older: VaultKeys[];
  /** How many archived keys this PIN could NOT open (an old PIN may). */
  lockedArchives: number;
}

/**
 * The vault keys for a PIN pinStore has already verified. Creates the record
 * on first use — only when `keyedFilesExist()` says no file on disk needs a
 * key; otherwise a missing record is reported as 'lost' and nothing is
 * created. `keys` is null when a record exists but this PIN cannot open it, or
 * when SecureStore (or the disk check) failed; `miss` says which.
 */
export async function unlockVaultKeys(pin: string, keyedFilesExist: () => Promise<boolean>): Promise<VaultUnlock> {
  const archives = await openArchives(pin);
  const base = { older: archives.opened, lockedArchives: archives.locked };
  let rec: VaultKeyRecord | null | undefined;
  try { rec = await readRecord(); } catch { return { ...base, keys: null, miss: 'storage' }; }
  if (rec === null) return { ...base, keys: null, miss: 'damaged' };
  if (rec !== undefined) {
    const keys = openVaultKeys(pin, rec);
    return keys ? { ...base, keys } : { ...base, keys: null, miss: 'pin' };
  }
  let dependent: boolean;
  try { dependent = await keyedFilesExist(); } catch { return { ...base, keys: null, miss: 'storage' }; }
  if (dependent) return { ...base, keys: null, miss: 'lost' };
  const keys = newVaultKeys(pin);
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(sealVaultKeys(pin, keys)));
  } catch {
    return { ...base, keys: null, miss: 'storage' };
  }
  return { ...base, keys };
}

/** Archived records this PIN opens, and how many it does not (unreadable
 *  ones count as not opened, so the user can still try an old PIN). */
async function openArchives(pin: string): Promise<{ opened: VaultKeys[]; locked: number }> {
  let names: string[];
  try { names = await archiveNames(); } catch { return { opened: [], locked: 0 }; }
  const opened: VaultKeys[] = [];
  let locked = 0;
  for (const name of names) {
    let keys: VaultKeys | null = null;
    try { keys = openVaultKeys(pin, await readRecord(name)); } catch { /* unreadable: counts as locked */ }
    if (keys) opened.push(keys); else locked++;
  }
  return { opened, locked };
}

/** Re-seal the record at `name` from `fromPin` to `toPin` when `fromPin` opens
 *  it. Returns whether it did. Throws when SecureStore fails. */
async function rewrapOne(name: string, fromPin: string, toPin: string): Promise<boolean> {
  const keys = openVaultKeys(fromPin, await readRecord(name));
  if (!keys) return false;
  await SecureStore.setItemAsync(name, JSON.stringify(sealVaultKeys(toPin, keys)));
  return true;
}

/**
 * Re-wrap the vault key — and every archived key — from `oldPin` to `newPin`.
 * Call BEFORE the new PIN is stored. Records `oldPin` cannot open are left
 * untouched. Throws when SecureStore cannot be read or written, so the caller
 * aborts the PIN change (and re-wraps back) rather than strand a key under a
 * PIN that no longer exists.
 */
export async function rewrapVaultKeys(oldPin: string, newPin: string): Promise<void> {
  await rewrapOne(KEY, oldPin, newPin);
  for (const name of await archiveNames()) await rewrapOne(name, oldPin, newPin);
}

/**
 * "Try an old PIN": every record (the current one and the archived ones) that
 * `pin` — the current, verified Device PIN — cannot open but `oldPin` can is
 * re-wrapped under `pin`, so its files open from now on. Returns how many
 * were recovered; the caller then unlocks again to pick them up. Nothing is
 * deleted or replaced: each record keeps the same key, only the wrap changes.
 */
export async function tryOldVaultPin(oldPin: string, pin: string): Promise<number> {
  if (oldPin === pin) return 0;
  let recovered = 0;
  for (const name of [KEY, ...await archiveNames()]) {
    if (openVaultKeys(pin, await readRecord(name))) continue;
    if (await rewrapOne(name, oldPin, pin)) recovered++;
  }
  return recovered;
}

/**
 * Start a new vault key for `pin` when the existing record cannot be opened
 * (this PIN did not seal it, it is damaged, or it is lost). The existing record
 * is copied to an archive entry FIRST and its name added to the index; if
 * either write fails nothing changes. Files sealed under the old key stay on
 * disk and stay unreadable until an old PIN opens that archive ("Try an old
 * PIN"); v1 files still open with the PIN that sealed them.
 */
export async function replaceVaultKeys(pin: string): Promise<VaultKeys> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (raw) {
    // Never replace a record this PIN can open.
    let rec: VaultKeyRecord | null = null;
    try { rec = JSON.parse(raw) as VaultKeyRecord; } catch { /* damaged: archive it */ }
    const current = openVaultKeys(pin, rec);
    if (current) return current;
    const names = await archiveNames();
    const name = `${KEY}_prev_${Date.now()}`;
    await SecureStore.setItemAsync(name, raw);
    await SecureStore.setItemAsync(ARCHIVE_INDEX, JSON.stringify([...names, name]));
  }
  const keys = newVaultKeys(pin);
  await SecureStore.setItemAsync(KEY, JSON.stringify(sealVaultKeys(pin, keys)));
  return keys;
}
