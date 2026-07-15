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
  relayBlockUrls, relayMarkUploaded, relayState, relayComplete,
  uploadedBlocks, MAX_BYTES,
} from './vaultbeamRelay';

const URL_BATCH = 64;   // matches routes/vaultbeam.js MAX_URLS
const PARALLEL  = 4;    // concurrent block ops (matches the native I/O pool width)
const POLL_MS   = 1500; // recipient poll cadence while the sender is still uploading

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

// ── SENDER ──────────────────────────────────────────────────────────
// Push every not-yet-uploaded block for a transfer that the caller has ALREADY
// opened via relay/init (lib/vaultBeamController does this before it delivers the
// E2EE manifest message, so the relay row exists before the recipient can tap
// Accept). Geometry + resume state come from relay/state — no second init here.
// Returns when all blocks are on R2.
export async function sendTransfer(opts: {
  srcPath: string; totalBytes: number; fileId: string; transferId: string; keyB64: string;
  onProgress?: ProgressCb; signal?: AbortSignal;
}): Promise<{ blockCount: number }> {
  if (!isNativeStreamAvailable()) throw new Error('native stream unavailable');
  if (opts.totalBytes <= 0 || opts.totalBytes > MAX_BYTES) throw new Error('size out of range (0–12 GB)');

  // Server-authoritative geometry + resume: which blocks does R2 already have?
  const st = await relayState(opts.transferId);
  const { blockCount, chunkCount, chunkBytes, blockBytes } = st;
  const have = new Set(uploadedBlocks(st.uploadedMask, blockCount));
  let todo = range(blockCount).filter((b) => !have.has(b));
  let uploadedBytes = 0;

  for (let i = 0; i < todo.length; i += URL_BATCH) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const batch = todo.slice(i, i + URL_BATCH);
    const { urls } = await relayBlockUrls(opts.transferId, batch, 'put');
    const okBlocks: number[] = [];
    await mapPool(urls, PARALLEL, async ({ blockIndex, url }) => {
      const bytes = await uploadBlock({
        url, srcPath: opts.srcPath, keyB64: opts.keyB64, transferId: opts.transferId,
        fileId: opts.fileId, blockIndex, chunkBytes, blockBytes, chunkCount, totalBytes: opts.totalBytes,
      });
      okBlocks.push(blockIndex);
      uploadedBytes += bytes;
      have.add(blockIndex);
      opts.onProgress?.({ done: have.size, total: blockCount, bytes: uploadedBytes, totalBytes: opts.totalBytes });
    }, opts.signal);
    // Server HEAD-verifies each before flipping its bit → truth is authoritative.
    if (okBlocks.length) await relayMarkUploaded(opts.transferId, okBlocks);
  }
  return { blockCount };
}

// ── RECIPIENT ───────────────────────────────────────────────────────
// Preallocate the shell and pull every block as it becomes available on R2,
// verifying + decrypting natively into place. Polls while the sender is still
// uploading; verifies the whole-file sha256 (if the manifest carried one) before
// telling the server to purge the relay copy.
export async function receiveTransfer(opts: {
  transferId: string; dstPath: string; totalBytes: number; fileId: string; keyB64: string;
  expectedSha256?: string; onProgress?: ProgressCb; signal?: AbortSignal;
}): Promise<{ path: string; verified: boolean }> {
  if (!isNativeStreamAvailable()) throw new Error('native stream unavailable');

  await prealloc(opts.dstPath, opts.totalBytes);
  const got = new Set<number>();
  let downloadedBytes = 0;
  let blockCount = 0; let chunkCount = 0; let chunkBytes = 0; let blockBytes = 0;

  // Loop until we hold every block or the transfer ends.
  for (;;) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const st = await relayState(opts.transferId);
    blockCount = st.blockCount; chunkCount = st.chunkCount;
    chunkBytes = st.chunkBytes; blockBytes = st.blockBytes;
    if (st.state === 'aborted') throw new Error('transfer aborted by sender');

    const avail = uploadedBlocks(st.uploadedMask, blockCount).filter((b) => !got.has(b));
    for (let i = 0; i < avail.length; i += URL_BATCH) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const batch = avail.slice(i, i + URL_BATCH);
      const { urls } = await relayBlockUrls(opts.transferId, batch, 'get');
      await mapPool(urls, PARALLEL, async ({ blockIndex, url }) => {
        await downloadBlock({
          url, dstPath: opts.dstPath, keyB64: opts.keyB64, transferId: opts.transferId,
          fileId: opts.fileId, blockIndex, chunkBytes, blockBytes, chunkCount, totalBytes: opts.totalBytes,
        });
        got.add(blockIndex);
        downloadedBytes = got.size * blockBytes; // approx; last block is short
        opts.onProgress?.({ done: got.size, total: blockCount, bytes: Math.min(downloadedBytes, opts.totalBytes), totalBytes: opts.totalBytes });
      }, opts.signal);
    }

    if (blockCount > 0 && got.size >= blockCount) break;
    if (st.state === 'complete') break; // relay already purged; nothing more to pull
    await wait(POLL_MS); // sender still uploading — poll for more blocks
  }

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
