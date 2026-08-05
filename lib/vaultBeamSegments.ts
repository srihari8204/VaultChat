// lib/vaultBeamSegments.ts — segmented-geometry manifest for VaultBeam (R2 + R6).
//
// Adaptive chunk sizing can't renegotiate mid-stream without breaking the
// per-block resume bitmask + the native offset math (both assume uniform size).
// The fix: divide the file into SEGMENTS. Each segment has a fixed chunk/block
// size (chosen at its start from networkState). Within a segment geometry is
// uniform, so the bitmask + offsets stay clean; size changes only at segment
// boundaries. This manifest maps each GLOBAL block index → its geometry + its
// plaintext byte offset — the single source both the sender, the receiver, and
// resume read from.
//
// Delivered to the receiver over E2EE (like K_t), never to the relay server —
// it's content-free (sizes/offsets), but it stays off the server anyway. The
// plan only ever APPENDS, so incremental delivery + merge is safe.
//
// Invariants (enforced + self-checked):
//   • blocks never span a segment → a non-final segment is a whole number of blocks
//   • blockBytes % chunkBytes === 0 (native computes chunksPerBlock)
//   • global block indices are contiguous and cover exactly [0, totalBlocks)

// v1 — legacy: per-segment chunkBytes varies, chunk id = plaintext byte offset.
// v2 — canonical: logical chunk is ALWAYS CHUNK_BYTES and its id is its global
//      logical index (offset / CHUNK_BYTES), identical on every transport. Only
//      the PHYSICAL block size still varies per segment. v1 plans remain
//      readable for the one-release dual-read window (relay objects expire in
//      24 h, so the window only needs to exceed a day).
export const SEGMENT_PLAN_V1 = 1;
export const SEGMENT_PLAN_V2 = 2;
export const SEGMENT_PLAN_VERSION = SEGMENT_PLAN_V2;
export const TARGET_SEGMENT_BYTES = 256 * 1024 * 1024; // re-evaluate geometry ~every 256 MiB

/** The canonical LOGICAL chunk: the unit of AES-GCM, acknowledgement, the resume
 *  bitmap, and cross-transport equivalence. Fixed — never adaptive. */
export const CHUNK_BYTES = 512 * 1024;

/** Which chunk-identity scheme a plan's blocks were sealed with. Mirrors
 *  services/vaultbeam/rust/src/chunk.rs IdScheme. */
export type IdScheme = 'uniform' | 'legacyOffset' | 'canonical';
export const idSchemeForPlan = (p: SegmentPlan): IdScheme =>
  p.version >= SEGMENT_PLAN_V2 ? 'canonical' : 'legacyOffset';

export interface Segment {
  start: number;       // plaintext byte offset of the segment's first byte
  bytes: number;       // segment length (multiple of blockBytes, except the file tail)
  chunkBytes: number;
  blockBytes: number;
  firstBlock: number;  // global index of this segment's first block
}
export interface SegmentPlan { version: number; totalBytes: number; segments: Segment[] }

export function newPlan(totalBytes: number, version: number = SEGMENT_PLAN_VERSION): SegmentPlan {
  return { version, totalBytes, segments: [] };
}

export const segBlockCount = (s: Segment): number => Math.ceil(s.bytes / s.blockBytes);
export const plannedBytes = (p: SegmentPlan): number => p.segments.reduce((n, s) => n + s.bytes, 0);
export const totalBlocks  = (p: SegmentPlan): number => p.segments.reduce((n, s) => n + segBlockCount(s), 0);
export const isComplete   = (p: SegmentPlan): boolean => plannedBytes(p) >= p.totalBytes;

/**
 * Append one segment with the given PHYSICAL block size (from
 * networkState.geometry()). The LOGICAL chunk size is fixed at CHUNK_BYTES on a
 * v2 plan; `chunkBytes` may only be passed to build a legacy v1 plan.
 *
 * A non-final segment is rounded to a whole number of blocks so no block spans
 * two segments; the final segment takes the remainder (its last block may be
 * partial — the native code bounds the tail via min(chunkBytes, total-offset)).
 * Returns a NEW plan (pure). No-op once the file is fully planned.
 */
