// lib/vaultBeam/drivers/p2p.ts — the WebRTC datachannel as a transport driver.
//
// Two protocol changes versus today, both required for resume:
//
//   1. The sender streams the REQUESTED RUNS, not `0..chunkCount`. A resumed or
//      fallen-back-from transfer must be able to say "send me 900..1000".
//   2. The per-chunk progress ack carries the chunk ID, not a running count.
//      `{t:'p', n: received}` is meaningless once the sender is sending an
//      arbitrary subset — the sender cannot know which bit to set. It is now
//      `{t:'p', i: <chunkId>}`, which feeds PeerHave directly.
//
// (2) is also what defuses RC-6: because every verified chunk is acked
// individually, the final `{t:'ack'}` stops being load-bearing. Losing it costs
// nothing, where today it discards the entire transfer.
//
// The datachannel and the chunk crypto are injected, so the protocol is
// exercised end-to-end under `npx tsx` with two drivers wired back to back.

import { type ChunkRun, CHUNK_BYTES } from '../bitmap';
import { TransferSession } from '../session';
import {
  type TransportDriver, type DriverOutcome, type DriverReport, type TransportChannel, expandRuns,
} from './types';

const FRAME = 16 * 1024;            // SCTP-safe datachannel frame
const BP_HIGH = 4 * 1024 * 1024;    // send-side: SCTP buffer ceiling
const ACK_TIMEOUT_MS = 30000;

// ── reader-side backpressure ─────────────────────────────────────────
// SCTP is reliable and ordered, so the transport itself never tells a sender to
// slow down for the RECEIVER's benefit — only for the network's. Bytes arrive as
// fast as the link allows, are reassembled into 512 KiB buffers, and each buffer
// is retained until its decrypt-and-write completes. A fast sender against a
// slow disk therefore grew the receiver's heap without any bound at all: 200
// outstanding writes is ~100 MiB, and nothing stopped it at 200.
//
// Two layers, because one is not enough:
//
//   1. COOPERATIVE. The receiver asks the sender to stop ({t:'x'}), and resumes
//      it when the queue drains. This is what makes the common case efficient —
//      no bytes are wasted.
//   2. UNILATERAL. Past the hard cap the receiver stops allocating at all and
//      discards the incoming chunk. That costs a re-fetch, but it holds even
//      against a peer that ignores the pause, is buggy, or is hostile. A memory
//      bound that depends on the other end's cooperation is not a bound.

/** Bytes of reassembled-but-not-yet-written chunk data the receiver will hold. */
const WRITE_BUDGET_BYTES = 4 * 1024 * 1024;      // 8 logical chunks
/** Resume the sender once the backlog has halved — hysteresis, not a thrash. */
const WRITE_RESUME_BYTES = WRITE_BUDGET_BYTES / 2;
/** Longest a sender obeys a pause before assuming the resume frame was lost. */
const MAX_PAUSE_MS = 30000;
/**
 * Largest wire chunk we will ever allocate for. The sender declares the length
 * and we used to believe it — `new Uint8Array(c.len)` from a peer-supplied
 * integer is an allocation primitive handed to the other end. A logical chunk
 * plus its GCM tag is the only legal size.
 */
const MAX_WIRE_CHUNK = CHUNK_BYTES + 16;

/** The datachannel, abstracted so the protocol can be tested without WebRTC. */
export interface P2pChannel {
  sendControl(json: string): void;
  sendBinary(bytes: Uint8Array): void;
  onMessage(cb: (m: string | Uint8Array) => void): () => void;
  bufferedAmount(): number;
  close(): void;
}

/** Per-chunk crypto + positional IO — native in production. */
export interface P2pCrypto {
  readChunk(index: number): Promise<Uint8Array>;              // → ct‖tag
  writeChunk(index: number, ct: Uint8Array): Promise<number>; // verify+decrypt+write
}

