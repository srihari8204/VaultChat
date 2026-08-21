// lib/vaultBeam/reportReceived.ts — tell the server what the receiver holds.
//
// # THE MISSING LINK
//
// `relayReceived` (POST /vaultbeam/relay/received) has existed, fully built and
// fully authorised, with NO CALLERS. So `recv_mask` was never populated —
// confirmed in production on a transfer that reached 74%: `recv=0B`.
//
// Everything downstream depended on it and was therefore inert:
//
//   recv_mask empty  ->  no vb_have nudge ever emitted
//                    ->  sender work-list has nothing to subtract
//                    ->  a broken direct transfer re-stages the whole file
//
// This is the call that turns that chain on.
//
// # BLOCKS IN, CHUNKS OUT
//
// The receiver tracks PHYSICAL blocks (`got`); the server's recv_mask is in
// LOGICAL chunks. A block is only reported when every chunk it covers is
// present, which is the same conservative rule the sender uses when deciding
// what it may skip — claiming a chunk the receiver does not have would let the
// sender skip staging it, and then nothing would hold it.
//
// # NEVER FAILS A TRANSFER
//
// Throttled like saveRecvBitmapSoon (same 1.5s coalescing, one timer per
// transfer), fire-and-forget, every error swallowed. This is bookkeeping that
// makes the NEXT resume cheaper; a transfer must not break because it failed.

import { ChunkBitmap } from './bitmap';

export interface BlockSpanLookup {
  (blockIndex: number): { blockPlainOffset: number; blockBytes: number } | null;
}

/**
 * Convert the receiver's committed BLOCK set into a logical-chunk bitmap.
 *
 * Only whole blocks contribute: a block whose span cannot be resolved, or which
 * would run past `chunkCount`, is skipped rather than guessed at.
 */
export function chunkMaskFromBlocks(
  got: Iterable<number>,
  locate: BlockSpanLookup,
  chunkBytes: number,
  chunkCount: number,
): string | null {
  if (!(chunkBytes > 0) || !(chunkCount > 0)) return null;
  const bm = new ChunkBitmap(chunkCount);
  let any = false;
  for (const b of got) {
    let span: { blockPlainOffset: number; blockBytes: number } | null = null;
    try { span = locate(b); } catch { span = null; }
    if (!span || !(span.blockBytes > 0)) continue;
    const first = Math.floor(span.blockPlainOffset / chunkBytes);
    const last = Math.ceil((span.blockPlainOffset + span.blockBytes) / chunkBytes) - 1;
    if (first < 0 || last >= chunkCount || last < first) continue;
    for (let g = first; g <= last; g++) { if (bm.set(g)) any = true; }
  }
  return any ? bm.encode() : null;
}

/**
 * Build the mask from chunk ids the DIRECT tier has committed.
 *
 * The relay tier thinks in physical blocks, so it uses chunkMaskFromBlocks
 * above. The direct tier receives logical chunks one at a time and knows
 * exactly which ids are on disk, so it can report them directly.
 *
 * Takes the committed SET, never a count. `received` on the direct path counts
 * writes that finished, and because the message handler is async those can
 * finish out of order — so "chunks 0..received-1" would sometimes claim a chunk
 * still in flight. The sender would then skip staging the one chunk nothing
 * holds, and the transfer could only fail at the whole-file digest. A set
 * cannot express that lie.
 *
 * Out-of-range ids are dropped rather than clamped: an id the plan does not
 * cover is evidence something is wrong, not something to round off.
 */
export function chunkMaskFromCommitted(committed: Iterable<number>, chunkCount: number): string | null {
  if (!(chunkCount > 0)) return null;
  const bm = new ChunkBitmap(chunkCount);
  let any = false;
  for (const c of committed) {
    if (!Number.isInteger(c) || c < 0 || c >= chunkCount) continue;
    if (bm.set(c)) any = true;
  }
  return any ? bm.encode() : null;
}

/**
 * How many chunks are verified from 0 with NO gap.
 *
 * This is a different question from "how many are verified", and conflating the
 * two is a data-loss bug rather than an off-by-one. `haveBytes` tells the relay
 * tier "the first N bytes are already on disk, don't re-download them" — a claim
 * about a contiguous PREFIX. The receiver's verified set is not a prefix,
 * because writes can complete out of order.
 *
 *     committed = {0,1,2,4,5}    verified count = 5    contiguous prefix = 3
 *
 * Reading that count as a prefix would tell the relay tier chunk 3 is on disk.
 * It is not, and nothing would ever fetch it: the hole survives to the
 * whole-file digest, which fails after the entire transfer has run.
 *
 * Counting stops at the first gap, so malformed or out-of-range ids can only
 * ever shorten the answer — they cannot manufacture a longer prefix.
 */
