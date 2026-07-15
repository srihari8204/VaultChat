// lib/mediaCrypto.ts — symmetric encryption for media payloads (E2E media).
//
// Each attachment gets a fresh random AES-256-GCM key. The file BYTES are
// encrypted before upload (server stores ciphertext only); the key + nonce
// travel to the recipient inside the per-peer E2E message envelope (never in
// plaintext meta).
//
// ENGINE: react-native-quick-crypto (native, JSI) when present — this is the
// media speed fix: whole-file AES-GCM in pure JS was the dominant upload/
// download cost. Falls back to pure-JS @noble under Expo Go / missing native.
// WIRE FORMAT IS IDENTICAL either way: @noble's gcm().encrypt returns
// ciphertext with the 16-byte auth tag APPENDED, so the native path emits
// ct||tag too — old and new builds decrypt each other's media byte-for-byte.
//
// Wire helpers operate on base64 (expo FileSystem reads/writes files as base64):
//   plaintext file  --base64-->  encryptMediaB64  -->  ciphertext base64 (upload)
//   ciphertext b64  --download-->  decryptMediaB64 -->  plaintext base64 (write file)

import 'react-native-get-random-values';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

const TAG_LEN = 16;

// Native AES-256-GCM (JSI). Loaded once at module init; null under Expo Go.
let QC: any = null;
try { QC = require('react-native-quick-crypto'); if (!QC?.createCipheriv) QC = null; } catch { QC = null; }

// Key material that gets embedded (base64) in the E2E envelope.
export interface MediaKey { k: string; n: string } // key (32B), nonce (12B), both base64

export function newMediaKey(): MediaKey {
  return {
    k: Buffer.from(randomBytes(32)).toString('base64'),
    n: Buffer.from(randomBytes(12)).toString('base64'),
  };
}

// Encrypt the raw file bytes (given as base64) → ciphertext base64 (ct||tag).
export function encryptMediaB64(fileB64: string, mk: MediaKey): string {
  const key = Buffer.from(mk.k, 'base64');
  const iv = Buffer.from(mk.n, 'base64');
  const pt = Buffer.from(fileB64, 'base64');
  if (QC) {
    const cipher = QC.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
    return ct.toString('base64');
  }
  return Buffer.from(gcm(key, iv).encrypt(pt)).toString('base64');
}

// Decrypt ciphertext base64 (ct||tag) → original file bytes as base64.
export function decryptMediaB64(ctB64: string, mk: MediaKey): string {
  const key = Buffer.from(mk.k, 'base64');
  const iv = Buffer.from(mk.n, 'base64');
  const blob = Buffer.from(ctB64, 'base64');
  if (QC && blob.length > TAG_LEN) {
    const decipher = QC.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
    const pt = Buffer.concat([decipher.update(blob.subarray(0, blob.length - TAG_LEN)), decipher.final()]);
    return pt.toString('base64');   // throws on tag mismatch — same contract as @noble
  }
  return Buffer.from(gcm(key, iv).decrypt(blob)).toString('base64');
}
