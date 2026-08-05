// lib/vaultBeam/blockMap.ts — the bridge between the relay's PHYSICAL block
// granularity and the session's CANONICAL LOGICAL CHUNK granularity.
//
// The relay stores one R2 object per block; the session reasons in 512 KiB
// logical chunks. On a v2 (canonical) plan every block starts on a chunk
// boundary and spans a whole number of chunks, so the mapping is exact and a
// block is simply a ChunkRun.
//
// Two directions:
//   • server mask (per block) → R2Have (per chunk)     — what the relay holds
//   • work-list (per chunk)   → blocks to transfer     — what to ask R2 for
//
// Pure: no react-native / expo imports, so it runs under `npx tsx`.

import {
  type SegmentPlan, locateBlock, totalBlocks, CHUNK_BYTES, SEGMENT_PLAN_V2,
} from '../vaultBeamSegments';
import { ChunkBitmap, type ChunkRun } from './bitmap';

/**
 * The canonical chunk run a relay block covers, or null if the block index is
 * outside the plan. Returns null for a v1 (legacy) plan: its blocks do not align
 * to the canonical grid, which is exactly why v1 transfers cannot share a bitmap
 * and must run to completion on their original scheme.
 */
export function blockChunkRun(plan: SegmentPlan, blockIndex: number, chunkCount: number): ChunkRun | null {
  if (plan.version < SEGMENT_PLAN_V2) return null;
  const loc = locateBlock(plan, blockIndex);
  if (!loc) return null;
  if (loc.blockPlainOffset % CHUNK_BYTES !== 0) return null;      // invariant, defensively rechecked
  const start = loc.blockPlainOffset / CHUNK_BYTES;
  if (start >= chunkCount) return null;
  const span = Math.ceil(loc.blockBytes / CHUNK_BYTES);
  return { start, count: Math.min(span, chunkCount - start) };
}

/** Does this block contain at least one chunk that is still needed? */
export function blockIsNeeded(plan: SegmentPlan, blockIndex: number, chunkCount: number, needed: ChunkBitmap): boolean {
  const run = blockChunkRun(plan, blockIndex, chunkCount);
  if (!run) return false;
  for (let i = run.start; i < run.start + run.count; i++) if (needed.test(i)) return true;
  return false;
}

/**
 * Blocks that must be transferred to satisfy `needed`, ascending.
 *
 * A block is included when ANY of its chunks is needed — not when *every* chunk
 * is. An R2 object is written and read whole, so a block holding one missing
 * chunk must still move; the cost is bounded to at most one partial block at
 * each edge of a needed region, and the common resume shape (a contiguous
 * prefix already held) has exactly one such edge.
 */
export function blocksForNeed(plan: SegmentPlan, chunkCount: number, needed: ChunkBitmap): number[] {
  const out: number[] = [];
  for (let b = 0, n = totalBlocks(plan); b < n; b++) {
    if (blockIsNeeded(plan, b, chunkCount, needed)) out.push(b);
  }
  return out;
}

/**
 * Server block mask (base64 BYTEA, one bit per block) → an R2Have bitmap at
 * chunk granularity. A block bit set means every chunk in that block is staged
 * on R2, because a block is only marked after the server HEAD-verifies the whole
 * object exists.
 */
export function r2HaveFromServerMask(
  plan: SegmentPlan, maskB64: string, blockCount: number, chunkCount: number,
): ChunkBitmap {
  const out = new ChunkBitmap(chunkCount);
  if (!maskB64) return out;
  const mask = ChunkBitmap.fromBase64(maskB64, blockCount);
  for (let b = 0; b < blockCount; b++) {
    if (!mask.test(b)) continue;
    const run = blockChunkRun(plan, b, chunkCount);
    if (run) out.setRun(run);
  }
  return out;
}

/** Chunks a set of blocks covers — used to credit a completed block transfer. */
export function chunksOfBlocks(plan: SegmentPlan, blocks: readonly number[], chunkCount: number): ChunkRun[] {
  const out: ChunkRun[] = [];
  for (const b of blocks) {
    const run = blockChunkRun(plan, b, chunkCount);
    if (run) out.push(run);
  }
  return out;
}

