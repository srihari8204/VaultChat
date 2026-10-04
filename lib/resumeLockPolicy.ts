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

/** What decides whether the app lock applies to this user at all. */
export type LockFactors = { signedIn: boolean; mfaOn: boolean; hasDevicePin: boolean };

/**
 * The app lock applies to a signed-in user who turned on device MFA OR set a
 * Device PIN (app/backup-pin). It used to be MFA-only, so a PIN holder whose
 * session is sealed at cold start was never relocked on resume.
 */
export function lockAppliesTo(f: LockFactors): boolean {
  return f.signedIn && (f.mfaOn || f.hasDevicePin);
}

export type UnlockMode = 'seal' | 'bio' | 'pin';

/**
 * Which unlock app/app-lock opens with. A sealed session can only be opened by
 * the PIN that seals it; device MFA starts with biometrics (MPIN fallback); a
 * Device-PIN user without MFA is asked for that PIN.
 */
export function unlockMode(f: { sealedLocked: boolean; mfaOn: boolean; hasDevicePin: boolean }): UnlockMode {
  if (f.sealedLocked) return 'seal';
  if (!f.mfaOn && f.hasDevicePin) return 'pin';
  return 'bio';
}

/**
 * Relock only when the app lock applies to this user (lockAppliesTo), a
 * timeout is set, and the app was away at least that long. A negative
 * gap (clock moved back) never locks on its own — the cold launch still does.
 */
export function shouldRelock(awayMs: number, timeoutMs: number | null, lockApplies: boolean): boolean {
  return lockApplies && timeoutMs !== null && awayMs >= timeoutMs;
}
