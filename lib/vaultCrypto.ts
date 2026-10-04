// lib/vaultCrypto.ts — local AES-256-GCM for the personal Vault.
//
// v1 (vaultEncrypt/vaultDecrypt): a key derived from a secret (PBKDF2-SHA256,
// 100k iterations, constant salt) — still used by lib/cloudBackup, and still
// read for Vault files added before v2. v2 (below): Vault files are sealed with
// a random key wrapped under the Device PIN. v3/v4 (end of file): new Vault
// files, the same key, sealed in chunks so they stream from disk to disk, and
// (v4) bound to their file id. Pure-JS
// @noble primitives so it works under Hermes (unlike crypto.subtle);
// Node-testable (vaultCrypto.selftest.ts). The v3/v4 chunk cipher uses native
// AES-256-GCM (react-native-quick-crypto → OpenSSL) when it is present and
// passes a known-answer check against @noble; the bytes are identical either
// way (vaultCryptoNative.selftest.ts).

import 'react-native-get-random-values';
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2, pbkdf2Async } from '@noble/hashes/pbkdf2.js';
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

/**
 * pbkdf2Bytes without holding the JS thread: quick-crypto's async pbkdf2 (runs
 * off the JS thread) when present, else @noble's pbkdf2Async (yields to the
 * event loop between rounds). Same bytes as pbkdf2Bytes for the same inputs.
 */
export async function pbkdf2BytesAsync(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const pw = new TextEncoder().encode(password);
  if (typeof QC?.pbkdf2 === 'function') {
    try {
      const dk: any = await new Promise((resolve, reject) => QC.pbkdf2(Buffer.from(pw), Buffer.from(salt), iterations, 32, 'sha256',
        (err: Error | null, key?: unknown) => (err || !key ? reject(err ?? new Error('pbkdf2 failed')) : resolve(key))));
      return new Uint8Array(dk.buffer ? dk : Buffer.from(dk));
    } catch { /* fall through to JS */ }
  }
  return pbkdf2Async(sha256, pw, salt, { c: iterations, dkLen: 32 });
}

