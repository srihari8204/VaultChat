// services/security/vaultKeys.ts — PIN-derived vault keys + sealed-blob crypto.
//
// The cryptographic core behind the genuine duress/decoy split (W3). PURE: no
// React-Native imports, so the EXACT same code runs in Node (proven in
// vaultKeys.selftest.ts) and in Hermes — same pattern as services/crypto/e2ee.ts.
//
// Model: a vault key is derived from a PIN with a memory-hard KDF (scrypt) over
// a per-install random salt. Each "vault" is a small blob sealed with AES-256-GCM
// under its own PIN-derived key. Which vault opens is decided ONLY by which key
// successfully authenticates the blob — so a PIN can never open a vault it
// doesn't own, and the PIN itself is never stored anywhere.

import { gcm } from '@noble/ciphers/aes.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';

const TE = new TextEncoder();
const TD = new TextDecoder();
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

// P3.2: native scrypt engine (react-native-quick-crypto → OpenSSL) when the
// app runs under Hermes with the native module present. scrypt is scrypt —
// identical output bytes for identical params — so headers sealed by either
// engine open under the other. The guarded require keeps this file Node-clean:
// in the selftests the require throws, QC stays null, and the @noble path runs
// (the "PURE" contract above is preserved — no RN import, only a soft probe).
let QC: any = null;
try { QC = require('react-native-quick-crypto'); if (typeof QC?.scryptSync !== 'function') QC = null; } catch { QC = null; }

// scrypt parameters. N=2^14 is memory-hard enough to slow brute force of a
// short PIN meaningfully while staying ~sub-300ms on low-end Android. Tunable.
export const KDF_PARAMS = { N: 1 << 14, r: 8, p: 1, dkLen: 32 } as const;
// OpenSSL enforces maxmem: 128*N*r = 16 MB for these params; give headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Derive a 32-byte vault key from a PIN + salt (memory-hard, deterministic).
 *  Native (OpenSSL) when available — ~5-10× faster than the JS loop, cutting
 *  the unlock stall on low-end devices; @noble otherwise (Node/Expo Go). */
export function deriveVaultKey(pin: string, salt: Uint8Array): Uint8Array {
  if (QC) {
    try {
      const dk = QC.scryptSync(Buffer.from(TE.encode(pin)), Buffer.from(salt), KDF_PARAMS.dkLen,
        { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: SCRYPT_MAXMEM });
      return new Uint8Array(dk.buffer ? dk : Buffer.from(dk));
    } catch { /* fall through to JS */ }
  }
  return scrypt(TE.encode(pin), salt, {
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, dkLen: KDF_PARAMS.dkLen,
  });
}

/** Async twin of deriveVaultKey. On the native engine the derivation runs on
 *  quick-crypto's background thread pool, so the JS thread stays free during
 *  unlock (the lock screen keeps animating). Same output bytes as the sync
 *  path — callers may mix them freely. */
export function deriveVaultKeyAsync(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  if (QC && typeof QC.scrypt === 'function') {
    return new Promise((resolve, reject) => {
      QC.scrypt(Buffer.from(TE.encode(pin)), Buffer.from(salt), KDF_PARAMS.dkLen,
        { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: SCRYPT_MAXMEM },
        (err: any, dk: any) => {
          if (err || !dk) { try { resolve(deriveVaultKey(pin, salt)); } catch (e) { reject(e); } return; }
          resolve(new Uint8Array(dk.buffer ? dk : Buffer.from(dk)));
        });
    });
  }
  return Promise.resolve(deriveVaultKey(pin, salt));
}

/** Fresh 16-byte random salt (one per install). */
export function newSalt(): Uint8Array {
  return randomBytes(16);
}

/** Seal a string under a key → base64( nonce(12) || ciphertext+tag ). */
export function seal(key: Uint8Array, plaintext: string): string {
  const nonce = randomBytes(12);
  const ct = gcm(key, nonce).encrypt(TE.encode(plaintext));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return toB64(out);
}

/**
 * Open a sealed blob. Returns the plaintext, or null if `key` is wrong — the
 * GCM auth tag fails to verify, so a non-owning key cannot decrypt it. This
 * null-on-wrong-key is exactly the property the duress split relies on.
 */
export function open(key: Uint8Array, envelope: string): string | null {
  try {
    const buf = fromB64(envelope);
    if (buf.length <= 12) return null;
    const nonce = buf.slice(0, 12);
    const ct = buf.slice(12);
    return TD.decode(gcm(key, nonce).decrypt(ct));
  } catch {
    return null;
  }
}

