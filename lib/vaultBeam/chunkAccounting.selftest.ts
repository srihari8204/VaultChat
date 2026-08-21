// chunkAccounting.selftest.ts — every logical chunk accounted for, exactly once.
//
// The hard requirement is not "transfers usually work". It is:
//
//     expected == verified,  missing == 0,  duplicate == 0
//
// and completion must be IMPOSSIBLE while any of that is false. This exercises
// the real ChunkBitmap and the real physical-block mapping against the failure
// modes that would otherwise be discovered by a user with a corrupt file:
// duplicate delivery, out-of-order delivery, out-of-range indices, a dropped
// chunk, and a physical block whose logical chunks only partly arrived.
//
// PURE — no transport, no storage, no crypto. It asserts the ACCOUNTING model,
// which is what decides whether a transfer may be declared complete.
//
//   npx tsx lib/vaultBeam/chunkAccounting.selftest.ts

import { ChunkBitmap, chunkCountFor, CHUNK_BYTES } from './bitmap';
import { chunksPerBlock, SUPPORTED_BLOCK_BYTES } from './blockSize';

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam logical chunk accounting\n');

// ── the accounting model ───────────────────────────────────────────
const FILE = 37 * CHUNK_BYTES + 1234;          // 37 whole chunks + a partial tail
const expected = chunkCountFor(FILE);
A(expected === 38, `1. expected chunk count from size alone (${expected})`);

// ── 6/14. DUPLICATE DELIVERY IS EXACTLY ONCE ───────────────────────
{
  const bm = new ChunkBitmap(expected);
  const first = bm.set(10);
  const second = bm.set(10);
  const third = bm.set(10);
  A(first === true, '2. the first delivery of chunk 10 is NEW');
  A(second === false && third === false, '3. repeat deliveries report DUPLICATE, not new');
  A(bm.popcount() === 1, '4. three deliveries of one chunk leave popcount 1, not 3');
  A(bm.test(10), '5. and the bit is set');
}

// ── 15. OUT-OF-ORDER DELIVERY ──────────────────────────────────────
{
  const bm = new ChunkBitmap(expected);
  for (const i of [5, 2, 9, 0, 4, 37, 18, 3, 1]) bm.set(i);
  A(bm.popcount() === 9, '6. out-of-order arrivals are each counted once');
  for (const i of [5, 2, 9, 0, 4, 37, 18, 3, 1]) {
    if (!bm.test(i)) { A(false, `6b. chunk ${i} recorded`); break; }
  }
  A(bm.test(37), '7. the final partial chunk is a chunk like any other');
  A(!bm.isFull(), '8. and arrival order does not fake completeness');
}

// ── 6. OUT-OF-RANGE IS REJECTED, NOT SILENTLY ACCEPTED ─────────────
{
  const bm = new ChunkBitmap(expected);
  for (const bad of [-1, expected, expected + 1, 1e9]) {
    A(bm.set(bad) === false, `9. set(${bad}) is refused as out of range`);
    A(bm.test(bad) === false, `10. test(${bad}) is false, never a phantom hit`);
  }
  A(bm.popcount() === 0, '11. no out-of-range write reached the bitmap');
}

// ── 4/16. A MISSING CHUNK MAKES COMPLETION IMPOSSIBLE ──────────────
{
  const bm = new ChunkBitmap(expected);
  for (let i = 0; i < expected; i++) if (i !== 23) bm.set(i);
  A(bm.popcount() === expected - 1, '12. 37 of 38 chunks received');
  A(!bm.isFull(), '13. ONE missing chunk blocks completion');
  const missing: number[] = [];
  for (let i = 0; i < expected; i++) if (!bm.test(i)) missing.push(i);
  A(missing.length === 1 && missing[0] === 23,
    `14. the missing chunk is identifiable for diagnostics (${JSON.stringify(missing)})`);
  bm.set(23);
  A(bm.isFull() && bm.popcount() === expected,
    '15. supplying it — and only it — completes the set');
}

