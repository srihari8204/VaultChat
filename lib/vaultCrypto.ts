// lib/vaultCrypto.ts — local AES-256-GCM for the personal Vault.
//
// v1 (vaultEncrypt/vaultDecrypt): a key derived from a secret (PBKDF2-SHA256,
// 100k iterations, constant salt) — still used by lib/cloudBackup, and still
// read for Vault files added before v2. v2 (below): Vault files are sealed with
// a random key wrapped under the Device PIN. v3 (end of file): new Vault files,
// the same key, sealed in chunks so they stream from disk to disk. Pure-JS
// @noble primitives so it works under Hermes (unlike crypto.subtle);
// Node-testable (vaultCrypto.selftest.ts).

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

/** Thrown when a new file would have to be sealed without the vault key. */
export class VaultKeyMissingError extends Error {
  constructor() {
    super('The vault key is not open, so new files cannot be added. Files already in the vault are not affected.');
    this.name = 'VaultKeyMissingError';
  }
}
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

/** v2 under the DEK. Without keys (the record could not be opened) this FAILS:
 *  it used to fall back to v1, i.e. a key from the PIN over the one constant
 *  SALT above, so a missing record silently downgraded new files to the
 *  weakest format. Files already written in any format still open. */
export function vaultFileEncrypt(keys: VaultKeys | null, _pin: string, plaintext: string): VaultFilePayload {
  if (!keys) throw new VaultKeyMissingError();
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

// ─── v3: chunked, so a file is never held whole in memory (2026-10-04) ───────
//
// v1/v2 seal one base64 string, so adding or opening a file held it in JS
// memory several times over (base64, bytes, ciphertext, base64 again, JSON).
// v3 seals the raw bytes in 1 MiB chunks under the same v2 DEK, so a caller can
// stream from disk to disk holding one chunk at a time.
//
// Layout: 'VCV3' | nonce(8) | chunk_0 | … | chunk_{n-1}
//   chunk_i = AES-256-GCM(dek, iv = nonce ‖ u32be(i | LAST), aad = header)(plain_i)
// Every chunk but the last holds V3_CHUNK plaintext bytes; the last holds the
// rest (possibly 0). The LAST bit in the IV marks the final chunk, so cutting
// chunks off the end, reordering or splicing two files fails the tag check.
// v1/v2 files are JSON (they start with '{'), so the magic tells them apart.

export const V3_MAGIC = new Uint8Array([0x56, 0x43, 0x56, 0x33]);   // 'VCV3'
export const V3_HEADER_BYTES = 12;
export const V3_CHUNK = 1 << 20;
const V3_TAG = 16;
const V3_LAST = 0x80000000;

/** True when `b` (at least 4 bytes) starts a v3 file. */
export function isV3(b: Uint8Array): boolean {
  return b.length >= 4 && V3_MAGIC.every((x, i) => b[i] === x);
}

/** Chunks a `plainSize`-byte file is sealed in (an empty file is one empty chunk). */
export function v3ChunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / V3_CHUNK));
}

/** Plaintext size of a `sealedSize`-byte v3 file; throws when no v3 file has that size. */
export function v3PlainSize(sealedSize: number): number {
  const body = sealedSize - V3_HEADER_BYTES;
  const n = Math.max(1, Math.ceil(body / (V3_CHUNK + V3_TAG)));
  const plain = body - n * V3_TAG;
  if (body < V3_TAG || plain < 0 || plain > n * V3_CHUNK) throw new Error('This vault file is damaged (truncated).');
  return plain;
}

function v3Iv(header: Uint8Array, index: number, last: boolean): Uint8Array {
  if (index >= V3_LAST) throw new Error('File too large for the vault format');
  const iv = new Uint8Array(12);
  iv.set(header.subarray(4, 12), 0);
  new DataView(iv.buffer).setUint32(8, (index | (last ? V3_LAST : 0)) >>> 0);
  return iv;
}

type ReadFn = (n: number) => Uint8Array | Promise<Uint8Array>;
type WriteFn = (b: Uint8Array) => void | Promise<void>;
// Lets the UI breathe between chunks (the cipher is pure JS on the JS thread).
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Seal `plainSize` bytes pulled from `read` into a v3 file pushed to `write`.
 * `read(n)` must return exactly n bytes (fewer means the source changed under
 * us, and the seal fails rather than store a short file).
 */
export async function v3SealStream(dek: Uint8Array, plainSize: number, read: ReadFn, write: WriteFn): Promise<void> {
  const header = new Uint8Array(V3_HEADER_BYTES);
  header.set(V3_MAGIC, 0);
  header.set(randomBytes(8), 4);
  await write(header);
  const n = v3ChunkCount(plainSize);
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const want = last ? plainSize - i * V3_CHUNK : V3_CHUNK;
    const pt = await read(want);
    if (pt.length !== want) throw new Error('The file changed while it was being added. Try again.');
    await write(gcm(dek, v3Iv(header, i, last), header).encrypt(pt));
    if (!last) await yieldToUi();
  }
}

/** Open a `sealedSize`-byte v3 file pulled from `read`, pushing plaintext to `write`.
 *  Throws (after writing only authenticated chunks) on any tampering or damage. */
export async function v3OpenStream(dek: Uint8Array, sealedSize: number, read: ReadFn, write: WriteFn): Promise<void> {
  const plainSize = v3PlainSize(sealedSize);
  const header = await read(V3_HEADER_BYTES);
  if (header.length !== V3_HEADER_BYTES || !isV3(header)) throw new Error('Not a vault file');
  const n = v3ChunkCount(plainSize);
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const len = (last ? plainSize - i * V3_CHUNK : V3_CHUNK) + V3_TAG;
    const ct = await read(len);
    if (ct.length !== len) throw new Error('This vault file is damaged (truncated).');
    let pt: Uint8Array;
    try { pt = gcm(dek, v3Iv(header, i, last), header).decrypt(ct); }
    catch { throw new Error('This vault file could not be opened: it is damaged, or was sealed with another key.'); }
    await write(pt);
    if (!last) await yieldToUi();
  }
}
