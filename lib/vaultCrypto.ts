// lib/vaultCrypto.ts — local AES-256-GCM for the personal Vault.
//
// v1 (vaultEncrypt/vaultDecrypt): a key derived from a secret (PBKDF2-SHA256,
// 100k iterations, constant salt) — still used by lib/cloudBackup, and still
// read for Vault files added before v2. v2 (below): Vault files are sealed with
// a random key wrapped under the Device PIN. Pure-JS @noble primitives so it
// works under Hermes (unlike crypto.subtle); Node-testable (vaultCrypto.selftest.ts).

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

// ─── v2: a random file key, wrapped under the PIN (2026-10-04) ───────────────
//
// v1 derived the FILE key straight from the PIN over the constant SALT above.
// Two consequences: changing the Device PIN (app/backup-pin) silently made every
// stored .enc file undecryptable, and one global salt over a short PIN keyspace
// is a single precomputation for every install.
//
// v2 seals files with a random 32-byte key (the DEK) instead. The DEK — and,
// alongside it, the v1 key derived from the PIN in force when v2 was first
// opened — are wrapped under PBKDF2(PIN, per-install random salt) in one small
// record (lib/vaultKeyStore persists it in SecureStore). A PIN change only
// re-wraps that record, so no file is rewritten and none is orphaned.
//
// EXISTING FILES ARE NEVER REWRITTEN. A v1 payload still opens: first with the
// v1 key carried in the record, then with the v1 derivation of the PIN just
// entered. vaultEncrypt/vaultDecrypt above are untouched (lib/cloudBackup uses
// them with its own secret), so no other format changes either.

export interface VaultKeys { dek: Uint8Array; legacy: Uint8Array }
export interface VaultKeyRecord { v: 2; salt: string; iv: string; ct: string }
export interface VaultFilePayload { v: 2; iv: string; ct: string }

const WRAP_ITERATIONS = 100000;
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** Fresh keys for an install that has no record yet. `pin` supplies the v1 key
 *  so files written before v2 stay readable after the PIN later changes. */
export function newVaultKeys(pin: string): VaultKeys {
  return { dek: randomBytes(32), legacy: keyFromPin(pin) };
}

export function sealVaultKeys(pin: string, keys: VaultKeys): VaultKeyRecord {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const body = new Uint8Array(64);
  body.set(keys.dek, 0);
  body.set(keys.legacy, 32);
  const ct = gcm(pbkdf2Bytes(pin, salt, WRAP_ITERATIONS), iv).encrypt(body);
  return { v: 2, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** The keys in `rec`, or null when `pin` is not the PIN it was sealed under. */
export function openVaultKeys(pin: string, rec: VaultKeyRecord | null | undefined): VaultKeys | null {
  if (!rec || rec.v !== 2 || !rec.salt || !rec.iv || !rec.ct) return null;
  try {
    const key = pbkdf2Bytes(pin, unb64(rec.salt), WRAP_ITERATIONS);
    const body = gcm(key, unb64(rec.iv)).decrypt(unb64(rec.ct));
    if (body.length !== 64) return null;
    return { dek: body.slice(0, 32), legacy: body.slice(32, 64) };
  } catch {
    return null;   // GCM tag mismatch: wrong PIN (or a damaged record)
  }
}

/** New files: v2 under the DEK. Without keys (the record could not be opened)
 *  fall back to v1 under the PIN, so adding a file never fails for that reason. */
export function vaultFileEncrypt(keys: VaultKeys | null, pin: string, plaintext: string): VaultFilePayload | VaultPayload {
  if (!keys) return vaultEncrypt(pin, plaintext);
  const iv = randomBytes(12);
  const ct = gcm(keys.dek, iv).encrypt(new TextEncoder().encode(plaintext));
  return { v: 2, iv: b64(iv), ct: b64(ct) };
}

/** Opens either format. Throws when no key this install holds can open it. */
export function vaultFileDecrypt(keys: VaultKeys | null, pin: string, p: VaultFilePayload | VaultPayload): string {
  const open = (key: Uint8Array) => new TextDecoder().decode(gcm(key, unb64(p.iv)).decrypt(unb64(p.ct)));
  if (p.v === 2) {
    if (!keys) throw new Error('The vault key could not be opened with this PIN.');
    return open(keys.dek);
  }
  // v1: sealed under whatever PIN was set when it was added. Lazy, so the
  // second 100k-iteration derivation only runs when the first key misses.
  const candidates: (() => Uint8Array)[] = [() => keyFromPin(pin)];
  if (keys) candidates.unshift(() => keys.legacy);
  for (const k of candidates) {
    try { return open(k()); } catch { /* next */ }
  }
  throw new Error('This file was added under an earlier PIN and cannot be opened with this one.');
}
