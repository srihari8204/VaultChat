// services/crypto/vaultbeam-vectors.selftest.ts — VaultBeam wire-contract golden
// vectors (Phase 3, Step 0). Freezes the EXACT chunk crypto + on-wire layout the
// Kotlin VaultBeamStream produces today, so the Rust vaultbeam-core must
// reproduce them byte-for-byte. This is the cross-version interop contract.
//
// Check (CI):  npm run test:vaultbeam:vectors
// Regenerate:  npx tsx services/crypto/vaultbeam-vectors.selftest.ts --write
//   (ONLY when a wire-format change is intentional — the JSON diff is the review)
//
// The committed services/crypto/__vectors__/vaultbeam.json is the golden copy.
// vaultbeam-core's Rust unit tests read the SAME file; this script guards the
// JS/spec oracle against drift. The Kotlin↔vectors cross-check runs on-device in
// the Step 5 interop gate (no JVM in Node CI).
//
// WHY SMALL SIZES: nonce/AAD/chunk-identity/block-layout are all SCALE-INVARIANT
// (they depend on geometry, not on the 512 KiB chunk size). 16-byte chunks
// exercise the identical code path as production while keeping the vector JSON
// tiny and reviewable. Real 512 KiB only matters for throughput (Step 5).
//
// Source of truth mirrored here — plugins/android/VaultBeamStreamModule.kt:
//   nonce = 4B(transferId UTF-8 prefix, zero-padded) ‖ u64_be(chunkId)   [12B]
//   aad   = "<transferId>|<fileId>|<chunkId>"  (UTF-8)
//   wire  = ciphertext ‖ 16B GCM tag           (AES-256-GCM, 128-bit tag)
//   chunkId = plaintext byte offset (segmented/offset scheme)
//             OR blockIndex*chunksPerBlock + i (uniform R2) == global chunk index (P2/LAN)
//   block wire = concat of each chunk's (ct‖tag), tail chunk = min(chunkBytes, total-offset)
//   LAN frame  = [i32_be index][i32_be ctLen][ct‖tag] per chunk, index/ctLen big-endian

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';
import * as crypto from 'node:crypto';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__vectors__');
const FILE = path.join(DIR, 'vaultbeam.json');
const hex = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('hex');

// ── the oracle: EXACTLY the Kotlin derivation (must not diverge) ─────────────

// nonce = 4B transferId UTF-8 prefix (zero-padded to 4) ‖ u64 big-endian chunkId.
function chunkNonce(transferId: string, chunkId: number): Buffer {
  const n = Buffer.alloc(12);
  const tb = Buffer.from(transferId, 'utf8');
  tb.copy(n, 0, 0, Math.min(4, tb.length));
  n.writeBigUInt64BE(BigInt(chunkId), 4);
  return n;
}

function seal(keyBytes: Buffer, transferId: string, fileId: string, chunkId: number, plain: Buffer): Buffer {
  const aad = Buffer.from(`${transferId}|${fileId}|${chunkId}`, 'utf8');
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes, chunkNonce(transferId, chunkId), { authTagLength: 16 });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]); // ct ‖ 16B tag (matches Java doFinal)
}

// Deterministic "file" content so vectors are reproducible + sha256 is fixed.
function fileBytes(len: number): Buffer {
  const b = Buffer.alloc(len);
  for (let o = 0; o < len; o++) b[o] = (o * 31 + 7) & 0xff;
  return b;
}

// ── fixed inputs ─────────────────────────────────────────────────────────────

const KEY = crypto.createHash('sha256').update('vaultbeam-vectors-key-v1').digest(); // 32B
const FILE_LEN = 100;
const DATA = fileBytes(FILE_LEN);
const chunkBytes = 16;
const blockBytes = 64; // chunksPerBlock = 4
const chunksPerBlock = blockBytes / chunkBytes;

// A representative 16-char transferId, a <4-byte one (zero-pad path), and a
// >4-byte one whose 5th+ bytes must NOT enter the nonce (prefix truncation).
const TID = 'TQF9k2mZ7pXaLdRb';
const TID_SHORT = 'ab';           // 2 bytes → nonce prefix = 61 62 00 00
const TID_LONG = 'ZZZZ-tail-ignored';
const FID = 'file-9d3c1f';

// ── single-chunk seal cases (nonce/aad/wire pinned) ──────────────────────────

interface ChunkCase {
  name: string; transferId: string; fileId: string; chunkId: number;
  plaintextHex: string; nonceHex: string; aad: string; wireHex: string;
}
function chunkCase(name: string, transferId: string, fileId: string, chunkId: number, plain: Buffer): ChunkCase {
  return {
    name, transferId, fileId, chunkId, plaintextHex: hex(plain),
    nonceHex: hex(chunkNonce(transferId, chunkId)),
    aad: `${transferId}|${fileId}|${chunkId}`,
    wireHex: hex(seal(KEY, transferId, fileId, chunkId, plain)),
  };
}

