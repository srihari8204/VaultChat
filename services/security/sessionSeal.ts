// services/security/sessionSeal.ts — seal the real session under the unlock PIN (#32 Phase A).
//
// The JWT access/refresh tokens are the keys to the real account. Today they sit
// in plaintext SecureStore (OS-encrypted at rest, but readable by anyone who
// gets past the device lock — including someone who knows a *different* unlock
// path). This seals them under a key derived from the REAL unlock PIN, so the
// duress/decoy PIN (or no PIN) cannot recover the real session.
//
// Reuses the proven crypto in vaultKeys (scrypt + AES-256-GCM). Gated by
// VAULT_SESSION_SEALED; the api seam falls back to re-login if unseal ever
// fails, so this can never brick the app.

import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { deriveVaultKey, open, seal } from './vaultKeys';

const SALT_KEY   = 'vc_session_salt';
const SEALED_KEY = 'vc_session_sealed';

export interface SessionTokens { access: string; refresh: string; }

/** Derive the session-sealing key from the PIN (manages a per-install salt). */
export async function deriveSessionKey(pin: string): Promise<Uint8Array> {
  let hex = await SecureStore.getItemAsync(SALT_KEY);
  if (!hex) {
    const s = randomBytes(16);
    hex = bytesToHex(s);
    await SecureStore.setItemAsync(SALT_KEY, hex);
  }
  return deriveVaultKey(pin, hexToBytes(hex));
}

/** Seal the tokens under a derived key (overwrites any prior sealed session). */
export async function sealWithKey(key: Uint8Array, tokens: SessionTokens): Promise<void> {
  await SecureStore.setItemAsync(SEALED_KEY, seal(key, JSON.stringify(tokens)));
}

/** Unseal the tokens with a derived key. Returns null if the key is wrong (GCM auth fails). */
export async function unsealWithKey(key: Uint8Array): Promise<SessionTokens | null> {
  const blob = await SecureStore.getItemAsync(SEALED_KEY);
  if (!blob) return null;
  const pt = open(key, blob);
  if (pt == null) return null;
  try {
    const t = JSON.parse(pt);
    if (t && typeof t.access === 'string' && typeof t.refresh === 'string') return t;
  } catch { /* fall through */ }
  return null;
}

export async function hasSealedSession(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(SEALED_KEY));
}

export async function clearSealedSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SEALED_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(SALT_KEY).catch(() => {});
}