// ─── Dual-vault header logic (pure; persistence lives in duressVault.ts) ──────

export type VaultKind = 'real' | 'decoy';
export interface VaultUnlock { kind: VaultKind; payload: Record<string, any>; }
export interface VaultHeaders { realHeader: string; decoyHeader: string; }

/**
 * Seal the real and decoy vault headers under their respective PIN-derived keys.
 * Neither PIN is stored — only the two opaque sealed blobs and the shared salt.
 */
export function createVaultHeaders(
  realPin: string,
  duressPin: string,
  salt: Uint8Array,
  realPayload: Record<string, any> = {},
  decoyPayload: Record<string, any> = {},
): VaultHeaders {
  const realKey = deriveVaultKey(realPin, salt);
  const duressKey = deriveVaultKey(duressPin, salt);
  return {
    realHeader: seal(realKey, JSON.stringify({ kind: 'real', ...realPayload })),
    decoyHeader: seal(duressKey, JSON.stringify({ kind: 'decoy', ...decoyPayload })),
  };
}

/**
 * Decide which vault a PIN opens by trying to authenticate each header. Returns
 * the matching vault + its payload, or null when the PIN owns neither. The real
 * header is tried first but only opens if the key truly authenticates it, so a
 * duress PIN can never yield the real vault.
 */
export function tryUnlock(
  pin: string,
  salt: Uint8Array,
  realHeader: string,
  decoyHeader: string,
): VaultUnlock | null {
  const key = deriveVaultKey(pin, salt);

  const real = open(key, realHeader);
  if (real != null) return { kind: 'real', payload: safeParse(real) };

  const decoy = open(key, decoyHeader);
  if (decoy != null) return { kind: 'decoy', payload: safeParse(decoy) };

  return null;
}

/** Async twin of tryUnlock (P3.2): the scrypt derivation — the entire cost of
 *  an unlock attempt — runs off the JS thread on the native engine. Identical
 *  decision logic and results. */
export async function tryUnlockAsync(
  pin: string,
  salt: Uint8Array,
  realHeader: string,
  decoyHeader: string,
): Promise<VaultUnlock | null> {
  const key = await deriveVaultKeyAsync(pin, salt);

  const real = open(key, realHeader);
  if (real != null) return { kind: 'real', payload: safeParse(real) };

  const decoy = open(key, decoyHeader);
  if (decoy != null) return { kind: 'decoy', payload: safeParse(decoy) };

  return null;
}

function safeParse(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}

// ─── PIN credential (pure) ────────────────────────────────────────────────────
//
// One representation for "is this the user's PIN?", replacing the two weaker
// ones that grew up alongside this file: an unsalted SHA-256 in authService and
// the PIN stored verbatim in securityService. Same scrypt + AES-GCM machinery as
// the vault headers above, so there is one KDF in the app, not three.
//
// A record holds a per-install salt and a sealed known constant. Verifying =
// deriving the key and trying to open it: the GCM auth tag decides, so a wrong
// PIN yields null and the PIN itself is never stored in any form. Persistence
// lives in services/security/pinStore.ts — this half stays Node-testable.

const PIN_PROOF = 'vc-pin-ok';

export interface PinRecord { v: 1; salt: string; verifier: string }

export function makePinRecord(pin: string): PinRecord {
  const salt = newSalt();
  return { v: 1, salt: toB64(salt), verifier: seal(deriveVaultKey(pin, salt), PIN_PROOF) };
}

export async function makePinRecordAsync(pin: string): Promise<PinRecord> {
  const salt = newSalt();
  const key = await deriveVaultKeyAsync(pin, salt);
  return { v: 1, salt: toB64(salt), verifier: seal(key, PIN_PROOF) };
}

export function checkPinRecord(rec: PinRecord | null | undefined, pin: string): boolean {
  if (!rec || rec.v !== 1 || !rec.salt || !rec.verifier) return false;
  return open(deriveVaultKey(pin, fromB64(rec.salt)), rec.verifier) === PIN_PROOF;
}

/** Async twin — keeps the lock screen responsive during the scrypt derivation. */
export async function checkPinRecordAsync(rec: PinRecord | null | undefined, pin: string): Promise<boolean> {
  if (!rec || rec.v !== 1 || !rec.salt || !rec.verifier) return false;
  const key = await deriveVaultKeyAsync(pin, fromB64(rec.salt));
  return open(key, rec.verifier) === PIN_PROOF;
}
