// lib/vaultBeam/drivers/relay.ts — the R2 relay as a transport driver.
//
// Wraps the existing byte path (native uploadBlock/downloadBlock + the relay
// control plane); it does NOT reimplement it. What changes versus today:
//
//   • the work-list comes from the session's bitmaps, so a chunk the peer has
//     already verified is never staged again — the fix, in one line of intent;
//   • the sender reports `staged`, never `verified`. Staging on R2 is not
//     delivery (RC-4), so it cannot advance progress;
//   • ordering is ascending by chunk, so when the receiver holds a prefix the
//     first block uploaded is one it actually needs (RC-8).
//
// Adaptive geometry is preserved exactly: each segment's PHYSICAL block size is
// still chosen from measured throughput. Only the LOGICAL chunk is fixed.
//
// All I/O is injected, so the driver's logic is exercised under `npx tsx` with a
// fake relay. The default binding lazily imports the react-native modules, which
// keeps this file importable in Node.

import { ChunkBitmap, type ChunkRun, CHUNK_BYTES } from '../bitmap';
import { TransferSession } from '../session';
import {
  type TransportDriver, type DriverOutcome, type DriverReport, type TransportChannel,
} from './types';
import { blockChunkRun, blocksForNeed, r2HaveFromServerMask, chunksOfBlocks } from '../blockMap';
import {
  type SegmentPlan, newPlan, appendSegment, isComplete, totalBlocks, locateBlock,
  serialize as serializePlan, deserialize as deserializePlan, idSchemeForPlan,
} from '../../vaultBeamSegments';

const URL_BATCH = 64;   // matches routes/vaultbeam.js MAX_URLS
const DEFAULT_PARALLEL = 4;

export interface RelayStateLike {
  state: string;
  plan?: string | null;
  uploadedMask: string;
  blockCount: number;
  sessionVersion?: number;
}

export interface RelayBlockOp {
  url: string; blockIndex: number; chunkBytes: number; blockBytes: number;
  blockPlainOffset: number; totalBytes: number; idScheme: string;
  transferId: string; fileId: string; keyB64: string;
  srcPath?: string; dstPath?: string;
}

/** Everything the driver touches outside itself. Injected ⇒ testable. */
export interface RelayIO {
  state(transferId: string): Promise<RelayStateLike>;
  grow(transferId: string, blockCount: number, plan: string): Promise<void>;
  blockUrls(transferId: string, blocks: number[], op: 'put' | 'get'): Promise<Array<{ blockIndex: number; url: string }>>;
  markUploaded(transferId: string, blocks: number[]): Promise<void>;
  uploadBlock(op: RelayBlockOp): Promise<number>;
  downloadBlock(op: RelayBlockOp): Promise<number>;
  /** Physical block size for the next segment, from measured throughput. */
  nextBlockBytes(): Promise<number>;
  /** Concurrency for block ops (battery-aware in production). */
  parallelism?(): Promise<number>;
}

export interface RelayDriverOpts {
  io: RelayIO;
  srcPath?: string;      // sender
  dstPath?: string;      // recipient
  parallel?: number;
}

/** Bounded-concurrency map honouring an AbortSignal. */
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

export class RelayDriver implements TransportDriver {
  readonly id = 'relay';
  readonly cost = 30;                       // most expensive: always last
  readonly channel: TransportChannel = 'relay';

  private plan: SegmentPlan | null = null;
  private disposed = false;

  constructor(private readonly opts: RelayDriverOpts) {}

  /** Physical unit = the current segment's block size, in logical chunks. */
  unitChunks(_session: TransferSession): number {
    const p = this.plan;
    if (!p || p.segments.length === 0) return 8;             // 4 MiB default
    const seg = p.segments[p.segments.length - 1];
    return Math.max(1, Math.floor(seg.blockBytes / CHUNK_BYTES));
  }