const chunkCases: ChunkCase[] = [
  chunkCase('uniform id=0', TID, FID, 0, DATA.subarray(0, 16)),
  chunkCase('uniform id=1', TID, FID, 1, DATA.subarray(16, 32)),
  chunkCase('offset id=64 (segmented)', TID, FID, 64, DATA.subarray(64, 80)),
  chunkCase('partial tail (2 bytes)', TID, FID, 6, DATA.subarray(96, 100)),
  chunkCase('short transferId zero-pads nonce prefix', TID_SHORT, FID, 3, DATA.subarray(48, 64)),
  chunkCase('long transferId truncated to 4B prefix', TID_LONG, FID, 3, DATA.subarray(48, 64)),
  chunkCase('id > 2^32 exercises u64 nonce', TID, FID, 0x100000002, DATA.subarray(0, 16)),
  chunkCase('empty plaintext (tag-only wire)', TID, FID, 9, Buffer.alloc(0)),
];

// ── block layout cases (concat of chunk wires, partial tail, both schemes) ───

interface BlockCase {
  name: string; transferId: string; fileId: string; blockIndex: number;
  chunkBytes: number; blockBytes: number; totalBytes: number;
  offsetScheme: boolean; blockPlainOffset?: number;
  chunkIds: number[]; wireHex: string;
}
function blockCase(
  name: string, transferId: string, fileId: string, blockIndex: number,
  totalBytes: number, offsetScheme: boolean,
): BlockCase {
  const firstChunk = blockIndex * chunksPerBlock;
  const blockPlainOffset = offsetScheme
    ? blockIndex * blockBytes  // segmented supplies it explicitly; here it equals the uniform offset for a single-geometry file
    : blockIndex * blockBytes;
  const ids: number[] = [];
  const parts: Buffer[] = [];
  for (let i = 0; i < chunksPerBlock; i++) {
    const plainOffset = blockPlainOffset + i * chunkBytes;
    if (plainOffset >= totalBytes) break;
    const id = offsetScheme ? plainOffset : firstChunk + i;
    const plainLen = Math.min(chunkBytes, totalBytes - plainOffset);
    ids.push(id);
    parts.push(seal(KEY, transferId, fileId, id, DATA.subarray(plainOffset, plainOffset + plainLen)));
  }
  const c: BlockCase = {
    name, transferId, fileId, blockIndex, chunkBytes, blockBytes, totalBytes,
    offsetScheme, chunkIds: ids, wireHex: hex(Buffer.concat(parts)),
  };
  if (offsetScheme) c.blockPlainOffset = blockPlainOffset;
  return c;
}

const blockCases: BlockCase[] = [
  blockCase('block0 uniform, 4 full chunks (total 100)', TID, FID, 0, FILE_LEN, false),
  blockCase('block1 uniform, non-zero firstChunk + partial tail', TID, FID, 1, FILE_LEN, false),
  blockCase('block1 offset-scheme (id = plaintext offset)', TID, FID, 1, FILE_LEN, true),
];

// ── LAN frame case: [i32_be idx][i32_be ctLen][ct‖tag] per chunk ─────────────

function lanFrames(transferId: string, fileId: string, totalBytes: number): { chunkCount: number; framesHex: string } {
  const chunkCount = Math.ceil(totalBytes / chunkBytes);
  const parts: Buffer[] = [];
  for (let g = 0; g < chunkCount; g++) {
    const plainOffset = g * chunkBytes;
    const plainLen = Math.min(chunkBytes, totalBytes - plainOffset);
    const ct = seal(KEY, transferId, fileId, g, DATA.subarray(plainOffset, plainOffset + plainLen));
    const hdr = Buffer.alloc(8);
    hdr.writeInt32BE(g, 0);
    hdr.writeInt32BE(ct.length, 4);
    parts.push(hdr, ct);
  }
  return { chunkCount, framesHex: hex(Buffer.concat(parts)) };
}

// ── build the golden object ──────────────────────────────────────────────────

function build() {
  return {
    _comment: 'VaultBeam wire-contract golden vectors — see vaultbeam-vectors.selftest.ts. Regenerate ONLY on an intentional wire-format change.',
    inputs: { keyHex: hex(KEY), chunkBytes, blockBytes, fileLen: FILE_LEN, fileDataHex: hex(DATA) },
    chunks: chunkCases,
    blocks: blockCases,
    lan: { transferId: TID, fileId: FID, totalBytes: FILE_LEN, ...lanFrames(TID, FID, FILE_LEN) },
    sha256: { dataHex: hex(DATA), hex: crypto.createHash('sha256').update(DATA).digest('hex') },
  };
}

// ── write / check ────────────────────────────────────────────────────────────

const WRITE = process.argv.includes('--write');
const golden = build();

if (WRITE) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(golden, null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), FILE)} (${chunkCases.length} chunk, ${blockCases.length} block, 1 LAN, 1 sha256 vectors)`);
} else {
  if (!fs.existsSync(FILE)) throw new Error(`missing ${FILE} — run with --write first`);
  const committed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  deepStrictEqual(golden, committed,
    'vaultbeam vectors DRIFTED from the committed golden copy. If the wire-format change is intentional, regenerate with --write and review the diff.');
  // Independent self-consistency: every sealed chunk must open back to its plaintext.
  for (const c of chunkCases) {
    const nonce = chunkNonce(c.transferId, c.chunkId);
    const wire = Buffer.from(c.wireHex, 'hex');
    const ct = wire.subarray(0, wire.length - 16), tag = wire.subarray(wire.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, nonce, { authTagLength: 16 });
    d.setAAD(Buffer.from(c.aad, 'utf8')); d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]);
    deepStrictEqual(hex(plain), c.plaintextHex, `open(seal) mismatch for "${c.name}"`);
  }
  console.log('vaultbeam vectors self-check: OK');
}
