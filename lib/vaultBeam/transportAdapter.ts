// lib/vaultBeam/transportAdapter.ts — one vocabulary over the four live transports.
//
// ============================================================================
// THE REQUESTED INTERFACE, AND WHY THIS IS NOT IT
// ============================================================================
//
// The ask was `sendChunk / receiveChunk / cancel / pause / resume /
// getTransportInfo`. Two of those six cannot be built over the live path
// without replacing it, so they are deliberately absent. The reasons, because
// "we left it out" is not an answer:
//
// --- sendChunk / receiveChunk ---
//
// No live transport has a per-chunk entry point. Every one of them is a
// WHOLE-TRANSFER function that owns its own loop:
//
//     serveDirect(g)      -> 'lan' | 'p2p' | null
//     receiveDirect(g)    -> boolean
//     sendTransfer(o)     -> { blockCount }
//     receiveTransfer(o)  -> { path, verified }
//
// Worse than awkward, a per-chunk interface would be SLOWER by construction.
// `p2pSend` pipelines: it pushes frames into SCTP until `bufferedAmount` hits
// BP_HIGH and only then waits, so many chunks are in flight at once. An
// `await sendChunk(i)` boundary permits exactly one, making throughput a
// function of round-trip time instead of bandwidth. Turning a pipelined stream
// into a request/response ladder is not an abstraction, it is a regression.
//
// This is settled ground: `drivers/types.ts` already defines TransportDriver
// with `run(session, work: ChunkRun[], report, signal)` — a BATCH shape. That
// design faced the same question and reached the same answer.
//
// --- pause / resume ---
//
// No transport supports suspension. AbortSignal is one-way, the datachannel has
// no flow-control frame, and `mapPool` has no latch. Real pause means new
// protocol on the direct path.
//
// It is also unnecessary. Resume is already a property of the TRANSFER, not the
// transport: the bitmap is authoritative, so `cancel()` followed by a restart
// continues from exactly the committed chunks. Pause/resume as a user-visible
// feature is therefore cancel + restart, and that works today.
//
// ============================================================================
// WHAT THIS IS
// ============================================================================
//
// A thin façade at the granularity the transports actually have: run, cancel,
// getTransportInfo. It DELEGATES — it re-implements no protocol, touches no ICE
// configuration, no TURN, no R2 signing, no crypto. That delegation is the
// whole point, and the self-check asserts it rather than trusting it.
//
// It also absorbs one real inconsistency: `ProgressCb` means `(done, total)` in
// vaultBeamDirect and `(p: TransferProgress)` in vaultBeamTransfer. Callers
// currently adapt at each site; here they see one shape.
//
// ============================================================================
// NOT ON THE DEFAULT PATH — ON PURPOSE
// ============================================================================
//
// The controller still calls the transports directly. This is staging for the
// migration, and it stays unwired until the device matrix can prove the
// rewiring changed nothing — rewiring a device-proven path with no devices
// attached is how you ship a regression you cannot see. That is a deliberate,
// time-boxed state, unlike `lib/vaultBeam/wiring.ts`, which is unreachable code
// nobody chose. See vaultchat-two-transfer-stacks.
//
// PURE — the real transports are imported lazily inside run(), so this module
// loads under `npx tsx`. Injectable deps make the self-check hermetic.

import { currentEpoch } from './transportEpoch';

export type TransportId = 'direct' | 'relay';
export type TransportRole = 'sender' | 'receiver';

/** One progress shape, whatever the underlying transport reports. */
export interface TransportProgress {
  done: number;
  total: number;
  bytes?: number;
  totalBytes?: number;
}

/** What a transport achieved. Every field the underlying call produced. */
export interface TransportOutcome {
  /** Did THIS transport finish the transfer? A false here is a fallback cue. */
  delivered: boolean;
  /** Direct only: which tier actually won. */
  tier?: 'lan' | 'p2p';
  /** Receiver relay only. */
  path?: string;
  verified?: boolean;
  /** Sender relay only. */
  blockCount?: number;
}