  async available(session: TransferSession): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const st = await this.opts.io.state(session.transferId);
      return st.state !== 'aborted';
    } catch { return false; }
  }

  dispose(): void { this.disposed = true; this.plan = null; }

  /** Pull authoritative state: plan + which blocks the relay actually holds. */
  private async refresh(session: TransferSession): Promise<RelayStateLike> {
    const st = await this.opts.io.state(session.transferId);
    if (st.plan) {
      const p = deserializePlan(st.plan);
      if (p) this.plan = p;
    }
    // A v1 plan cannot be addressed by canonical chunk ids, and blockMap
    // correctly refuses to pretend otherwise — but the refusal used to surface
    // as "no addressable blocks", i.e. a drained run that moved nothing and a
    // session that parked without a reason. Say what actually happened: this
    // engine was pointed at a legacy plan, which is a pairing mistake, not a
    // transient stall.
    if (this.plan && idSchemeForPlan(this.plan) !== 'canonical') {
      throw new Error('relay plan is v1 (legacy grid) — the seamless engine cannot address it');
    }
    if (this.plan) {
      session.setR2Have(r2HaveFromServerMask(this.plan, st.uploadedMask, st.blockCount, session.chunkCount));
    }
    return st;
  }

  async run(
    session: TransferSession, work: ChunkRun[], report: DriverReport, signal: AbortSignal,
  ): Promise<DriverOutcome> {
    if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
    if (this.disposed) return { kind: 'failed', reason: 'disposed' };
    try {
      const st = await this.refresh(session);
      if (st.state === 'aborted') return { kind: 'failed', reason: 'transfer aborted' };
      return session.role === 'sender'
        ? await this.send(session, work, report, signal)
        : await this.receive(session, work, report, signal);
    } catch (e: any) {
      return { kind: 'failed', reason: e?.message ?? 'relay error' };
    }
  }

  // ── SENDER: stage the work-list on R2 ────────────────────────────
  private async send(
    session: TransferSession, work: ChunkRun[], report: DriverReport, signal: AbortSignal,
  ): Promise<DriverOutcome> {
    const wanted = new ChunkBitmap(session.chunkCount);
    for (const r of work) wanted.setRun(r);
    if (wanted.isEmpty()) return { kind: 'drained' };

    const par = (await this.opts.io.parallelism?.()) ?? this.opts.parallel ?? DEFAULT_PARALLEL;
    let plan = this.plan ?? newPlan(session.totalBytes);

    // Chunks staged during THIS run. Tracked locally rather than read back from
    // the session, so the loop terminates on its own behaviour and cannot
    // re-stage a segment when a later segment is appended.
    const stagedNow = new ChunkBitmap(session.chunkCount);
    const remaining = (): ChunkBitmap => {
      const bm = new ChunkBitmap(session.chunkCount);
      for (let c = 0; c < session.chunkCount; c++) if (wanted.test(c) && !stagedNow.test(c)) bm.set(c);
      return bm;
    };

    // Grow the plan segment by segment, choosing each segment's PHYSICAL block
    // size from live throughput, and stage that segment's needed blocks. Same
    // reactive sizing as before — only the logical chunk is now fixed.
    let guard = 0;
    while (guard++ < 100_000) {
      if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
      const need = remaining();
      if (need.isEmpty()) break;

      if (!isComplete(plan)) {
        const blockBytes = await this.opts.io.nextBlockBytes();
        plan = appendSegment(plan, Math.max(blockBytes, CHUNK_BYTES));
        this.plan = plan;
        await this.opts.io.grow(session.transferId, totalBlocks(plan), serializePlan(plan));
      }

      const blocks = blocksForNeed(plan, session.chunkCount, need);
      if (blocks.length === 0) {
        if (isComplete(plan)) break;      // fully planned and nothing addressable left
        continue;                          // plan does not reach the needed region yet
      }

      for (let i = 0; i < blocks.length; i += URL_BATCH) {
        if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
        const batch = blocks.slice(i, i + URL_BATCH);
        const urls = await this.opts.io.blockUrls(session.transferId, batch, 'put');
        const done: number[] = [];
        await mapPool(urls, par, async ({ blockIndex, url }) => {
          const loc = locateBlock(plan, blockIndex);
          const run = blockChunkRun(plan, blockIndex, session.chunkCount);
          if (!loc || !run) return;
          await this.opts.io.uploadBlock({
            url, blockIndex, chunkBytes: loc.chunkBytes, blockBytes: loc.blockBytes,
            blockPlainOffset: loc.blockPlainOffset, totalBytes: session.totalBytes,
            idScheme: idSchemeForPlan(plan), transferId: session.transferId,
            fileId: session.fileId, keyB64: session.keyB64, srcPath: this.opts.srcPath,
          });
          done.push(blockIndex);
        }, signal);
        if (done.length && !signal.aborted) {
          await this.opts.io.markUploaded(session.transferId, done);
          // STAGED, not verified: the relay holds it; the peer does not yet.
          for (const run of chunksOfBlocks(plan, done, session.chunkCount)) {
            for (let c = run.start; c < run.start + run.count; c++) {
              stagedNow.set(c);
              if (wanted.test(c)) report.staged(c);
            }
          }
        }
      }
    }
    return { kind: 'drained' };
  }

  // ── RECIPIENT: fetch staged blocks, verify + write natively ──────
  private async receive(
    session: TransferSession, work: ChunkRun[], report: DriverReport, signal: AbortSignal,
  ): Promise<DriverOutcome> {
    const plan = this.plan;
    if (!plan) return { kind: 'failed', reason: 'sender has not posted geometry yet', retryAfterMs: 1500 };

    const need = new ChunkBitmap(session.chunkCount);
    for (const r of work) need.setRun(r);
    if (need.isEmpty()) return { kind: 'drained' };

    const par = (await this.opts.io.parallelism?.()) ?? this.opts.parallel ?? DEFAULT_PARALLEL;
    // Only blocks that are BOTH needed and actually staged can be fetched.
    const fetchable = blocksForNeed(plan, session.chunkCount, need)
      .filter((b) => {
        const run = blockChunkRun(plan, b, session.chunkCount);
        if (!run) return false;
        for (let c = run.start; c < run.start + run.count; c++) if (!session.r2Have.test(c)) return false;
        return true;
      });
    if (fetchable.length === 0) return { kind: 'drained' };

    for (let i = 0; i < fetchable.length; i += URL_BATCH) {
      if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
      const batch = fetchable.slice(i, i + URL_BATCH);
      const urls = await this.opts.io.blockUrls(session.transferId, batch, 'get');
      await mapPool(urls, par, async ({ blockIndex, url }) => {
        const loc = locateBlock(plan, blockIndex);
        const run = blockChunkRun(plan, blockIndex, session.chunkCount);
        if (!loc || !run) return;
        await this.opts.io.downloadBlock({
          url, blockIndex, chunkBytes: loc.chunkBytes, blockBytes: loc.blockBytes,
          blockPlainOffset: loc.blockPlainOffset, totalBytes: session.totalBytes,
          idScheme: idSchemeForPlan(plan), transferId: session.transferId,
          fileId: session.fileId, keyB64: session.keyB64, dstPath: this.opts.dstPath,
        });
        // A native block op cannot be interrupted from here, so an abort during
        // one still resolves — possibly seconds later. Crediting it would move
        // progress on a transfer the caller has already been told is cancelled.
        if (signal.aborted) return;
        // downloadBlock throws on a short/tampered body, so reaching here means
        // every chunk in the block passed its GCM tag and is written at its offset.
        for (let c = run.start; c < run.start + run.count; c++) {
          if (need.test(c)) report.verified(c);
        }
      }, signal);
    }
    return { kind: 'drained' };
  }
}

