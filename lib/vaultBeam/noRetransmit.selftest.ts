// noRetransmit.selftest.ts — §13, the scenario spelled out:
//
//     receiver commits chunk 10
//        -> vb_have nudges the sender
//        -> the direct transport fails
//        -> the transfer switches transport and reconnects
//        -> chunk 10 MUST NOT be transmitted again
//
// This drives the REAL modules end to end — chunkMaskFromBlocks (receiver ->
// mask), blocksReceiverAlreadyHas (mask -> skippable blocks), blocksToSkip
// (union with what R2 holds) and transportEpoch (the reconnect) — rather than
// re-implementing the arithmetic. A test that recomputed the rule would agree
// with itself no matter what the shipped code did.
//
// The scenario is run as an ACCOUNT of one transfer, so each step can assert on
// the state the previous step actually produced.
//
//   npx tsx lib/vaultBeam/noRetransmit.selftest.ts

import { ChunkBitmap } from './bitmap';
import { chunkMaskFromBlocks } from './reportReceived';
import { blocksReceiverAlreadyHas, blocksToSkip } from './senderWorkList';
import { beginEpoch, guard, endTransfer, isCurrent } from './transportEpoch';

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

const CHUNK = 512 * 1024;
const BLOCK = 4 * CHUNK;          // 2 MiB = 4 logical chunks
const BLOCKS = 8;
const CHUNKS = BLOCKS * 4;        // 32 logical chunks
const TID = 'Tnoretx123456789';
const locate = (b: number) =>
  b >= 0 && b < BLOCKS ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null;

/** Every chunk the sender actually put on a wire, in order, across all epochs. */
const transmitted: { chunk: number; epoch: number }[] = [];

/**
 * The sender's real decision procedure, exactly as vaultBeamTransfer derives it:
 * stage every block except those R2 holds and those the receiver already holds.
 */
function senderWork(recvMask: string | null, serverReceived: number | undefined, uploaded: number[]): number[] {
  const receiverHas = blocksReceiverAlreadyHas({
    recvMask, expectedReceived: serverReceived,
    chunkCount: CHUNKS, blockCount: BLOCKS, locate, chunkBytes: CHUNK,
  });
  const skip = blocksToSkip(uploaded, receiverHas);
  const work: number[] = [];
  for (let b = 0; b < BLOCKS; b++) if (!skip.has(b)) work.push(b);
  return work;
}

function transmit(blocks: number[], epoch: number): void {
  for (const b of blocks) for (let c = b * 4; c < b * 4 + 4; c++) transmitted.push({ chunk: c, epoch });
}

console.log('\nVaultBeam §13 — a committed chunk is never sent twice\n');

// ── EPOCH 1: DIRECT. The receiver commits block 2 (chunks 8-11). ───
const e1 = beginEpoch(TID);
A(e1 === 1, '1. the direct attempt opens as epoch 1');

const committed = new Set<number>([2]);        // block 2 => chunks 8,9,10,11
const mask = chunkMaskFromBlocks(committed, locate, CHUNK, CHUNKS);
A(mask !== null, '2. the receiver derives a mask from its committed blocks');
const bm = ChunkBitmap.decode(mask!, CHUNKS);
A(bm.test(10), '3. and chunk 10 is genuinely in it');
const serverReceived = bm.popcount();
A(serverReceived === 4, '4. the server records the 4 chunks that block covers');

transmit(senderWork(null, undefined, []), e1);   // before any nudge: everything
A(transmitted.some((t) => t.chunk === 10), '5. epoch 1 did transmit chunk 10 (nothing known yet)');
const sentInE1 = transmitted.length;

// ── vb_have arrives. It must only re-derive, never send. ───────────
const afterNudge = senderWork(mask, serverReceived, []);
A(!afterNudge.includes(2), '6. after vb_have the sender drops block 2 from its work-list');
A(afterNudge.length === BLOCKS - 1, '7. and drops exactly that one block, not more');
A(transmitted.length === sentInE1, '8. the nudge itself transmitted nothing');

// ── EPOCH 2: the direct tier fails; reconnect on another transport ─
const e2 = beginEpoch(TID);
A(e2 === 2 && !isCurrent(TID, e1), '9. reconnecting opens epoch 2 and retires epoch 1');

transmit(senderWork(mask, serverReceived, []), e2);

