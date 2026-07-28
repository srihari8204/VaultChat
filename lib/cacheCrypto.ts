// lib/cacheCrypto.ts — at-rest sealing for the local SQLite message cache (#32 Phase B).
//
// The local cache (lib/localDb) is the source of truth the UI renders from, and
// today it stores message bodies in plaintext. This module seals the sensitive
// columns (messages.content, messages.meta, chats.data) with AES-256-GCM so a
// duress/decoy PIN or a seized, unlocked device cannot read cached message text.
//
// Key model (envelope encryption):
//   • A random 32-byte Data Encryption Key (DEK) encrypts the fields.
//   • The DEK is itself sealed under the PIN-derived session key and stored in
//     SecureStore (vc_cache_dek). Envelope means a PIN change only re-seals the
//     DEK — it never re-encrypts the whole cache.
//   • The DEK is held in memory ONLY after a successful unlock (setCacheKey).
//
// Pass-through safety: encField/decField gate on whether a DEK is loaded, NOT on
// the flag directly. So with the flag off (DEK never provisioned) or while locked
// (DEK not yet loaded), both are identity functions and localDb behaves exactly as
// before. The `enc:v1:` prefix lets sealed and legacy-plaintext rows coexist, so
// enabling the flag migrates rows lazily on next write — nothing is bulk-rewritten.
//
// Reuses the proven crypto in services/security/vaultKeys (AES-256-GCM seal/open).

import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { open, seal } from '../services/security/vaultKeys';
import { VAULT_CACHE_ENCRYPTED } from '../constants/flags';

const DEK_KEY = 'vc_cache_dek';     // the PIN-sealed DEK envelope
const PREFIX  = 'enc:v1:';          // marks a sealed field value

// The DEK lives in memory only — never persisted in the clear.
let _dek: Uint8Array | null = null;

/** Load the DEK into memory (called after a successful unlock/setup). */
export function setCacheKey(dek: Uint8Array | null): void {
  _dek = dek;
}

/** Drop the in-memory DEK (called on lock/logout). Sealed envelope stays on disk. */
export function clearCacheKey(): void {
  _dek = null;
}

/** True once a DEK is loaded and field sealing is active. */
export function cacheKeyReady(): boolean {
  return _dek != null;
}

/** Seal a field value for storage. Identity when no DEK is loaded or value is null. */
export function encField(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (_dek == null) return value;                 // flag off / locked → pass-through
  if (value.startsWith(PREFIX)) return value;     // already sealed (idempotent)
  return PREFIX + seal(_dek, value);
}

/** Open a stored field value. Returns plaintext for sealed rows, the value as-is
 *  for legacy plaintext rows, and the raw ciphertext if it can't be opened (no
 *  DEK / wrong DEK) — never throws, so a locked read degrades instead of crashing. */
export function decField(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) return value;    // legacy plaintext row
  if (_dek == null) return value;                 // locked → leave sealed
  const pt = open(_dek, value.slice(PREFIX.length));
  return pt == null ? value : pt;                 // wrong key → leave sealed
}

// ─── DEK envelope management (sealed under the PIN-derived session key) ────────

/**
 * Ensure a DEK exists for this install and load it into memory, sealing a fresh
 * one under `pinKey` on first use. Call at PIN setup. No-op unless the flag is on.
 */
export async function provisionCacheKey(pinKey: Uint8Array): Promise<void> {
  if (!VAULT_CACHE_ENCRYPTED) return;
  try {
    const existing = await SecureStore.getItemAsync(DEK_KEY);
    if (existing) {
      const hex = open(pinKey, existing);
      if (hex) { _dek = hexToBytes(hex); return; }
      // Envelope exists but this PIN can't open it (e.g. PIN changed without
      // re-seal) — re-seal a fresh DEK so writes keep working. Old sealed rows
      // under the previous DEK become unreadable, which is the correct security
      // outcome for a changed key; they degrade to ciphertext, never crash.
    }
    const dek = randomBytes(32);
    await SecureStore.setItemAsync(DEK_KEY, seal(pinKey, bytesToHex(dek)));
    _dek = dek;
  } catch { /* leave _dek null → pass-through; cache stays usable in cleartext */ }
}

/**
 * Unseal the DEK with `pinKey` and load it into memory. Call at unlock.
 * Returns true if a DEK was loaded. No-op (false) unless the flag is on.
 */
export async function unlockCacheKey(pinKey: Uint8Array): Promise<boolean> {
  if (!VAULT_CACHE_ENCRYPTED) return false;
  try {
    const env = await SecureStore.getItemAsync(DEK_KEY);
    if (!env) return false;
    const hex = open(pinKey, env);
    if (!hex) return false;
    _dek = hexToBytes(hex);
    return true;
  } catch { return false; }
}

/** Delete the sealed DEK envelope and drop the in-memory key (account wipe). */
export async function clearCacheKeyStore(): Promise<void> {
  _dek = null;
  await SecureStore.deleteItemAsync(DEK_KEY).catch(() => {});
}
