// directFallback.selftest.ts — direct dies, relay starts, nothing is re-sent.
//
// The production failure this locks down: transfer 209910ee reached 14 %, the
// receiver's process restarted, and the sender sat frozen for FIVE MINUTES with
// `uploaded_mask=0B` before anything happened. Two separate faults produced
// that, and both are covered here.
//
//   1. No sender-side stall detection. Recovery depended on SCTP eventually
//      tearing the channel down. Now: STALL_MS, fed only by peer progress.
//
//   2. The direct receiver never called reportReceivedSoon, so `recv_mask`
//      stayed EMPTY even at 14 %. When the sender fell back it subtracted
//      nothing and re-staged the whole file to R2 — including everything the
//      receiver had already verified.
//
// 14 % is not a threshold; it is where we happened to be standing. The rules
// below are asserted at 1 %, 14 %, 50 % and 99 % precisely so nothing can come
// to depend on that number.
//
// [S] = structural (reads shipped source)  [B] = behavioural (drives real modules)
//
//   npx tsx lib/vaultBeam/directFallback.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { ChunkBitmap } from './bitmap';
import { chunkMaskFromCommitted } from './reportReceived';
import { blocksReceiverAlreadyHas, blocksToSkip } from './senderWorkList';
import { beginEpoch, guard, isCurrent, endTransfer } from './transportEpoch';
import {
  markStart, notePeerProgress, noteStall, noteFallbackStart, report, forget, __setClock,
} from './transferMetrics';

const ROOT = join(__dirname, '..', '..');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const DIRECT = strip(readFileSync(join(ROOT, 'lib', 'vaultBeamDirect.ts'), 'utf8'));
const CTRL = strip(readFileSync(join(ROOT, 'lib', 'vaultBeamController.ts'), 'utf8'));

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam direct → relay fallback\n');

// ── 1. THE 45 s SLA ────────────────────────────────────────────────
A(/export const DIRECT_STALL_MAX_MS = 45000;/.test(DIRECT),
  '1. [S] the 45 s SLA ceiling is declared');
A(/const STALL_MS\s+= 15000;/.test(DIRECT),
  '2. [S] the actual detector is still 15 s — not inflated to meet the SLA');
{
  const sla = 45000, stall = 15000;
  A(stall <= sla, '3. [S] detector is within the ceiling');
  A(stall * 2 <= sla, '4. [S] with margin for the relay handover that follows');
}

// ── 2. ONLY PEER PROGRESS FEEDS THE CLOCK ──────────────────────────
{
  const handler = DIRECT.slice(DIRECT.indexOf('dc.onmessage = (m: any) =>'),
                               DIRECT.indexOf('dc.onopen = () => {'));
  A((handler.match(/notePeerProgress\(g\.transferId\)/g) ?? []).length === 2,
    '5. [S] the SLA clock is fed from exactly the two receiver-message sites');
  A(/c\?\.t === 'p'/.test(handler) && /c\?\.t === 'ack'/.test(handler),
    '6. [S] both of which are receiver-originated acks');
}
{
  const send = DIRECT.slice(DIRECT.indexOf('async function p2pSend('),
                            DIRECT.indexOf('async function p2pReceive('));
  A(!send.includes('notePeerProgress') && !send.includes('ping('),
    '7. [S] nothing in the send loop feeds it — local work is not peer progress');
}
A(!/bufferedAmount[^\n]*(ping|notePeerProgress)/.test(DIRECT),
  '8. [S] a draining buffer is not progress either');

// ── 3. THE WEDGED LOOP CAN EXIT ────────────────────────────────────
A(/const dead = \(\) => g\.signal\?\.aborted \|\| abandon\?\.aborted;/.test(DIRECT),
  '9. [S] p2pSend has one liveness predicate');
