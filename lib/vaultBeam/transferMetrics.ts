// lib/vaultBeam/transferMetrics.ts — when things actually happened.
//
// # WHY THIS EXISTS
//
// Every performance question asked of VaultBeam so far has been answered with
// arithmetic instead of a measurement, because nothing recorded time. The audit
// score for Performance sat at 40/100 for exactly one reason: there was no
// instrument. This is the instrument.
//
// # THE ONE RULE THAT MATTERS
//
// `firstVerifiedChunk` is stamped ONLY after a chunk has been
//
//     GCM-authenticated  ->  decrypted  ->  written at its offset  ->  committed
//
// It is NOT the connection opening, NOT the first byte off the wire, and NOT a
// block credited from a previous run's `haveBytes` during hydration. Those are
// separate marks (`transportConnected`, `firstByte`) precisely so that the
// honest one cannot be quietly satisfied by a cheaper event. A hydration credit
// re-counts bytes this session never received; stamping it here would make a
// resumed transfer report a first-verified-chunk time of ~0 ms forever.
//
// # FIRST WRITE WINS
//
// Every mark is idempotent and monotonic. Chunks arrive in bursts and out of
// order, transports reconnect, and a resumed transfer re-enters the same code
// paths — so a mark that could be overwritten would drift to the LAST event and
// silently invert its own meaning. Later marks are dropped, not applied.
//
// Marks for an unknown transfer are ignored rather than creating a partial
// record: without a start there is no baseline, and a duration measured from
// nothing is worse than no duration.
//
// # NOT A TRANSFER DEPENDENCY
//
// This is observation. It allocates a small record per transfer and nothing
// else. It performs no IO, throws nothing, and must never be able to fail a
// transfer. `forget()` on terminal state keeps the map bounded.

/** Injectable clock — the self-check drives time by hand. */
export type Clock = () => number;

export interface TransferTimings {
  /** Wall-clock ms at which the transfer began. */
  startedAt: number;
  /** Transport reported itself usable (ICE connected / relay reachable). */
  transportConnectedAt?: number;
  /** First payload byte observed, verified or not. */
  firstByteAt?: number;
  /** First chunk fully verified, written AND committed to the bitmap. */
  firstVerifiedChunkAt?: number;
  /** Terminal success. */
  completedAt?: number;
  /** Plaintext bytes attributed to this transfer at completion. */
  bytes?: number;
  /** Last GENUINE receiver-originated progress on the direct tier. */
  lastPeerProgressAt?: number;
  /** When the stall watchdog fired. */
  stallDetectedAt?: number;
  /** When the replacement transport began. */
  fallbackStartedAt?: number;
  fallbackReason?: string;
  fallbackTransport?: string;
}

export interface TransferReport extends TransferTimings {
  /** Time to first byte, ms — connection establishment excluded from nothing. */
  ttfbMs?: number;
  /** The honest one: start -> first chunk verified, written and committed. */
  timeToFirstVerifiedChunkMs?: number;
  /** Start -> transport usable, ms. */
  connectMs?: number;
  /** Start -> completion, ms. */
  totalMs?: number;
  /** Mean throughput over the whole transfer, bytes/sec. */
  throughputBps?: number;
  /**
   * Last genuine peer progress -> fallback started. THE SLA number: it must
   * stay under DIRECT_STALL_MAX_MS. Undefined when no stall occurred.
   */
  directStallDurationMs?: number;
}

const records = new Map<string, TransferTimings>();

let clock: Clock = () => Date.now();

/** Test seam. Production never calls this. */
export function __setClock(c: Clock | null): void {
  clock = c ?? (() => Date.now());
}

/**
 * Begin (or restart) measurement for a transfer.
 *
 * A restart is a genuinely new observation window — a resumed transfer's TTFB
 * is its own, not the original attempt's — so this one mark deliberately
 * replaces any previous record instead of being first-write-wins.
 */
export function markStart(transferId: string): void {
  if (!transferId) return;
  records.set(transferId, { startedAt: clock() });
}