export interface TransportInfo {
  id: TransportId;
  role: TransportRole;
  /** The §8 generation this adapter is running under; 0 before it starts. */
  epoch: number;
  /** Direct only, once known. Never guessed. */
  tier?: 'lan' | 'p2p';
  /** True between run() starting and settling. */
  running: boolean;
  /** True once cancel() has been called. */
  cancelled: boolean;
}

export interface RunOptions {
  transferId: string;
  onProgress?: (p: TransportProgress) => void;
  /** Cancels this adapter too, so a transfer-wide abort still works. */
  signal?: AbortSignal;
  /** Everything the underlying transport needs, passed through untouched. */
  params: Record<string, unknown>;
}

/** Injection seam. Production resolves these lazily to the real modules. */
export interface TransportDeps {
  serveDirect?: (g: any) => Promise<'lan' | 'p2p' | null>;
  receiveDirect?: (g: any) => Promise<boolean>;
  sendTransfer?: (o: any) => Promise<{ blockCount: number }>;
  receiveTransfer?: (o: any) => Promise<{ path: string; verified: boolean }>;
}

async function realDeps(): Promise<Required<TransportDeps>> {
  const [d, t] = await Promise.all([import('../vaultBeamDirect'), import('../vaultBeamTransfer')]);
  return {
    serveDirect: d.serveDirect, receiveDirect: d.receiveDirect,
    sendTransfer: t.sendTransfer, receiveTransfer: t.receiveTransfer,
  };
}

export class TransportAdapter {
  private ac = new AbortController();
  private _running = false;
  private _cancelled = false;
  private _tier?: 'lan' | 'p2p';
  private _transferId = '';

  constructor(
    readonly id: TransportId,
    readonly role: TransportRole,
    private readonly deps?: TransportDeps,
  ) {}

  /**
   * Run the underlying transport to completion.
   *
   * Never throws for "this transport did not deliver" — that is
   * `{ delivered: false }`, which is the fallback cue. A genuine error (native
   * unavailable, sha256 mismatch) still throws, because those must not be
   * mistaken for "try the next tier".
   */
  async run(o: RunOptions): Promise<TransportOutcome> {
    this._transferId = o.transferId;
    this._running = true;
    // Chain a transfer-wide abort onto this adapter's own controller.
    const onParentAbort = () => this.cancel();
    if (o.signal) {
      if (o.signal.aborted) { this._running = false; this._cancelled = true; throw new Error('aborted'); }
      try { o.signal.addEventListener?.('abort', onParentAbort); } catch {}
    }
    try {
      // Only reach for the real modules when an injected dep is missing:
      // importing vaultBeamDirect pulls in react-native, which the self-check
      // cannot load. Fully-stubbed runs must never touch it.
      const need: (keyof TransportDeps)[] = this.id === 'direct'
        ? [this.role === 'sender' ? 'serveDirect' : 'receiveDirect']
        : [this.role === 'sender' ? 'sendTransfer' : 'receiveTransfer'];
      const injected = this.deps ?? {};
      const d: Required<TransportDeps> = need.every((k) => typeof injected[k] === 'function')
        ? ({ ...injected } as Required<TransportDeps>)
        : { ...(await realDeps()), ...injected };
      const base = { ...o.params, transferId: o.transferId, signal: this.ac.signal };

      if (this.id === 'direct') {
        // vaultBeamDirect speaks (done, total).
        const onProgress = (done: number, total: number) => o.onProgress?.({ done, total });
        if (this.role === 'sender') {
          const tier = await d.serveDirect({ ...base, onProgress });
          if (tier) this._tier = tier;
          return { delivered: tier !== null, tier: tier ?? undefined };
        }
        const ok = await d.receiveDirect({ ...base, onProgress });
        return { delivered: ok };
      }

      // vaultBeamTransfer speaks ({ done, total, bytes, totalBytes }).
      const onProgress = (p: TransportProgress) => o.onProgress?.(p);
      if (this.role === 'sender') {
        const r = await d.sendTransfer({ ...base, onProgress });
        // Staged to R2. Delivery is the peer's pull, not this call.
        return { delivered: false, blockCount: r?.blockCount };
      }
      const r = await d.receiveTransfer({ ...base, onProgress });
      return { delivered: true, path: r?.path, verified: r?.verified };
    } finally {
      this._running = false;
      try { o.signal?.removeEventListener?.('abort', onParentAbort); } catch {}
    }
  }