export function appendSegment(
  p: SegmentPlan, blockBytes: number, target = TARGET_SEGMENT_BYTES, chunkBytes?: number,
): SegmentPlan {
  const chunk = p.version >= SEGMENT_PLAN_V2 ? CHUNK_BYTES : (chunkBytes ?? CHUNK_BYTES);
  if (p.version >= SEGMENT_PLAN_V2 && chunkBytes !== undefined && chunkBytes !== CHUNK_BYTES) {
    throw new Error('v2 plans use the fixed canonical logical chunk');
  }
  if (blockBytes % chunk !== 0) throw new Error('blockBytes not a multiple of chunkBytes');
  const start = plannedBytes(p);
  const remaining = p.totalBytes - start;
  if (remaining <= 0) return p;

  // Round the target down to a whole number of blocks (≥ one block).
  const rounded = Math.max(blockBytes, Math.floor(target / blockBytes) * blockBytes);
  let bytes: number;
  if (remaining <= rounded) {
    bytes = remaining;                                   // tail — take everything left
  } else {
    bytes = Math.floor(remaining / blockBytes) * blockBytes;
    bytes = Math.min(rounded, bytes) || remaining;       // whole blocks, capped at target
  }
  return { ...p, segments: [...p.segments, { start, bytes, chunkBytes: chunk, blockBytes, firstBlock: totalBlocks(p) }] };
}

export interface BlockLocation { chunkBytes: number; blockBytes: number; blockPlainOffset: number; segIndex: number }

/** Global block index → geometry + plaintext byte offset (for native ops + resume). */
export function locateBlock(p: SegmentPlan, blockIndex: number): BlockLocation | null {
  for (let i = 0; i < p.segments.length; i++) {
    const s = p.segments[i];
    const n = segBlockCount(s);
    if (blockIndex >= s.firstBlock && blockIndex < s.firstBlock + n) {
      return {
        chunkBytes: s.chunkBytes, blockBytes: s.blockBytes,
        blockPlainOffset: s.start + (blockIndex - s.firstBlock) * s.blockBytes,
        segIndex: i,
      };
    }
  }
  return null;
}

// ── serialize for the E2EE manifest + validate on the way back in ──
export function serialize(p: SegmentPlan): string { return JSON.stringify(p); }

export function deserialize(json: string): SegmentPlan | null {
  try {
    const p = JSON.parse(json);
    if (!p || typeof p.totalBytes !== 'number' || !Array.isArray(p.segments)) return null;
    // Accept v1 (legacy, dual-read window) and v2 (canonical); refuse anything else.
    if (p.version !== SEGMENT_PLAN_V1 && p.version !== SEGMENT_PLAN_V2) return null;
    let expectBlock = 0, expectStart = 0;
    for (const s of p.segments) {
      if (s.blockBytes % s.chunkBytes !== 0) return null;
      // v2 invariant: the logical chunk is uniform across every segment. This is
      // what makes a chunk's id its global logical index on every transport.
      if (p.version >= SEGMENT_PLAN_V2 && s.chunkBytes !== CHUNK_BYTES) return null;
      if (s.firstBlock !== expectBlock || s.start !== expectStart) return null;  // contiguous
      expectBlock += segBlockCount(s); expectStart += s.bytes;
    }
    return p as SegmentPlan;
  } catch { return null; }
}