/** Stamp a milestone, first write wins. Unknown transfer ⇒ ignored. */
function mark(transferId: string, field: keyof TransferTimings): void {
  if (!transferId) return;
  const r = records.get(transferId);
  if (!r) return;                       // no baseline ⇒ no duration
  if (r[field] !== undefined) return;   // first write wins
  (r as unknown as Record<string, number>)[field as string] = clock();
}

/** ICE connected / relay reachable. Not delivery. */
export function markTransportConnected(transferId: string): void {
  mark(transferId, 'transportConnectedAt');
}

/** First payload byte seen on the wire. Not yet trusted. */
export function markFirstByte(transferId: string): void {
  mark(transferId, 'firstByteAt');
}

/**
 * A chunk is verified, decrypted, written at its offset and committed.
 *
 * Call this ONLY from a genuine verify-and-commit site. Never from hydration,
 * never from a progress callback, never on connect.
 */
export function markFirstVerifiedChunk(transferId: string): void {
  mark(transferId, 'firstVerifiedChunkAt');
}

/**
 * A genuine peer-progress event on the direct tier.
 *
 * Call ONLY from a receiver-originated verification signal. This is the clock
 * the stall SLA is measured against, so feeding it from local activity — a read,
 * an encrypt, a drained buffer, an open channel — would make the measurement
 * describe the sender's own liveness instead of the peer's.
 *
 * Unlike the milestone marks this deliberately overwrites: it is a "last seen",
 * not a "first seen".
 */
export function notePeerProgress(transferId: string): void {
  const r = records.get(transferId);
  if (r) r.lastPeerProgressAt = clock();
}

/** The watchdog fired. Records why, and when, for the SLA calculation. */
export function noteStall(transferId: string, reason = 'DIRECT_STALL_TIMEOUT'): void {
  const r = records.get(transferId);
  if (!r || r.stallDetectedAt !== undefined) return;   // first stall wins
  r.stallDetectedAt = clock();
  r.fallbackReason = reason;
}

/** The replacement transport began. */
export function noteFallbackStart(transferId: string, transport?: string): void {
  const r = records.get(transferId);
  if (!r || r.fallbackStartedAt !== undefined) return;
  r.fallbackStartedAt = clock();
  if (transport) r.fallbackTransport = transport;
}

/** Terminal success, after the whole-file SHA-256 gate has passed. */
export function markComplete(transferId: string, bytes?: number): void {
  if (!transferId) return;
  const r = records.get(transferId);
  if (!r) return;
  if (r.completedAt === undefined) r.completedAt = clock();
  if (bytes !== undefined && Number.isFinite(bytes) && bytes >= 0 && r.bytes === undefined) {
    r.bytes = bytes;
  }
}

/** Derived view. Returns null for a transfer that was never started. */
export function report(transferId: string): TransferReport | null {
  const r = records.get(transferId);
  if (!r) return null;
  const since = (t?: number): number | undefined =>
    t === undefined ? undefined : Math.max(0, t - r.startedAt);
  const out: TransferReport = {
    ...r,
    connectMs: since(r.transportConnectedAt),
    ttfbMs: since(r.firstByteAt),
    timeToFirstVerifiedChunkMs: since(r.firstVerifiedChunkAt),
    totalMs: since(r.completedAt),
    // Measured from the last PEER progress, not from detection: the user waits
    // from the moment data actually stopped, not from when we noticed.
    directStallDurationMs:
      r.lastPeerProgressAt !== undefined && r.fallbackStartedAt !== undefined
        ? Math.max(0, r.fallbackStartedAt - r.lastPeerProgressAt)
        : undefined,
  };
  if (out.totalMs !== undefined && out.totalMs > 0 && r.bytes !== undefined && r.bytes > 0) {
    out.throughputBps = (r.bytes * 1000) / out.totalMs;
  }
  return out;
}

/** Drop a finished transfer's record so the map stays bounded. */
export function forget(transferId: string): void {
  records.delete(transferId);
}

