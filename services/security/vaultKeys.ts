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

// scrypt parameters. N=2^14 is memory-hard enough to slow brute force of a
// short PIN meaningfully while staying ~sub-300ms on low-end Android. Tunable.
export const KDF_PARAMS = { N: 1 << 14, r: 8, p: 1, dkLen: 32 } as const;

/** Derive a 32-byte vault key from a PIN + salt (memory-hard, deterministic). */
export function deriveVaultKey(pin: string, salt: Uint8Array): Uint8Array {
  return scrypt(TE.encode(pin), salt, {
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, dkLen: KDF_PARAMS.dkLen,
  });
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

function safeParse(s: string): Record<string, any> {
  try { return JSON.parse(s); } catch { return {}; }
}