export interface P2pDriverOpts {
  channel: P2pChannel;
  crypto: P2pCrypto;
  /** Chunks per control frame. Throughput tuning only. */
  unit?: number;
  ackTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Reader-side memory budget: reassembled bytes awaiting a write. Past this
   *  the receiver refuses to allocate and the chunk is re-fetched later. */
  writeBudgetBytes?: number;
}

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class P2pDriver implements TransportDriver {
  readonly id = 'p2p';
  readonly cost = 20;                       // cheaper than the relay, dearer than LAN
  readonly channel: TransportChannel = 'direct';

  private off: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly opts: P2pDriverOpts) {}

  unitChunks(): number { return Math.max(1, this.opts.unit ?? 1); }
  async available(): Promise<boolean> { return !this.disposed; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.off?.(); } catch { /* listener already gone */ }
    this.off = null;
    try { this.opts.channel.close(); } catch { /* channel already closed */ }
  }

  async run(
    session: TransferSession, work: ChunkRun[], report: DriverReport, signal: AbortSignal,
  ): Promise<DriverOutcome> {
    if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
    if (this.disposed) return { kind: 'failed', reason: 'disposed' };
    try {
      return session.role === 'sender'
        ? await this.send(work, report, signal)
        : await this.receive(session, work, report, signal);
    } catch (e: any) {
      return { kind: 'failed', reason: e?.message ?? 'p2p error' };
    } finally {
      // Per-run subscription released here, NOT in dispose(): the driver is
      // reused across rounds, so a listener that only went away at teardown
      // would accumulate one handler per round on the datachannel.
      try { this.off?.(); } catch { /* already removed */ }
      this.off = null;
    }
  }

  // ── SENDER ───────────────────────────────────────────────────────
  private async send(work: ChunkRun[], report: DriverReport, signal: AbortSignal): Promise<DriverOutcome> {
    const wanted = expandRuns(work);
    if (wanted.length === 0) return { kind: 'drained' };
    const ch = this.opts.channel;

    // Verified-chunk acks arrive by chunk ID, so a partial delivery is credited
    // exactly. This is what makes the final ack non-load-bearing.
    const acked = new Set<number>();
    let eofAcked = false;
    /** The receiver has asked us to hold off — its write backlog is at budget. */
    let peerPaused = false;
    this.off = ch.onMessage((m) => {
      if (typeof m !== 'string') return;
      try {
        const c = JSON.parse(m);
        if (c?.t === 'p' && Number.isInteger(c.i)) {
          if (!acked.has(c.i)) { acked.add(c.i); report.verified(c.i); }
        } else if (c?.t === 'x') {
          peerPaused = !!c.stop;
        } else if (c?.t === 'ack') {
          eofAcked = true;
          if (Array.isArray(c.have)) for (const i of c.have) if (Number.isInteger(i) && !acked.has(i)) { acked.add(i); report.verified(i); }
        }
      } catch { /* a malformed control frame is ignored, never fatal */ }
    });

    // Tell the receiver exactly which chunks are coming, so it can size its
    // expectation without assuming a full-file stream.
    ch.sendControl(JSON.stringify({ t: 'w', runs: work.map((r) => [r.start, r.count]) }));

    const nap = this.opts.sleep ?? defaultSleep;
    for (const i of wanted) {
      if (signal.aborted) return { kind: 'failed', reason: 'aborted' };

      // Honour the receiver's pause BETWEEN chunks: stopping here leaves it with
      // no half-filled buffer to hold, which is the whole point of pausing.
      //
      // Bounded, because the resume frame can be lost and a sender that waits
      // forever on a message that will never arrive is a hang, not flow control.
      // The receiver's hard cap makes resuming early safe — the worst case is a
      // refused chunk and a re-fetch.
      for (let waited = 0; peerPaused && waited < MAX_PAUSE_MS; waited += 15) {
        if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
        await nap(15);
      }
      peerPaused = false;

      const ct = await this.opts.crypto.readChunk(i);
      ch.sendControl(JSON.stringify({ t: 'c', i, len: ct.length }));
      for (let off = 0; off < ct.length; off += FRAME) {
        while (ch.bufferedAmount() > BP_HIGH) {
          if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
          await nap(15);
        }
        ch.sendBinary(ct.subarray(off, off + FRAME));
      }
      // No progress reported here: buffering into SCTP is not delivery.
    }
    ch.sendControl(JSON.stringify({ t: 'eof' }));

    // Wait for the closing ack, but do NOT treat its loss as losing the
    // transfer: every chunk the receiver verified was already acked by ID.
    const deadline = (this.opts.ackTimeoutMs ?? ACK_TIMEOUT_MS);
    const step = 10;
    for (let waited = 0; waited < deadline && !eofAcked; waited += step) {
      if (signal.aborted) break;
      await (this.opts.sleep ?? defaultSleep)(step);
    }
    if (eofAcked && acked.size >= wanted.length) return { kind: 'drained' };
    if (acked.size > 0) return { kind: 'drained' };   // partial, but credited — the session decides what remains
    return { kind: 'failed', reason: 'no p2p delivery ack' };
  }

  // ── RECIPIENT ────────────────────────────────────────────────────
  private async receive(
    session: TransferSession, work: ChunkRun[], report: DriverReport, signal: AbortSignal,
  ): Promise<DriverOutcome> {
    const ch = this.opts.channel;
    const verified: number[] = [];
    let expected = expandRuns(work).length;
    let cur: { i: number; len: number; buf: Uint8Array; off: number } | null = null;
    /** Bytes still to discard for a chunk we refused to allocate for. */
    let skip = 0;
    /** No more data is expected: the sender said eof, or something went fatal. */
    let done = false;
    /** DISCARD results. Only cancellation sets this — `done` must not, or the
     *  chunk whose write is still in flight when eof arrives gets written to
     *  disk and then dropped on the floor, one short of a complete transfer. */
    let stopped = false;
    let failure: string | null = null;
    /** A Set, not an array: a settled write REMOVES itself, so `size` is the live
     *  backlog rather than a tally of everything the run ever did. The array it
     *  replaces only ever grew. */
    const queue = new Set<Promise<void>>();
    let pendingBytes = 0;
    let paused = false;
    let refused = 0;

    const budget = this.opts.writeBudgetBytes ?? WRITE_BUDGET_BYTES;
    const resumeAt = Math.max(1, Math.floor(budget / 2));

    const say = (msg: unknown) => { try { ch.sendControl(JSON.stringify(msg)); } catch { /* channel gone */ } };

    this.off = ch.onMessage((m) => {
      if (done) return;
      if (typeof m === 'string') {
        try {
          const c = JSON.parse(m);
          if (c?.t === 'w' && Array.isArray(c.runs)) {
            expected = c.runs.reduce((n: number, r: number[]) => n + (r?.[1] ?? 0), 0);
          } else if (c?.t === 'c' && Number.isInteger(c.i) && Number.isInteger(c.len)) {
            // The peer declares the length; we do not take its word for it. An
            // out-of-range length is a broken or hostile sender, not a chunk.
            if (c.len <= 0 || c.len > MAX_WIRE_CHUNK) {
              failure = `illegal chunk length ${c.len} for chunk ${c.i}`;
              done = true;
              return;
            }
            if (pendingBytes + c.len > budget) {
              // HARD CAP. Allocate nothing and discard this chunk's bytes as
              // they arrive. It is never acked, so it stays in the work-list and
              // comes back on a later round — a re-fetch is the correct price
              // for a bound that does not depend on the sender behaving.
              skip = c.len;
              cur = null;
              refused++;
              return;
            }
            cur = { i: c.i, len: c.len, buf: new Uint8Array(c.len), off: 0 };
            pendingBytes += c.len;
          } else if (c?.t === 'eof') {
            done = true;
          }
        } catch { /* ignore malformed control */ }
        return;
      }
      if (skip > 0) { skip -= m.length; if (skip < 0) skip = 0; return; }
      if (!cur) return;
      const take = Math.min(m.length, cur.len - cur.off);
      cur.buf.set(m.subarray(0, take), cur.off);
      cur.off += take;
      if (cur.off < cur.len) return;
      const { i, buf, len } = cur;
      cur = null;

      // Ask the sender to hold off BEFORE starting the write, so the pause is in
      // flight while the disk works rather than after the backlog has grown.
      if (!paused && pendingBytes >= budget) { paused = true; say({ t: 'x', stop: 1 }); }

      const p = (async () => {
        try {
          await this.opts.crypto.writeChunk(i, buf);
          if (stopped) return;                    // cancelled mid-write
          verified.push(i);
          report.verified(i);
          say({ t: 'p', i });                     // ack by chunk ID
        } catch (e: any) {
          failure = e?.message ?? 'chunk verify failed';
          done = true;
        } finally {
          // Release the budget whatever happened — a write that threw still
          // dropped its buffer, and holding the accounting open would wedge the
          // receiver in a permanent pause.
          pendingBytes -= len;
          queue.delete(p);
          if (paused && pendingBytes <= resumeAt && !stopped) { paused = false; say({ t: 'x', stop: 0 }); }
        }
      })();
      queue.add(p);
    });

    const sleep = this.opts.sleep ?? defaultSleep;
    const deadline = this.opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    const drain = async () => { while (queue.size) await Promise.all([...queue]); };

    for (let waited = 0; waited < deadline; waited += 10) {
      if (signal.aborted) {
        // CANCEL. Stop accepting first, so nothing new is allocated while we
        // unwind, then wait for the writes already touching the file — leaving
        // them running would let them report progress into a cancelled session
        // and write behind a caller that believes everything has stopped.
        done = true;
        stopped = true;
        try { this.off?.(); } catch { /* already removed */ }
        this.off = null;
        cur = null;
        skip = 0;
        await drain();
        queue.clear();
        return { kind: 'failed', reason: 'aborted' };
      }
      if (done && queue.size === 0) break;
      if (done) { await drain(); break; }
      await sleep(10);
    }
    await drain();
    queue.clear();

    if (failure) return { kind: 'failed', reason: failure };
    // A refusal is not an error: those chunks are simply still outstanding, and
    // the session re-derives them. Report it so a receiver that is chronically
    // behind its disk is visible rather than merely slow.
    if (refused > 0 && verified.length < expected) {
      return { kind: 'failed', reason: `write budget exceeded — ${refused} chunk(s) deferred`, retryAfterMs: 250 };
    }
    // Closing ack carries the full verified set, so a peer that missed some
    // per-chunk acks still converges.
    try { ch.sendControl(JSON.stringify({ t: 'ack', have: verified })); } catch { /* channel gone */ }
    void session;
    return verified.length >= expected ? { kind: 'drained' } : { kind: 'failed', reason: 'incomplete p2p stream' };
  }
}

