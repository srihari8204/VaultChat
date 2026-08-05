// lib/vaultBeam/wiring.ts — the composition root.
//
// Everything above this file is transport-agnostic and pure; everything below it
// is react-native. This is the single place they meet, so the seam stays one
// module rather than leaking into the session or the drivers.
//
// It owns: building a session from a manifest, registering the drivers a given
// transfer can actually use, wiring persistence to the manager's change hook,
// and the adapters that turn platform objects (an RTCDataChannel, the native
// module) into the small interfaces the drivers declare.
//
// Deliberately NOT here: negotiation. Choosing a transport, exchanging SDP/ICE
// and discovering a LAN endpoint stay in lib/vaultBeamDirect.ts; this file only
// consumes the result. Keeping negotiation out is what lets the engine be
// exercised with fakes.

import { CHUNK_BYTES, chunkCountFor } from './bitmap';
import { TransferSession, type TransferRole } from './session';
import { TransferManager, type RunResult } from './manager';
import { type TransportDriver } from './drivers/types';
import { WriteBehind, type SessionStore, type PersistedSession } from './persistence';
import { type P2pChannel, type P2pCrypto } from './drivers/p2p';
import { type LanNative } from './drivers/lan';

export interface VBManifestLike {
  keyB64: string; fileId: string; name: string; mime: string; size: number; token: string;
}

export interface EngineOpts {
  manager: TransferManager;
  store: SessionStore;
  /** Extra durable fields per session (sender source ref, driver cooldowns). */
  extra?: (s: TransferSession) => Partial<PersistedSession>;
  /** UI/progress sink — called on every session revision change. */
  onChange?: (s: TransferSession) => void;
  writeDelayMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => any;
  cancel?: (h: any) => void;
}

/**
 * Owns the manager + write-behind pair and the session lifecycle. One instance
 * per app process.
 */
export class VaultBeamEngine {
  readonly manager: TransferManager;
  private readonly wb: WriteBehind;
  private readonly onChange?: (s: TransferSession) => void;
  /** Per-transfer progress sinks. The engine is process-wide and long-lived, so
   *  a single stored callback would belong to whichever transfer happened to
   *  build it first and every later transfer's UI would go dark. */
  private readonly sinks = new Map<string, (s: TransferSession) => void>();

  constructor(o: EngineOpts) {
    this.manager = o.manager;
    this.onChange = o.onChange;
    this.wb = new WriteBehind({
      store: o.store, delayMs: o.writeDelayMs, extra: o.extra,
      now: o.now, schedule: o.schedule, cancel: o.cancel,
    });
  }

  /** Route this transfer's progress to a specific sink (its chat bubble). */
  setSink(transferId: string, cb: (s: TransferSession) => void): void { this.sinks.set(transferId, cb); }
  clearSink(transferId: string): void { this.sinks.delete(transferId); }

  /** Wire this into TransferManager({ onChange }) so state and disk stay in step. */
  handleChange = (s: TransferSession): void => {
    // A terminal state or a transport change is flushed at once; ordinary
    // progress coalesces. Both are the same call, so a caller cannot forget.
    this.wb.schedule(s, s.state !== 'active');
    this.sinks.get(s.transferId)?.(s);
    this.onChange?.(s);
  };

  session(opts: {
    transferId: string; sessionVersion: number; manifest: VBManifestLike; role: TransferRole;
  }): TransferSession {
    const existing = this.manager.get(opts.transferId);
    if (existing) return existing;
    return this.manager.adopt(new TransferSession({
      transferId: opts.transferId,
      sessionVersion: opts.sessionVersion,
      fileId: opts.manifest.fileId,
      keyB64: opts.manifest.keyB64,
      role: opts.role,
      totalBytes: opts.manifest.size,
      name: opts.manifest.name,
    }));
  }

