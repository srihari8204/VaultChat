// lib/vaultBeam/senderWorkList.ts — what the sender still has to stage.
//
// # THE WASTE THIS REMOVES
//
// A direct transfer that breaks part-way leaves the receiver holding verified
// chunks and R2 holding nothing. The sender then staged the WHOLE file to the
// relay, because its work-list only ever subtracted `uploadedMask` — what R2
// already has — and never `recvMask` — what the PEER already has. Measured on a
// real 280 MB transfer that died at 74%: R2 sat at `blocks=0`, so the sender
// was about to re-upload all 280 MB to deliver the missing ~73 MB.
//
// Everything needed was already in place. The server authenticates recv_mask
// (recipient-only), unions it idempotently, returns it from relay/state, and
// even pushes a `vb_have` nudge to the sender. The client's RelayState type
// already declares `recvMask` with a comment saying it exists "so it never
// stages a delivered chunk again". Only the subtraction was missing.
//
//     receiverMissing = expected - recvMask
//     relayNeeded     = receiverMissing - uploadedMask
//
// # THE RULE THAT KEEPS THIS SAFE
//
// A physical block may be skipped ONLY if EVERY logical chunk inside it is in
// recvMask. A block is the unit R2 stores; a chunk is the unit the receiver
// verifies. Skipping a partially-received block would strand the chunks the
// receiver is still missing with no copy anywhere — bandwidth saved, transfer
// broken. Partial ⇒ stage it.
//
// # FAIL SAFE, ALWAYS
//
// Absent, malformed, truncated or over-wide recvMask ⇒ skip nothing and behave
// exactly as before. Never read "no receiver state" as "receiver has it all":
// that is the one mistake here that loses data rather than bandwidth.
//
// PURE — no network, no storage. `npx tsx lib/vaultBeam/senderWorkList.ts`.

import { ChunkBitmap } from './bitmap';

/** Where a physical block sits, in the plan's own terms. */
export interface BlockSpan {
  /** Plaintext byte offset of the block's first byte. */
  blockPlainOffset: number;
  /** Plaintext length of the block. */
  blockBytes: number;
}

export interface ReceiverSkipInput {
  /** Base64 chunk bitmap from relay/state. Absent/invalid ⇒ skip nothing. */
  recvMask?: string | null;
  /**
   * The server's OWN count of received chunks, from the same relay/state
   * response. Used as a cross-check: a mask that decodes to a different
   * popcount is not the mask the server meant, so it is distrusted entirely.
   *
   * This is what stops a merely DECODABLE string from being believed — "zzz"
   * is valid base64 and yields a non-empty bitmap, which without this check
   * would have skipped real blocks.
   */
  expectedReceived?: number;
  chunkCount: number;
  blockCount: number;
  /** Block index → its span, or null when the plan does not cover it yet. */
  locate: (blockIndex: number) => BlockSpan | null;
  chunkBytes: number;
}

/**
 * Blocks the sender may skip because the RECEIVER already holds every logical
 * chunk in them.
 *
 * Returns an empty set on any doubt. The caller unions this with the blocks R2
 * already holds; the result is the set it does not need to stage.
 */
