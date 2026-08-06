// lib/vaultBeamTransfer.ts — VaultBeam Tier-3 orchestrator.
//
// Drives a whole file over the R2 relay by pairing the native byte pipeline
// (lib/vaultBeamStreamNative) with the relay control plane (lib/vaultbeamRelay).
// JS orchestrates block indices + presigned URLs; every file byte + all crypto
// stays native, so this scales to the full 12 GB cap without touching the JS heap.
//
// Resumable: both directions reconcile against the server's uploaded-block bitmask
// on every batch, so a killed transfer picks up exactly where it stopped. Neither
// side ever hands the relay a plaintext byte, the key, the filename, or the mime.

import {
  isNativeStreamAvailable, prealloc, uploadBlock, downloadBlock, sha256File,
} from './vaultBeamStreamNative';
import {
  relayBlockUrls, relayMarkUploaded, relayState, relayComplete, relayGrow,
  uploadedBlocks, MAX_BYTES,
} from './vaultbeamRelay';
import {
  type SegmentPlan, newPlan, appendSegment, isComplete, totalBlocks, segBlockCount,
  locateBlock, serialize as serializePlan, deserialize as deserializePlan,
  idSchemeForPlan, SEGMENT_PLAN_V1, SEGMENT_PLAN_V2,
} from './vaultBeamSegments';
import { recordSample, loadState, saveState } from './networkStateStore';
import { geometry as geoOf, sample as sampleNs } from './networkState';
import { VB_RELIABILITY_FIXES, VB_SEAMLESS_RESUME } from '../constants/flags';
import { loadRecvBitmap, saveRecvBitmapSoon, clearRecvBitmap } from './vaultBeamRecvBitmap';

const URL_BATCH = 64;   // matches routes/vaultbeam.js MAX_URLS
const PARALLEL  = 4;    // concurrent block ops (matches the native I/O pool width)
const POLL_MS   = 1500; // recipient poll cadence while the sender is still uploading
// Companion #1: fail a relay receive that makes zero forward progress for this
// long (neither a new block downloaded nor the server's plan/bitmap growing) —
// e.g. the sender only tried direct then died, so the recipient would otherwise
// poll an empty plan forever. Generous, to never trip a merely-slow link.
const RECV_WATCHDOG_MS = 180_000;

// Battery awareness (UITE §14): on a low, non-charging battery (or OS low-power
// mode) halve the concurrent block ops — fewer radio bursts + less CPU. Sampled
// once per transfer start (ponytail: per-transfer sample, continuous monitoring
// if users report drain mid-multi-GB sends).
async function batteryParallelism(): Promise<number> {
  try {
    const B = require('expo-battery');
    const s = await B.getPowerStateAsync();
    const charging = s?.batteryState === B.BatteryState?.CHARGING || s?.batteryState === B.BatteryState?.FULL;
    if (s?.lowPowerMode || (typeof s?.batteryLevel === 'number' && s.batteryLevel >= 0 && s.batteryLevel < 0.2 && !charging)) return 2;
  } catch {}
  return PARALLEL;
}

export interface TransferProgress { done: number; total: number; bytes: number; totalBytes: number }
type ProgressCb = (p: TransferProgress) => void;

