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
//
// STREAMING (P3.1): encryptMediaFile/decryptMediaFile below process the file in
// 4 MB slices through the SAME cipher (GCM is CTR+GHASH — incremental by
// design), so the output is byte-identical to the whole-file helpers: ct||tag
// under the same key+nonce. Old and new builds decrypt each other's media
// unchanged — this is a memory fix, not a format change. Peak JS heap goes
// from ~4× the file size to ~one slice (~20 MB transient) regardless of file
// size, which is what un-caps encrypted media (the old path OOM'd on large
// videos). Needs quick-crypto (incremental cipher) + react-native-fs
// (positional read / append-write); callers fall back to the whole-file
// helpers when either native module is absent (Expo Go).

import 'react-native-get-random-values';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

const TAG_LEN = 16;
const SLICE = 4 * 1024 * 1024; // 4 MB plaintext per cipher.update()

// Native AES-256-GCM (JSI). Loaded once at module init; null under Expo Go.
let QC: any = null;
try { QC = require('react-native-quick-crypto'); if (!QC?.createCipheriv) QC = null; } catch { QC = null; }

// Positional file I/O for the streaming path (already an app dependency —
// lib/mediaStore.ts uses it). Guarded like QC so Expo Go degrades cleanly.
let RNFS: any = null;
try {
  RNFS = require('@dr.pogodin/react-native-fs');
  if (typeof RNFS?.read !== 'function' || typeof RNFS?.appendFile !== 'function' || typeof RNFS?.stat !== 'function') RNFS = null;
} catch { RNFS = null; }

// RNFS wants plain paths; expo FileSystem hands out file:// URIs.
const rnfsPath = (uri: string): string => uri.startsWith('file://') ? decodeURI(uri.slice(7)) : uri;

/** True when the bounded-memory streaming engine is available. */
export function canStreamMedia(): boolean { return !!(QC && RNFS); }

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

// ── Streaming file crypto (P3.1) ────────────────────────────────────────

async function fileSize(path: string): Promise<number> {
  const st = await RNFS.stat(path);
  return Number(st.size);
}

/**
 * Encrypt srcUri → dstUri in bounded memory. Output = ct||tag, byte-identical
 * to encryptMediaB64 with the same MediaKey. Returns false when the native
 * engines are missing (caller must use the whole-file path); throws on I/O or
 * crypto failure (dst is cleaned up).
 */
export async function encryptMediaFile(
  srcUri: string, dstUri: string, mk: MediaKey,
  /** 0→1 as slices are consumed, for the sender's "Preparing…" state. Purely
   *  observational — it cannot affect the ciphertext. */
  onProgress?: (frac: number) => void,
): Promise<boolean> {
  if (!canStreamMedia()) return false;
  const src = rnfsPath(srcUri), dst = rnfsPath(dstUri);
  const cipher = QC.createCipheriv('aes-256-gcm', Buffer.from(mk.k, 'base64'), Buffer.from(mk.n, 'base64'));
  try {
    const total = await fileSize(src);
    await RNFS.writeFile(dst, '', 'base64'); // create/truncate
    for (let pos = 0; pos < total; pos += SLICE) {
      const b64 = await RNFS.read(src, Math.min(SLICE, total - pos), pos, 'base64');
      const out = cipher.update(Buffer.from(b64, 'base64')) as Buffer;
      if (out.length) await RNFS.appendFile(dst, Buffer.from(out).toString('base64'), 'base64');
      if (total > 0) onProgress?.(Math.min(1, (pos + SLICE) / total));
    }
    const tail = Buffer.concat([cipher.final(), cipher.getAuthTag()]);
    await RNFS.appendFile(dst, tail.toString('base64'), 'base64');
    return true;
  } catch (e) {
    await RNFS.unlink(dst).catch(() => {});
    throw e;
  }
}

/**
 * Decrypt srcUri (ct||tag) → dstUri in bounded memory. The plaintext is
 * staged in a temp file and only moved to dstUri AFTER the GCM tag verifies —
 * unauthenticated bytes are never exposed at the destination path. Returns
 * false when the native engines are missing; throws on tag mismatch/I/O
 * failure (temp + dst cleaned up).
 */
export async function decryptMediaFile(srcUri: string, dstUri: string, mk: MediaKey): Promise<boolean> {
  if (!canStreamMedia()) return false;
  const src = rnfsPath(srcUri), dst = rnfsPath(dstUri);
  const tmp = dst + '.vctmp';
  const decipher = QC.createDecipheriv('aes-256-gcm', Buffer.from(mk.k, 'base64'), Buffer.from(mk.n, 'base64'));
  try {
    const total = await fileSize(src);
    if (total < TAG_LEN) throw new Error('ciphertext shorter than auth tag');
    const ctLen = total - TAG_LEN;
    const tagB64 = await RNFS.read(src, TAG_LEN, ctLen, 'base64');
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    await RNFS.writeFile(tmp, '', 'base64');
    for (let pos = 0; pos < ctLen; pos += SLICE) {
      const b64 = await RNFS.read(src, Math.min(SLICE, ctLen - pos), pos, 'base64');
      const out = decipher.update(Buffer.from(b64, 'base64')) as Buffer;
      if (out.length) await RNFS.appendFile(tmp, Buffer.from(out).toString('base64'), 'base64');
    }
    decipher.final(); // throws on tag mismatch — tmp is discarded below
    await RNFS.unlink(dst).catch(() => {});
    await RNFS.moveFile(tmp, dst);
    return true;
  } catch (e) {
    await RNFS.unlink(tmp).catch(() => {});
    throw e;
  }
}
