// lib/vaultBeam/drivers/lan.ts — same-LAN native TCP as a transport driver.
//
// Native owns the socket and every file byte; this driver only translates the
// session's work-list into the native `runs` argument and turns native progress
// events into verified-chunk reports.
//
// What changed for resume: `lanServe`/`lanConnect` now take `runs`, so a resumed
// LAN attempt streams ONLY the missing chunks instead of `0..chunkCount`. The
// LAN frame format is unchanged — each frame already carries its chunk index, so
// a subset needed no new framing, and the frozen LAN golden vector still holds.
//
// Honest note on the physical unit: batching buys almost nothing here (the frame
// header is 8 bytes per 512 KiB and writes are already flushed every 16 chunks).
// `unitChunks` exists so the manager can express runs and so a future small-MTU
// transport can pick its own unit — not for LAN throughput.

import { type ChunkRun } from '../bitmap';
import { TransferSession } from '../session';
import {
  type TransportDriver, type DriverOutcome, type DriverReport, type TransportChannel, expandRuns,
} from './types';

export interface LanRunsOp {
  runs: Array<{ start: number; count: number }>;
  transferId: string; fileId: string; keyB64: string; token: string;
  chunkBytes: number; chunkCount: number; totalBytes: number;
  srcPath?: string; dstPath?: string; host?: string; port?: number;
}

/** The native LAN surface, injected so the driver is testable without a socket. */
export interface LanNative {
  /** SENDER: bind + accept + stream the runs. Resolves the chunk count moved. */
  serve(op: LanRunsOp): Promise<number>;
  /** RECIPIENT: connect + receive the runs. Resolves the chunk count moved. */
  connect(op: LanRunsOp): Promise<number>;
  /** vbLanProgress / vbLanBound. Returns an unsubscribe. */
  onEvent(name: 'vbLanProgress' | 'vbLanBound', cb: (d: any) => void): () => void;
}

export interface LanDriverOpts {
  native: LanNative;
  token: string;
  chunkBytes: number;
  /** SENDER side needs the source path; RECIPIENT the destination. */
  srcPath?: string;
  dstPath?: string;
  /** RECIPIENT only: the sender's advertised endpoint. Absent ⇒ unavailable. */
  endpoint?: { host: string; port: number };
  unit?: number;
}

export class LanDriver implements TransportDriver {
  readonly id = 'lan';
  readonly cost = 10;                       // cheapest: try first
  readonly channel: TransportChannel = 'direct';

  private offs: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly opts: LanDriverOpts) {}

  unitChunks(): number { return Math.max(1, this.opts.unit ?? 16); }

  async available(session: TransferSession): Promise<boolean> {
    if (this.disposed) return false;
    if (session.role === 'sender') return !!this.opts.srcPath;
    return !!this.opts.dstPath && !!this.opts.endpoint;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) { try { off(); } catch { /* already gone */ } }
    this.offs = [];
  }

  async run(
    session: TransferSession, work: ChunkRun[], report: DriverReport, signal: AbortSignal,
  ): Promise<DriverOutcome> {
    if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
    if (this.disposed) return { kind: 'failed', reason: 'disposed' };
    const wanted = expandRuns(work);
    if (wanted.length === 0) return { kind: 'drained' };

    const op: LanRunsOp = {
      runs: work.map((r) => ({ start: r.start, count: r.count })),
      transferId: session.transferId, fileId: session.fileId, keyB64: session.keyB64,
      token: this.opts.token, chunkBytes: this.opts.chunkBytes,
      chunkCount: session.chunkCount, totalBytes: session.totalBytes,
      srcPath: this.opts.srcPath, dstPath: this.opts.dstPath,
      host: this.opts.endpoint?.host, port: this.opts.endpoint?.port,
    };

    // Native reports progress as a COUNT of frames moved, in the order of the
    // run list, so map that ordinal back to the chunk id it refers to.
    let credited = 0;
    // A native transfer cannot be interrupted from here — the socket loop lives
    // in Rust/Kotlin and owns its own lifetime. What we CAN guarantee is that a
    // cancelled run credits nothing: the promise and the progress events both
    // keep arriving, and every one of them must be ignored once the caller has
    // been told the transfer stopped.
    let stopped = signal.aborted;
    const onAbort = () => { stopped = true; };
    signal.addEventListener?.('abort', onAbort);
    const creditTo = (done: number) => {
      if (stopped) return;
      const upto = Math.min(done, wanted.length);
      for (; credited < upto; credited++) report.verified(wanted[credited]);
    };
    // Released in the finally below, NOT in dispose(): a driver is reused across
    // rounds, so a per-run listener that only went away at teardown would
    // accumulate one subscription per round.
    const offProgress = this.opts.native.onEvent('vbLanProgress', (d) => {
      if (d?.transferId === session.transferId && Number.isInteger(d?.done)) creditTo(d.done);
    });

    try {
      const moved = session.role === 'sender'
        ? await this.opts.native.serve(op)
        : await this.opts.native.connect(op);
      // The native call resolves only after the peer's delivery ack (sender) or
      // after every chunk is decrypted and on disk (receiver), so crediting the
      // remainder here is a statement about durability, not about bytes sent.
      creditTo(moved);
      if (stopped) return { kind: 'failed', reason: 'aborted' };
      return moved >= wanted.length
        ? { kind: 'drained' }
        : { kind: 'failed', reason: `lan moved ${moved}/${wanted.length}` };
    } catch (e: any) {
      return { kind: 'failed', reason: stopped ? 'aborted' : (e?.message ?? 'lan error') };
    } finally {
      try { offProgress(); } catch { /* already removed */ }
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* no-op */ }
    }
  }
}

