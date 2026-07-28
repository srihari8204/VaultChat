// lib/networkState.ts — the adaptive "brain" for VaultBeam (R1).
//
// Ingests per-block throughput samples and emits the geometry {chunkBytes,
// blockBytes} the next SEGMENT should use. Pure + deterministic → unit-checkable
// in Node; no react-native import. The orchestrator (vaultBeamTransfer) feeds it
// one sample per completed block and reads geometry() at each segment boundary.
//
// Rules that matter (why this isn't just a table lookup):
//   • EWMA-smoothed throughput, so one fast/slow block doesn't move the decision.
//   • Hysteresis: ratchet DOWN immediately (a collapsing link must shrink now —
//     a lost big block re-sends a lot), step UP only after the higher bucket
//     holds for several consecutive samples. Asymmetric response is the point.
//   • "Just backgrounded" guard: OEM-aggressive devices (P30) report artificially
//     low throughput right after backgrounding — ignore samples briefly so one
//     bad read doesn't ratchet us down for the rest of the transfer.
//
// Invariant enforced here: blockBytes % chunkBytes === 0 (native computes
// chunksPerBlock = blockBytes/chunkBytes) and blockBytes ≤ 8 MiB (a failed block
// re-sends at most one block — resume granularity is the block).

const KiB = 1024, MiB = 1024 * 1024;

export interface Bucket { maxMbps: number; chunkBytes: number; blockBytes: number }

// Honors the requested chunk table exactly; blockBytes bounded to ≤8 MiB so a
// dropped block is a bounded re-send. chunksPerBlock = blockBytes/chunkBytes is
// integer in every row (8, 4, 2, 1) — required by the native offset math.
export const BUCKETS: Bucket[] = [
  { maxMbps: 1,        chunkBytes: 256 * KiB, blockBytes: 2 * MiB }, // <1 Mbps  · congested 3G/edge   (cpb 8)
  { maxMbps: 5,        chunkBytes: 1 * MiB,   blockBytes: 4 * MiB }, // 1–5 Mbps · typical 4G          (cpb 4)
  { maxMbps: 25,       chunkBytes: 4 * MiB,   blockBytes: 8 * MiB }, // 5–25 Mbps· good 4G/weak 5G     (cpb 2)
  { maxMbps: Infinity, chunkBytes: 8 * MiB,   blockBytes: 8 * MiB }, // >25 Mbps · WiFi/strong 5G      (cpb 1)
];

const DEFAULT_BUCKET = 1;   // index into BUCKETS — start at "typical 4G" (512K-ish), measured overrides
const EWMA_ALPHA = 0.25;    // smoothing; a single burst moves tput ~¼ of the way
const STEP_UP_HOLD = 3;     // consecutive samples the higher bucket must win before we step up
const BG_GUARD_MS = 4000;   // ignore samples for this long after a background event

export interface NetState {
  tputBps: number;          // EWMA throughput, bytes/sec (0 = unmeasured)
  bucket: number;           // current committed bucket index
  upHold: number;           // consecutive samples pointing at a HIGHER bucket
  bgUntilMs: number;        // ignore samples until this timestamp (bg guard)
}

export function initNetState(startBucket = DEFAULT_BUCKET): NetState {
  return { tputBps: 0, bucket: clampBucket(startBucket), upHold: 0, bgUntilMs: 0 };
}

function clampBucket(i: number): number { return Math.max(0, Math.min(BUCKETS.length - 1, i)); }

/** Which bucket does a throughput (bytes/sec) fall into? */
export function bucketForBps(bps: number): number {
  const mbps = (bps * 8) / 1_000_000;
  for (let i = 0; i < BUCKETS.length; i++) if (mbps < BUCKETS[i].maxMbps) return i;
  return BUCKETS.length - 1;
}

export interface Sample { bytes: number; elapsedMs: number; nowMs: number }

/**
 * Fold one completed-block measurement into the state. Returns the NEW state
 * (pure — caller keeps the reference). collapse=true forces an immediate step
 * down (call it when the transport signals loss / a stalled block / RTT spike).
 */