export function blocksReceiverAlreadyHas(a: ReceiverSkipInput): Set<number> {
  const out = new Set<number>();
  if (!a.recvMask || typeof a.recvMask !== 'string') return out;
  if (!(a.chunkCount > 0) || !(a.blockCount > 0) || !(a.chunkBytes > 0)) return out;

  let bm: ChunkBitmap;
  try {
    bm = ChunkBitmap.decode(a.recvMask, a.chunkCount);
  } catch {
    return out;                       // malformed ⇒ stage everything, as before
  }
  if (bm.isEmpty()) return out;

  // CROSS-CHECK AGAINST THE SERVER'S OWN COUNT.
  //
  // Decodability is not validity: any base64-ish string decodes to bytes and
  // therefore to a bitmap. relay/state returns `received` beside `recvMask`, so
  // a disagreement means the string is not the bitmap the server described —
  // distrust it and stage everything rather than skip on a guess.
  // MANDATORY, not advisory. Without the server's count there is nothing to
  // corroborate the string against, and an uncorroborated mask is exactly the
  // "zzz decodes to something" case — so no count means no skip.
  if (typeof a.expectedReceived !== 'number' || a.expectedReceived !== bm.popcount()) {
    return out;
  }

  for (let b = 0; b < a.blockCount; b++) {
    let span: BlockSpan | null = null;
    try { span = a.locate(b); } catch { span = null; }
    if (!span || !(span.blockBytes > 0)) continue;      // unplanned ⇒ do not skip

    const first = Math.floor(span.blockPlainOffset / a.chunkBytes);
    const last = Math.ceil((span.blockPlainOffset + span.blockBytes) / a.chunkBytes) - 1;
    if (first < 0 || last >= a.chunkCount || last < first) continue;

    // EVERY chunk, not the first and not most: a partially received block still
    // has to be staged or its missing chunks have no source at all.
    let whole = true;
    for (let g = first; g <= last; g++) {
      if (!bm.test(g)) { whole = false; break; }
    }
    if (whole) out.add(b);
  }
  return out;
}

/** Union of what R2 holds and what the receiver holds — the skip set. */
export function blocksToSkip(uploaded: Iterable<number>, receiverHas: Iterable<number>): Set<number> {
  const s = new Set<number>();
  for (const b of uploaded) s.add(b);
  for (const b of receiverHas) s.add(b);
  return s;
}