/** Default production binding — lazily imported so this module stays Node-safe. */
export async function defaultLanNative(): Promise<LanNative> {
  const native = await import('../../vaultBeamStreamNative');
  return {
    serve: (op) => native.lanServe(op as any),
    connect: (op) => native.lanConnect(op as any),
    onEvent: (name, cb) => native.onLanEvent(name, cb),
  };
}

// ── self-check: `npx tsx lib/vaultBeam/drivers/lan.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('lan driver: ' + m); };
  const CHUNK = 512 * 1024;
  const CHUNKS = 12;

  const mkSession = (role: 'sender' | 'recipient') => new TransferSession({
    transferId: 'Tlan123456789012', sessionVersion: 1, fileId: 'F', keyB64: 'k',
    role, totalBytes: CHUNKS * CHUNK,
  });

  /** Fake native: records the runs it was handed, emits progress, resolves. */
  class FakeNative implements LanNative {
    lastOp: LanRunsOp | null = null;
    private cbs: Record<string, Array<(d: any) => void>> = {};
    constructor(private cfg: { moved?: number; throwWith?: string; emitEvery?: number } = {}) {}
    onEvent(name: string, cb: (d: any) => void) {
      (this.cbs[name] ||= []).push(cb);
      return () => { const a = this.cbs[name]; const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
    }
    private async go(op: LanRunsOp): Promise<number> {
      this.lastOp = op;
      if (this.cfg.throwWith) throw new Error(this.cfg.throwWith);
      const total = op.runs.reduce((n, r) => n + r.count, 0);
      const moved = this.cfg.moved ?? total;
      const every = this.cfg.emitEvery ?? 0;
      if (every > 0) {
        for (let d = every; d <= moved; d += every) {
          for (const cb of this.cbs['vbLanProgress'] ?? []) cb({ transferId: op.transferId, done: d, total });
        }
      }
      return moved;
    }
    serve(op: LanRunsOp) { return this.go(op); }
    connect(op: LanRunsOp) { return this.go(op); }
    listenerCount() { return Object.values(this.cbs).reduce((n, a) => n + a.length, 0); }
  }

  const run = async () => {
    // 1. the work-list becomes the native `runs` argument, verbatim
    let nat = new FakeNative();
    let d = new LanDriver({ native: nat, token: 'tok', chunkBytes: CHUNK, srcPath: '/s' });
    let s = mkSession('sender');
    const work: ChunkRun[] = [{ start: 3, count: 2 }, { start: 9, count: 1 }];
    let out = await d.run(s, work, { verified: (c) => s.markVerified(c), staged: () => {} }, new AbortController().signal);
    A(out.kind === 'drained', 'drains');
    A(JSON.stringify(nat.lastOp!.runs) === JSON.stringify([{ start: 3, count: 2 }, { start: 9, count: 1 }]),
      'the session work-list is passed to native as runs');
    A(s.peerHave.popcount() === 3, 'exactly the requested chunks credited');
    A(s.peerHave.test(3) && s.peerHave.test(4) && s.peerHave.test(9), 'the RIGHT chunk ids were credited');
    A(!s.peerHave.test(0) && !s.peerHave.test(5), 'untouched chunks stay unverified');
    d.dispose();

    // 2. progress events credit chunk IDs in run order, not ordinals
    nat = new FakeNative({ emitEvery: 1 });
    d = new LanDriver({ native: nat, token: 'tok', chunkBytes: CHUNK, srcPath: '/s' });
    s = mkSession('sender');
    const seen: number[] = [];
    await d.run(s, [{ start: 7, count: 3 }], { verified: (c) => { seen.push(c); s.markVerified(c); }, staged: () => {} },
      new AbortController().signal);
    A(seen.join(',') === '7,8,9', 'progress maps ordinals back to real chunk ids');
    A(new Set(seen).size === seen.length, 'no chunk credited twice');
    d.dispose();

    // 3. a partial move fails the tier, but keeps what genuinely landed
    nat = new FakeNative({ moved: 2 });
    d = new LanDriver({ native: nat, token: 'tok', chunkBytes: CHUNK, dstPath: '/d', endpoint: { host: '10.0.0.2', port: 5555 } });
    s = mkSession('recipient');
    out = await d.run(s, [{ start: 0, count: 5 }], { verified: (c) => s.markVerified(c), staged: () => {} },
      new AbortController().signal);
    A(out.kind === 'failed' && /2\/5/.test((out as any).reason), 'partial move is a failure');
    A(s.peerHave.popcount() === 2, 'the two chunks that landed are kept');
    A(s.pendingRuns()[0].start === 2, 'the session resumes from the first missing chunk');
    d.dispose();

    // 4. a native throw is a driver failure, not an exception
    nat = new FakeNative({ throwWith: 'lan_auth: bad token' });
    d = new LanDriver({ native: nat, token: 'tok', chunkBytes: CHUNK, srcPath: '/s' });
    s = mkSession('sender');
    out = await d.run(s, [{ start: 0, count: 3 }], { verified: () => {}, staged: () => {} }, new AbortController().signal);
    A(out.kind === 'failed' && /bad token/.test((out as any).reason), 'native errors surface as a failed outcome');
    d.dispose();

    // 5. availability: a recipient without an advertised endpoint cannot run
    const noEp = new LanDriver({ native: new FakeNative(), token: 't', chunkBytes: CHUNK, dstPath: '/d' });
    A((await noEp.available(mkSession('recipient'))) === false, 'no endpoint ⇒ unavailable');
    const withEp = new LanDriver({ native: new FakeNative(), token: 't', chunkBytes: CHUNK, dstPath: '/d', endpoint: { host: 'h', port: 1 } });
    A((await withEp.available(mkSession('recipient'))) === true, 'endpoint ⇒ available');
    A((await new LanDriver({ native: new FakeNative(), token: 't', chunkBytes: CHUNK }).available(mkSession('sender'))) === false,
      'sender without a source path is unavailable');

    // 6. the per-run listener is released by run() ITSELF, not by dispose().
    //    A driver is reused across rounds, so a subscription that only went away
    //    at teardown would accumulate one handler per round.
    const leakNat = new FakeNative({ emitEvery: 1 });
    const leaky = new LanDriver({ native: leakNat, token: 't', chunkBytes: CHUNK, srcPath: '/s' });
    const ls = mkSession('sender');
    A(leakNat.listenerCount() === 0, 'no listener before the first run');
    await leaky.run(ls, [{ start: 0, count: 2 }], { verified: (c) => ls.markVerified(c), staged: () => {} },
      new AbortController().signal);
    A(leakNat.listenerCount() === 0, 'run() released its own listener');
    // …and repeated rounds on the SAME driver stay flat
    for (let i = 0; i < 10; i++) {
      await leaky.run(ls, [{ start: 0, count: 1 }], { verified: () => {}, staged: () => {} }, new AbortController().signal);
    }
    A(leakNat.listenerCount() === 0, '10 rounds on one driver leak no listeners');
    leaky.dispose(); leaky.dispose();
    A(leakNat.listenerCount() === 0, 'dispose is idempotent and leaves nothing');

    // 7. repeated construct/run/dispose cycles do not accumulate listeners either
    const cycleNat = new FakeNative({ emitEvery: 1 });
    for (let i = 0; i < 20; i++) {
      const cd = new LanDriver({ native: cycleNat, token: 't', chunkBytes: CHUNK, srcPath: '/s' });
      const cs = mkSession('sender');
      await cd.run(cs, [{ start: 0, count: 1 }], { verified: (c) => cs.markVerified(c), staged: () => {} },
        new AbortController().signal);
      cd.dispose();
    }
    A(cycleNat.listenerCount() === 0, '20 run/dispose cycles leak no listeners');

    // 8. abort before anything moves
    const ac = new AbortController(); ac.abort();
    const ad = new LanDriver({ native: new FakeNative(), token: 't', chunkBytes: CHUNK, srcPath: '/s' });
    out = await ad.run(mkSession('sender'), [{ start: 0, count: 3 }], {
      verified: () => { throw new Error('must not report'); }, staged: () => {},
    }, ac.signal);
    A(out.kind === 'failed', 'aborted run fails without moving bytes');
    ad.dispose();

    console.log('vaultBeam/drivers/lan self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
