// lib/media/scanRecent.ts — safe read-modify-write of Doc Scanner's sealed
// recent list.
//
// The sealed list is the ONLY place each scan's decryption key is kept, so it
// must never be written from a copy that was not read successfully: a scan
// saved after a failed load used to replace the whole list with [newScan] and
// every older scan became unreadable. Each change therefore re-reads the
// stored list, applies the change to that, and refuses (throws
// RecentListUnavailable) when the stored list exists but cannot be opened, or
// when a legacy plaintext list is still waiting to be migrated.

// No cap: the list holds each scan's only key, so dropping an entry would
// leave its PDF unreadable. A scan leaves the list only when it is deleted.

export class RecentListUnavailable extends Error {
  constructor(readonly reason: 'locked' | 'legacy') {
    super(reason === 'locked' ? 'recent list cannot be opened' : 'legacy recent list not migrated yet');
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
 *  Nothing is written when the read fails. */
export async function updateRecent<T>(store: RecentStore<T>, change: (stored: T[]) => T[]): Promise<T[]> {
  const sealed = await store.readSealed();
  let stored: T[] = [];
  if (sealed != null) {
    const opened = await store.open(sealed);
    if (!opened) throw new RecentListUnavailable('locked');
    stored = opened;
  } else if (await store.hasLegacy()) {
    throw new RecentListUnavailable('legacy');
  }
  const next = change(stored);
  await store.write(next);
  return next;
}