export function sample(s: NetState, m: Sample, collapse = false): NetState {
  // Background guard: a sample taken while (or just after) backgrounded is
  // untrustworthy — skip it entirely.
  if (m.nowMs < s.bgUntilMs) return s;
  if (collapse) {
    return { ...s, bucket: clampBucket(s.bucket - 1), upHold: 0 };
  }
  if (m.elapsedMs <= 0 || m.bytes <= 0) return s;

  const inst = (m.bytes / m.elapsedMs) * 1000; // bytes/sec this block
  const tput = s.tputBps === 0 ? inst : EWMA_ALPHA * inst + (1 - EWMA_ALPHA) * s.tputBps;
  const target = bucketForBps(tput);

  let { bucket, upHold } = s;
  if (target < bucket) {
    // Ratchet DOWN immediately — no hysteresis on the way down.
    bucket = target; upHold = 0;
  } else if (target > bucket) {
    // Step UP only after the higher target holds for STEP_UP_HOLD samples.
    upHold += 1;
    if (upHold >= STEP_UP_HOLD) { bucket = clampBucket(bucket + 1); upHold = 0; }
  } else {
    upHold = 0; // target == current → reset the up counter
  }
  return { tputBps: tput, bucket, upHold, bgUntilMs: s.bgUntilMs };
}

/** Call on a background event so the next few samples are ignored. */
export function noteBackground(s: NetState, nowMs: number): NetState {
  return { ...s, bgUntilMs: nowMs + BG_GUARD_MS };
}

/** The geometry the NEXT segment should use. */
export function geometry(s: NetState): { chunkBytes: number; blockBytes: number } {
  const b = BUCKETS[clampBucket(s.bucket)];
  return { chunkBytes: b.chunkBytes, blockBytes: b.blockBytes };
}

// ── self-check: `npx tsx lib/networkState.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('networkState: ' + m); };

  // invariant: every bucket has integer chunksPerBlock and blockBytes ≤ 8 MiB
  for (const b of BUCKETS) {
    A(b.blockBytes % b.chunkBytes === 0, 'blockBytes divisible by chunkBytes');
    A(b.blockBytes <= 8 * MiB, 'block ≤ 8 MiB');
    A(b.chunkBytes <= b.blockBytes, 'chunk ≤ block');
  }

  // bucket boundaries match the table
  A(bucketForBps(0.5e6 / 8) === 0, '<1Mbps → bucket 0');   // 0.5 Mbps
  A(bucketForBps(3e6 / 8) === 1, '3Mbps → bucket 1');
  A(bucketForBps(10e6 / 8) === 2, '10Mbps → bucket 2');
  A(bucketForBps(100e6 / 8) === 3, '100Mbps → bucket 3');

  // ratchet DOWN is immediate: one slow sample drops the bucket now
  let s = initNetState(3); // start high
  s = sample(s, { bytes: 256 * KiB, elapsedMs: 4000, nowMs: 1000 }); // ~0.5 Mbps
  A(s.bucket === 0, 'one slow sample ratchets straight down');

  // step UP needs STEP_UP_HOLD consecutive fast samples (hysteresis)
  s = initNetState(0);
  const fast = () => (s = sample(s, { bytes: 8 * MiB, elapsedMs: 1000, nowMs: 1000 })); // ~64 Mbps
  fast(); A(s.bucket === 0, 'no jump on sample 1 (EWMA still low, hysteresis)');
  fast(); fast(); fast(); fast(); fast();
  A(s.bucket > 0, 'steps up after sustained fast samples');

  // background guard: a sample during the guard window is ignored
  s = initNetState(2);
  s = noteBackground(s, 1000);
  const before = s.bucket;
  s = sample(s, { bytes: 128 * KiB, elapsedMs: 5000, nowMs: 1500 }); // slow, but within guard
  A(s.bucket === before, 'sample within bg guard is ignored');
  s = sample(s, { bytes: 128 * KiB, elapsedMs: 5000, nowMs: 6000 }); // after guard → counts
  A(s.bucket < before, 'sample after bg guard counts');

  // explicit collapse forces a step down regardless of throughput
  s = initNetState(3);
  s = sample(s, { bytes: 0, elapsedMs: 0, nowMs: 1000 }, true);
  A(s.bucket === 2, 'collapse steps down one bucket');

  // geometry respects the divisibility invariant
  const g = geometry(initNetState(2));
  A(g.blockBytes % g.chunkBytes === 0, 'geometry divisible');

  console.log('networkState self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
