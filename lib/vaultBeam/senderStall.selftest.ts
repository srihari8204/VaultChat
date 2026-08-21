// senderStall.selftest.ts — the sender must not hang on a dead receiver.
//
// # THE DEFECT THIS LOCKS DOWN
//
// Production transfer 209910ee…, 780,243,403 bytes, 1489 chunks. The receiver's
// process restarted mid-stream. The sender sat at "Sending direct… 14% · 1.3
// MB/s" for five minutes with `uploaded_mask=0B` on the relay: direct never
// terminated, so the R2 fallback — the thing that makes delivery guaranteed —
// never ran. The transfer could neither complete nor fail.
//
// Three escape hatches existed and none covered it:
//
//   1. `setTimeout(... , CONNECT_MS)` is gated on `!connected`, inert once a
//      tier connects. Its own comment says so.
//   2. the `vaultbeam_tier -> relay` bailout needs the RECEIVER to emit it, and
//      the receiver was gone.
//   3. p2pSend's `while (dc.bufferedAmount > BP_HIGH) await sleep(15)` — SCTP
//      cannot drain to a dead peer, so bufferedAmount stays pinned forever.
//
// The receiver had `stallGuard(STALL_MS)` on both its tiers. The sender had
// nothing. That asymmetry was the bug.
//
// # WHY THIS FILE IS PART STRUCTURAL
//
// `vaultBeamDirect.ts` imports react-native, so it cannot be loaded under tsx,
// and `stallGuard` is module-private. Rather than clone it — a copy would agree
// with itself no matter what shipped — the stall wiring is asserted against the
// real SOURCE, and everything genuinely loadable (transportEpoch,
// senderWorkList, reportReceived) is driven as the real module.
//
// Each check below is labelled [S] structural or [B] behavioural, so nothing
// here can be mistaken for device evidence. Device proof is separate.
//
//   npx tsx lib/vaultBeam/senderStall.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { beginEpoch, guard, isCurrent, endTransfer } from './transportEpoch';
import { blocksReceiverAlreadyHas } from './senderWorkList';