// ── self-check: `npx tsx lib/vaultBeamSegments.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('vaultBeamSegments: ' + m); };
  const MiB = 1024 * 1024;

  // ── v1 (legacy, dual-read): per-segment chunkBytes varies ──
  let p = newPlan(700 * MiB, SEGMENT_PLAN_V1);
  p = appendSegment(p, 4 * MiB, 256 * MiB, 1 * MiB);   // 256 MiB @ 4 MiB blocks, 1 MiB chunks
  p = appendSegment(p, 8 * MiB, 256 * MiB, 4 * MiB);   // 256 MiB @ 8 MiB blocks, 4 MiB chunks
  p = appendSegment(p, 8 * MiB, 256 * MiB, 8 * MiB);   // 188 MiB tail
  A(isComplete(p), 'v1 plan covers the whole file');
  A(plannedBytes(p) === 700 * MiB, 'v1 planned bytes = total');
  A(idSchemeForPlan(p) === 'legacyOffset', 'v1 uses the legacy offset id scheme');

  // non-final segments are whole blocks; contiguous starts + block indices
  let block = 0, off = 0;
  for (let i = 0; i < p.segments.length; i++) {
    const s = p.segments[i];
    A(s.firstBlock === block, 'firstBlock contiguous @' + i);
    A(s.start === off, 'start contiguous @' + i);
    if (i < p.segments.length - 1) A(s.bytes % s.blockBytes === 0, 'non-final segment is whole blocks @' + i);
    block += segBlockCount(s); off += s.bytes;
  }

  // every global block maps to a unique, contiguous plaintext range; no gaps/overlaps
  const N = totalBlocks(p);
  let expectOff = 0;
  for (let b = 0; b < N; b++) {
    const loc = locateBlock(p, b);
    A(loc !== null, 'block located @' + b);
    A(loc!.blockPlainOffset === expectOff, 'contiguous offset @' + b);
    const isLastBlockOfFile = b === N - 1;
    expectOff += isLastBlockOfFile ? (700 * MiB - expectOff) : loc!.blockBytes;
  }
  A(expectOff === 700 * MiB, 'blocks cover the whole file exactly');
  A(locateBlock(p, N) === null, 'out-of-range block → null');

  // ── v2 (canonical): logical chunk fixed, PHYSICAL block adaptive ──
  let q = newPlan(700 * MiB);
  A(q.version === SEGMENT_PLAN_V2, 'newPlan defaults to v2');
  q = appendSegment(q, 2 * MiB, 256 * MiB);   // slow link → small physical unit
  q = appendSegment(q, 8 * MiB, 256 * MiB);   // link recovers → large physical unit
  q = appendSegment(q, 4 * MiB, 256 * MiB);   // tail
  A(isComplete(q), 'v2 plan covers the whole file');
  A(idSchemeForPlan(q) === 'canonical', 'v2 uses the canonical id scheme');
  A(q.segments.every((s) => s.chunkBytes === CHUNK_BYTES), 'v2 logical chunk is uniform across segments');
  A(new Set(q.segments.map((s) => s.blockBytes)).size > 1, 'v2 physical block size DID adapt');

  // THE canonical property: a chunk's id is its global logical index, so the
  // same plaintext offset has the same identity regardless of which physical
  // block (or which transport) carries it.
  for (let b = 0, n = totalBlocks(q); b < n; b++) {
    const loc = locateBlock(q, b)!;
    A(loc.blockPlainOffset % CHUNK_BYTES === 0, 'v2 block starts on a logical chunk boundary @' + b);
    A(loc.blockBytes % CHUNK_BYTES === 0, 'v2 block is a whole number of logical chunks @' + b);
  }
  A(appendSegment(newPlan(10 * MiB), 2 * MiB, 256 * MiB, CHUNK_BYTES).segments.length === 1,
    'v2 accepts an explicit chunkBytes that equals the canonical one');
  let threw = false;
  try { appendSegment(newPlan(10 * MiB), 2 * MiB, 256 * MiB, 1 * MiB); } catch { threw = true; }
  A(threw, 'v2 rejects a non-canonical logical chunk');

  // round-trip + version guards
  const round = deserialize(serialize(q));
  A(round !== null && totalBlocks(round!) === totalBlocks(q), 'v2 serialize round-trips');
  A(deserialize(serialize(p)) !== null, 'v1 plans still deserialize (dual-read window)');
  A(deserialize(JSON.stringify({ ...q, version: 999 })) === null, 'rejects unknown version');
  A(deserialize('not json') === null, 'rejects garbage');
  // a v2 plan claiming a non-canonical chunk size is refused, not silently read
  const forged = { ...q, segments: q.segments.map((s, i) => (i === 0 ? { ...s, chunkBytes: 1 * MiB } : s)) };
  A(deserialize(JSON.stringify(forged)) === null, 'v2 refuses a non-canonical chunkBytes');

  // small file: a single sub-block segment
  let r = newPlan(300 * 1024);   // 300 KiB, smaller than one logical chunk
  r = appendSegment(r, 2 * MiB, 256 * MiB);
  A(totalBlocks(r) === 1 && isComplete(r), 'tiny file → one partial block');

  console.log('vaultBeamSegments self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