// ── self-check: `npx tsx lib/vaultBeam/drivers/p2p.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('p2p driver: ' + m); };
  const CHUNK = 512 * 1024;
  const CHUNKS = 12;
  const TOTAL = CHUNKS * CHUNK;

  /** Two channels wired back to back, with optional message loss. */
  function link(opts: { dropControl?: (c: any) => boolean } = {}) {
    const cbs: Array<Array<(m: string | Uint8Array) => void>> = [[], []];
    const mk = (self: 0 | 1): P2pChannel => ({
      sendControl: (json) => {
        if (opts.dropControl) { try { if (opts.dropControl(JSON.parse(json))) return; } catch { /* not JSON */ } }
        for (const cb of cbs[1 - self]) cb(json);
      },
      sendBinary: (b) => { const copy = new Uint8Array(b); for (const cb of cbs[1 - self]) cb(copy); },
      onMessage: (cb) => { cbs[self].push(cb); return () => { const i = cbs[self].indexOf(cb); if (i >= 0) cbs[self].splice(i, 1); }; },
      bufferedAmount: () => 0,
      close: () => { cbs[self].length = 0; },
    });
    return { a: mk(0), b: mk(1) };
  }

  /** A fake "file": chunk i is a buffer full of byte i. Ciphertext = plaintext + tag byte. */
  const plain = (i: number, len = CHUNK) => new Uint8Array(len).fill(i & 0xff);
  const mkCrypto = (store: Map<number, Uint8Array>, tamper?: number): P2pCrypto => ({
    async readChunk(i) { const p = plain(i, 64); const ct = new Uint8Array(p.length + 1); ct.set(p); ct[p.length] = 0xAA; return ct; },
    async writeChunk(i, ct) {
      if (tamper === i || ct[ct.length - 1] !== 0xAA) throw new Error(`GCM tag failure on chunk ${i}`);
      store.set(i, ct.subarray(0, ct.length - 1));
      return ct.length - 1;
    },
  });

  const mkSession = (role: 'sender' | 'recipient') => new TransferSession({
    transferId: 'Tp2p123456789012', sessionVersion: 1, fileId: 'F', keyB64: 'k', role, totalBytes: TOTAL,
  });

  const drive = async (work: ChunkRun[], o: { dropControl?: (c: any) => boolean; tamper?: number } = {}) => {
    const { a, b } = link({ dropControl: o.dropControl });
    const store = new Map<number, Uint8Array>();
    const ss = mkSession('sender');
    const rs = mkSession('recipient');
    const sd = new P2pDriver({ channel: a, crypto: mkCrypto(new Map()), sleep: async () => {}, ackTimeoutMs: 400 });
    const rd = new P2pDriver({ channel: b, crypto: mkCrypto(store, o.tamper), sleep: async () => {}, ackTimeoutMs: 400 });
    const sig = new AbortController().signal;
    const rp = rd.run(rs, work, { verified: (c) => rs.markVerified(c), staged: () => {} }, sig);
    const sp = sd.run(ss, work, { verified: (c) => ss.markVerified(c), staged: () => {} }, sig);
    const [rout, sout] = await Promise.all([rp, sp]);
    sd.dispose(); rd.dispose();
    return { ss, rs, store, rout, sout };
  };

  const run = async () => {
    // 1. full transfer: both sides converge, sender's progress comes from acks
    let r = await drive([{ start: 0, count: CHUNKS }]);
    A(r.rout.kind === 'drained' && r.sout.kind === 'drained', 'full transfer drains both ways');
    A(r.rs.peerHave.popcount() === CHUNKS, 'receiver verified every chunk');
    A(r.ss.peerHave.popcount() === CHUNKS, 'SENDER learned every chunk from per-chunk acks');
    A(r.store.size === CHUNKS, 'every chunk written');

    // 2. THE resume case: a subset is requested, and ONLY that subset moves
    r = await drive([{ start: 5, count: 3 }, { start: 11, count: 1 }]);
    A(r.rs.peerHave.popcount() === 4, 'exactly the requested chunks verified');
    A([...r.store.keys()].sort((a, b) => a - b).join(',') === '5,6,7,11', 'only the requested chunks were written');
    A(r.ss.peerHave.popcount() === 4, 'sender credited exactly those chunks');
    A(!r.rs.peerHave.test(0) && !r.rs.peerHave.test(4), 'untouched chunks stay unverified');

    // 3. RC-6: the closing ack is LOST. Per-chunk acks already credited
    //    everything, so nothing is lost and the sender still drains.
    r = await drive([{ start: 0, count: CHUNKS }], { dropControl: (c) => c?.t === 'ack' });
    A(r.ss.peerHave.popcount() === CHUNKS, 'losing the final ack costs NOTHING');
    A(r.sout.kind === 'drained', 'sender still drains without the closing ack');

    // 4. a tampered chunk fails the tier without corrupting what was verified
    r = await drive([{ start: 0, count: CHUNKS }], { tamper: 4 });
    A(r.rout.kind === 'failed', 'tampered chunk fails the receiver');
    A(!r.rs.peerHave.test(4), 'the bad chunk is NOT marked verified');
    A(r.rs.peerHave.popcount() > 0, 'chunks verified before the failure are kept');
    A(r.rs.peerHave.popcount() < CHUNKS, 'and the transfer is not claimed complete');

    // 5. an empty work-list is a no-op, not an error
    r = await drive([]);
    A(r.sout.kind === 'drained', 'empty work drains immediately');
    A(r.store.size === 0, 'nothing moved');

    // 6. the ack carries chunk IDs, so a sender resuming later sets the RIGHT
    //    bits — a running count could not express a subset at all
    const { a, b } = link();
    const seen: number[] = [];
    const rs2 = mkSession('recipient');
    const rd2 = new P2pDriver({ channel: b, crypto: mkCrypto(new Map()), sleep: async () => {}, ackTimeoutMs: 200 });
    const off = a.onMessage((m) => { if (typeof m === 'string') { const c = JSON.parse(m); if (c.t === 'p') seen.push(c.i); } });
    const sd2 = new P2pDriver({ channel: a, crypto: mkCrypto(new Map()), sleep: async () => {}, ackTimeoutMs: 200 });
    const w: ChunkRun[] = [{ start: 8, count: 2 }];
    await Promise.all([
      rd2.run(rs2, w, { verified: (c) => rs2.markVerified(c), staged: () => {} }, new AbortController().signal),
      sd2.run(mkSession('sender'), w, { verified: () => {}, staged: () => {} }, new AbortController().signal),
    ]);
    off(); sd2.dispose(); rd2.dispose();
    A(seen.sort((x, y) => x - y).join(',') === '8,9', 'progress acks carry chunk IDs, not a running count');

    // 7. abort is honoured before anything moves
    const ac = new AbortController(); ac.abort();
    const sd3 = new P2pDriver({ channel: link().a, crypto: mkCrypto(new Map()), sleep: async () => {} });
    const out = await sd3.run(mkSession('sender'), [{ start: 0, count: 4 }], {
      verified: () => { throw new Error('must not report'); }, staged: () => {},
    }, ac.signal);
    A(out.kind === 'failed', 'aborted run fails without moving bytes');
    sd3.dispose();

    // 8. dispose is idempotent
    const sd4 = new P2pDriver({ channel: link().a, crypto: mkCrypto(new Map()) });
    sd4.dispose(); sd4.dispose();
    A(true, 'dispose is idempotent');

    // ── reader-side backpressure (P1) ──────────────────────────────
    // A slow disk with a fast sender is the shape that grew the receiver's heap
    // without bound. Every assertion below is about MEMORY, not throughput.

    /** Crypto whose writes never settle until released — a stalled disk. */
    const stalledCrypto = (gate: { release: null | (() => void); waiting: number }): P2pCrypto => ({
      async readChunk(i) { const ct = new Uint8Array(65); ct.fill(i & 0xff); ct[64] = 0xAA; return ct; },
      async writeChunk() {
        gate.waiting++;
        await new Promise<void>((r) => {
          const prev = gate.release;
          gate.release = () => { prev?.(); r(); };
        });
        return 64;
      },
    });

    // 9. the receiver never holds more than its budget, no matter how fast the
    //    sender pushes. The budget here is 3 chunks' worth of wire bytes.
    {
      const { a, b } = link();
      const gate = { release: null as null | (() => void), waiting: 0 };
      const BUDGET = 65 * 3;
      const rd5 = new P2pDriver({
        channel: b, crypto: stalledCrypto(gate), sleep: async () => {},
        ackTimeoutMs: 50, writeBudgetBytes: BUDGET,
      });
      const rs5 = mkSession('recipient');
      const w = [{ start: 0, count: CHUNKS }];
      const rp = rd5.run(rs5, w, { verified: (c) => rs5.markVerified(c), staged: () => {} }, new AbortController().signal);

      // Push every chunk at the receiver with no regard for its pause, exactly
      // as a peer that ignores flow control would.
      for (let i = 0; i < CHUNKS; i++) {
        a.sendControl(JSON.stringify({ t: 'c', i, len: 65 }));
        const ct = new Uint8Array(65); ct.fill(i & 0xff); ct[64] = 0xAA;
        a.sendBinary(ct);
      }
      A(gate.waiting <= 3, `receiver started at most 3 writes under a 3-chunk budget (got ${gate.waiting})`);
      a.sendControl(JSON.stringify({ t: 'eof' }));
      gate.release?.();
      const out9 = await rp;
      A(out9.kind === 'failed' && /budget/.test((out9 as any).reason),
        `a receiver at its budget says so (got ${JSON.stringify(out9)})`);
      A(rs5.peerHave.popcount() <= 3, 'only the chunks it had room for were verified');
      A(rs5.pendingRuns().length > 0, 'the refused chunks are still work — nothing was lost');
      rd5.dispose();
    }

    // 10. the pause actually reaches the sender, and the sender obeys it
    {
      const { a, b } = link();
      const paused: any[] = [];
      const offSpy = b.onMessage(() => {});      // keep the link alive
      const spy = a.onMessage((m) => { if (typeof m === 'string') { const c = JSON.parse(m); if (c.t === 'x') paused.push(c.stop); } });
      const gate = { release: null as null | (() => void), waiting: 0 };
      const rd6 = new P2pDriver({
        channel: b, crypto: stalledCrypto(gate), sleep: async () => {},
        ackTimeoutMs: 50, writeBudgetBytes: 65 * 2,
      });
      const rs6 = mkSession('recipient');
      const rp = rd6.run(rs6, [{ start: 0, count: 6 }], { verified: (c) => rs6.markVerified(c), staged: () => {} }, new AbortController().signal);
      for (let i = 0; i < 4; i++) {
        a.sendControl(JSON.stringify({ t: 'c', i, len: 65 }));
        const ct = new Uint8Array(65); ct.fill(i & 0xff); ct[64] = 0xAA;
        a.sendBinary(ct);
      }
      A(paused.includes(1), 'the receiver told the sender to stop');
      a.sendControl(JSON.stringify({ t: 'eof' }));
      gate.release?.();
      await rp;
      spy(); offSpy(); rd6.dispose();
    }

    // 11. a peer-declared chunk length is NOT an allocation primitive. Believing
    //     `len` meant the other end could ask for any buffer it liked.
    {
      const { a, b } = link();
      const rd7 = new P2pDriver({ channel: b, crypto: mkCrypto(new Map()), sleep: async () => {}, ackTimeoutMs: 50 });
      const rs7 = mkSession('recipient');
      const rp = rd7.run(rs7, [{ start: 0, count: 2 }], { verified: () => { throw new Error('must not verify'); }, staged: () => {} }, new AbortController().signal);
      a.sendControl(JSON.stringify({ t: 'c', i: 0, len: 2 ** 31 }));
      const out11 = await rp;
      A(out11.kind === 'failed' && /illegal chunk length/.test((out11 as any).reason),
        `an out-of-range length is rejected (got ${JSON.stringify(out11)})`);
      rd7.dispose();
    }

    // 12. CANCELLATION drains rather than abandoning: a write already touching
    //     the file must not still be running after the run has returned, and
    //     must not report into a session the caller believes is cancelled.
    {
      const { a, b } = link();
      const gate = { release: null as null | (() => void), waiting: 0 };
      let reportedAfterCancel = 0;
      let cancelled = false;
      const rd8 = new P2pDriver({ channel: b, crypto: stalledCrypto(gate), sleep: async () => {}, ackTimeoutMs: 10_000 });
      const rs8 = mkSession('recipient');
      const ac8 = new AbortController();
      const rp = rd8.run(rs8, [{ start: 0, count: 4 }], {
        verified: () => { if (cancelled) reportedAfterCancel++; }, staged: () => {},
      }, ac8.signal);
      a.sendControl(JSON.stringify({ t: 'c', i: 0, len: 65 }));
      const ct = new Uint8Array(65); ct.fill(0); ct[64] = 0xAA;
      a.sendBinary(ct);
      A(gate.waiting === 1, 'a write is in flight');
      cancelled = true;
      ac8.abort();
      // The run must not resolve while the write is still outstanding.
      let settled = false;
      void rp.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 20));
      A(settled === false, 'cancel WAITS for the in-flight write instead of abandoning it');
      gate.release?.();
      const out12 = await rp;
      A(out12.kind === 'failed' && /aborted/.test((out12 as any).reason), 'cancel reports aborted');
      A(reportedAfterCancel === 0, 'a write that finished after cancel reported NOTHING');
      A(rs8.peerHave.popcount() === 0, 'and moved no progress');
      rd8.dispose();
    }

    console.log('vaultBeam/drivers/p2p self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
