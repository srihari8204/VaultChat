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
//     Wrong old PINs are counted here, in SecureStore, so re-locking the vault
//     does not reset the limit.
//   • A Device PIN change is all-or-nothing (stageVaultRewrap): every record the
//     old PIN opens is re-wrapped into a STAGED copy (<name>_next) first; the
//     live records change only after the new PIN is stored. If staging or the
//     PIN save fails the staged copies are discarded and nothing else changed.
//     If moving a staged copy fails after the PIN was saved (or the app dies
//     there), the next unlock opens the staged copy with the new PIN and
//     finishes the move. A staged copy names the record it was made from (its
//     iv), so a leftover copy can never replace a record that changed since.
//   • A damaged archive index never blocks anything: the names still readable
//     in it are used, a copy of it is kept aside, and the screen is told.

import * as SecureStore from 'expo-secure-store';
import {
  newVaultKeys, openVaultKeys, sealVaultKeys,
  type VaultKeyRecord, type VaultKeys,
} from './vaultCrypto';

const KEY = 'vault_key_v2';
/** JSON list of the SecureStore names of archived key records. */
const ARCHIVE_INDEX = 'vault_key_v2_archive';
const ARCHIVE_NAME = /vault_key_v2_prev_\d+/g;
/** Wrong "Try an old PIN" attempts: { n, at }. */
const OLD_PIN_TRIES_KEY = 'vault_key_v2_old_pin_tries';
/** Wrong old PINs allowed before a wait. Each try runs the 100k-round key
 *  derivation once per closed record. */
export const OLD_PIN_TRIES = 5;
/** How long the limit lasts after the last wrong old PIN. */
export const OLD_PIN_WAIT_MS = 15 * 60_000;

const stagedName = (name: string) => `${name}_next`;
/** A record re-wrapped under a new PIN, waiting for the PIN to be saved.
 *  `from` is the iv of the record it replaces. */
interface StagedRecord { rec: VaultKeyRecord; from: string }

/** undefined = no record; null = a record that does not parse (kept, never
 *  replaced). A SecureStore read failure throws. */
async function readRecord(name: string = KEY): Promise<VaultKeyRecord | null | undefined> {
  const raw = await SecureStore.getItemAsync(name);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as VaultKeyRecord; } catch { return null; }
}

/** The archive names in a stored index. A damaged index is not an error: the
 *  names still readable in it are returned with `damaged`, so no path is
 *  blocked and no archive it still names is lost. */
export function parseArchiveIndex(raw: string | null): { names: string[]; damaged: boolean } {
  if (!raw) return { names: [], damaged: false };
  try {
    const list: unknown = JSON.parse(raw);
    if (Array.isArray(list) && list.every((n) => typeof n === 'string' && /^vault_key_v2_prev_\d+$/.test(n))) {
      return { names: [...new Set(list as string[])], damaged: false };
    }
  } catch { /* salvaged below */ }
  return { names: [...new Set(raw.match(ARCHIVE_NAME) ?? [])], damaged: true };
}

/** Throws only when SecureStore cannot be read. */
async function readArchiveIndex(): Promise<{ names: string[]; damaged: boolean; raw: string | null }> {
  const raw = await SecureStore.getItemAsync(ARCHIVE_INDEX);
  return { ...parseArchiveIndex(raw), raw };
}

/** Write the index. When the one there is damaged, a copy of it is kept aside
 *  first, so nothing it held is overwritten. */
async function writeArchiveIndex(names: string[], prev: { damaged: boolean; raw: string | null }): Promise<void> {
  if (prev.damaged && prev.raw) await SecureStore.setItemAsync(`${ARCHIVE_INDEX}_damaged_${Date.now()}`, prev.raw);
  await SecureStore.setItemAsync(ARCHIVE_INDEX, JSON.stringify(names));
}

/** The staged copy of `name`, when it was staged from `rec` (the record there now). */
async function stagedFor(name: string, rec: VaultKeyRecord | null | undefined): Promise<VaultKeyRecord | null> {
  if (!rec?.iv) return null;
  const raw = await SecureStore.getItemAsync(stagedName(name));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StagedRecord;
    return s?.from === rec.iv && s.rec ? s.rec : null;
  } catch { return null; }
}

/** Put a staged copy in place and drop it. Throws when the write fails. */
async function moveStaged(name: string, next: VaultKeyRecord): Promise<void> {
  await SecureStore.setItemAsync(name, JSON.stringify(next));
  await SecureStore.deleteItemAsync(stagedName(name)).catch(() => {});
}

/** Open `rec` (stored at `name`) with `pin`. When it does not open but a
 *  PIN change staged a copy of it that does, the PIN change got as far as
 *  saving the PIN: finish it, and use the staged copy even if the move fails. */
