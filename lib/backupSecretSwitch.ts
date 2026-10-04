// lib/backupSecretSwitch.ts — replace the stored end-to-end backup secret
// without ever leaving the device on a secret the server copy does not match.
//
// Used by lib/cloudBackup for every switch: account → password, account → key,
// password → new password ("Change password"), password ↔ key, a new key, and
// back to account mode (next = null). Pure (the store, the marker and the
// upload are passed in), so every path is tested under plain Node in
// backupSecretSwitch.selftest.ts.
//
// THE RULE: what the device holds is the truth, and the server copy is made to
// match it. The device's pair is ONE store record (lib/cloudBackup's e2eeSlot),
// so it is always wholly the old pair or wholly the new one.
//
// Order, and why:
//   1. Read the current pair. A failed read aborts before anything changes.
//   2. Set the "switch pending" marker. Until it is cleared, the next backup
//      run re-uploads under whatever the device holds, without waiting for the
//      schedule (lib/backupScheduler). That is what recovers a crash or a
//      double failure in the steps below.
//   3. Upload under the NEW pair while the OLD pair is still stored.
//   4. Store the new pair, then read it back: a store call that threw may still
//      have written, and one that returned may not have.
//   5. The device has the new pair → done. It still has the old pair → upload
//      under the old pair again, so the server copy is one the user can open.
// Callers serialise this with every other backup write (createLock below), so a
// scheduled backup cannot land an upload under the other secret in between.

import { userErrorText } from './userErrorText';

export interface SecretPair<H> { secret: string; header: H }

export interface SecretSlot<H> {
  /** The stored pair, or null in account-managed mode. Throws on a read failure. */
  get(): Promise<SecretPair<H> | null>;
  /** Writes the pair as ONE record. */
  put(pair: SecretPair<H>): Promise<void>;
  /** Back to account-managed mode. */
  clear(): Promise<void>;
}

/** The "switch not finished" marker (lib/cloudBackup: a device-local AsyncStorage key). */
export interface PendingMarker { set(): Promise<void>; clear(): Promise<void> }

/** Which secret a side is on after a failed switch. */
export type SwitchSide = 'prev' | 'next' | 'unknown';

/**
 * A switch that did not complete, and exactly where it left things:
 *   device — what this phone now backs up with (prev: unchanged; unknown: the
 *            store could not be read back, so backups stay blocked);
 *   server — what the account copy is encrypted under (unknown: the upload
 *            failed, so it is most likely still prev — the pending marker
 *            re-uploads under the device's pair on the next backup run).
 */
export class BackupSwitchError extends Error {
  readonly code = 'BACKUP_SWITCH_FAILED';
  /** Set by lib/cloudBackup in 'key' mode when the server copy is under the new key. */
  recoveryKey?: string;
  constructor(readonly reason: unknown, readonly device: SwitchSide, readonly server: SwitchSide) {
    super((reason as { message?: string } | null)?.message ?? 'The backup secret could not be changed.');
  }
}
export function isBackupSwitchError(e: unknown): e is BackupSwitchError {
  return (e as { code?: string } | null)?.code === 'BACKUP_SWITCH_FAILED';
}

const secretOf = (p: { secret: string } | null | undefined) => p?.secret ?? null;

/**
 * Upload under `next` (null = the account key), then store it. Resolves only
 * when the device holds `next`; otherwise throws a BackupSwitchError that says
 * where the device and the server copy were left.
 */
export async function switchBackupSecret<H>(
  slot: SecretSlot<H>,
  pending: PendingMarker,
  next: SecretPair<H> | null,
  upload: (using: SecretPair<H> | null) => Promise<void>,
): Promise<void> {
  const prev = await slot.get();
  await pending.set();
  try {
    await upload(next);
  } catch (e) {
    throw new BackupSwitchError(e, 'prev', 'unknown');
  }
  let storeErr: unknown = null;
  try { await (next ? slot.put(next) : slot.clear()); } catch (e) { storeErr = e; }

  let now: SwitchSide = 'unknown';
  try {
    const held = secretOf(await slot.get());
    now = held === secretOf(next) ? 'next' : held === secretOf(prev) ? 'prev' : 'unknown';
  } catch (e) { storeErr = storeErr ?? e; }

  if (now === 'next') {
    // A marker left behind only costs one extra upload under this same pair.
    await pending.clear().catch(() => {});
    return;
  }
  const cause = storeErr ?? new Error('The new backup secret was not saved on this phone.');
  if (now === 'unknown') throw new BackupSwitchError(cause, 'unknown', 'next');
  try {
    await upload(prev);
  } catch {
    throw new BackupSwitchError(cause, 'prev', 'next');
  }
  await pending.clear().catch(() => {});
  throw new BackupSwitchError(cause, 'prev', 'prev');
}

/**
 * A FIFO lock: each call runs after every earlier one has settled. Shared by
 * the switch and every backup write in lib/cloudBackup, so a scheduled backup
 * cannot resolve the old secret, wait on the network, and land its upload after
 * a switch stored the new one.
 */
export function createLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * User copy for a failed backup, upload or restore — never the raw message of
 * a JS, crypto or network error (lib/userErrorText), plus the backup-specific
 * failures lib/cloudBackup throws.
 */
export function backupErrorText(e: unknown, fallback = 'Please try again.'): string {
  const x = e as { message?: string; code?: string } | null | undefined;
  if (x?.code === 'BACKUP_SETTINGS_UNREADABLE') {
    return "This phone couldn't read your backup encryption settings, so nothing was uploaded. Try again, or restart the phone.";
  }
  const msg = String(x?.message ?? '');
  const put = /^backup (upload|download) failed \((\d+)\)$/.exec(msg);
  if (put) return Number(put[2]) >= 500 ? 'The storage server is having trouble. Please try again shortly.' : `The ${put[1]} was refused. Please try again.`;
  if (msg === 'Could not get backup key') return "Your account's backup key could not be fetched. Check your connection and try again.";
  return userErrorText(e, fallback);
}