/** Default production binding — lazily imported so this module stays Node-safe. */
export async function defaultRelayIO(): Promise<RelayIO> {
  const relay = await import('../../vaultbeamRelay');
  const native = await import('../../vaultBeamStreamNative');
  const store = await import('../../networkStateStore');
  return {
    state: async (t) => (await relay.relayState(t)) as unknown as RelayStateLike,
    grow: async (t, n, p) => { await relay.relayGrow(t, n, p); },
    blockUrls: async (t, b, op) => (await relay.relayBlockUrls(t, b, op)).urls,
    markUploaded: async (t, b) => { await relay.relayMarkUploaded(t, b); },
    uploadBlock: (op) => native.uploadBlock(op as any),
    downloadBlock: (op) => native.downloadBlock(op as any),
    nextBlockBytes: async () => (await store.startingGeometry(null)).blockBytes,
  };
}

// ── self-check: `npx tsx lib/vaultBeam/drivers/relay.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('relay driver: ' + m); };
  const MiB = 1024 * 1024;

  /** An in-memory relay: block storage + the server's uploaded mask + the plan. */
  class FakeRelay implements RelayIO {
    objects = new Map<number, number>();      // blockIndex → byte length
    planStr = '';
    blockCount = 0;
    puts = 0; gets = 0;
    blockBytes: number;
    constructor(blockBytes = 4 * MiB) { this.blockBytes = blockBytes; }
    async state() {
      const mask = new ChunkBitmap(Math.max(1, this.blockCount));
      for (const b of this.objects.keys()) mask.set(b);
      return { state: 'pending', plan: this.planStr || null, uploadedMask: mask.toBase64(), blockCount: this.blockCount };
    }
    async grow(_t: string, n: number, p: string) { this.blockCount = n; this.planStr = p; }
    async blockUrls(_t: string, blocks: number[], op: 'put' | 'get') {
      if (op === 'get') blocks = blocks.filter((b) => this.objects.has(b));
      return blocks.map((b) => ({ blockIndex: b, url: `${op}://${b}` }));
    }
    async markUploaded() { /* the fake marks on PUT */ }
    async uploadBlock(op: RelayBlockOp) { this.puts++; this.objects.set(op.blockIndex, op.blockBytes); return op.blockBytes; }
    async downloadBlock(op: RelayBlockOp) {
      this.gets++;
      if (!this.objects.has(op.blockIndex)) throw new Error('missing object');
      return op.blockBytes;
    }
    async nextBlockBytes() { return this.blockBytes; }
  }

  const TOTAL = 20 * MiB;
  const CHUNKS = Math.ceil(TOTAL / CHUNK_BYTES);        // 40
  const mkSession = (role: 'sender' | 'recipient') => new TransferSession({
    transferId: 'Trelay1234567890', sessionVersion: 1, fileId: 'F', keyB64: 'k', role, totalBytes: TOTAL,
  });

  const run = async () => {
    // 1. sender stages everything; staging is NOT progress
    let io = new FakeRelay();
    let d = new RelayDriver({ io, srcPath: '/tmp/src' });
    let s = mkSession('sender');
    let out = await d.run(s, s.pendingRuns(), {
      verified: (c) => s.markVerified(c), staged: (c) => s.markStaged(c),
    }, new AbortController().signal);
    A(out.kind === 'drained', 'sender drains');
    A(s.r2Have.popcount() === CHUNKS, 'every chunk staged');
    A(s.peerHave.popcount() === 0, 'staging did NOT advance PeerHave');
    A(s.progressBytes() === 0, 'staging is not progress');
    A(!s.isComplete(), 'sender is not complete merely because R2 holds the file');
    A(s.uploadWork().length === 0, 'nothing left to stage');
    d.dispose();

    // 2. THE fix: a sender whose peer already verified a prefix stages ONLY the rest
    io = new FakeRelay();
    d = new RelayDriver({ io, srcPath: '/tmp/src' });
    s = mkSession('sender');
    for (let c = 0; c < 30; c++) s.markVerified(c);          // delivered over P2P earlier
    await d.run(s, s.uploadWork(), {
      verified: (c) => s.markVerified(c), staged: (c) => s.markStaged(c),
    }, new AbortController().signal);
    const stagedChunks = s.r2Have.popcount();
    A(stagedChunks > 0, 'staged the remainder');
    A(stagedChunks <= CHUNKS - 30 + 8, 'staged only the tail (plus at most one straddling block)');
    A(io.puts < Math.ceil(TOTAL / (4 * MiB)), 'fewer PUTs than a full re-upload');
    d.dispose();

    // 3. ascending order — the FIRST block staged covers a chunk the peer needs
    A(io.objects.size > 0, 'objects were written');
    const firstBlock = Math.min(...io.objects.keys());
    const planAfter = deserializePlan(io.planStr)!;
    const firstRun = blockChunkRun(planAfter, firstBlock, CHUNKS)!;
    A(firstRun.start + firstRun.count > 30, 'the first block staged reaches into the needed tail (RC-8)');

    // 4. receiver fetches only staged+needed blocks and reports VERIFIED
    const rio = new FakeRelay();
    const sender = new RelayDriver({ io: rio, srcPath: '/tmp/src' });
    const ss = mkSession('sender');
    await sender.run(ss, ss.pendingRuns(), {
      verified: (c) => ss.markVerified(c), staged: (c) => ss.markStaged(c),
    }, new AbortController().signal);
    sender.dispose();

    const rd = new RelayDriver({ io: rio, dstPath: '/tmp/dst' });
    const rs = mkSession('recipient');
    await rd.run(rs, rs.pendingRuns(), {
      verified: (c) => rs.markVerified(c), staged: (c) => rs.markStaged(c),
    }, new AbortController().signal);
    A(rs.peerHave.popcount() === CHUNKS, 'receiver verified every chunk');
    A(rs.progressBytes() === TOTAL, 'receiver progress equals the file size');
    A(rs.isComplete(), 'receiver is complete');
    rd.dispose();

    // 5. a receiver whose sender staged nothing fetches nothing (and does not throw)
    const empty = new FakeRelay();
    const rd2 = new RelayDriver({ io: empty, dstPath: '/tmp/dst' });
    const rs2 = mkSession('recipient');
    const out2 = await rd2.run(rs2, rs2.pendingRuns(), {
      verified: (c) => rs2.markVerified(c), staged: (c) => rs2.markStaged(c),
    }, new AbortController().signal);
    A(out2.kind === 'failed' && /geometry/.test((out2 as any).reason), 'no plan yet ⇒ retryable failure');
    A(rs2.peerHave.popcount() === 0, 'nothing verified');
    rd2.dispose();

    // 6. adaptive PHYSICAL unit: a smaller block size changes unitChunks, not identity
    const slow = new FakeRelay(2 * MiB);
    const dSlow = new RelayDriver({ io: slow, srcPath: '/tmp/src' });
    const sSlow = mkSession('sender');
    await dSlow.run(sSlow, sSlow.pendingRuns(), {
      verified: (c) => sSlow.markVerified(c), staged: (c) => sSlow.markStaged(c),
    }, new AbortController().signal);
    A(sSlow.r2Have.popcount() === CHUNKS, 'small physical unit still stages every chunk');
    A(slow.puts > io.puts, 'a smaller physical unit means more requests');
    A(dSlow.unitChunks(sSlow) === 4, '2 MiB block = 4 logical chunks');
    dSlow.dispose();

    // 7. abort is honoured
    const aio = new FakeRelay();
    const ad = new RelayDriver({ io: aio, srcPath: '/tmp/src' });
    const as = mkSession('sender');
    const ac = new AbortController(); ac.abort();
    const aout = await ad.run(as, as.pendingRuns(), {
      verified: () => { throw new Error('should not report'); },
      staged: () => { throw new Error('should not report'); },
    }, ac.signal);
    A(aout.kind === 'failed', 'aborted run fails');
    A(aio.puts === 0, 'aborted run moves nothing');
    ad.dispose();

    // 8. REGRESSION: a file spanning several 256 MiB segments must stage each
    //    block exactly once. The plan grows a segment at a time, so a naive loop
    //    re-selects earlier segments' blocks on every round.
    const BIG = 600 * MiB;
    const bigIo = new FakeRelay(8 * MiB);
    const bigPuts: number[] = [];
    const origUpload = bigIo.uploadBlock.bind(bigIo);
    bigIo.uploadBlock = async (op: RelayBlockOp) => { bigPuts.push(op.blockIndex); return origUpload(op); };
    const bigD = new RelayDriver({ io: bigIo, srcPath: '/tmp/src' });
    const bigS = new TransferSession({
      transferId: 'Tbig123456789012', sessionVersion: 1, fileId: 'F', keyB64: 'k',
      role: 'sender', totalBytes: BIG,
    });
    await bigD.run(bigS, bigS.pendingRuns(), {
      verified: (c) => bigS.markVerified(c), staged: (c) => bigS.markStaged(c),
    }, new AbortController().signal);
    A(bigS.r2Have.popcount() === bigS.chunkCount, 'multi-segment file fully staged');
    A(new Set(bigPuts).size === bigPuts.length, 'every block staged EXACTLY once across segments');
    A(deserializePlan(bigIo.planStr)!.segments.length > 1, 'the fixture really spanned multiple segments');
    bigD.dispose();

    // 9. the injected parallelism seam is actually honoured (tsc caught this
    //    being wired to the wrong object; the fakes could not, so assert it).
    class ConcurrencyRelay extends FakeRelay {
      live = 0; peak = 0;
      async parallelism() { return 2; }
      async uploadBlock(op: RelayBlockOp) {
        this.live++; this.peak = Math.max(this.peak, this.live);
        await new Promise((r) => setTimeout(r, 1));
        this.live--;
        return super.uploadBlock(op);
      }
    }
    const cio = new ConcurrencyRelay(2 * MiB);
    const cd = new RelayDriver({ io: cio, srcPath: '/tmp/src' });
    const cs = mkSession('sender');
    await cd.run(cs, cs.pendingRuns(), {
      verified: (c) => cs.markVerified(c), staged: (c) => cs.markStaged(c),
    }, new AbortController().signal);
    A(cio.peak > 0 && cio.peak <= 2, `parallelism honoured (peak ${cio.peak} ≤ 2)`);
    A(cs.r2Have.popcount() === CHUNKS, 'bounded concurrency still stages everything');
    cd.dispose();

    // 10a. a LEGACY (v1) plan must fail LOUDLY, not drain silently. The v1 grid
    //      carries per-segment chunk sizes, so canonical ids do not address it;
    //      blockMap returns null for every block and the old behaviour was a
    //      run that reported success having moved nothing, then a park with no
    //      explanation. This is the pairing a percentage rollout can produce.
    {
      const v1io = new FakeRelay();
      const { newPlan: mkPlan, SEGMENT_PLAN_V1: V1, serialize: ser } = require('../../vaultBeamSegments');
      const legacy = mkPlan(TOTAL, V1);
      v1io.planStr = ser(legacy);
      v1io.blockCount = 1;
      const v1d = new RelayDriver({ io: v1io, dstPath: '/tmp/dst' });
      const v1s = mkSession('recipient');
      const v1out = await v1d.run(v1s, v1s.pendingRuns(), {
        verified: () => { throw new Error('must not report against a legacy plan'); },
        staged: () => { throw new Error('must not report against a legacy plan'); },
      }, new AbortController().signal);
      A(v1out.kind === 'failed', 'a v1 plan fails the run');
      A(/v1|legacy/i.test((v1out as any).reason), `and says why (got: ${(v1out as any).reason})`);
      A(v1s.peerHave.popcount() === 0, 'nothing was claimed against a legacy plan');
      v1d.dispose();
    }

    // 10. the shared driver contract
    const { runDriverContract } = require('./types');
    await runDriverContract('relay/recipient', {
      chunkCount: CHUNKS,
      // An unstaged relay legitimately moves nothing; the contract asserts the
      // driver behaves correctly in that case too (no phantom reports).
      make: () => ({ driver: new RelayDriver({ io: new FakeRelay(), dstPath: '/d' }), session: mkSession('recipient') }),
    });
    await runDriverContract('relay/sender', {
      chunkCount: CHUNKS,
      make: () => ({ driver: new RelayDriver({ io: new FakeRelay(), srcPath: '/s' }), session: mkSession('sender') }),
      makeWithUnit: (unit) => ({
        driver: new RelayDriver({ io: new FakeRelay(unit * CHUNK_BYTES), srcPath: '/s' }),
        session: mkSession('sender'),
      }),
    });

    console.log('vaultBeam/drivers/relay self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
