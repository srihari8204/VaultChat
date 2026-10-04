// lib/resumeLockPolicy.ts — when returning to the app should lock it again. Pure.
//
// The cold-launch gate (app/_layout.tsx) only ever ran once per process, so a
// phone left unlocked in the background stayed inside the app no matter how
// long it was away. The timeout is the "Auto Screen Lock" choice in
// app/vault-features.tsx, which used to be saved and read by nothing.
// Node-tested in resumeLockPolicy.selftest.ts.

export type LockTimer = '1m' | '5m' | '15m' | '30m' | 'never';
export const DEFAULT_LOCK_TIMER: LockTimer = '5m';
/** SecureStore key vault-features writes its settings blob to. */
export const LOCK_SETTINGS_KEY = 'vault_features_settings';

const MS: Record<Exclude<LockTimer, 'never'>, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
};

/** The saved settings blob → its lock timer, defaulting on anything odd. */
export function parseLockTimer(raw: string | null | undefined): LockTimer {
  try {
    const v = raw ? JSON.parse(raw)?.lockTimer : undefined;
    return v === 'never' || (typeof v === 'string' && v in MS) ? v : DEFAULT_LOCK_TIMER;
  } catch {
    return DEFAULT_LOCK_TIMER;
  }
}

/** Milliseconds away before relocking, or null for "never". */
export function lockTimerMs(t: LockTimer): number | null {
  return t === 'never' ? null : MS[t];
}

/**
 * Relock only when the app lock applies to this user (device MFA on, signed
 * in), a timeout is set, and the app was away at least that long. A negative
 * gap (clock moved back) never locks on its own — the cold launch still does.
 */
export function shouldRelock(awayMs: number, timeoutMs: number | null, lockApplies: boolean): boolean {
  return lockApplies && timeoutMs !== null && awayMs >= timeoutMs;
}