const ROOT = join(__dirname, '..', '..');
const raw = (f: string) => readFileSync(join(ROOT, 'lib', f), 'utf8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const DIRECT = strip(raw('vaultBeamDirect.ts'));
const XFER = strip(raw('vaultBeamTransfer.ts'));
const CTRL = strip(raw('vaultBeamController.ts'));

/** p2pSend's body, so assertions cannot be satisfied by the receive path. */
const SEND_BODY = (() => {
  const i = DIRECT.indexOf('async function p2pSend(');
  const j = DIRECT.indexOf('async function p2pReceive(', i);
  return i < 0 ? '' : DIRECT.slice(i, j > i ? j : DIRECT.length);
})();

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nVaultBeam sender stall — a dead receiver must not freeze the sender\n');

// ── 1-4. THE WATCHDOG EXISTS, AND STARTS AT CONNECT ────────────────
A(/sendGuard = stallGuard\(STALL_MS\)/.test(DIRECT),
  '1. [S] the sender arms a stall watchdog');
A(/const STALL_MS\s*=\s*15000;/.test(DIRECT),
  '2. [S] using the existing STALL_MS, no invented timeout');
{
  const open = DIRECT.indexOf('dc.onopen = () => {');
  const arm = DIRECT.indexOf('sendGuard = stallGuard(STALL_MS)');
  A(open > 0 && arm > open,
    '3. [S] armed inside dc.onopen — CONNECT_MS covers everything before that');
}
A(/setTimeout\(\(\) => \{ if \(!connected\) done\(null\); \}, CONNECT_MS\)/.test(DIRECT),
  '4. [S] the pre-connect CONNECT_MS guard is still there, unchanged');

// ── 5-8. FED ONLY BY PROOF THE PEER IS ALIVE ───────────────────────
{
  // Every ping must sit in the {t:'p'} / {t:'ack'} message handler.
  const pings = (DIRECT.match(/sendGuard\?\.ping\(\)/g) ?? []).length;
  A(pings === 2, '5. [S] exactly two ping sites: verified-chunk ack and delivery ack');

  const handler = DIRECT.slice(DIRECT.indexOf('dc.onmessage = (m: any) =>'),
                               DIRECT.indexOf('dc.onopen = () => {'));
  A((handler.match(/sendGuard\?\.ping\(\)/g) ?? []).length === 2,
    '6. [S] and BOTH are inside the receiver-message handler');
  A(/c\?\.t === 'p'/.test(handler) && /c\?\.t === 'ack'/.test(handler),
    '7. [S] which only fires on messages the receiver sent');
}
A(!/bufferedAmount[^\n]*ping|ping[^\n]*bufferedAmount/.test(DIRECT),
  '8. [S] bufferedAmount never feeds the watchdog — a full buffer is not progress');
A(!SEND_BODY.includes('ping('),
  '9. [S] nor does anything in p2pSend: reading or encrypting locally proves nothing');

// ── 10-13. THE BACKPRESSURE WAIT IS INTERRUPTIBLE ──────────────────
A(/const dead = \(\) => g\.signal\?\.aborted \|\| abandon\?\.aborted;/.test(SEND_BODY),
  '10. [S] p2pSend has one liveness predicate covering abort AND stall');
A(/while \(dc\.bufferedAmount > BP_HIGH\) \{ if \(dead\(\)\) throw/.test(SEND_BODY),
  '11. [S] the backpressure loop honours it — this is the wait that hung');
A(/for \(let i = 0; i < g\.chunkCount; i\+\+\) \{\s*if \(dead\(\)\) throw/.test(SEND_BODY),
  '12. [S] and so does the per-chunk loop');
A(/sendAc\.abort\(\);/.test(DIRECT) &&
  DIRECT.indexOf('sendAc.abort()') < DIRECT.indexOf('done(null);       '),
  '13. [S] the watchdog aborts the send BEFORE settling, so the loop actually exits');

// ── 14-16. STREAMING IS PRESERVED ──────────────────────────────────
A(/const BP_HIGH = 4 \* 1024 \* 1024;/.test(DIRECT), '14. [S] BP_HIGH still 4 MiB');
A(/const FRAME = 16 \* 1024;/.test(DIRECT), '15. [S] FRAME still 16 KiB');
A(!/await\s+ackFor\(|await\s+waitChunkAck\(/.test(SEND_BODY),
  '16. [S] no per-chunk await was introduced — the pipeline is not serialized');

// ── 17-19. ONE TERMINAL RESULT: SUCCESS / STALL / CANCEL RACES ─────
{
  // Everything must funnel through the same latched done().
  const latch = /const done = \(v: 'lan' \| 'p2p' \| null\) => \{ if \(!settled\) \{ settled = true; resolve\(v\); \} \};/;
  A(latch.test(DIRECT), '17. [S] done() is latched — first caller wins');
  A(/sendGuard\.promise\.then\(\(\) => \{[\s\S]*?done\(null\);[\s\S]*?\}\)/.test(DIRECT),
    '18. [S] the stall path resolves through that same latch, not a separate exit');
  A(/p2pSend\(dc, g, ackP, sendAc\.signal\)\.then\(\(\) => done\('p2p'\)\)\.catch\(\(\) => done\(null\)\)/.test(DIRECT),
    '19. [S] so a completion landing as the watchdog fires still yields one result');
  A(/g\.signal\?\.addEventListener\?\.\('abort', \(\) => done\(null\)\)/.test(DIRECT),
    '20. [S] and user cancellation uses the same latch — no fallback after cancel');
}

// ── 21-22. NO LEAKED TIMER OR LISTENER ─────────────────────────────
A(/cleanups\.push\(\(\) => \{ sendGuard\?\.cancel\(\); sendAc\.abort\(\); \}\);/.test(DIRECT),
  '21. [S] the watchdog is cancelled on every exit path via cleanups');
A(/for \(const c of cleanups\) \{ try \{ c\(\); \} catch \{\} \}/.test(DIRECT),
  '22. [S] and cleanups always run before serveDirect returns');

// ── 23-26. FALLBACK DESTROYS NOTHING ───────────────────────────────
for (const forbidden of ['relayComplete(', 'clearRecvBitmap(', 'newTransferId', 'chunkCount = 0']) {
  A(!DIRECT.includes(forbidden),
    `23. [S] the direct path never calls ${forbidden} — a stall must not finalize or reset`);
}
// This assertion used to match `directDone * CHUNK_BYTES` while calling it a
// "prefix". It was not one: directDone counts verified chunks, which can contain
// gaps. The expression it now pins is the contiguous prefix, which is the only
// value that may legally become a byte offset.
A(/haveBytes: Math\.max\(0, Math\.min\(directPrefix \* CHUNK_BYTES, manifest\.size\)\)/.test(CTRL),
  '24. [S] the receiver carries its CONTIGUOUS prefix into the relay tier');
A(!/haveBytes:[^\n]*directDone/.test(CTRL),
  '24b. [S] and never the raw verified count');
{
  const shaAt = XFER.indexOf('expectedSha256');
  const completeAt = XFER.indexOf('await relayComplete(');
  A(shaAt > 0 && completeAt > shaAt,
    '25. [S] the whole-file digest is still gated BEFORE relayComplete');
  A(/if \(!verified\) throw new Error\('sha256 mismatch/.test(XFER),
    '26. [S] and a mismatch throws, so the relay copy is never purged');
}

// ── 27-31. [B] REAL MODULES: epoch + work-list after a stall ───────
{
  const TID = 'Tstall1234567890';
  const e1 = beginEpoch(TID);                 // DIRECT
  let staleWrites = 0;
  const staleProgress = guard(TID, e1, () => { staleWrites++; });

  const e2 = beginEpoch(TID);                 // stall -> relay
  A(e2 === e1 + 1, '27. [B] the fallback opens a new transport epoch');
  A(!isCurrent(TID, e1), '28. [B] the stalled direct attempt is retired');

  staleProgress(); staleProgress();
  A(staleWrites === 0,
    '29. [B] a late direct callback after the stall mutates nothing');

  // Fail-closed work-list: no corroboration ⇒ skip nothing.
  const CHUNK = 512 * 1024, BLOCK = 4 * CHUNK;
  const locate = (b: number) => (b >= 0 && b < 4 ? { blockPlainOffset: b * BLOCK, blockBytes: BLOCK } : null);
  const noCount = blocksReceiverAlreadyHas({
    recvMask: 'zzz', expectedReceived: undefined,
    chunkCount: 16, blockCount: 4, locate, chunkBytes: CHUNK,
  });
  A(noCount.size === 0,
    '30. [B] after a stall, an uncorroborated receiver mask skips NOTHING');
  const absent = blocksReceiverAlreadyHas({
    recvMask: null, expectedReceived: 8,
    chunkCount: 16, blockCount: 4, locate, chunkBytes: CHUNK,
  });
  A(absent.size === 0,
    '31. [B] and a missing mask is never read as "receiver has everything"');
  endTransfer(TID);
}

console.log(failures === 0
  ? '\nALL SENDER-STALL CHECKS PASSED ✓  ([S] structural, [B] behavioural — DEVICE PROOF SEPARATE)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
