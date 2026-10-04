// lib/media/scanRecent.ts — safe read-modify-write of Doc Scanner's sealed
// recent list, and the rules for the scan key that seals it.
//
// The sealed list is the ONLY place each scan's decryption key is kept, so it
// must never be written from a copy that was not read successfully: a scan
// saved after a failed load used to replace the whole list with [newScan] and
// every older scan became unreadable. Each change therefore re-reads the
// stored list, applies the change to that, and refuses (throws
// RecentListUnavailable) when the stored list exists but cannot be opened, or
// when a legacy plaintext list is still waiting to be migrated.
//
// Pure (no native imports) so the rules run under `npx tsx`; lib/scanVault and
// app/docscanner supply the storage.

// No cap: the list holds each scan's only key, so dropping an entry would
// leave its PDF unreadable. A scan leaves the list only when it is deleted.

export type RecentUnavailableReason = 'locked' | 'legacy' | 'keyLost';

export class RecentListUnavailable extends Error {
  constructor(readonly reason: RecentUnavailableReason) {
    super(reason === 'locked' ? 'recent list cannot be opened'
      : reason === 'legacy' ? 'legacy recent list not migrated yet'
      : 'scan key missing while a sealed list exists');
    this.name = 'RecentListUnavailable';
  }
}

export interface RecentStore<T> {
  /** Raw sealed list, or null when none is stored. Throws on a read failure. */
  readSealed(): Promise<string | null>;
  /** True when the pre-encryption plaintext list is still stored. */
  hasLegacy(): Promise<boolean>;
  /** Open a sealed list; null when it cannot be opened. */
  open(sealed: string): Promise<T[] | null>;
  /** Seal and store the list. Throws on failure. */
  write(docs: T[]): Promise<void>;
}

/** Re-read the stored list, apply `change`, store the result and return it.
 *  Nothing is written when the read fails. The legacy list is read BEFORE the
 *  sealed one: the migration writes the sealed list before it removes the
 *  legacy one, so "no legacy" guarantees a migrated list would be seen, and a
 *  change can never land on an empty list over a migration in progress. */
export async function updateRecent<T>(store: RecentStore<T>, change: (stored: T[]) => T[]): Promise<T[]> {
  const legacy = await store.hasLegacy();
  const sealed = await store.readSealed();
  let stored: T[] = [];
  if (sealed != null) {
    const opened = await store.open(sealed);
    if (!opened) throw new RecentListUnavailable('locked');
    stored = opened;
  } else if (legacy) {
    throw new RecentListUnavailable('legacy');
  }
  const next = change(stored);
  await store.write(next);
  return next;
}

/** Runs tasks one at a time, in call order; a failed task does not stop the
 *  next. Every change to the recent list goes through one of these, so a
 *  delete computed from an older read can never land after a newer save. */
export function serialQueue(): <R>(task: () => Promise<R>) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return <R>(task: () => Promise<R>) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

export interface ScanKeyStore {
  /** The stored key (hex), or null when none is stored. Throws on a read failure. */
  get(): Promise<string | null>;
  set(hex: string): Promise<void>;
  /** True when a sealed list (the only thing sealed under the key) is stored. Throws on a read failure. */
  sealedListExists(): Promise<boolean>;
}

/** The stored scan key, or a new one when none is stored AND nothing is sealed
 *  under the old one. A missing key is not proof there never was one: Android's
 *  secure storage drops values when its keystore key is invalidated, and a
 *  read can come back empty. Minting then would overwrite the key a sealed
 *  list needs, so it throws RecentListUnavailable('keyLost') and writes
 *  nothing (mirrors lib/vaultKeyStore's 'lost'). */
export async function resolveScanKey(store: ScanKeyStore, mint: () => string): Promise<string> {
  const hex = await store.get();
  if (hex) return hex;
  if (await store.sealedListExists()) throw new RecentListUnavailable('keyLost');
  const fresh = mint();
  await store.set(fresh);
  return fresh;
}
