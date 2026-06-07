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

function keyFromPin(pin: string): Uint8Array {
  let k = keyCache.get(pin);
  if (!k) {
    k = pbkdf2(sha256, new TextEncoder().encode(pin), SALT, { c: 100000, dkLen: 32 });
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
