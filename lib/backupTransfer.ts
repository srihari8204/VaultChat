// lib/backupTransfer.ts — deadlines for the backup network steps that run under
// lib/cloudBackup's lock.
//
// React Native's fetch has no timeout on Android (OkHttp is built with zero =
// infinite timeouts; see lib/api.ts rawFetch). A connected-but-dead link — a
// captive portal, Wi-Fi with no route — leaves such a fetch pending forever.
// Every backup write, restore and secret switch shares one lock, so one hung
// upload used to queue every later backup, "Make a new key", "Change password"
// and "Turn off" until the app was killed. Each step under the lock now has a
// deadline, so a dead link fails the step and the lock moves on.
//
// Pure apart from the global fetch/AbortController it is handed; Node-tested in
// backupTransfer.selftest.ts.

/** Generous floor: a backstop against a dead link, not a latency budget. */
const BASE_MS = 60_000;
/** The slowest link a backup is expected to finish on (≈0.5 Mbit/s). */
const MIN_BYTES_PER_SEC = 64 * 1024;
/** Cap, and the deadline when the size is not known in advance (a download). */
export const MAX_TRANSFER_MS = 45 * 60_000;
/** Small JSON requests to Google (file lookups, token refresh). */
export const SMALL_REQUEST_MS = 30_000;

/** How long moving `bytes` may take before it counts as a dead link. */
export function transferDeadlineMs(bytes?: number): number {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return MAX_TRANSFER_MS;
  return Math.min(MAX_TRANSFER_MS, BASE_MS + Math.ceil(bytes / MIN_BYTES_PER_SEC) * 1000);
}

function timedOut(): Error {
  const err = new Error('The backup transfer timed out.');
  err.name = 'TimeoutError';
  return err;
}

/** The person stopped the transfer (a `cancel` signal fired). Code BACKUP_CANCELLED. */
export function transferCancelled(): Error {
  const err: Error & { code?: string } = new Error('The backup upload was stopped.');
  err.code = 'BACKUP_CANCELLED';
  return err;
}
export function isTransferCancelled(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'BACKUP_CANCELLED';
}

/**
 * Run `work` with an AbortSignal that fires after `ms`, then WAIT for `work` to
 * settle: the abort is what ends it. Rejecting at `ms` while the work ran on
 * would release lib/cloudBackup's lock under an upload that could still land
 * after the next holder's (lib/backupSecretSwitch createLock: the holder is
 * never cut loose). React Native's fetch and lib/api settle as soon as they are
 * aborted, so in practice this still returns at the deadline. Put the body
 * read inside `work`, so the deadline covers it too. A late failure rejects
 * with the timeout, whose text matches lib/userErrorText's connection copy; a
 * late success is returned (the transfer did complete).
 *
 * Work that cannot be aborted must not run under it: use giveUpAfter, and
 * only for a step that writes nothing.
 *
 * `cancel` lets a person stop the step (backup-e2ee's Stop): it aborts the
 * work like the deadline does and rejects with BACKUP_CANCELLED.
 */
export async function withDeadline<T>(
  ms: number, work: (signal: AbortSignal) => Promise<T>, cancel?: AbortSignal,
): Promise<T> {
  if (cancel?.aborted) throw transferCancelled();
  const ctl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; ctl.abort(); }, ms);
  // A person's Stop aborts the same way, and is waited for the same way.
  const onCancel = () => ctl.abort();
  cancel?.addEventListener('abort', onCancel);
  try {
    return await work(ctl.signal);
  } catch (e) {
    throw expired ? timedOut() : cancel?.aborted ? transferCancelled() : e;
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', onCancel);
  }
}

/**
 * Stop waiting for `work` after `ms` even though it keeps running — for a
 * native call that takes no signal (a Google token refresh). Only for steps
 * that WRITE NOTHING: whatever it returns late is dropped, and the caller,
 * having failed, never uses it.
 */
export async function giveUpAfter<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut()), ms); });
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export default {};
