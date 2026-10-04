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

/**
 * Run `work` with an AbortSignal that fires after `ms`, and reject at `ms` even
 * if `work` ignores the signal (a native call that cannot be aborted). Put the
 * body read inside `work`, so the deadline covers it too. The rejection's text
 * matches lib/userErrorText's connection copy.
 */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(timedOut()); }, ms);
  });
  try {
    return await Promise.race([work(ctl.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export default {};