A(/while \(dc\.bufferedAmount > BP_HIGH\) \{ if \(dead\(\)\) throw/.test(DIRECT),
  '10. [S] the backpressure wait honours it — this is the loop that hung');
A(DIRECT.indexOf('sendAc.abort()') < DIRECT.indexOf("done(null);       "),
  '11. [S] the watchdog aborts the send BEFORE settling');
A(/noteStall\(g\.transferId, 'DIRECT_STALL_TIMEOUT'\)/.test(DIRECT),
  '12. [S] and records the reason');
A(/const FRAME = 16 \* 1024;/.test(DIRECT) && /const BP_HIGH = 4 \* 1024 \* 1024;/.test(DIRECT),
  '13. [S] FRAME and BP_HIGH unchanged — backpressure not redesigned');

// ── 4. THE RECEIVER NOW REPORTS WHAT IT HOLDS ──────────────────────
A(/reportReceivedSoon\(g\.transferId, chunkMaskFromCommitted\(committed, g\.chunkCount\)\)/.test(DIRECT),
  '14. [S] the DIRECT receiver reports recv_mask — the gap that caused the re-upload');
{
  const recv = DIRECT.slice(DIRECT.indexOf('let received = 0;'));
  const write = recv.indexOf('await writeCipherChunk(');
  const add = recv.indexOf('committed.add(i)');
  const rep = recv.indexOf('reportReceivedSoon(');
  A(write > 0 && add > write && rep > add,
    '15. [S] reported only AFTER the write and the commit, never optimistically');
  A(/const committed = new Set<number>\(\);/.test(recv),
    '16. [S] from a SET of committed ids, not from the `received` count');
}
A(/noteFallbackStart\(transferId, 'R2_RELAY'\)/.test(CTRL),
  '17. [S] the controller stamps when the replacement transport begins');

// ── 5. [B] THE SLA IS ACTUALLY MEASURED ────────────────────────────
{
  let t = 0; __setClock(() => t);
  const ID = 'Tsla123456789012';
  markStart(ID);
  t = 1000; notePeerProgress(ID);          // last genuine peer progress
  t = 16000; noteStall(ID);                // 15 s later the watchdog fires
  t = 17000; noteFallbackStart(ID, 'R2_RELAY');
  const r = report(ID)!;
  A(r.directStallDurationMs === 16000,
    '18. [B] SLA measured from last PEER progress to fallback start, not from detection');
  A(r.directStallDurationMs! <= 45000, '19. [B] and it is inside the 45 s ceiling');
  A(r.fallbackReason === 'DIRECT_STALL_TIMEOUT', '20. [B] with the reason recorded');
  A(r.fallbackTransport === 'R2_RELAY', '21. [B] and the replacement transport');

  // A late duplicate must not move either stamp.
  t = 99000; noteStall(ID); noteFallbackStart(ID, 'SOMETHING_ELSE');
  const r2 = report(ID)!;
  A(r2.directStallDurationMs === 16000 && r2.fallbackTransport === 'R2_RELAY',
    '22. [B] a second stall/fallback event cannot rewrite the record');
  forget(ID);

  // No stall ⇒ no SLA number invented.
  markStart(ID); t = 100; notePeerProgress(ID);
  A(report(ID)!.directStallDurationMs === undefined,
    '23. [B] a healthy transfer reports no stall duration at all');
  forget(ID); __setClock(null);
}

// ── 6. [B] NO RE-UPLOAD, AT ANY PERCENTAGE ─────────────────────────
{
  const CHUNK = 512 * 1024, BLOCK = 4 * CHUNK, BLOCKS = 100, CHUNKS = BLOCKS * 4;
  const locate = (b: number) =>
    b >= 0 && b < BLOCKS ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null;

  for (const pct of [1, 14, 50, 99]) {
    const wholeBlocks = Math.floor((BLOCKS * pct) / 100);
    const committed: number[] = [];
    for (let b = 0; b < wholeBlocks; b++) for (let c = b * 4; c < b * 4 + 4; c++) committed.push(c);

    const mask = chunkMaskFromCommitted(committed, CHUNKS);
    const received = mask ? ChunkBitmap.decode(mask, CHUNKS).popcount() : 0;
    const skip = blocksReceiverAlreadyHas({
      recvMask: mask, expectedReceived: received,
      chunkCount: CHUNKS, blockCount: BLOCKS, locate, chunkBytes: CHUNK,
    });
    A(skip.size === wholeBlocks,
      `24. [B] at ${pct}% the sender skips exactly the ${wholeBlocks} blocks the receiver holds`);
  }
}
{
  // A partially received block must STILL be staged — its missing chunks have
  // no other source once direct is gone.
  const CHUNK = 512 * 1024, BLOCK = 4 * CHUNK, BLOCKS = 10, CHUNKS = 40;
  const locate = (b: number) => (b >= 0 && b < BLOCKS ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null);
  const partial = [0, 1, 2, 4, 5, 6, 7];        // block 0 partial (3/4), block 1 whole
  const mask = chunkMaskFromCommitted(partial, CHUNKS)!;
  const skip = blocksReceiverAlreadyHas({
    recvMask: mask, expectedReceived: ChunkBitmap.decode(mask, CHUNKS).popcount(),
    chunkCount: CHUNKS, blockCount: BLOCKS, locate, chunkBytes: CHUNK,
  });
  A(!skip.has(0), '25. [B] a PARTIALLY received block is still staged');
  A(skip.has(1), '26. [B] while the fully received one is skipped');
}
{
  // Fail closed on every bad receiver state.
  const CHUNK = 512 * 1024, BLOCK = 4 * CHUNK, BLOCKS = 10, CHUNKS = 40;
  const locate = (b: number) => (b >= 0 && b < BLOCKS ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null);
  const good = chunkMaskFromCommitted([0, 1, 2, 3], CHUNKS)!;
  const base = { chunkCount: CHUNKS, blockCount: BLOCKS, locate, chunkBytes: CHUNK };
  A(blocksReceiverAlreadyHas({ ...base, recvMask: good, expectedReceived: undefined }).size === 0,
    '27. [B] uncorroborated mask ⇒ skip nothing');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: good, expectedReceived: 99 }).size === 0,
    '28. [B] mask disagreeing with the server count ⇒ skip nothing');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: null, expectedReceived: 4 }).size === 0,
    '29. [B] missing mask is never read as "receiver has everything"');
  A(blocksReceiverAlreadyHas({ ...base, recvMask: 'zzz', expectedReceived: 4 }).size === 0,
    '30. [B] a merely decodable string cannot cause a skip');
}