export function contiguousVerifiedPrefix(committed: Iterable<number>, chunkCount: number): number {
  if (!(chunkCount > 0)) return 0;
  const have = new Set<number>();
  for (const c of committed) {
    if (Number.isInteger(c) && c >= 0 && c < chunkCount) have.add(c);
  }
  let n = 0;
  while (n < chunkCount && have.has(n)) n++;
  return n;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastSent = new Map<string, string>();

/**
 * Report the receiver's verified chunks, coalesced.
 *
 * Skips the call entirely when the mask has not changed since the last report,
 * so a burst of block commits costs one request, not one per block.
 */
export function reportReceivedSoon(transferId: string, mask: string | null, delayMs = 1500): void {
  if (!transferId || !mask) return;
  if (lastSent.get(transferId) === mask) return;
  if (timers.has(transferId)) return;
  timers.set(transferId, setTimeout(() => {
    timers.delete(transferId);
    if (lastSent.get(transferId) === mask) return;
    lastSent.set(transferId, mask);
    import('../vaultbeamRelay')
      .then((m) => m.relayReceived(transferId, mask))
      .catch(() => { lastSent.delete(transferId); });   // let a later tick retry
  }, delayMs));
}

/** Drop a finished transfer's throttle state. */
export function forgetReported(transferId: string): void {
  const t = timers.get(transferId);
  if (t) { clearTimeout(t); timers.delete(transferId); }
  lastSent.delete(transferId);
}

export default {
  chunkMaskFromBlocks, chunkMaskFromCommitted, contiguousVerifiedPrefix,
  reportReceivedSoon, forgetReported,
};

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  const CHUNK = 512 * 1024;
  const BLOCK = 4 * CHUNK;                 // 2 MiB = 4 logical chunks
  const CHUNKS = 20;
  const loc = (b: number) =>
    b >= 0 && b < 5 ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null;

  console.log('\nVaultBeam receiver progress report\n');

  const m0 = chunkMaskFromBlocks([], loc, CHUNK, CHUNKS);
  A(m0 === null, '1. no committed blocks ⇒ nothing to report');

  const m1 = chunkMaskFromBlocks([0], loc, CHUNK, CHUNKS);
  A(m1 !== null, '2. one block yields a mask');
  const bm1 = ChunkBitmap.decode(m1!, CHUNKS);
  A(bm1.popcount() === 4, '3. a 2048 KiB block reports exactly its 4 logical chunks');
  A(bm1.test(0) && bm1.test(3) && !bm1.test(4), '4. and exactly the right ones');

  const m2 = chunkMaskFromBlocks([0, 2], loc, CHUNK, CHUNKS);
  const bm2 = ChunkBitmap.decode(m2!, CHUNKS);
  A(bm2.popcount() === 8, '5. non-contiguous blocks report 8 chunks');
  A(bm2.test(8) && !bm2.test(4), '6. block 2 maps to chunks 8-11, block 1 stays clear');

  // Unresolvable / out-of-range blocks are skipped, never guessed.
  A(chunkMaskFromBlocks([99], loc, CHUNK, CHUNKS) === null,
    '7. a block the plan cannot resolve contributes nothing');
  A(chunkMaskFromBlocks([0], () => { throw new Error('x'); }, CHUNK, CHUNKS) === null,
    '8. a throwing lookup degrades to reporting nothing');
  A(chunkMaskFromBlocks([0], loc, 0, CHUNKS) === null, '9. a zero chunk size reports nothing');
  A(chunkMaskFromBlocks([0], loc, CHUNK, 0) === null, '10. a zero chunk count reports nothing');

  // A block that would overrun the chunk count is not reported.
  const tight = (b: number) => (b === 0 ? { blockPlainOffset: 0, blockBytes: BLOCK } : null);
  A(chunkMaskFromBlocks([0], tight, CHUNK, 2) === null,
    '11. a block extending past the last chunk is skipped, never truncated');

  // The mask must be exactly what the sender's skip logic consumes.
  const round = ChunkBitmap.decode(chunkMaskFromBlocks([0, 1], loc, CHUNK, CHUNKS)!, CHUNKS);
  A(round.popcount() === 8 && round.test(7) && !round.test(8),
    '12. the encoding round-trips to the same chunk set the sender will read');

  // ── chunkMaskFromCommitted: the DIRECT tier's reporter ────────────
  A(chunkMaskFromCommitted([], CHUNKS) === null, '13. nothing committed ⇒ nothing reported');
  {
    const m = chunkMaskFromCommitted([0, 1, 3], CHUNKS)!;   // 2 deliberately still in flight
    const bm = ChunkBitmap.decode(m, CHUNKS);
    A(bm.popcount() === 3, '14. exactly the committed chunks are reported');
    A(bm.test(0) && bm.test(1) && bm.test(3), '15. and they are the right ones');
    A(!bm.test(2), '16. an IN-FLIGHT chunk is never claimed — the whole point of a set');
  }
  {
    // A count-based mask would have claimed 0..3. A set cannot lie like that.
    const bm = ChunkBitmap.decode(chunkMaskFromCommitted([5, 0, 9, 2], CHUNKS)!, CHUNKS);
    A(bm.popcount() === 4 && bm.test(9) && !bm.test(1),
      '17. out-of-order completion is represented exactly, never as a prefix');
  }
  A(ChunkBitmap.decode(chunkMaskFromCommitted([0, 0, 0], CHUNKS)!, CHUNKS).popcount() === 1,
    '18. duplicate commits are idempotent');
  A(chunkMaskFromCommitted([CHUNKS, CHUNKS + 5, -1], CHUNKS) === null,
    '19. out-of-range ids are dropped, never clamped into a false claim');
  A(chunkMaskFromCommitted([1.5 as any, NaN as any], CHUNKS) === null,
    '20. non-integer ids are dropped');
  A(chunkMaskFromCommitted([0], 0) === null, '21. a zero chunk count reports nothing');

  // ── contiguousVerifiedPrefix: a prefix is NOT a count ─────────────
  const P = (ids: number[], n = CHUNKS) => contiguousVerifiedPrefix(ids, n);
  A(P([]) === 0, '22. {} → 0');
  A(P([0]) === 1, '23. {0} → 1');
  A(P([0, 1, 2]) === 3, '24. {0,1,2} → 3');
  A(P([0, 1, 2, 4, 5]) === 3, '25. {0,1,2,4,5} → 3 — the count would have said 5');
  A(P([1, 2, 3]) === 0, '26. {1,2,3} → 0 — no chunk 0 means no prefix at all');
  A(P([0, 2, 3]) === 1, '27. {0,2,3} → 1');
  A(P([0, 1, 3, 4]) === 2, '28. {0,1,3,4} → 2');
  A(P([0, 1, 2, 3, 4]) === 5, '29. {0,1,2,3,4} → 5');
  A(P(Array.from({ length: CHUNKS }, (_, i) => i)) === CHUNKS, '30. a complete set → chunkCount');
  A(P([0, 0, 0, 1, 1]) === 2, '31. duplicates do not inflate the prefix');
  A(P([-1, 0]) === 1, '32. a negative id is ignored; the prefix still counts from 0');
  A(P([0, 1.5 as any, 1]) === 2, '33. a non-integer id is ignored');
  A(P([0, 1, CHUNKS, CHUNKS + 9]) === 2, '34. out-of-range ids cannot extend the prefix');
  A(P([NaN as any, Infinity as any]) === 0, '35. NaN/Infinity contribute nothing');
  A(P([0], 0) === 0, '36. a zero chunk count yields 0');
  A(contiguousVerifiedPrefix([0, 1, 2, 999_999], 1_000_000) === 3,
    '37. a huge chunk count still stops at the first hole');
  {
    // The two concepts must never be interchangeable.
    const committed = [0, 1, 2, 4, 5];
    const mask = chunkMaskFromCommitted(committed, CHUNKS)!;
    A(ChunkBitmap.decode(mask, CHUNKS).popcount() === 5 &&
      contiguousVerifiedPrefix(committed, CHUNKS) === 3,
      '38. recv_mask carries all 5 verified chunks while haveBytes may claim only 3');
  }

  console.log(failures === 0
    ? '\nALL RECEIVER-REPORT CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