// Bounded-concurrency map: run fn over items PARALLEL at a time, honoring an
// AbortSignal. Rejections propagate (a failed block aborts the batch → retried
// on the next resume pass, since only confirmed blocks get marked).
async function mapPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal?.aborted) throw new Error('aborted');
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── SENDER (v2 adaptive) ────────────────────────────────────────────
// Builds the segment plan REACTIVELY: pick the next segment's chunk/block size
// from live throughput (networkState), GROW the server (block count + content-free
// plan), upload that segment, measure, repeat. So a WiFi→4G drop mid-transfer
// shrinks the chunk size at the next segment boundary. Resume reloads the plan +
// uploaded bitmap the server already holds and continues. The caller opened the
// transfer via relay/init (empty plan) before delivering the E2EE manifest.
export async function sendTransfer(opts: {
  srcPath: string; totalBytes: number; fileId: string; transferId: string; keyB64: string;
  linkType?: string | null; onProgress?: ProgressCb; signal?: AbortSignal;
  /** The transfer's FROZEN VB_SEAMLESS_RESUME decision, which fixes the segment
   *  plan version for a NEW plan. Passed in rather than read from the flag,
   *  because the flag is server-driven and may have moved since this transfer
   *  was created — and a v1 plan and a v2 plan are not interchangeable.
   *  Omitted ⇒ fall back to the compiled constant (pre-channel callers). */
  seamless?: boolean;
}): Promise<{ blockCount: number }> {
  if (!isNativeStreamAvailable()) throw new Error('native stream unavailable');
  if (opts.totalBytes <= 0 || opts.totalBytes > MAX_BYTES) throw new Error('size out of range (0–12 GB)');

  let ns = await loadState(opts.linkType);                    // live throughput brain, seeded from history
  const par = await batteryParallelism();                     // §14: 2 on low battery, else 4
  const st = await relayState(opts.transferId);               // resume: what does the server already hold?
  // A plan the server already holds ALWAYS wins: it is what the recipient is
  // reading against, and its version is not ours to revise mid-transfer.
  const wantV2 = opts.seamless ?? VB_SEAMLESS_RESUME;
  let plan: SegmentPlan = (st.plan && deserializePlan(st.plan))
    || newPlan(opts.totalBytes, wantV2 ? SEGMENT_PLAN_V2 : SEGMENT_PLAN_V1);
  const have = new Set(uploadedBlocks(st.uploadedMask, st.blockCount));
  let uploadedBytes = 0;

  const push = async (indices: number[]) => {
    for (let i = 0; i < indices.length; i += URL_BATCH) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const batch = indices.slice(i, i + URL_BATCH);
      const { urls } = await relayBlockUrls(opts.transferId, batch, 'put');
      const okBlocks: number[] = [];
      await mapPool(urls, par, async ({ blockIndex, url }) => {
        const loc = locateBlock(plan, blockIndex);
        if (!loc) return;                                      // geometry not planned — skip (shouldn't happen)
        const t0 = Date.now();
        const bytes = await uploadBlock({
          url, srcPath: opts.srcPath, keyB64: opts.keyB64, transferId: opts.transferId,
          fileId: opts.fileId, blockIndex, chunkBytes: loc.chunkBytes, blockBytes: loc.blockBytes,
          chunkCount: 0, totalBytes: opts.totalBytes, blockPlainOffset: loc.blockPlainOffset,
          idScheme: idSchemeForPlan(plan),
        });
        ns = sampleNs(ns, { bytes, elapsedMs: Math.max(1, Date.now() - t0), nowMs: Date.now() });
        okBlocks.push(blockIndex); uploadedBytes += bytes; have.add(blockIndex);
        opts.onProgress?.({ done: have.size, total: totalBlocks(plan) || have.size, bytes: uploadedBytes, totalBytes: opts.totalBytes });
      }, opts.signal);
      if (okBlocks.length) await relayMarkUploaded(opts.transferId, okBlocks);   // server HEAD-verifies each
    }
  };

  // Grow + upload one segment at a time, each size chosen from LIVE throughput.
  let guard = 0;
  while (!isComplete(plan) && guard++ < 200_000) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const geo = geoOf(ns);
    // v2: the LOGICAL chunk is fixed; only the PHYSICAL block adapts to throughput.
    plan = plan.version >= SEGMENT_PLAN_V2
      ? appendSegment(plan, geo.blockBytes)
      : appendSegment(plan, geo.blockBytes, undefined, geo.chunkBytes);
    await relayGrow(opts.transferId, totalBlocks(plan), serializePlan(plan));
    const seg = plan.segments[plan.segments.length - 1];
    await push(range(segBlockCount(seg)).map((k) => seg.firstBlock + k).filter((b) => !have.has(b)));
  }
  // Resume tail: earlier-segment blocks that never finished uploading.
  const missing = range(totalBlocks(plan)).filter((b) => !have.has(b));
  if (missing.length) await push(missing);

  await saveState(opts.linkType, ns);                         // carry the measured throughput forward
  return { blockCount: totalBlocks(plan) };
}