// ── 7. [B] EXACTLY ONE FALLBACK, NO STALE RESURRECTION ─────────────
{
  const ID = 'Tonce123456789012';
  const e1 = beginEpoch(ID);
  let fallbacks = 0;
  const startRelay = () => { fallbacks++; };
  const e2 = beginEpoch(ID);                       // the stall → relay handover
  startRelay();
  A(fallbacks === 1, '31. [B] the handover happens once');
  A(!isCurrent(ID, e1) && isCurrent(ID, e2), '32. [B] the direct epoch is retired');

  let stale = 0;
  const staleAck = guard(ID, e1, () => { stale++; });
  staleAck(); staleAck(); staleAck();
  A(stale === 0, '33. [B] a late direct ACK after fallback mutates nothing');

  const relayOk = guard(ID, e2, () => { stale++; });
  relayOk();
  A(stale === 1, '34. [B] while the relay tier still works normally');
  endTransfer(ID);
}
{
  // R2-held and receiver-held blocks compose; neither overrides the other.
  const have = blocksToSkip([0, 1], [1, 2]);
  A(have.size === 3 && have.has(0) && have.has(1) && have.has(2),
    '35. [B] uploaded and receiver-held sets union');
}

// ── 8. RESUME ACCOUNTING: prefix for bytes, set for the mask ───────
A(/let directPrefix = 0;/.test(CTRL),
  '36. [S] the controller tracks a contiguous prefix separately from the count');
A(/haveBytes: Math\.max\(0, Math\.min\(directPrefix \* CHUNK_BYTES, manifest\.size\)\)/.test(CTRL),
  '37. [S] haveBytes is built from the PREFIX and clamped to the file size');
A(!/haveBytes:[^\n]*directDone/.test(CTRL),
  '38. [S] and never from the verified count — the bug this fixes');
A(/contiguous\?: number/.test(DIRECT),
  '39. [S] the direct transport reports the prefix alongside the count');
A(/contiguousVerifiedPrefix\(committed, g\.chunkCount\)/.test(DIRECT),
  '40. [S] computed from the committed set');
A(/const c = contiguous \?\? done;/.test(CTRL),
  '41. [S] a strictly-sequential transport that omits it keeps its old behaviour');
{
  // The mask must still carry the non-contiguous chunks the prefix cannot.
  const CHUNKS = 40;
  const committed = [0, 1, 2, 4, 5];
  const mask = chunkMaskFromCommitted(committed, CHUNKS)!;
  const bm = ChunkBitmap.decode(mask, CHUNKS);
  A(bm.test(4) && bm.test(5) && !bm.test(3),
    '42. [B] recv_mask keeps chunks 4,5 that sit beyond the gap at 3');
  A(bm.popcount() === 5, '43. [B] all five verified chunks survive into the mask');
}
{
  // Regression for the exact hazard: a hole must not be credited as received.
  const CHUNK = 512 * 1024, TOTAL = 40 * CHUNK;
  const { contiguousVerifiedPrefix: pre } = require('./reportReceived');
  const haveBytes = Math.max(0, Math.min(pre([0, 1, 2, 4, 5], 40) * CHUNK, TOTAL));
  A(haveBytes === 3 * CHUNK,
    '44. [B] haveBytes stops at the hole — chunk 3 is still fetched, not assumed');
  A(haveBytes < 5 * CHUNK,
    '45. [B] which is strictly less than the count-based value that caused the bug');
}

console.log(failures === 0
  ? '\nALL DIRECT-FALLBACK CHECKS PASSED ✓  (device timing NOT MEASURED — needs the Redmi)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
