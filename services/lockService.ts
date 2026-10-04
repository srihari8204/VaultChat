import * as SecureStore from "expo-secure-store";
import { AppStateStatus } from "react-native";
import {
  LOCK_SETTINGS_KEY, lockTimerMs, parseLockTimer, shouldRelock,
} from "../lib/resumeLockPolicy";

const KEY = "vc_session_active";

export async function recordAuthTime(): Promise<void> {
  await SecureStore.setItemAsync(KEY, "true");
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

export async function shouldLock(): Promise<boolean> {
  try {
    const active = await SecureStore.getItemAsync(KEY);
    return active !== "true";
  } catch {
    return true;
  }
}

// When the app last went to the background. Memory only on purpose: a process
// that dies in the background comes back through the cold-launch gate in
// app/_layout.tsx, which locks on its own.
let backgroundAt: number | null = null;

/** The "Auto Screen Lock" choice (app/vault-features.tsx) in ms; null = never. */
export async function getLockTimeoutMs(): Promise<number | null> {
  let raw: string | null = null;
  try { raw = await SecureStore.getItemAsync(LOCK_SETTINGS_KEY); } catch { /* default */ }
  return lockTimerMs(parseLockTimer(raw));
}

/**
 * Feed every AppState change in; resolves true when the app has just come back
 * after being away at least the configured timeout AND the app lock applies to
 * this user (`lockApplies`, e.g. device MFA on and signed in). Only 'background'
 * starts the clock: iOS reports 'inactive' for a pulled-down notification shade,
 * which is not leaving the app.
 *
 * Was: cleared a session flag on background and returned "locked" on every
 * resume because nothing ever set the flag again — and it had no caller, so the
 * lock only ever ran at cold launch (2026-10-04, components/ResumeLock.tsx).
 */
export async function checkLockOnResume(
  state: AppStateStatus,
  lockApplies: () => Promise<boolean>,
): Promise<boolean> {
  if (state === "background") { backgroundAt = Date.now(); return false; }
  if (state !== "active" || backgroundAt === null) return false;
  const away = Date.now() - backgroundAt;
  backgroundAt = null;
  const timeout = await getLockTimeoutMs();
  if (timeout === null || away < timeout) return false;
  return shouldRelock(away, timeout, await lockApplies());
}
