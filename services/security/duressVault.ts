// services/security/duressVault.ts — genuine duress/decoy vault separation (W3).
//
// Replaces the old plaintext-PIN string-compare (app/duresspin.tsx stored
// 'vaultRealPin'/'vaultDuressPin' in the clear and the "data is encrypted"
// claim was false). Here:
//   • Neither PIN is ever stored. Only a random salt + two opaque sealed blobs.
//   • The real PIN derives a key that authenticates the REAL header; the duress
//     PIN derives a different key that authenticates only the DECOY header.
//   • A duress PIN cannot derive or open the real vault — it is cryptographically
//     unreachable (GCM auth fails), not merely hidden behind a UI flag.
//
// Persistence only. The crypto is in vaultKeys.ts (pure + Node-tested).
//
// NOTE (honest scope): this seals the *vault selection* and any secret carried
// in the real header. Re-keying the full message cache at rest under the real
// key is the follow-on (#32). Even so, this already removes the old failure
// where the real account opened on a plaintext PIN compare.

import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  createVaultHeaders, newSalt, tryUnlockAsync,
  type VaultUnlock,
} from './vaultKeys';

const SALT_KEY  = 'vault_salt';
const REAL_HDR  = 'vault_real_hdr';
const DECOY_HDR = 'vault_decoy_hdr';

/** True once both vaults have been provisioned. */
export async function isVaultSetup(): Promise<boolean> {
  const [s, r, d] = await Promise.all([
    SecureStore.getItemAsync(SALT_KEY),
    SecureStore.getItemAsync(REAL_HDR),
    SecureStore.getItemAsync(DECOY_HDR),
  ]);
  return !!(s && r && d);
}

/**
 * Provision the real + decoy vaults from the two PINs. `realPayload` is sealed
 * under the real key (e.g. a marker, or later the real session secret);
 * `decoyPayload` under the duress key. The PINs are discarded after derivation.
 */
export async function setupVaults(
  realPin: string,
  duressPin: string,
  realPayload: Record<string, any> = {},
  decoyPayload: Record<string, any> = {},
): Promise<void> {
  if (!realPin || !duressPin) throw new Error('Both PINs are required');
  if (realPin === duressPin) throw new Error('Duress PIN must differ from the real PIN');

  const salt = newSalt();
  const { realHeader, decoyHeader } = createVaultHeaders(realPin, duressPin, salt, realPayload, decoyPayload);

  await SecureStore.setItemAsync(SALT_KEY, bytesToHex(salt));
  await SecureStore.setItemAsync(REAL_HDR, realHeader);
  await SecureStore.setItemAsync(DECOY_HDR, decoyHeader);
}

/**
 * Resolve a PIN to a vault by decryption. Returns { kind, payload } for the
 * real or decoy vault, or null for an unrecognised PIN. There is no stored flag
 * that reveals duress mode — selection is purely cryptographic.
 */
export async function unlockWithPin(pin: string): Promise<VaultUnlock | null> {
  const [saltHex, realHeader, decoyHeader] = await Promise.all([
    SecureStore.getItemAsync(SALT_KEY),
    SecureStore.getItemAsync(REAL_HDR),
    SecureStore.getItemAsync(DECOY_HDR),
  ]);
  if (!saltHex || !realHeader || !decoyHeader) return null;
  // P3.2: async twin — scrypt runs on the native background pool, so the lock
  // screen stays responsive during the derivation. Same result bytes.
  return tryUnlockAsync(pin, hexToBytes(saltHex), realHeader, decoyHeader);
}

/** Remove all vault material (e.g. on account reset). */
export async function clearVaults(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(SALT_KEY),
    SecureStore.deleteItemAsync(REAL_HDR),
    SecureStore.deleteItemAsync(DECOY_HDR),
  ]);
}