// ── RECIPIENT (v2 adaptive) ─────────────────────────────────────────
// Polls the GROWING server plan + bitmap: pulls each block whose geometry it holds
// AND that's on R2, verifying+decrypting natively into place. Done when the plan is
// fully built (isComplete) and every block it defines is held. Whole-file sha256
// gates the relay purge. Works for an offline recipient — the plan lives server-side.
export async function receiveTransfer(opts: {
  transferId: string; dstPath: string; totalBytes: number; fileId: string; keyB64: string;
  linkType?: string | null; expectedSha256?: string; onProgress?: ProgressCb; signal?: AbortSignal;
  /** Contiguous plaintext prefix a DIRECT tier already landed on dstPath
   *  (GCM-verified chunk by chunk). Blocks fully inside it are credited, not
   *  re-downloaded — a 50% direct transfer resumes at 50% on the relay. */
  haveBytes?: number;
}): Promise<{ path: string; verified: boolean }> {
  if (!isNativeStreamAvailable()) throw new Error('native stream unavailable');

  // prealloc opens WITHOUT truncate and set_len()s to the full size, so a resumed
  // receive keeps every block already written to disk (see vaultBeamRecvBitmap).
  await prealloc(opts.dstPath, opts.totalBytes);
  const par = await batteryParallelism();                     // §14: 2 on low battery, else 4
  const got = new Set<number>();
  let downloadedBytes = 0;
  let plan: SegmentPlan | null = null;

  // Companion #3: resume — seed `got` from the persisted on-disk bitmap so a
  // dropped download continues instead of restarting from block 0.
  let seeded = false;
  if (VB_RELIABILITY_FIXES) {
    try { for (const b of await loadRecvBitmap(opts.transferId)) got.add(b); } catch {}
    seeded = got.size > 0;
  }
  // Companion #1: no-forward-progress watchdog.
  let lastProgressAt = Date.now();
  let prevServerHeld = -1;

  for (;;) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const st = await relayState(opts.transferId);
    if (st.state === 'aborted') throw new Error('transfer aborted by sender');
    if (st.plan) { const p = deserializePlan(st.plan); if (p) plan = p; }
    if (!plan) {
      if (VB_RELIABILITY_FIXES && Date.now() - lastProgressAt > RECV_WATCHDOG_MS) throw new Error('transfer stalled — the sender never started uploading');
      await wait(POLL_MS); continue;                           // sender hasn't posted geometry yet
    }

    const p = plan;
    if (seeded) {                                              // reconcile the seed against the now-known plan, once
      for (const b of [...got]) if (!locateBlock(p, b)) got.delete(b);
      downloadedBytes = [...got].reduce((s, b) => s + (locateBlock(p, b)?.blockBytes ?? 0), 0);
      opts.onProgress?.({ done: got.size, total: totalBlocks(p) || got.size, bytes: Math.min(downloadedBytes, opts.totalBytes), totalBytes: opts.totalBytes });
      seeded = false; lastProgressAt = Date.now();
    }

    // Cross-tier resume: credit blocks the direct tier already wrote. The plan
    // grows over time, so newly-defined blocks get credited as they appear.
    // Same key + same per-chunk GCM verification as the relay path, and the
    // whole-file sha256 below still gates completion.
    if (opts.haveBytes && opts.haveBytes > 0) {
      let credited = false;
      for (let b = 0, n = totalBlocks(p); b < n; b++) {
        if (got.has(b)) continue;
        const loc = locateBlock(p, b);
        if (loc && loc.blockPlainOffset + loc.blockBytes <= opts.haveBytes) {
          got.add(b); downloadedBytes += loc.blockBytes; credited = true;
        }
      }
      if (credited) {
        lastProgressAt = Date.now();
        if (VB_RELIABILITY_FIXES) saveRecvBitmapSoon(opts.transferId, got);
        opts.onProgress?.({ done: got.size, total: totalBlocks(p) || got.size, bytes: Math.min(downloadedBytes, opts.totalBytes), totalBytes: opts.totalBytes });
      }
    }

    const serverHeld = uploadedBlocks(st.uploadedMask, st.blockCount).length;
    const avail = uploadedBlocks(st.uploadedMask, st.blockCount).filter((b) => !got.has(b) && locateBlock(p, b));
    for (let i = 0; i < avail.length; i += URL_BATCH) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const batch = avail.slice(i, i + URL_BATCH);
      const { urls } = await relayBlockUrls(opts.transferId, batch, 'get');
      await mapPool(urls, par, async ({ blockIndex, url }) => {
        const loc = locateBlock(p, blockIndex)!;
        const t0 = Date.now();
        await downloadBlock({
          url, dstPath: opts.dstPath, keyB64: opts.keyB64, transferId: opts.transferId,
          fileId: opts.fileId, blockIndex, chunkBytes: loc.chunkBytes, blockBytes: loc.blockBytes,
          chunkCount: 0, totalBytes: opts.totalBytes, blockPlainOffset: loc.blockPlainOffset,
          idScheme: idSchemeForPlan(p),
        });
        recordSample(opts.linkType, loc.blockBytes, Math.max(1, Date.now() - t0), Date.now()).catch(() => {});
        got.add(blockIndex); downloadedBytes += loc.blockBytes;
        lastProgressAt = Date.now();                           // real forward progress
        if (VB_RELIABILITY_FIXES) saveRecvBitmapSoon(opts.transferId, got);   // persist for resume
        opts.onProgress?.({ done: got.size, total: totalBlocks(p) || got.size, bytes: Math.min(downloadedBytes, opts.totalBytes), totalBytes: opts.totalBytes });
      }, opts.signal);
    }

    if (isComplete(plan) && got.size >= totalBlocks(plan)) break;  // plan done + every block held
    if (st.state === 'complete') break;                        // relay already purged
    // Watchdog: the server plan/bitmap growing also counts as progress (sender alive).
    if (VB_RELIABILITY_FIXES) {
      if (serverHeld > prevServerHeld) { prevServerHeld = serverHeld; lastProgressAt = Date.now(); }
      if (Date.now() - lastProgressAt > RECV_WATCHDOG_MS) throw new Error('transfer stalled — no data from the sender');
    }
    await wait(POLL_MS);
  }
  if (VB_RELIABILITY_FIXES) clearRecvBitmap(opts.transferId).catch(() => {});   // resume record no longer needed

  // Whole-file integrity gate before we let the server purge the only other copy.
  let verified = true;
  if (opts.expectedSha256) {
    const h = await sha256File(opts.dstPath);
    verified = h.toLowerCase() === opts.expectedSha256.toLowerCase();
    if (!verified) throw new Error('sha256 mismatch — file corrupt, not purging relay');
  }
  await relayComplete(opts.transferId);
  return { path: opts.dstPath, verified };
}