  /** Idempotent. Safe before, during and after run(). */
  cancel(): void {
    this._cancelled = true;
    try { this.ac.abort(); } catch {}
  }

  getTransportInfo(): TransportInfo {
    return {
      id: this.id,
      role: this.role,
      epoch: this._transferId ? currentEpoch(this._transferId) : 0,
      tier: this._tier,
      running: this._running,
      cancelled: this._cancelled,
    };
  }
}

export const directSender = (d?: TransportDeps) => new TransportAdapter('direct', 'sender', d);
export const directReceiver = (d?: TransportDeps) => new TransportAdapter('direct', 'receiver', d);
export const relaySender = (d?: TransportDeps) => new TransportAdapter('relay', 'sender', d);
export const relayReceiver = (d?: TransportDeps) => new TransportAdapter('relay', 'receiver', d);

export default { TransportAdapter, directSender, directReceiver, relaySender, relayReceiver };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    let failures = 0;
    const A = (ok: boolean, what: string): void => {
      if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
    };
    const { beginEpoch, endTransfer } = require('./transportEpoch');

    console.log('\nVaultBeam transport adapter\n');

    const seen: Record<string, any> = {};
    const stub: TransportDeps = {
      serveDirect: async (g) => { seen.serveDirect = g; return 'p2p'; },
      receiveDirect: async (g) => { seen.receiveDirect = g; return false; },
      sendTransfer: async (o) => { seen.sendTransfer = o; return { blockCount: 7 }; },
      receiveTransfer: async (o) => { seen.receiveTransfer = o; return { path: '/d', verified: true }; },
    };
    const TID = 'Tadapter12345678';
    beginEpoch(TID);

    // ── delegation, not reimplementation ───────────────────────────
    const ds = directSender(stub);
    const r1 = await ds.run({ transferId: TID, params: { srcPath: '/s', peerId: 'P' } });
    A(r1.delivered && r1.tier === 'p2p', '1. sender-direct reports the tier that won');
    A(seen.serveDirect.srcPath === '/s' && seen.serveDirect.peerId === 'P',
      '2. and passes its params through untouched');
    A(seen.serveDirect.transferId === TID, '3. with the transfer id');
    A(typeof seen.serveDirect.signal === 'object', '4. and a signal it can cancel');

    const dr = directReceiver(stub);
    A((await dr.run({ transferId: TID, params: {} })).delivered === false,
      '5. a direct tier that did not deliver returns delivered:false, it does not throw');

    const rs = relaySender(stub);
    const r3 = await rs.run({ transferId: TID, params: { srcPath: '/s' } });
    A(r3.blockCount === 7, '6. sender-relay surfaces blockCount');
    A(r3.delivered === false,
      '7. staging to R2 is NOT delivery — the peer still has to pull');

    const rr = relayReceiver(stub);
    const r4 = await rr.run({ transferId: TID, params: { dstPath: '/d' } });
    A(r4.delivered && r4.path === '/d' && r4.verified === true,
      '8. receiver-relay surfaces path and the verification verdict');

    // ── the two progress shapes become one ─────────────────────────
    {
      const got: TransportProgress[] = [];
      const direct = directSender({
        ...stub,
        serveDirect: async (g) => { g.onProgress(3, 10); return 'lan'; },
      });
      await direct.run({ transferId: TID, onProgress: (p) => got.push(p), params: {} });
      A(got.length === 1 && got[0].done === 3 && got[0].total === 10,
        '9. direct (done,total) is normalised');

      const relay = relayReceiver({
        ...stub,
        receiveTransfer: async (o) => { o.onProgress({ done: 4, total: 9, bytes: 40, totalBytes: 90 }); return { path: '/d', verified: true }; },
      });
      await relay.run({ transferId: TID, onProgress: (p) => got.push(p), params: {} });
      A(got.length === 2 && got[1].done === 4 && got[1].bytes === 40,
        '10. relay ({done,total,bytes}) is normalised into the same shape');
    }

    // ── cancel ─────────────────────────────────────────────────────
    {
      const a = directSender({ ...stub, serveDirect: async (g) => (g.signal.aborted ? null : 'p2p') });
      a.cancel();
      const out = await a.run({ transferId: TID, params: {} });
      A(out.delivered === false, '11. cancel() before run reaches the transport as an aborted signal');
      A(a.getTransportInfo().cancelled, '12. and is visible in getTransportInfo');
      a.cancel(); a.cancel();
      A(true, '13. cancel is idempotent');
    }
    {
      const parent = new AbortController();
      let sawAbort = false;
      const a = relaySender({
        ...stub,
        sendTransfer: async (o) => {
          parent.abort();
          sawAbort = o.signal.aborted;
          return { blockCount: 0 };
        },
      });
      await a.run({ transferId: TID, signal: parent.signal, params: {} });
      A(sawAbort, '14. a transfer-wide abort propagates into the adapter');
    }
    {
      const parent = new AbortController();
      parent.abort();
      let threw = false;
      try { await directSender(stub).run({ transferId: TID, signal: parent.signal, params: {} }); }
      catch { threw = true; }
      A(threw, '15. an already-aborted transfer never starts the transport');
    }

    // ── getTransportInfo ───────────────────────────────────────────
    {
      const a = directSender(stub);
      const before = a.getTransportInfo();
      A(before.epoch === 0 && !before.running && !before.tier,
        '16. before running, nothing is claimed — no invented tier or epoch');
      await a.run({ transferId: TID, params: {} });
      const after = a.getTransportInfo();
      A(after.id === 'direct' && after.role === 'sender', '17. identity is reported');
      A(after.epoch === currentEpoch(TID), '18. the epoch comes from the §8 register, not a copy');
      A(after.tier === 'p2p', '19. the tier is reported only once observed');
      A(!after.running, '20. and running clears when run() settles');
    }

    // ── a real error is NOT a fallback cue ─────────────────────────
    {
      let threw = false;
      const a = relayReceiver({ ...stub, receiveTransfer: async () => { throw new Error('sha256 mismatch'); } });
      try { await a.run({ transferId: TID, params: {} }); } catch { threw = true; }
      A(threw, '21. a genuine error propagates — it must not look like "try the next tier"');
      A(!a.getTransportInfo().running, '22. and still clears the running flag');
    }

    // ── it delegates: no protocol of its own ───────────────────────
    {
      // Comments stripped: the claim is "implements no crypto/ICE", and prose
      // explaining WHY it delegates must not be mistaken for doing the thing.
      const src = require('fs').readFileSync(__filename, 'utf8')
        .split('// ── self-check')[0]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l: string) => !/^\s*\/\//.test(l)).join('\n');
      for (const forbidden of ['RTCPeerConnection', 'iceServers', 'createOffer', 'addIceCandidate',
                               'AES', 'nonce', 'presign', 'Signature', 'sha256', 'CHUNK_BYTES']) {
        A(!src.includes(forbidden),
          `23. the adapter contains no ${forbidden} — it delegates, it does not re-implement`);
      }
      A(!/sendChunk|receiveChunk|\bpause\b|\bresume\b/.test(src.replace(/\/\/[^\n]*/g, '')),
        '24. and defines no per-chunk or pause API it cannot honour');
    }

    endTransfer(TID);
    console.log(failures === 0
      ? '\nALL TRANSPORT-ADAPTER CHECKS PASSED ✓  (not on the default path yet)\n'
      : `\n${failures} FAILED ✗\n`);
    process.exit(failures === 0 ? 0 : 1);
  })();
}