/** Derive (and cache) the v1 key without blocking, so the sync calls below find it. */
async function warmKeyFromPin(pin: string): Promise<void> {
  if (!keyCache.has(pin)) keyCache.set(pin, await pbkdf2BytesAsync(pin, SALT, 100000));
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

/** vaultEncrypt, with the key derived off the UI's critical path. */
export async function vaultEncryptAsync(pin: string, plaintext: string): Promise<VaultPayload> {
  await warmKeyFromPin(pin);
  return vaultEncrypt(pin, plaintext);
}

/** vaultDecrypt, with the key derived off the UI's critical path. */
export async function vaultDecryptAsync(pin: string, p: VaultPayload): Promise<string> {
  await warmKeyFromPin(pin);
  return vaultDecrypt(pin, p);
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

/** An error whose message was written for the person using the vault, so a
 *  screen may show it as is. Anything else (a library's, the OS's or a
 *  keystore's own text) is replaced by the screen's fixed copy. */
export class VaultCopyError extends Error {
  constructor(message: string) { super(message); this.name = 'VaultCopyError'; }
}
/** What a vault screen shows for `e`: its own copy, else `fallback`. */
export function vaultErrorText(e: unknown, fallback: string): string {
  return e instanceof VaultCopyError ? e.message : fallback;
}

/** Thrown when a new file would have to be sealed without the vault key. */
export class VaultKeyMissingError extends VaultCopyError {
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

function wrapVaultKeys(wrapKey: Uint8Array, salt: Uint8Array, keys: VaultKeys): VaultKeyRecord {
  const iv = randomBytes(12);
  const body = new Uint8Array(64);
  body.set(keys.dek, 0);
  body.set(keys.legacy, 32);
  const ct = gcm(wrapKey, iv).encrypt(body);
  return { v: 2, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export function sealVaultKeys(pin: string, keys: VaultKeys): VaultKeyRecord {
  const salt = randomBytes(16);
  return wrapVaultKeys(pbkdf2Bytes(pin, salt, WRAP_ITERATIONS), salt, keys);
}

/** sealVaultKeys with the PIN derivation off the JS thread (lib/vaultKeyStore uses this). */
export async function sealVaultKeysAsync(pin: string, keys: VaultKeys): Promise<VaultKeyRecord> {
  const salt = randomBytes(16);
  return wrapVaultKeys(await pbkdf2BytesAsync(pin, salt, WRAP_ITERATIONS), salt, keys);
}

const isRecord = (rec: VaultKeyRecord | null | undefined): rec is VaultKeyRecord =>
  !!rec && rec.v === 2 && !!rec.salt && !!rec.iv && !!rec.ct;

function unwrapVaultKeys(wrapKey: Uint8Array, rec: VaultKeyRecord): VaultKeys | null {
  try {
    const body = gcm(wrapKey, unb64(rec.iv)).decrypt(unb64(rec.ct));
    if (body.length !== 64) return null;
    return { dek: body.slice(0, 32), legacy: body.slice(32, 64) };
  } catch {
    return null;   // GCM tag mismatch: wrong PIN (or a damaged record)
  }
}

/** The keys in `rec`, or null when `pin` is not the PIN it was sealed under. */
export function openVaultKeys(pin: string, rec: VaultKeyRecord | null | undefined): VaultKeys | null {
  if (!isRecord(rec)) return null;
  try { return unwrapVaultKeys(pbkdf2Bytes(pin, unb64(rec.salt), WRAP_ITERATIONS), rec); } catch { return null; }
}

/** openVaultKeys with the PIN derivation off the JS thread: an unlock runs one
 *  per archived key, which held the UI on the JS fallback (lib/vaultKeyStore uses this). */
export async function openVaultKeysAsync(pin: string, rec: VaultKeyRecord | null | undefined): Promise<VaultKeys | null> {
  if (!isRecord(rec)) return null;
  try { return unwrapVaultKeys(await pbkdf2BytesAsync(pin, unb64(rec.salt), WRAP_ITERATIONS), rec); } catch { return null; }
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

/** Opens either format. Throws when no key this install holds can open it.
 *  `older` are archived keys an old PIN recovered (lib/vaultKeyStore): they
 *  are tried after the current key, only for reading. */
export function vaultFileDecrypt(keys: VaultKeys | null, pin: string, p: VaultFilePayload | VaultPayload, older: VaultKeys[] = []): string {
  const open = (key: Uint8Array) => new TextDecoder().decode(gcm(key, unb64(p.iv)).decrypt(unb64(p.ct)));
  const ring = keys ? [keys, ...older] : older;
  if (p.v === 2) {
    if (!ring.length) throw new VaultCopyError('The vault key could not be opened with this PIN.');
    for (const k of ring) {
      try { return open(k.dek); } catch { /* next */ }
    }
    throw new VaultCopyError('This file was sealed with another vault key. If you used a different PIN before, try it with "Try an old PIN".');
  }
  // v1: sealed under whatever PIN was set when it was added. Lazy, so the
  // 100k-iteration derivation of the PIN just entered only runs when the
  // carried legacy keys miss.
  const candidates: (() => Uint8Array)[] = [...ring.map((k) => () => k.legacy), () => keyFromPin(pin)];
  for (const k of candidates) {
    try { return open(k()); } catch { /* next */ }
  }
  throw new VaultCopyError('This file was added under an earlier PIN and cannot be opened with this one.');
}

// ─── v3/v4: chunked, so a file is never held whole in memory (2026-10-04) ────
//
// v1/v2 seal one base64 string, so adding or opening a file held it in JS
// memory several times over (base64, bytes, ciphertext, base64 again, JSON).
// v3 seals the raw bytes in 1 MiB chunks under the same v2 DEK, so a caller can
// stream from disk to disk holding one chunk at a time.
//
// Layout: MAGIC | nonce(8) | chunk_0 | … | chunk_{n-1}
//   chunk_i = AES-256-GCM(dek, iv = nonce ‖ u32be(i | LAST), aad)(plain_i)
//   'VCV3' (round 4): aad = header
//   'VCV4' (every file sealed from round 5 on): aad = header ‖ utf8(fileId),
//     so a .enc file only opens under the manifest entry it was sealed for —
//     swapping two files' bytes on disk makes both fail the tag check.
// Every chunk but the last holds V3_CHUNK plaintext bytes; the last holds the
// rest (possibly 0). The LAST bit in the IV marks the final chunk, so cutting
// chunks off the end, reordering or splicing two files fails the tag check.
// v1/v2 files are JSON (they start with '{'), so the magic tells them apart.
// VCV3 files are only read, never written again.

export const V3_MAGIC = new Uint8Array([0x56, 0x43, 0x56, 0x33]);   // 'VCV3'
export const V4_MAGIC = new Uint8Array([0x56, 0x43, 0x56, 0x34]);   // 'VCV4'
export const V3_HEADER_BYTES = 12;
export const V3_CHUNK = 1 << 20;
const V3_TAG = 16;
const V3_LAST = 0x80000000;

const startsWith = (b: Uint8Array, m: Uint8Array) => b.length >= m.length && m.every((x, i) => b[i] === x);

/** True when `b` (at least 4 bytes) starts a chunked (v3 or v4) file. */
export function isV3(b: Uint8Array): boolean {
  return startsWith(b, V3_MAGIC) || startsWith(b, V4_MAGIC);
}

/** Chunks a `plainSize`-byte file is sealed in (an empty file is one empty chunk). */
export function v3ChunkCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / V3_CHUNK));
}

/** Size on disk of a chunked file holding `plainSize` bytes. */
export function v3SealedSize(plainSize: number): number {
  return V3_HEADER_BYTES + plainSize + V3_TAG * v3ChunkCount(plainSize);
}

/** Plaintext size of a `sealedSize`-byte v3 file; throws when no v3 file has that size. */
export function v3PlainSize(sealedSize: number): number {
  const body = sealedSize - V3_HEADER_BYTES;
  const n = Math.max(1, Math.ceil(body / (V3_CHUNK + V3_TAG)));
  const plain = body - n * V3_TAG;
  if (body < V3_TAG || plain < 0 || plain > n * V3_CHUNK) throw new VaultCopyError('This vault file is damaged (truncated).');
  return plain;
}

function v3Iv(header: Uint8Array, index: number, last: boolean): Uint8Array {
  if (index >= V3_LAST) throw new VaultCopyError('File too large for the vault format');
  const iv = new Uint8Array(12);
  iv.set(header.subarray(4, 12), 0);
  new DataView(iv.buffer).setUint32(8, (index | (last ? V3_LAST : 0)) >>> 0);
  return iv;
}

/** The AAD for a header: VCV3 binds only the header, VCV4 also the file id. */
function v3Aad(header: Uint8Array, fileId: string): Uint8Array {
  if (startsWith(header, V3_MAGIC)) return header;
  if (!fileId) throw new Error('The vault file id is missing.');
  const id = new TextEncoder().encode(fileId);
  const aad = new Uint8Array(header.length + id.length);
  aad.set(header, 0);
  aad.set(id, header.length);
  return aad;
}

// ─── The chunk cipher: native AES-256-GCM when present, @noble otherwise ─────
//
// @noble's AES-GCM is pure JS on the JS thread: a large video took long enough
// to seal or open that the UI stalled between chunks. OpenSSL (through
// react-native-quick-crypto's createCipheriv) does the same AES-256-GCM —
// same 12-byte IV, same AAD, 16-byte tag appended — so a file sealed by one
// opens with the other and the format does not change. The native path is
// used only after it reproduces @noble's output on a fixed vector (a build
// whose native module is missing or misbehaves keeps using @noble).

/** Seals or opens one chunk: `seal` returns ct ‖ tag(16); `open` throws on a bad tag. */
export interface ChunkCipher {
  name: 'native' | 'js';
  seal(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array): Uint8Array;
  open(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, ctTag: Uint8Array): Uint8Array;
}

export const jsChunkCipher: ChunkCipher = {
  name: 'js',
  seal: (key, iv, aad, pt) => gcm(key, iv, aad).encrypt(pt),
  open: (key, iv, aad, ct) => gcm(key, iv, aad).decrypt(ct),
};

/** The subset of Node's crypto API (react-native-quick-crypto mirrors it) used here. */
interface GcmLib {
  createCipheriv(alg: string, key: Uint8Array, iv: Uint8Array): {
    setAAD(b: Uint8Array): unknown; update(b: Uint8Array): Uint8Array; final(): Uint8Array; getAuthTag(): Uint8Array;
  };
  createDecipheriv(alg: string, key: Uint8Array, iv: Uint8Array): {
    setAAD(b: Uint8Array): unknown; setAuthTag(b: Uint8Array): unknown; update(b: Uint8Array): Uint8Array; final(): Uint8Array;
  };
}

// quick-crypto's setAAD hands `buffer.buffer` (the WHOLE backing store) to
// native, so the AAD must sit in a buffer of exactly its own length.
const exactBuffer = (b: Uint8Array) => { const c = new Uint8Array(b.length); c.set(b); return Buffer.from(c.buffer); };
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const EMPTY = new Uint8Array(0);

/** A ChunkCipher over a Node-style crypto library (quick-crypto on a phone, node:crypto in tests). */
export function nodeStyleChunkCipher(lib: GcmLib): ChunkCipher {
  return {
    name: 'native',
    seal(key, iv, aad, pt) {
      const c = lib.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(exactBuffer(aad));
      const body = pt.length ? c.update(pt) : EMPTY;
      return join(body, c.final(), c.getAuthTag());
    },
    open(key, iv, aad, ct) {
      if (ct.length < V3_TAG) throw new Error('chunk too short');
      const d = lib.createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(exactBuffer(aad));
      d.setAuthTag(ct.slice(ct.length - V3_TAG));
      const body = ct.length > V3_TAG ? d.update(ct.subarray(0, ct.length - V3_TAG)) : EMPTY;
      return join(body, d.final());   // final() throws when the tag does not match
    },
  };
}

/** `candidate` if it matches @noble on fixed vectors (both ways, a wrong tag
 *  rejected), else null. Any throw — a missing native module — is a no. The
 *  last vector is one full 1 MiB chunk, the size every real seal uses, so a
 *  fault that shows only on large buffers is caught here and not when the
 *  file is next opened (rerate7/J flaw 4). chunkCipher() runs this once per
 *  app session and keeps the answer. */
export function verifiedChunkCipher(candidate: ChunkCipher): ChunkCipher | null {
  try {
    const key = new Uint8Array(32).map((_, i) => i * 7 + 1);
    const iv = new Uint8Array(12).map((_, i) => 0xa0 + i);
    const aad = join(V4_MAGIC, iv.subarray(0, 8), new TextEncoder().encode('kat-file-id'));
    for (const len of [0, 1, 33, V3_CHUNK]) {
      const pt = new Uint8Array(len);
      for (let i = 0; i < len; i++) pt[i] = (i * 31 + 5 + (i >>> 8)) & 0xff;
      const want = jsChunkCipher.seal(key, iv, aad, pt);
      const got = candidate.seal(key, iv, aad, pt);
      if (!sameBytes(got, want)) return null;
      if (!sameBytes(candidate.open(key, iv, aad, want), pt)) return null;
      const bad = want.slice(); bad[bad.length - 1] ^= 1;
      let rejected = false;
      try { candidate.open(key, iv, aad, bad); } catch { rejected = true; }
      if (!rejected) return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let chosenCipher: ChunkCipher | null = null;
/** The chunk cipher this build uses: native when verified, else @noble.
 *  Decided on first use and kept for the session (the check above seals 1 MiB
 *  once with @noble, which takes a moment on a phone). */
export function chunkCipher(): ChunkCipher {
  if (!chosenCipher) {
    const native = typeof QC?.createCipheriv === 'function' && typeof QC?.createDecipheriv === 'function'
      ? verifiedChunkCipher(nodeStyleChunkCipher(QC as GcmLib)) : null;
    chosenCipher = native ?? jsChunkCipher;
  }
  return chosenCipher;
}

/** Thrown when the caller cancelled a seal or open (no partial output is kept). */
export class VaultCancelledError extends Error {
  constructor() { super('Cancelled.'); this.name = 'VaultCancelledError'; }
}

type ReadFn = (n: number) => Uint8Array | Promise<Uint8Array>;
type WriteFn = (b: Uint8Array) => void | Promise<void>;
/** `onProgress(done, total)` after each chunk; `cancelled()` is checked before each one.
 *  `cipher` overrides chunkCipher() (the speed test and the selftests compare the two). */
export interface V3StreamOptions { onProgress?: (done: number, total: number) => void; cancelled?: () => boolean; cipher?: ChunkCipher }
// Lets the UI breathe between chunks (both ciphers run on the JS thread; the
// native one is just much faster).
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Seal `plainSize` bytes pulled from `read` into a VCV4 file pushed to `write`,
 * bound to `fileId` (the id the manifest will list it under).
 * `read(n)` must return exactly n bytes (fewer means the source changed under
 * us, and the seal fails rather than store a short file).
 */
export async function v3SealStream(
  dek: Uint8Array, plainSize: number, read: ReadFn, write: WriteFn, fileId: string, opts: V3StreamOptions = {},
): Promise<void> {
  const header = new Uint8Array(V3_HEADER_BYTES);
  header.set(V4_MAGIC, 0);
  header.set(randomBytes(8), 4);
  const aad = v3Aad(header, fileId);
  const cipher = opts.cipher ?? chunkCipher();
  await write(header);
  const n = v3ChunkCount(plainSize);
  for (let i = 0; i < n; i++) {
    if (opts.cancelled?.()) throw new VaultCancelledError();
    const last = i === n - 1;
    const want = last ? plainSize - i * V3_CHUNK : V3_CHUNK;
    const pt = await read(want);
    if (pt.length !== want) throw new VaultCopyError('The file changed while it was being added. Try again.');
    await write(cipher.seal(dek, v3Iv(header, i, last), aad, pt));
    opts.onProgress?.(i + 1, n);
    if (!last) await yieldToUi();
  }
}

/**
 * Open a `sealedSize`-byte v3/v4 file pulled from `read`, pushing plaintext to
 * `write`. `deks` are tried in order on the first chunk (the current key, then
 * archived ones), and the one that opens it is used for the rest. `fileId` must
 * be the id a VCV4 file was sealed for. Throws (after writing only
 * authenticated chunks) on any tampering or damage.
 */
export async function v3OpenStream(
  deks: Uint8Array[], sealedSize: number, read: ReadFn, write: WriteFn, fileId: string, opts: V3StreamOptions = {},
): Promise<void> {
  const plainSize = v3PlainSize(sealedSize);
  const header = await read(V3_HEADER_BYTES);
  if (header.length !== V3_HEADER_BYTES || !isV3(header)) throw new VaultCopyError('Not a vault file');
  const aad = v3Aad(header, fileId);
  const n = v3ChunkCount(plainSize);
  const cipher = opts.cipher ?? chunkCipher();
  let dek: Uint8Array | null = null;
  for (let i = 0; i < n; i++) {
    if (opts.cancelled?.()) throw new VaultCancelledError();
    const last = i === n - 1;
    const len = (last ? plainSize - i * V3_CHUNK : V3_CHUNK) + V3_TAG;
    const ct = await read(len);
    if (ct.length !== len) throw new VaultCopyError('This vault file is damaged (truncated).');
    const iv = v3Iv(header, i, last);
    let pt: Uint8Array | null = null;
    for (const k of dek ? [dek] : deks) {
      try { pt = cipher.open(k, iv, aad, ct); dek = k; break; } catch { /* next key */ }
    }
    if (!pt) {
      throw new VaultCopyError(i === 0
        ? 'This vault file could not be opened: it is damaged, was moved from another entry, or was sealed with another key.'
        : 'This vault file is damaged and could not be opened.');
    }
    await write(pt);
    opts.onProgress?.(i + 1, n);
    if (!last) await yieldToUi();
  }
}
