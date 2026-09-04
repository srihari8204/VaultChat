// lib/vaultCrypto.ts — local AES-256-GCM for the personal Vault.
//
// Files are encrypted on-device with a key derived from the user's 8-digit
// Vault PIN (PBKDF2-SHA256, 100k iterations). Pure-JS @noble primitives so it
// works under Hermes (unlike crypto.subtle). The key never leaves memory; the
// PIN is held only for the unlocked session.

import 'react-native-get-random-values';
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

const SALT = new TextEncoder().encode('vaultchat-vault-aes-gcm-salt-2026');
const keyCache = new Map<string, Uint8Array>();

// P3.2: native PBKDF2 (react-native-quick-crypto → OpenSSL) when present —
// the 100k-iteration JS loop blocked the UI on the first Vault operation per
// PIN. Identical derived bytes (PBKDF2-HMAC-SHA256 is fully specified), so
// existing payloads decrypt unchanged; @noble stays as the Expo Go fallback.
let QC: any = null;
try { QC = require('react-native-quick-crypto'); if (typeof QC?.pbkdf2Sync !== 'function') QC = null; } catch { QC = null; }

/**
 * PBKDF2-HMAC-SHA256 → 32 bytes, native when available.
 *
 * Extracted from keyFromPin so the encrypted-backup key (lib/backupCrypto) can
 * derive with its OWN per-user salt and iteration count without duplicating the
 * quick-crypto fast path — a second copy of this is a second place for the two
 * to drift apart on a security boundary. PBKDF2-HMAC-SHA256 is fully specified,
 * so both branches return identical bytes for identical inputs.
 */
export function pbkdf2Bytes(password: string, salt: Uint8Array, iterations: number): Uint8Array {
  if (QC) {
    try {
      const dk = QC.pbkdf2Sync(Buffer.from(new TextEncoder().encode(password)), Buffer.from(salt), iterations, 32, 'sha256');
      return new Uint8Array(dk.buffer ? dk : Buffer.from(dk));
    } catch { /* fall through to JS */ }
  }
  return pbkdf2(sha256, new TextEncoder().encode(password), salt, { c: iterations, dkLen: 32 });
}

function keyFromPin(pin: string): Uint8Array {
  let k = keyCache.get(pin);
  if (!k) {
    k = pbkdf2Bytes(pin, SALT, 100000);
    keyCache.set(pin, k);
  }
  return k;
}

export interface VaultPayload { v: 1; iv: string; ct: string }

export function vaultEncrypt(pin: string, plaintext: string): VaultPayload {
  const key = keyFromPin(pin);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext));
  return { v: 1, iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64') };
}

export function vaultDecrypt(pin: string, p: VaultPayload): string {
  const key = keyFromPin(pin);
  const iv = Buffer.from(p.iv, 'base64');
  const ct = Buffer.from(p.ct, 'base64');
  const pt = gcm(key, iv).decrypt(ct);
  return new TextDecoder().decode(pt);
}

export function clearVaultKeyCache() { keyCache.clear(); }