export default { blocksReceiverAlreadyHas, blocksToSkip };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  const CHUNK = 512 * 1024;
  // A 2 MiB block = 4 logical chunks, the widest supported mapping.
  const BLOCK = 4 * CHUNK;
  const CHUNKS = 20;                 // 5 blocks of 4 chunks
  const BLOCKS = 5;
  const locate = (b: number) =>
    b >= 0 && b < BLOCKS ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null;
  const base = { chunkCount: CHUNKS, blockCount: BLOCKS, locate, chunkBytes: CHUNK };

  const maskOf = (chunks: number[]) => {
    const bm = new ChunkBitmap(CHUNKS);
    for (const c of chunks) bm.set(c);
    return bm.encode();
  };
  const all = (n: number) => Array.from({ length: n }, (_, i) => i);

  console.log('\nVaultBeam sender work-list — receiver-aware staging\n');

  // 1. empty recv_mask ⇒ existing behaviour
  A(blocksReceiverAlreadyHas({ ...base, recvMask: maskOf([]) }).size === 0,
    '1. an empty receiver bitmap skips nothing');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: undefined }).size === 0,
    '2. an ABSENT receiver bitmap skips nothing — never read as "has everything"');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: null }).size === 0,
    '3. null skips nothing');

  // 2/3. partial and complete
  const two = blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(8)), expectedReceived: 8 });
  A(two.size === 2 && two.has(0) && two.has(1),
    `4. chunks 0-7 received ⇒ exactly blocks 0,1 skipped (${[...two]})`);
  A(blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(CHUNKS)), expectedReceived: CHUNKS }).size === BLOCKS,
    '5. a fully received file skips every block');

  // THE SAFETY RULE: a partly received block must still be staged.
  const partial = blocksReceiverAlreadyHas({ ...base, recvMask: maskOf([0, 1, 2]), expectedReceived: 3 });
  A(partial.size === 0,
    '6. 3 of block 0\'s 4 chunks received ⇒ block 0 is NOT skipped');
  const partial2 = blocksReceiverAlreadyHas({ ...base, recvMask: maskOf([0, 1, 2, 3, 4, 5]), expectedReceived: 6 });
  A(partial2.size === 1 && partial2.has(0),
    '7. block 0 whole + block 1 half ⇒ only block 0 skipped');

  // 8. out-of-order / non-contiguous receiver state
  const holey = blocksReceiverAlreadyHas({ ...base, recvMask: maskOf([8, 9, 10, 11, 16, 17, 18, 19]), expectedReceived: 8 });
  A(holey.size === 2 && holey.has(2) && holey.has(4),
    `8. a non-contiguous bitmap yields the exact block set (${[...holey]})`);
  A(!holey.has(0) && !holey.has(1) && !holey.has(3),
    '9. and nothing in between is skipped — never reduced to "last received"');

  // 7. malformed / hostile input ⇒ safe fallback
  for (const bad of ['', 'not-base64!!', 'r:', 'zzz', 'r:1.x.3']) {
    A(blocksReceiverAlreadyHas({ ...base, recvMask: bad }).size === 0,
      `10. malformed mask ${JSON.stringify(bad)} ⇒ skip nothing`);
  }
  // A decodable-but-wrong string must not be believed.
  A(blocksReceiverAlreadyHas({ ...base, recvMask: 'zzz', expectedReceived: 8 }).size === 0,
    '10b. a decodable but WRONG mask is rejected by the popcount cross-check');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(8)) }).size === 0,
    '10e. a mask with NO corroborating count is not trusted at all');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(8)), expectedReceived: 8 }).size === 2,
    '10c. a mask that agrees with the server count is trusted');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(8)), expectedReceived: 99 }).size === 0,
    '10d. a mask that disagrees with the server count is distrusted');

  A(blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(CHUNKS)), expectedReceived: CHUNKS, chunkCount: 0 }).size === 0,
    '11. a zero chunk count skips nothing');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(CHUNKS)), expectedReceived: CHUNKS, blockCount: 0 }).size === 0,
    '12. a zero block count skips nothing');

  // An unplanned block must never be skipped.
  const partialPlan = blocksReceiverAlreadyHas({
    ...base, recvMask: maskOf(all(CHUNKS)), expectedReceived: CHUNKS,
    locate: (b) => (b < 2 ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null),
  });
  A(partialPlan.size === 2, '13. blocks the plan does not cover yet are never skipped');
  A(blocksReceiverAlreadyHas({
    ...base, recvMask: maskOf(all(CHUNKS)), expectedReceived: CHUNKS,
    locate: () => { throw new Error('plan blew up'); },
  }).size === 0, '14. a throwing locate() degrades to skipping nothing');

  // 5/9. overlap with what R2 already holds — no double counting
  const skip = blocksToSkip([1, 2], blocksReceiverAlreadyHas({ ...base, recvMask: maskOf(all(8)), expectedReceived: 8 }));
  A(skip.size === 3 && skip.has(0) && skip.has(1) && skip.has(2),
    `15. uploaded{1,2} ∪ receiverHas{0,1} = {0,1,2}, no duplicates (${[...skip]})`);
  A(blocksToSkip([], []).size === 0, '16. both empty ⇒ stage everything');

  // The 280 MB case that prompted this, in block terms.
  {
    const TOT = 293118085;                       // the real transfer's byte count
    const chunks = Math.ceil(TOT / CHUNK);       // 560
    const blocks = Math.ceil(TOT / BLOCK);
    const loc = (b: number) => {
      const off = b * BLOCK;
      if (off >= TOT) return null;
      return { blockPlainOffset: off, blockBytes: Math.min(BLOCK, TOT - off) };
    };
    const got = Math.floor(chunks * 0.74);       // receiver held ~74%
    const bm = new ChunkBitmap(chunks);
    for (let i = 0; i < got; i++) bm.set(i);
    const s = blocksReceiverAlreadyHas({
      recvMask: bm.encode(), expectedReceived: got, chunkCount: chunks, blockCount: blocks, locate: loc, chunkBytes: CHUNK,
    });
    const savedBytes = s.size * BLOCK;
    A(chunks === 560, `17. the real transfer is ${chunks} logical chunks`);
    A(s.size > 0 && s.size < blocks,
      `18. ${s.size}/${blocks} blocks skippable at 74% (~${Math.round(savedBytes / 1048576)} MiB not re-staged)`);
    A(!s.has(blocks - 1), '19. the tail block the receiver still needs is NOT skipped');
  }

  console.log(failures === 0
    ? '\nALL SENDER WORK-LIST CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
