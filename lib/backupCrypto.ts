// lib/backupCrypto.ts — key material for END-TO-END ENCRYPTED chat backups.
//
// The default backup key is account-managed: the server generates it, stores it
// (user_backup_keys.dek) and hands it to any authenticated session. That is
// WhatsApp's default too, and it is what makes recovery work with nothing for
// the user to remember — but it also means the server can read any backup.
//
// This module is the opt-in upgrade that takes the server out of the loop. Two
// modes, mirroring WhatsApp's:
//
//   'password' — the user picks one; the key is PBKDF2-derived from it plus a
//                per-user random salt. Memorable, and nothing is stored anywhere
//                that can be used without it.
//   'key'      — a generated 64-hex-digit recovery key, shown once. 256 bits of
//                real entropy, so it is not guessable at any budget.
//
// WHAT THIS IS AND IS NOT
//
// There is NO key escrow here, and that is deliberate. WhatsApp can offer
// "password only, nothing to write down" because its Backup Key Vault holds the
// key in an HSM that hard-limits guesses. Without that hardware, escrowing a
// password-wrapped key on the server would mean an offline brute-force of a
// human-chosen password with no rate limit anywhere — a weaker guarantee than
// the one the UI would be claiming. So the secret exists only in the user's head
// (password) or in their hands (recovery key), and a forgotten one is
// unrecoverable BY DESIGN. The setup screen has to say so plainly.
//
// The cost of that honesty is the reason this is opt-in and the account-managed
// key remains the default: a user who wants recovery without a secret to keep
// should have it, and a user who wants the provider locked out should be told
// exactly what they are taking on.
//
// ENVELOPE
//
// A backup blob is `{v,iv,ct}` (lib/vaultCrypto's VaultPayload). E2EE blobs add
// ONE field, `vcE2EE`, carrying the non-secret parameters needed to re-derive:
//
//   {"v":1,"iv":"…","ct":"…","vcE2EE":{"mode":"password","kdf":"pbkdf2-sha256",
//                                      "iter":210000,"salt":"…"}}
//
// Additive on purpose. vaultDecrypt reads only iv/ct, so an older build ignores
// the field, and a blob written WITHOUT it is unambiguously account-managed —
// which is exactly how a restore knows whether to ask for a secret. No schema
// change, no migration, and no server involvement: the blob is opaque to it.

import 'react-native-get-random-values';
import { randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';
import { pbkdf2Bytes, pbkdf2BytesAsync } from './vaultCrypto';

/** OWASP's floor for PBKDF2-HMAC-SHA256. Recorded per-blob so it can be raised
 *  later without stranding backups written at the old cost. */
export const KDF_ITERATIONS = 210_000;

export type BackupMode = 'password' | 'key';

export interface E2EEHeader {
  mode: BackupMode;
  kdf:  'pbkdf2-sha256';
  iter: number;
  salt: string;   // base64; absent-but-present as '' for 'key' mode (no KDF)
  /**
   * 'key' mode only: recoveryKeyId() of the key the blob is under. Every key
   * header has salt '', so without this a device that made a new key could not
   * tell an older copy from a current one, and fed it the wrong key. Absent on
   * key-mode blobs written before 2026-10-04.
   */
  kid?: string;
}

/** The parsed header of a blob, or null when it is an account-managed backup. */
export function readE2EEHeader(blob: string): E2EEHeader | null {
  try {
    const h = JSON.parse(blob)?.vcE2EE;
    if (!h || (h.mode !== 'password' && h.mode !== 'key')) return null;
    return h as E2EEHeader;
  } catch { return null; }
}

/** Stamp a header onto an encrypted payload. Returns the blob to store. */
export function stampE2EEHeader(payload: object, header: E2EEHeader): string {
  return JSON.stringify({ ...payload, vcE2EE: header });
}

export function newSalt(): string {
  return Buffer.from(randomBytes(16)).toString('base64');
}

/**
 * A 64-hex-digit recovery key, WhatsApp's format. 32 bytes of CSPRNG output —
 * this is the key itself, not a password for one, so there is no KDF to run and
 * nothing to strengthen.
 */
export function generateRecoveryKey(): string {
  return Buffer.from(randomBytes(32)).toString('hex');
}

/** Group into 4-char blocks for display/transcription. Never used as input. */
export function formatRecoveryKey(hex: string): string {
  return (hex.match(/.{1,4}/g) ?? []).join(' ');
}

/** Accepts the key with or without the display spacing. */
export function normalizeRecoveryKey(input: string): string {
  return input.replace(/\s+/g, '').toLowerCase();
}

export function isValidRecoveryKey(input: string): boolean {
  return /^[0-9a-f]{64}$/.test(normalizeRecoveryKey(input));
}

/**
 * The secret handed to vaultEncrypt/vaultDecrypt for this backup.
 *
 * 'key' mode passes the recovery key straight through: vaultCrypto runs its own
 * PBKDF2 over it, and with 256 bits of input entropy the fixed salt there buys
 * an attacker nothing. 'password' mode derives first, against a per-user salt —
 * without one, a single rainbow table would cover every user of the app at once.
 */
export function backupSecret(header: E2EEHeader, userSecret: string): string {
  if (header.mode === 'key') {
    const k = normalizeRecoveryKey(userSecret);
    if (!isValidRecoveryKey(k)) throw new Error('That recovery key is not valid.');
    return k;
  }
  const salt = new Uint8Array(Buffer.from(header.salt, 'base64'));
  return Buffer.from(pbkdf2Bytes(userSecret, salt, header.iter)).toString('base64');
}

/** backupSecret without holding the JS thread for the password KDF. */
export async function backupSecretAsync(header: E2EEHeader, userSecret: string): Promise<string> {
  if (header.mode === 'key') return backupSecret(header, userSecret);
  const salt = new Uint8Array(Buffer.from(header.salt, 'base64'));
  return Buffer.from(await pbkdf2BytesAsync(userSecret, salt, header.iter)).toString('base64');
}

/**
 * A short, non-secret id for a recovery key: 8 bytes of SHA-256 over a
 * domain-separated copy of it. It names which key a blob needs; with 256 bits
 * of key entropy behind it, it tells an attacker nothing about the key.
 */
export function recoveryKeyId(key: string): string {
  const k = normalizeRecoveryKey(key);
  return Buffer.from(sha256(new TextEncoder().encode(`vc-backup-kid:${k}`)).slice(0, 8)).toString('hex');
}

/** Header for a NEW e2ee backup in the given mode ('key' mode: pass the key, for its id). */
export function newHeader(mode: BackupMode, recoveryKey?: string): E2EEHeader {
  const h: E2EEHeader = { mode, kdf: 'pbkdf2-sha256', iter: KDF_ITERATIONS, salt: mode === 'password' ? newSalt() : '' };
  if (mode === 'key' && recoveryKey) h.kid = recoveryKeyId(recoveryKey);
  return h;
}

/**
 * Can the secret stored under `held` open a blob stamped `blob`? False means
 * "certainly not — ask the user". True for a key-mode blob without a key id
 * (written before ids existed): the caller tries it and asks if it fails.
 */
export function heldSecretMayOpen(held: E2EEHeader, blob: E2EEHeader): boolean {
  if (held.mode !== blob.mode) return false;
  if (blob.mode === 'password') return held.salt === blob.salt;
  return !blob.kid || !held.kid || held.kid === blob.kid;
}

/**
 * Minimum password strength. Deliberately blunt: there is no server-side attempt
 * limiting behind this (see the header), so the password's own entropy is the
 * whole defence against someone who has taken a copy of the blob.
 */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number.';
  return null;
}

export default {};
