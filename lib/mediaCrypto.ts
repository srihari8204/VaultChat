// lib/mediaCrypto.ts — symmetric encryption for media payloads (E2E media).
//
// Each attachment gets a fresh random AES-256-GCM key. The file BYTES are
// encrypted before upload (server stores ciphertext only); the key + nonce
// travel to the recipient inside the per-peer E2E message envelope (never in
// plaintext meta). Pure-JS @noble so it runs under Hermes.
//
// Wire helpers operate on base64 (expo FileSystem reads/writes files as base64):
//   plaintext file  --base64-->  encryptMediaB64  -->  ciphertext base64 (upload)
//   ciphertext b64  --download-->  decryptMediaB64 -->  plaintext base64 (write file)

import 'react-native-get-random-values';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

// Key material that gets embedded (base64) in the E2E envelope.
export interface MediaKey { k: string; n: string } // key (32B), nonce (12B), both base64

export function newMediaKey(): MediaKey {
  return {
    k: Buffer.from(randomBytes(32)).toString('base64'),
    n: Buffer.from(randomBytes(12)).toString('base64'),
  };
}

// Encrypt the raw file bytes (given as base64) → ciphertext base64.
export function encryptMediaB64(fileB64: string, mk: MediaKey): string {
  const key = Buffer.from(mk.k, 'base64');
  const iv = Buffer.from(mk.n, 'base64');
  const ct = gcm(key, iv).encrypt(Buffer.from(fileB64, 'base64'));
  return Buffer.from(ct).toString('base64');
}

// Decrypt ciphertext base64 → original file bytes as base64.
export function decryptMediaB64(ctB64: string, mk: MediaKey): string {
  const key = Buffer.from(mk.k, 'base64');
  const iv = Buffer.from(mk.n, 'base64');
  const pt = gcm(key, iv).decrypt(Buffer.from(ctB64, 'base64'));
  return Buffer.from(pt).toString('base64');
}
