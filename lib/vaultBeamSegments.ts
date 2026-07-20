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

export const SEGMENT_PLAN_VERSION = 1;
export const TARGET_SEGMENT_BYTES = 256 * 1024 * 1024; // re-evaluate geometry ~every 256 MiB

export interface Segment {
  start: number;       // plaintext byte offset of the segment's first byte
  bytes: number;       // segment length (multiple of blockBytes, except the file tail)
  chunkBytes: number;
  blockBytes: number;
  firstBlock: number;  // global index of this segment's first block
}
export interface SegmentPlan { version: number; totalBytes: number; segments: Segment[] }

export function newPlan(totalBytes: number): SegmentPlan {
  return { version: SEGMENT_PLAN_VERSION, totalBytes, segments: [] };
}

export const segBlockCount = (s: Segment): number => Math.ceil(s.bytes / s.blockBytes);
export const plannedBytes = (p: SegmentPlan): number => p.segments.reduce((n, s) => n + s.bytes, 0);
export const totalBlocks  = (p: SegmentPlan): number => p.segments.reduce((n, s) => n + segBlockCount(s), 0);
export const isComplete   = (p: SegmentPlan): boolean => plannedBytes(p) >= p.totalBytes;

/**
 * Append one segment with the given geometry (from networkState.geometry()).
 * A non-final segment is rounded to a whole number of blocks so no block spans
 * two segments; the final segment takes the remainder (its last block may be
 * partial — the native code bounds the tail via min(chunkBytes, total-offset)).
 * Returns a NEW plan (pure). No-op once the file is fully planned.
 */
export function appendSegment(
  p: SegmentPlan, chunkBytes: number, blockBytes: number, target = TARGET_SEGMENT_BYTES,
): SegmentPlan {
  if (blockBytes % chunkBytes !== 0) throw new Error('blockBytes not a multiple of chunkBytes');
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
  return { ...p, segments: [...p.segments, { start, bytes, chunkBytes, blockBytes, firstBlock: totalBlocks(p) }] };
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
    if (p.version !== SEGMENT_PLAN_VERSION) return null;   // R6: refuse an unknown geometry version
    let expectBlock = 0, expectStart = 0;
    for (const s of p.segments) {
      if (s.blockBytes % s.chunkBytes !== 0) return null;
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

  // A 700 MiB file planned in three geometries: 256/256/remainder.
  let p = newPlan(700 * MiB);
  p = appendSegment(p, 1 * MiB, 4 * MiB, 256 * MiB);   // 256 MiB @ 4 MiB blocks
  p = appendSegment(p, 4 * MiB, 8 * MiB, 256 * MiB);   // 256 MiB @ 8 MiB blocks
  p = appendSegment(p, 8 * MiB, 8 * MiB, 256 * MiB);   // 188 MiB tail @ 8 MiB blocks
  A(isComplete(p), 'plan covers the whole file');
  A(plannedBytes(p) === 700 * MiB, 'planned bytes = total');

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
    const seg = p.segments[loc!.segIndex];
    const isLastBlockOfFile = b === N - 1;
    const span = isLastBlockOfFile ? (700 * MiB - expectOff) : loc!.blockBytes;
    expectOff += span;
  }
  A(expectOff === 700 * MiB, 'blocks cover the whole file exactly');
  A(locateBlock(p, N) === null, 'out-of-range block → null');

  // round-trip + version guard
  const round = deserialize(serialize(p));
  A(round !== null && totalBlocks(round!) === N, 'serialize round-trips');
  A(deserialize(JSON.stringify({ ...p, version: 999 })) === null, 'rejects unknown version');
  A(deserialize('not json') === null, 'rejects garbage');

  // small file: a single sub-block segment
  let q = newPlan(300 * 1024);   // 300 KiB, smaller than one 4 MiB block
  q = appendSegment(q, 256 * 1024, 2 * MiB, 256 * MiB);
  A(totalBlocks(q) === 1 && isComplete(q), 'tiny file → one partial block');

  console.log('vaultBeamSegments self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