  start(s: TransferSession): Promise<RunResult> { return this.manager.start(s); }
  cancel(transferId: string): void { this.manager.cancel(transferId); }
  poke(transferId: string): Promise<RunResult> | undefined { return this.manager.poke(transferId); }

  /** Flush every pending write — AppState background, teardown. */
  flush(): Promise<void> { return this.wb.flushAll(); }

  /** Terminal + acknowledged: drop the durable record. */
  forget(transferId: string): Promise<void> { return this.wb.forget(transferId); }

  /** Chunk count from size alone — the canonical grid needs nothing else. */
  static chunkCount(totalBytes: number): number { return chunkCountFor(totalBytes); }
}

// ── platform adapters ────────────────────────────────────────────────
// Small on purpose: each turns one platform object into the minimal interface a
// driver declares, so the driver never imports react-native.

/** RTCDataChannel → P2pChannel. */
export function channelFromDataChannel(dc: any): P2pChannel {
  const listeners: Array<(m: string | Uint8Array) => void> = [];
  const prior = dc.onmessage;
  dc.onmessage = (ev: any) => {
    try { prior?.(ev); } catch { /* a prior handler must not break ours */ }
    const d = ev?.data;
    const msg: string | Uint8Array = typeof d === 'string'
      ? d
      : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d?.buffer ?? d ?? []);
    for (const cb of [...listeners]) { try { cb(msg); } catch { /* one bad listener must not stop the rest */ } }
  };
  return {
    sendControl: (json) => dc.send(json),
    sendBinary: (bytes) => dc.send(new Uint8Array(bytes)),
    onMessage: (cb) => {
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    bufferedAmount: () => dc.bufferedAmount ?? 0,
    close: () => { listeners.length = 0; try { dc.close?.(); } catch { /* already closed */ } },
  };
}

/** The native per-chunk cipher, bound to one transfer. */
export function cryptoForSession(
  native: {
    readCipherChunk(op: any): Promise<string>;
    writeCipherChunk(op: any): Promise<number>;
  },
  s: TransferSession,
  paths: { srcPath?: string; dstPath?: string },
  b64: { decode: (s: string) => Uint8Array; encode: (b: Uint8Array) => string },
): P2pCrypto {
  const base = {
    keyB64: s.keyB64, transferId: s.transferId, fileId: s.fileId,
    chunkBytes: CHUNK_BYTES, chunkCount: s.chunkCount, totalBytes: s.totalBytes,
  };
  return {
    async readChunk(i) {
      return b64.decode(await native.readCipherChunk({ ...base, chunkIndex: i, srcPath: paths.srcPath }));
    },
    async writeChunk(i, ct) {
      return native.writeCipherChunk({ ...base, chunkIndex: i, dstPath: paths.dstPath, ctB64: b64.encode(ct) });
    },
  };
}

/** The native LAN surface. */
export function lanNativeFrom(native: {
  lanServe(op: any): Promise<number>;
  lanConnect(op: any): Promise<number>;
  onLanEvent(name: any, cb: (d: any) => void): () => void;
}): LanNative {
  return {
    serve: (op) => native.lanServe(op),
    connect: (op) => native.lanConnect(op),
    onEvent: (name, cb) => native.onLanEvent(name, cb),
  };
}

/** Register only the drivers a transfer can actually use, cheapest first. */
export function registerAvailable(manager: TransferManager, drivers: Array<TransportDriver | null | undefined>): void {
  const have = new Set(manager.driverIds());
  for (const d of drivers) if (d && !have.has(d.id)) manager.registerDriver(d);
}