async function openOrFinish(name: string, rec: VaultKeyRecord | null | undefined, pin: string): Promise<VaultKeys | null> {
  const keys = openVaultKeys(pin, rec);
  if (keys) return keys;
  let next: VaultKeyRecord | null = null;
  try { next = await stagedFor(name, rec); } catch { return null; }
  const staged = openVaultKeys(pin, next);
  if (staged && next) await moveStaged(name, next).catch(() => { /* the next unlock tries again */ });
  return staged;
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
  /** The list of archived keys was damaged. The names still readable in it
   *  were used, and a copy of it is kept; the screen says so. */
  archiveIndexDamaged?: boolean;
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
  const base = { older: archives.opened, lockedArchives: archives.locked, archiveIndexDamaged: archives.damaged };
  let rec: VaultKeyRecord | null | undefined;
  try { rec = await readRecord(); } catch { return { ...base, keys: null, miss: 'storage' }; }
  if (rec === null) return { ...base, keys: null, miss: 'damaged' };
  if (rec !== undefined) {
    const keys = await openOrFinish(KEY, rec, pin);
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
 *  ones count as not opened, so the user can still try an old PIN). A damaged
 *  index is rebuilt from the names still readable in it (copy kept aside). */
async function openArchives(pin: string): Promise<{ opened: VaultKeys[]; locked: number; damaged: boolean }> {
  let index: Awaited<ReturnType<typeof readArchiveIndex>>;
  try { index = await readArchiveIndex(); } catch { return { opened: [], locked: 0, damaged: false }; }
  if (index.damaged) await writeArchiveIndex(index.names, index).catch(() => { /* still damaged: next unlock tries again */ });
  const opened: VaultKeys[] = [];
  let locked = 0;
  for (const name of index.names) {
    let keys: VaultKeys | null = null;
    try { keys = await openOrFinish(name, await readRecord(name), pin); } catch { /* unreadable: counts as locked */ }
    if (keys) opened.push(keys); else locked++;
  }
  return { opened, locked, damaged: index.damaged };
}

/** Re-seal the record at `name` from `fromPin` to `toPin` when `fromPin` opens
 *  it. Returns whether it did. Throws when SecureStore fails. */
async function rewrapOne(name: string, fromPin: string, toPin: string): Promise<boolean> {
  const keys = openVaultKeys(fromPin, await readRecord(name));
  if (!keys) return false;
  await SecureStore.setItemAsync(name, JSON.stringify(sealVaultKeys(toPin, keys)));
  return true;
}

/** A Device PIN change's re-wrap, staged and not yet in force. */
export interface VaultRewrap {
  /** After the new PIN is saved: put the staged copies in place. Never
   *  throws; a copy it could not move stays staged and the next unlock with
   *  the new PIN finishes it. Resolves false when one was left staged. */
  commit(): Promise<boolean>;
  /** When the new PIN was NOT saved: drop the staged copies. The live records
   *  were never changed, so they still open with the old PIN. */
  discard(): Promise<void>;
}

/**
 * Stage the re-wrap of the vault key — and every archived key — from `oldPin`
 * to `newPin`. Call BEFORE the new PIN is stored, then `commit()` once it is,
 * or `discard()` if storing it failed. No live record is touched here. Throws
 * (after discarding what it staged) when SecureStore cannot be read or
 * written, so the caller aborts the PIN change with nothing changed. Records
 * `oldPin` cannot open are left as they are.
 */
export async function stageVaultRewrap(oldPin: string, newPin: string): Promise<VaultRewrap> {
  const staged: string[] = [];
  const discard = async () => {
    for (const name of staged) await SecureStore.deleteItemAsync(stagedName(name)).catch(() => {});
  };
  try {
    const { names } = await readArchiveIndex();
    for (const name of [KEY, ...names]) {
      const rec = await readRecord(name);
      const keys = openVaultKeys(oldPin, rec);
      if (!keys || !rec) continue;
      const s: StagedRecord = { rec: sealVaultKeys(newPin, keys), from: rec.iv };
      staged.push(name);
      await SecureStore.setItemAsync(stagedName(name), JSON.stringify(s));
    }
  } catch (e) {
    await discard();
    throw e;
  }
  return {
    discard,
    async commit() {
      let all = true;
      for (const name of staged) {
        try {
          const next = await stagedFor(name, await readRecord(name));
          if (next) await moveStaged(name, next);
        } catch { all = false; }
      }
      return all;
    },
  };
}

/**
 * A Device PIN change with the vault keys carried along, all or nothing:
 * stage the re-wraps, run `savePin`, then put the staged copies in place.
 * When staging or `savePin` throws, the staged copies are dropped and this
 * throws: the PIN and every vault record are as they were. `oldPin` null =
 * there was no PIN before, so there is nothing to re-wrap. Resolves false when
 * a staged copy could not be moved yet (the next unlock finishes it).
 */
export async function changePinWithVaultKeys(
  oldPin: string | null, newPin: string, savePin: (pin: string) => Promise<void>,
): Promise<boolean> {
  const rewrap = oldPin ? await stageVaultRewrap(oldPin, newPin) : null;
  try {
    await savePin(newPin);
  } catch (e) {
    await rewrap?.discard();
    throw e;
  }
  return rewrap ? rewrap.commit() : true;
}

/** Thrown by tryOldVaultPin while the wrong-old-PIN limit is in force. */
export class OldPinLimitError extends Error {
  constructor(readonly waitMs: number) {
    super(`Too many old PINs tried. Try again in ${Math.max(1, Math.ceil(waitMs / 60_000))} min.`);
    this.name = 'OldPinLimitError';
  }
}

/** Wrong old PINs left now, and how long until more are allowed (0 = now).
 *  Throws when SecureStore cannot be read. */
export async function oldVaultPinTries(now: number = Date.now()): Promise<{ left: number; waitMs: number }> {
  const raw = await SecureStore.getItemAsync(OLD_PIN_TRIES_KEY);
  let n = 0;
  let at = 0;
  try {
    const p = raw ? JSON.parse(raw) as { n?: unknown; at?: unknown } : null;
    if (typeof p?.n === 'number' && typeof p.at === 'number') { n = p.n; at = p.at; }
  } catch { /* unreadable count: start again */ }
  if (now - at >= OLD_PIN_WAIT_MS) n = 0;
  const left = Math.max(0, OLD_PIN_TRIES - n);
  return { left, waitMs: left > 0 ? 0 : at + OLD_PIN_WAIT_MS - now };
}

/**
 * "Try an old PIN": every record (the current one and the archived ones) that
 * `pin` — the current, verified Device PIN — cannot open but `oldPin` can is
 * re-wrapped under `pin`, so its files open from now on. Returns how many
 * were recovered; the caller then unlocks again to pick them up. Nothing is
 * deleted or replaced: each record keeps the same key, only the wrap changes.
 * The try is counted BEFORE it runs (so quitting mid-try still counts) and the
 * count resets when one succeeds; throws OldPinLimitError at the limit.
 */
export async function tryOldVaultPin(oldPin: string, pin: string, now: number = Date.now()): Promise<number> {
  if (oldPin === pin) return 0;
  const tries = await oldVaultPinTries(now);
  if (tries.left <= 0) throw new OldPinLimitError(tries.waitMs);
  await SecureStore.setItemAsync(OLD_PIN_TRIES_KEY, JSON.stringify({ n: OLD_PIN_TRIES - tries.left + 1, at: now }));
  let recovered = 0;
  const { names } = await readArchiveIndex();
  for (const name of [KEY, ...names]) {
    if (openVaultKeys(pin, await readRecord(name))) continue;
    if (await rewrapOne(name, oldPin, pin)) recovered++;
  }
  if (recovered > 0) await SecureStore.deleteItemAsync(OLD_PIN_TRIES_KEY).catch(() => {});
  return recovered;
}

/** Why "New key" failed. `archived` is true when the old record was already
 *  copied to the archive (and listed) before the failure: nothing was deleted
 *  and the current record is unchanged, but one more old key is listed. */
export class VaultNewKeyError extends Error {
  constructor(readonly archived: boolean) {
    super(archived
      ? 'The old key was copied to the list of old keys, but the new key could not be saved. The current key is unchanged and nothing was deleted; one more old key may now be listed.'
      : 'Nothing was changed: this phone\'s secure storage could not be read or written. Try again.');
    this.name = 'VaultNewKeyError';
  }
}

/**
 * Start a new vault key for `pin` when the existing record cannot be opened
 * (this PIN did not seal it, it is damaged, or it is lost). The existing record
 * is copied to an archive entry FIRST and its name added to the index; if
 * either write fails nothing changes. Files sealed under the old key stay on
 * disk and stay unreadable until an old PIN opens that archive ("Try an old
 * PIN"); v1 files still open with the PIN that sealed them. Throws
 * VaultNewKeyError, which says whether an archive entry was written.
 */
export async function replaceVaultKeys(pin: string): Promise<VaultKeys> {
  let archived = false;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw) {
      // Never replace a record this PIN can open.
      let rec: VaultKeyRecord | null = null;
      try { rec = JSON.parse(raw) as VaultKeyRecord; } catch { /* damaged: archive it */ }
      const current = openVaultKeys(pin, rec);
      if (current) return current;
      const index = await readArchiveIndex();
      let stamp = Date.now();
      // Never overwrite an older archive (a clock set back can repeat a stamp).
      while (index.names.includes(`${KEY}_prev_${stamp}`) || await SecureStore.getItemAsync(`${KEY}_prev_${stamp}`)) stamp++;
      const name = `${KEY}_prev_${stamp}`;
      await SecureStore.setItemAsync(name, raw);
      try {
        await writeArchiveIndex([...index.names, name], index);
      } catch (e) {
        await SecureStore.deleteItemAsync(name).catch(() => {});   // unlisted copy: nothing visible changed
        throw e;
      }
      archived = true;
    }
    const keys = newVaultKeys(pin);
    await SecureStore.setItemAsync(KEY, JSON.stringify(sealVaultKeys(pin, keys)));
    return keys;
  } catch (e) {
    if (e instanceof VaultNewKeyError) throw e;
    throw new VaultNewKeyError(archived);
  }
}