// ── THE ASSERTION THE WHOLE FILE EXISTS FOR ────────────────────────
const e2chunks = transmitted.filter((t) => t.epoch === e2).map((t) => t.chunk);
A(!e2chunks.includes(10),
  '10. chunk 10 is NOT retransmitted after the transport switch');
for (const c of [8, 9, 11]) {
  A(!e2chunks.includes(c), `11. nor is chunk ${c}, the rest of the committed block`);
}
A(e2chunks.length === (BLOCKS - 1) * 4,
  '12. every OTHER chunk is still transmitted — nothing was silently dropped');

// ── partial blocks must NOT be skipped ─────────────────────────────
// The receiver holds chunk 20 only (block 5 covers 20-23). Skipping block 5
// would strand 21-23 with no source anywhere.
{
  const partial = new ChunkBitmap(CHUNKS);
  partial.set(20);
  const work = senderWork(partial.encode(), 1, []);
  A(work.includes(5), '13. a block the receiver only PARTLY holds is still staged');
}

// ── corroboration is mandatory ─────────────────────────────────────
A(senderWork(mask, undefined, []).includes(2),
  '14. an uncorroborated mask skips nothing, even though it decodes');
A(senderWork(mask, 99, []).includes(2),
  '15. a mask disagreeing with the server count skips nothing');
A(senderWork('zzz', 4, []).includes(2),
  '16. a merely decodable string cannot cause a skip');
A(senderWork(null, 4, []).includes(2), '17. an absent mask skips nothing');

// ── R2 and receiver knowledge compose ──────────────────────────────
{
  const work = senderWork(mask, serverReceived, [0, 1]);
  A(!work.includes(0) && !work.includes(1), '18. blocks already on R2 are skipped');
  A(!work.includes(2), '19. and the receiver-held block still is too');
  A(work.length === BLOCKS - 3, '20. the two sources union rather than override');
}

// ── a stale epoch cannot resurrect work ────────────────────────────
{
  let staleSent = 0;
  const staleTransmit = guard(TID, e1, () => { staleSent++; });
  staleTransmit(); staleTransmit();
  A(staleSent === 0, '21. the abandoned tier cannot transmit after the switch');
}

// ── no duplicates anywhere in the whole account ────────────────────
{
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const t of transmitted) { if (seen.has(t.chunk)) dupes.add(t.chunk); seen.add(t.chunk); }
  A(!dupes.has(10), '22. across BOTH epochs, chunk 10 went out exactly once');
  A([...dupes].every((c) => !bm.test(c)),
    '23. no chunk the receiver had committed was ever sent twice');
}

endTransfer(TID);

// ── STRUCTURAL: the guarantee above only holds if the live path is wired ──
// The scenario proves the RULE. These prove the shipped code applies it, so a
// future edit cannot quietly leave the modules correct and the transfer unguarded.
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const root = join(__dirname, '..', '..');
  const CTRL = readFileSync(join(root, 'lib', 'vaultBeamController.ts'), 'utf8');
  const DIRECT = readFileSync(join(root, 'lib', 'vaultBeamDirect.ts'), 'utf8');

  A((CTRL.match(/beginEpoch\(transferId\)/g) ?? []).length >= 4,
    '24. both roles open an epoch for direct AND bump it before the relay tier');
  A((CTRL.match(/epochGuard\(transferId,\s*directEpoch/g) ?? []).length === 2,
    '25. both direct progress callbacks are epoch-guarded');
  A(/endEpochs\(id\)/.test(CTRL),
    '26. epochs are released on terminal state');

  // The teardown half: losing the stall race must actually close the tier.
  A(/abandon\?: AbortSignal/.test(DIRECT),
    '27. p2pReceive accepts an abandonment signal');
  A(/abandon2\.abort\(\)/.test(DIRECT),
    '28. and the stall path aborts it, so the pc `finally` runs and closes');
  A(/if \(g\.abandon\.aborted\) \{ done\(false\); return; \}/.test(DIRECT),
    '29. an already-abandoned tier never even starts');
  // lastIndexOf: serveDirect has its own `settled`, and slicing from THAT one
  // would compare against the wrong function's async block entirely.
  const exec = DIRECT.slice(DIRECT.lastIndexOf('let settled = false;'));
  A(exec.indexOf('g.abandon') < exec.indexOf('(async () =>'),
    '30. the abandon listener registers BEFORE ICE setup, so an early stall is caught');
}

console.log(failures === 0
  ? '\nALL NO-RETRANSMIT CHECKS PASSED ✓  (device proof still required)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