// ── 17. A REJECTED (corrupt) CHUNK LEAVES ITS BIT CLEAR ────────────
//
// Integrity is enforced upstream by AES-GCM; what matters HERE is that a
// rejected chunk must never reach the bitmap, so a failed verification cannot
// advance completion.
{
  const bm = new ChunkBitmap(expected);
  const verify = (i: number, ok: boolean) => { if (ok) bm.set(i); };
  for (let i = 0; i < expected; i++) verify(i, i !== 12);   // chunk 12 fails its tag
  A(!bm.test(12), '16. a chunk that failed verification is NOT marked complete');
  A(!bm.isFull(), '17. so the transfer cannot be declared complete');
  A(bm.popcount() === expected - 1, '18. and nothing else was disturbed');
}

// ── 8. PHYSICAL BLOCK → LOGICAL CHUNKS ─────────────────────────────
{
  const want = [1, 2, 4, 8, 16];   // 512K 1M 2M 4M 8M, in 512 KiB logical chunks
  SUPPORTED_BLOCK_BYTES.forEach((b, i) => {
    A(chunksPerBlock(b) === want[i], `19. a ${b / 1024} KB block carries ${want[i]} logical chunk(s)`);
    A(b % CHUNK_BYTES === 0, `20. and is a whole number of them`);
  });

  // A PARTIALLY received physical block must not complete any of its chunks.
  const bm = new ChunkBitmap(expected);
  const blockBytes = 2097152;                    // 4 logical chunks
  const per = chunksPerBlock(blockBytes);
  const firstChunkOfBlock = 8;
  // only 2 of the block's 4 chunks verified
  bm.set(firstChunkOfBlock); bm.set(firstChunkOfBlock + 1);
  let full = true;
  for (let k = 0; k < per; k++) if (!bm.test(firstChunkOfBlock + k)) full = false;
  A(!full, '21. a half-delivered 2048 KB block completes none of its 4 chunks as a unit');
  A(bm.popcount() === 2, '22. only the chunks that actually verified are counted');
}

// ── 9/10. A TRANSPORT SWITCH MUST NOT LOSE A BIT ───────────────────
//
// Modelled the way the code does it: the bitmap is the transfer's single truth,
// carried across transports by value, never rebuilt from the transport.
{
  const bm = new ChunkBitmap(expected);
  for (let i = 0; i <= 14; i++) bm.set(i);                    // LAN
  const afterLan = bm.popcount();
  const wire = bm.encode();                                   // persist / hand over
  const afterSwitch = ChunkBitmap.decode(wire, expected);     // WebRTC picks it up
  A(afterSwitch.popcount() === afterLan, '23. a transport handover preserves every bit');
  for (let i = 15; i <= 25; i++) afterSwitch.set(i);          // WebRTC
  const toTurn = ChunkBitmap.decode(afterSwitch.encode(), expected);
  for (let i = 26; i <= 32; i++) toTurn.set(i);               // TURN
  const toR2 = ChunkBitmap.decode(toTurn.encode(), expected);
  for (let i = 33; i < expected; i++) toR2.set(i);            // R2
  A(toR2.isFull(), '24. four transports, one continuous bitmap, no gaps');
  A(toR2.popcount() === expected, '25. expected == verified after the full chain');
  let holes = 0;
  for (let i = 0; i < expected; i++) if (!toR2.test(i)) holes++;
  A(holes === 0, '26. missing chunks == 0');
}

// ── 11/12/13. NO UNNECESSARY RE-DOWNLOAD ───────────────────────────
//
// The work-list is derived from the bitmap, so anything already verified is
// never requested again — that is what makes a reload cheap.
{
  const bm = new ChunkBitmap(expected);
  for (let i = 0; i < 20; i++) bm.set(i);
  const restored = ChunkBitmap.decode(bm.encode(), expected); // UI reload / process restart
  const pending: number[] = [];
  for (let i = 0; i < expected; i++) if (!restored.test(i)) pending.push(i);
  A(pending.length === expected - 20, '27. a restored session asks only for what is missing');
  A(pending[0] === 20, '28. and resumes at the first incomplete chunk, not chunk 0');
  A(!pending.includes(0) && !pending.includes(19),
    '29. no already-verified chunk is scheduled for re-download');
}

console.log(failures === 0
  ? '\nALL CHUNK-ACCOUNTING CHECKS PASSED ✓  (device evidence separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