// ── self-check: `npx tsx lib/vaultBeam/blockMap.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('blockMap: ' + m); };
  const MiB = 1024 * 1024;
  const { newPlan, appendSegment, SEGMENT_PLAN_V1 } = require('../vaultBeamSegments');

  // A v2 plan with TWO different physical block sizes over a 20 MiB file:
  // segment 0 = 8 MiB @ 2 MiB blocks (4 chunks each), segment 1 = the rest @ 8 MiB blocks.
  const totalBytes = 20 * MiB;
  const chunkCount = Math.ceil(totalBytes / CHUNK_BYTES);   // 40
  let plan = newPlan(totalBytes);
  plan = appendSegment(plan, 2 * MiB, 8 * MiB);   // 8 MiB in 2 MiB blocks → 4 blocks
  plan = appendSegment(plan, 8 * MiB, 256 * MiB); // remaining 12 MiB in 8 MiB blocks
  A(chunkCount === 40, '20 MiB → 40 logical chunks');

  // every block maps to a contiguous chunk run; runs tile [0, chunkCount) exactly
  const n = totalBlocks(plan);
  let expect = 0;
  for (let b = 0; b < n; b++) {
    const run = blockChunkRun(plan, b, chunkCount)!;
    A(run !== null, 'block maps to a run @' + b);
    A(run.start === expect, 'runs are contiguous @' + b);
    expect += run.count;
  }
  A(expect === chunkCount, 'block runs tile the whole file exactly');
  A(blockChunkRun(plan, n, chunkCount) === null, 'out-of-range block → null');

  // differing physical block sizes produce differing run lengths — the point of
  // adaptive packing — while chunk identity stays on the canonical grid
  const lens = new Set<number>();
  for (let b = 0; b < n; b++) lens.add(blockChunkRun(plan, b, chunkCount)!.count);
  A(lens.size > 1, 'physical block sizes really do differ');
  A([...lens].every((l) => l === 4 || l === 16 || l < 16), 'run lengths follow blockBytes/CHUNK');

  // server mask → R2Have at chunk granularity
  const blockMask = new ChunkBitmap(n);
  blockMask.set(0); blockMask.set(1);            // first two 2 MiB blocks = chunks 0..7
  const r2 = r2HaveFromServerMask(plan, blockMask.toBase64(), n, chunkCount);
  A(r2.popcount() === 8, 'two 2 MiB blocks = 8 logical chunks');
  for (let i = 0; i < 8; i++) A(r2.test(i), 'chunk staged @' + i);
  A(!r2.test(8), 'chunk beyond the staged blocks is not set');
  A(r2HaveFromServerMask(plan, '', n, chunkCount).isEmpty(), 'empty mask → empty R2Have');

  // blocksForNeed: ANY needed chunk pulls its whole block in
  const needed = new ChunkBitmap(chunkCount);
  needed.set(5);                                  // sits inside block 1 (chunks 4..7)
  const blocks = blocksForNeed(plan, chunkCount, needed);
  A(JSON.stringify(blocks) === JSON.stringify([1]), 'one needed chunk pulls exactly its block');
  needed.set(39);                                 // last chunk → last block
  A(blocksForNeed(plan, chunkCount, needed).length === 2, 'two needed regions → two blocks');
  A(blocksForNeed(plan, chunkCount, new ChunkBitmap(chunkCount)).length === 0, 'nothing needed → no blocks');

  // the common resume shape: a held prefix means only the tail blocks move
  const tailNeed = new ChunkBitmap(chunkCount);
  for (let i = 30; i < chunkCount; i++) tailNeed.set(i);
  const tailBlocks = blocksForNeed(plan, chunkCount, tailNeed);
  A(tailBlocks.length < n, 'a held prefix transfers strictly fewer blocks');
  A(tailBlocks.every((b) => blockChunkRun(plan, b, chunkCount)!.start + blockChunkRun(plan, b, chunkCount)!.count > 30),
    'only blocks overlapping the needed tail are selected');

  // chunksOfBlocks credits exactly what the blocks cover
  const credited = chunksOfBlocks(plan, [0, 1], chunkCount);
  A(credited.reduce((s, r) => s + r.count, 0) === 8, 'crediting two blocks credits 8 chunks');

  // a v1 (legacy) plan has no canonical mapping — it must NOT be silently
  // treated as if it did, or a dual-read transfer would corrupt its bitmap
  let v1 = newPlan(totalBytes, SEGMENT_PLAN_V1);
  v1 = appendSegment(v1, 4 * MiB, 256 * MiB, 1 * MiB);
  A(blockChunkRun(v1, 0, chunkCount) === null, 'v1 plan has no canonical chunk mapping');
  A(blocksForNeed(v1, chunkCount, needed).length === 0, 'v1 plan yields no canonical block work');
  A(r2HaveFromServerMask(v1, blockMask.toBase64(), n, chunkCount).isEmpty(), 'v1 plan yields empty R2Have');

  console.log('vaultBeam/blockMap self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