/** Test/diagnostic only. */
export function __size(): number { return records.size; }

export default {
  markStart, markTransportConnected, markFirstByte,
  markFirstVerifiedChunk, markComplete, report, forget,
  notePeerProgress, noteStall, noteFallbackStart,
};

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  let t = 1000;
  __setClock(() => t);

  console.log('\nVaultBeam transfer metrics\n');

  // ── marks without a start are ignored ────────────────────────────
  markFirstVerifiedChunk('ghost');
  A(report('ghost') === null, '1. a mark with no start creates no record');

  markStart('a');
  A(report('a')!.startedAt === 1000, '2. start stamps the baseline');
  A(report('a')!.timeToFirstVerifiedChunkMs === undefined,
    '3. an unreached milestone is undefined, never 0');

  // ── the four milestones ──────────────────────────────────────────
  t = 1200; markTransportConnected('a');
  t = 1500; markFirstByte('a');
  t = 1800; markFirstVerifiedChunk('a');
  t = 5000; markComplete('a', 1_000_000);

  const r = report('a')!;
  A(r.connectMs === 200, '4. connect measured from start');
  A(r.ttfbMs === 500, '5. TTFB measured from start');
  A(r.timeToFirstVerifiedChunkMs === 800, '6. first verified chunk measured from start');
  A(r.totalMs === 4000, '7. total measured from start');
  A(r.throughputBps === 250_000, '8. throughput = bytes/total (1 MB / 4 s)');

  // ── first write wins ─────────────────────────────────────────────
  t = 9000;
  markFirstVerifiedChunk('a'); markFirstByte('a');
  markTransportConnected('a'); markComplete('a', 999);
  const r2 = report('a')!;
  A(r2.timeToFirstVerifiedChunkMs === 800,
    '9. a later chunk cannot move the first-verified stamp');
  A(r2.ttfbMs === 500 && r2.connectMs === 200,
    '10. nor can a reconnect move TTFB or connect');
  A(r2.totalMs === 4000 && r2.bytes === 1_000_000,
    '11. completion and byte count are stamped once');

  // ── the metric cannot be faked by a cheaper event ────────────────
  t = 100; markStart('b');
  t = 150; markTransportConnected('b');
  t = 160; markFirstByte('b');
  A(report('b')!.timeToFirstVerifiedChunkMs === undefined,
    '12. connecting and receiving bytes do NOT satisfy first-verified-chunk');
  t = 400; markFirstVerifiedChunk('b');
  A(report('b')!.timeToFirstVerifiedChunkMs === 300,
    '13. only a real verify+write+commit satisfies it');

  // ── restart opens a new window ───────────────────────────────────
  t = 10_000; markStart('b');
  A(report('b')!.startedAt === 10_000, '14. restart rebases the baseline');
  A(report('b')!.timeToFirstVerifiedChunkMs === undefined,
    '15. and clears the previous run\'s milestones');

  // ── monotonic: never negative even on a backwards clock ──────────
  t = 20_000; markStart('c');
  t = 19_000; markFirstVerifiedChunk('c');
  A(report('c')!.timeToFirstVerifiedChunkMs === 0,
    '16. a backwards clock clamps to 0, never a negative duration');

  // ── hygiene ──────────────────────────────────────────────────────
  A(report('a')!.throughputBps !== undefined && report('c')!.throughputBps === undefined,
    '17. throughput only where bytes and a duration both exist');
  markComplete('c'); // no bytes
  A(report('c')!.bytes === undefined, '18. completion without a byte count stays honest');

  const n = __size();
  forget('a'); forget('b'); forget('c');
  A(__size() === n - 3, '19. forget bounds the map');
  A(report('a') === null, '20. a forgotten transfer reports nothing');

  A(markStart('') === undefined && report('') === null,
    '21. an empty transfer id is inert');

  __setClock(null);
  console.log(failures === 0
    ? '\nALL TRANSFER-METRIC CHECKS PASSED ✓  (device measurement separate)\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
