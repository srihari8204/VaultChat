// lib/mfa.ts — device-level MFA (biometric / device PIN) on top of the account.
// A random 256-bit token in SecureStore marks MFA "on" for this device; the
// server mirror is users.mfa_enabled (POST /auth/mfa/configure). When on, a cold
// launch is gated by biometric OR the account MPIN (see app/app-lock.tsx).

import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { configureMfa } from './onboarding';

export const MFA_TOKEN_KEY = 'vc.mfa.token';

let cachedMfaEnabled: boolean | undefined;
let mfaRead: Promise<boolean> | null = null;

export async function isMfaEnabled(): Promise<boolean> {
  if (cachedMfaEnabled !== undefined) return cachedMfaEnabled;
  if (!mfaRead) {
    mfaRead = SecureStore.getItemAsync(MFA_TOKEN_KEY)
      .then((token) => {
        cachedMfaEnabled = !!token;
        return cachedMfaEnabled;
      })
      .catch(() => false)
      .finally(() => { mfaRead = null; });
  }
  return mfaRead;
}

export async function deviceSecurityAvailable(): Promise<boolean> {
  try { return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()); }
  catch { return false; }
}

// Prompt biometric, store the device token, mirror to the server. Returns false
// if the device has no enrolled security or the user dismisses the prompt.
export async function enableMfa(): Promise<boolean> {
  if (!(await deviceSecurityAvailable())) return false;
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Confirm to enable crazzychat MFA' });
  if (!r.success) return false;
  const bytes = await Crypto.getRandomBytesAsync(32);
  const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(MFA_TOKEN_KEY, token);
  cachedMfaEnabled = true;
  await configureMfa(true);
  return true;
}

export async function disableMfa(): Promise<void> {
  try { await SecureStore.deleteItemAsync(MFA_TOKEN_KEY); } catch { /* ignore */ }
  cachedMfaEnabled = false;
  mfaRead = null;
  await configureMfa(false);
}

// Launch-gate biometric prompt (no enrollment side effects).
export async function promptBiometricUnlock(): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock crazzychat', fallbackLabel: 'Use MPIN' });
    return r.success;
  } catch { return false; }
}
