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

import { type ChunkRun } from '../bitmap';
import { TransferSession } from '../session';
import {
  type TransportDriver, type DriverOutcome, type DriverReport, type TransportChannel, expandRuns,
} from './types';

const FRAME = 16 * 1024;            // SCTP-safe datachannel frame
const BP_HIGH = 4 * 1024 * 1024;    // backpressure ceiling
const ACK_TIMEOUT_MS = 30000;

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
    this.off = ch.onMessage((m) => {
      if (typeof m !== 'string') return;
      try {
        const c = JSON.parse(m);
        if (c?.t === 'p' && Number.isInteger(c.i)) {
          if (!acked.has(c.i)) { acked.add(c.i); report.verified(c.i); }
        } else if (c?.t === 'ack') {
          eofAcked = true;
          if (Array.isArray(c.have)) for (const i of c.have) if (Number.isInteger(i) && !acked.has(i)) { acked.add(i); report.verified(i); }
        }
      } catch { /* a malformed control frame is ignored, never fatal */ }
    });

    // Tell the receiver exactly which chunks are coming, so it can size its
    // expectation without assuming a full-file stream.
    ch.sendControl(JSON.stringify({ t: 'w', runs: work.map((r) => [r.start, r.count]) }));

    for (const i of wanted) {
      if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
      const ct = await this.opts.crypto.readChunk(i);
      ch.sendControl(JSON.stringify({ t: 'c', i, len: ct.length }));
      for (let off = 0; off < ct.length; off += FRAME) {
        while (ch.bufferedAmount() > BP_HIGH) {
          if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
          await (this.opts.sleep ?? defaultSleep)(15);
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
    let done = false;
    let failure: string | null = null;
    const queue: Promise<void>[] = [];

    this.off = ch.onMessage((m) => {
      if (done) return;
      if (typeof m === 'string') {
        try {
          const c = JSON.parse(m);
          if (c?.t === 'w' && Array.isArray(c.runs)) {
            expected = c.runs.reduce((n: number, r: number[]) => n + (r?.[1] ?? 0), 0);
          } else if (c?.t === 'c' && Number.isInteger(c.i) && Number.isInteger(c.len)) {
            cur = { i: c.i, len: c.len, buf: new Uint8Array(c.len), off: 0 };
          } else if (c?.t === 'eof') {
            done = true;
          }
        } catch { /* ignore malformed control */ }
        return;
      }
      if (!cur) return;
      const take = Math.min(m.length, cur.len - cur.off);
      cur.buf.set(m.subarray(0, take), cur.off);
      cur.off += take;
      if (cur.off < cur.len) return;
      const { i, buf } = cur;
      cur = null;
      queue.push((async () => {
        try {
          await this.opts.crypto.writeChunk(i, buf);
          verified.push(i);
          report.verified(i);
          // Ack by chunk ID — the sender sets exactly this bit.
          ch.sendControl(JSON.stringify({ t: 'p', i }));
        } catch (e: any) {
          failure = e?.message ?? 'chunk verify failed';
          done = true;
        }
      })());
    });

    const sleep = this.opts.sleep ?? defaultSleep;
    const deadline = this.opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    for (let waited = 0; waited < deadline; waited += 10) {
      if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
      if (done && queue.length === 0) break;
      if (done) { await Promise.all(queue.splice(0)); break; }
      await sleep(10);
    }
    await Promise.all(queue.splice(0));

    if (failure) return { kind: 'failed', reason: failure };
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

    console.log('vaultBeam/drivers/p2p self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