// ── self-check: `npx tsx lib/vaultBeam/wiring.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('wiring: ' + m); };

  class FakeStore implements SessionStore {
    rows = new Map<string, PersistedSession>();
    saves = 0; removes = 0;
    async save(r: PersistedSession) { this.saves++; this.rows.set(r.transferId, r); }
    async loadAll() { return [...this.rows.values()]; }
    async remove(id: string) { this.removes++; this.rows.delete(id); }
  }

  const manifest: VBManifestLike = {
    keyB64: 'k', fileId: 'F', name: 'big.bin', mime: 'application/octet-stream',
    size: 10 * CHUNK_BYTES, token: 'tok',
  };

  const run = async () => {
    // 1. one session per transferId, built from the manifest
    const store = new FakeStore();
    const mgr = new TransferManager({ concurrency: 1, idlePollMs: 1, maxIdleRounds: 1, sleep: async () => {} });
    const eng = new VaultBeamEngine({ manager: mgr, store, writeDelayMs: 0 });
    const s1 = eng.session({ transferId: 'Twire1234567890a', sessionVersion: 1, manifest, role: 'recipient' });
    const s2 = eng.session({ transferId: 'Twire1234567890a', sessionVersion: 1, manifest, role: 'recipient' });
    A(s1 === s2, 'the engine is single-flight per transferId');
    A(s1.chunkCount === 10 && s1.fileId === 'F' && s1.name === 'big.bin', 'session built from the manifest');
    A(VaultBeamEngine.chunkCount(manifest.size) === 10, 'chunk count derives from size alone');

    // 2. change hook persists, and a terminal state flushes IMMEDIATELY
    s1.markVerified(0);
    eng.handleChange(s1);
    await Promise.resolve();
    const afterTick = store.saves;
    for (let i = 1; i < 10; i++) s1.markVerified(i);
    s1.finish('complete');
    eng.handleChange(s1);
    await Promise.resolve();
    A(store.saves > afterTick, 'a terminal state flushed at once');
    A(store.rows.get('Twire1234567890a')!.state === 'complete', 'terminal state persisted');

    // 3. registerAvailable is idempotent and skips nulls (a transport a given
    //    transfer cannot use — no LAN endpoint, no WebRTC build)
    const mkDriver = (id: string, cost: number): TransportDriver => ({
      id, cost, channel: 'direct',
      unitChunks: () => 1, available: async () => true,
      run: async () => ({ kind: 'drained' }), dispose: () => {},
    });
    const m2 = new TransferManager({ sleep: async () => {} });
    registerAvailable(m2, [mkDriver('lan', 10), null, mkDriver('relay', 30), undefined]);
    registerAvailable(m2, [mkDriver('lan', 10)]);            // duplicate → ignored
    A(JSON.stringify(m2.driverIds()) === JSON.stringify(['lan', 'relay']), 'registers each driver once, cost-ordered');

    // 4. datachannel adapter: control vs binary, unsubscribe, and it must not
    //    clobber an existing onmessage handler
    const sent: any[] = [];
    let priorCalls = 0;
    const dc: any = {
      bufferedAmount: 7,
      onmessage: () => { priorCalls++; },
      send: (x: any) => sent.push(x),
      close: () => { dc.closed = true; },
    };
    const ch = channelFromDataChannel(dc);
    const got: Array<string | Uint8Array> = [];
    const off = ch.onMessage((m) => got.push(m));
    dc.onmessage({ data: '{"t":"c"}' });
    dc.onmessage({ data: new Uint8Array([1, 2, 3]).buffer });
    A(got.length === 2 && typeof got[0] === 'string' && got[1] instanceof Uint8Array, 'string and binary both delivered');
    A(priorCalls === 2, 'the prior onmessage handler still runs');
    A(ch.bufferedAmount() === 7, 'backpressure is read from the channel');
    ch.sendControl('x'); ch.sendBinary(new Uint8Array([9]));
    A(sent.length === 2, 'sends pass through');
    off();
    dc.onmessage({ data: 'ignored' });
    A(got.length === 2, 'unsubscribe stops delivery');
    ch.close();
    A(dc.closed === true, 'close closes the datachannel');

    // 5. a throwing listener must not stop the others (one bad bubble must not
    //    stall a transfer)
    const dc2: any = { send: () => {}, close: () => {}, bufferedAmount: 0 };
    const ch2 = channelFromDataChannel(dc2);
    let second = 0;
    ch2.onMessage(() => { throw new Error('bad listener'); });
    ch2.onMessage(() => { second++; });
    dc2.onmessage({ data: 'hello' });
    A(second === 1, 'a throwing listener does not block the next one');

    // 6. crypto adapter passes the canonical geometry, never a per-tier one
    const calls: any[] = [];
    const crypto = cryptoForSession(
      { async readCipherChunk(op) { calls.push(op); return 'AAAA'; }, async writeCipherChunk(op) { calls.push(op); return 1; } },
      s1, { srcPath: '/s', dstPath: '/d' },
      { decode: () => new Uint8Array([1]), encode: () => 'AAAA' },
    );
    await crypto.readChunk(3);
    await crypto.writeChunk(4, new Uint8Array([1]));
    A(calls[0].chunkBytes === CHUNK_BYTES, 'read uses the canonical logical chunk');
    A(calls[0].chunkIndex === 3 && calls[0].srcPath === '/s', 'read op carries index + source');
    A(calls[1].chunkIndex === 4 && calls[1].dstPath === '/d', 'write op carries index + destination');
    A(calls[1].chunkCount === s1.chunkCount && calls[1].totalBytes === s1.totalBytes, 'geometry comes from the session');
    A(calls[0].transferId === s1.transferId && calls[0].fileId === s1.fileId, 'identity comes from the session');

    // 7. LAN adapter forwards verbatim
    const lanCalls: any[] = [];
    const lan = lanNativeFrom({
      async lanServe(op) { lanCalls.push(['serve', op]); return 1; },
      async lanConnect(op) { lanCalls.push(['connect', op]); return 2; },
      onLanEvent: () => () => {},
    });
    await lan.serve({ runs: [{ start: 1, count: 2 }] } as any);
    await lan.connect({ runs: [] } as any);
    A(lanCalls[0][0] === 'serve' && lanCalls[0][1].runs[0].count === 2, 'serve forwards runs');
    A(lanCalls[1][0] === 'connect', 'connect forwards');

    // 7b. REGRESSION: sinks are PER TRANSFER. The engine is process-wide and
    //     outlives any one transfer, so a single stored callback belonged to
    //     whichever transfer built it first and every later transfer's bubble
    //     went dark.
    {
      const st = new FakeStore();
      const m = new TransferManager({ sleep: async () => {} });
      const e = new VaultBeamEngine({ manager: m, store: st, writeDelayMs: 0 });
      m.setOnChange(e.handleChange);
      const a = e.session({ transferId: 'TsinkA0000000001', sessionVersion: 1, manifest, role: 'recipient' });
      const b = e.session({ transferId: 'TsinkB0000000001', sessionVersion: 1, manifest, role: 'recipient' });
      const seen: string[] = [];
      e.setSink('TsinkA0000000001', (x) => seen.push('A:' + x.peerHave.popcount()));
      e.setSink('TsinkB0000000001', (x) => seen.push('B:' + x.peerHave.popcount()));
      a.markVerified(0); e.handleChange(a);
      b.markVerified(0); b.markVerified(1); e.handleChange(b);
      A(seen.join(',') === 'A:1,B:2', `each transfer reached its OWN sink (got ${seen.join(',')})`);
      e.clearSink('TsinkA0000000001');
      a.markVerified(1); e.handleChange(a);
      A(seen.length === 2, 'a cleared sink stops receiving');
      A(seen.filter((x) => x.startsWith('B')).length === 1, "clearing A did not disturb B's sink");
    }

    // 8. flush + forget
    await eng.flush();
    await eng.forget('Twire1234567890a');
    A(store.removes === 1 && !store.rows.has('Twire1234567890a'), 'forget drops the durable record');

    console.log('vaultBeam/wiring self-check: OK');
  };

  run().catch((e) => { console.error(e); process.exit(1); });
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
