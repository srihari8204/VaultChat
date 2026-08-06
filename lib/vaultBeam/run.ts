// lib/vaultBeam/run.ts — the seamless-resume entry point (VB_SEAMLESS_RESUME).
//
// One function per role. It assembles the session, the drivers a transfer can
// actually use, and the manager, then returns when the transfer reaches a
// terminal state or parks. Negotiation is reused from lib/vaultBeamDirect via
// its hooks, so the sealed offer/answer/ICE exchange and the tier signalling are
// the SAME code the legacy path uses — only the data path is different.
//
// Everything react-native is imported lazily, so this module (and the whole
// engine beneath it) stays importable under `npx tsx`.
//
// NOT YET DEVICE-TESTED. The flag is off; the 14-row transport-switching matrix
// in openspec/changes/vaultbeam-seamless-resume/tasks.md §8.2 is the merge gate.

import { Buffer } from 'buffer';
import { CHUNK_BYTES } from './bitmap';
import { TransferSession } from './session';
import { TransferManager } from './manager';
import { VaultBeamEngine, channelFromDataChannel, cryptoForSession, lanNativeFrom, type VBManifestLike } from './wiring';
import { gateUntilReady, graceGate } from './gate';
import { RelayDriver, type RelayIO, type RelayStateLike } from './drivers/relay';
import { P2pDriver, type P2pDriverOpts, type P2pChannel } from './drivers/p2p';
import { LanDriver, type LanDriverOpts } from './drivers/lan';

/** How long the relay is held back so LAN/P2P can negotiate. */
const DIRECT_GRACE_MS = 8000;

let _engine: VaultBeamEngine | null = null;
let _manager: TransferManager | null = null;

/** Process-wide engine. Built once, lazily, so nothing loads react-native at import. */
export async function engine(): Promise<VaultBeamEngine> {
  if (_engine) return _engine;
  const { defaultSessionStore } = await import('./persistence');
  const store = await defaultSessionStore();
  const native = await import('../vaultBeamStreamNative');
  const mgr = new TransferManager({ concurrency: 1 });
  _manager = mgr;

  // DURABILITY (P0). A recipient's chunk is not progress until its bytes are on
  // stable storage — see manager.ts `fsync`.
  //
  // If the resolved native backend has no syncFile (an older module in a mixed
  // build), we install NO barrier rather than a fake one. Installing a barrier
  // that cannot flush would stall every recipient; pretending to flush would
  // record durability that does not exist. Neither is acceptable, so the engine
  // runs with the pre-watermark semantics and says so loudly — a degraded mode
  // that is visible in telemetry, not a silent one.
  const canSync = native.isDurableSyncAvailable();
  const eng = new VaultBeamEngine({
    manager: mgr, store, fsync: canSync ? (p: string) => native.syncFile(p) : undefined,
  });
  if (canSync) mgr.setFsync(eng.handleFsync);
  else console.warn('[vaultbeam] native backend has no syncFile — running WITHOUT the durability watermark');

  // The manager's change hook IS the persistence + progress seam, so a caller
  // cannot forget to wire one of them.
  mgr.setOnChange(eng.handleChange);
  _engine = eng;
  return eng;
}

export function currentManager(): TransferManager | null { return _manager; }

/**
 * A relay IO binding that DETECTS a newer server session version and stops.
 *
 * It used to call `session.adoptVersion(v)`, which reset both bitmaps and kept
 * running — under the same K_t. A version bump restarts the chunk grid at 0, and
 * the nonce is `4B(transferId prefix) ‖ u64_be(chunkId)`, so the next round
 * would have sealed different plaintext at nonces already used. For AES-GCM that
 * is a total break, not a degradation.
 *
 * The only safe response is to stop this session. K_t lives in the E2EE manifest
 * and is not something the receiver can derive, so continuing requires a NEW
 * manifest carrying fresh key material — at which point a new session starts and
 * `adoptVersion` gets the key it now demands.
 */
async function relayIOFor(session: TransferSession, onStale: (v: number) => void): Promise<RelayIO> {
  const relay = await import('../vaultbeamRelay');
  const native = await import('../vaultBeamStreamNative');
  const store = await import('../networkStateStore');

  const checkVersion = (st: { sessionVersion?: number }) => {
    const v = st?.sessionVersion;
    if (typeof v !== 'number') return;             // pre-vbm3 server: absent ≠ stale
    if (v <= session.sessionVersion) return;
    onStale(v);
    throw new Error(`stale session: server v${v} > local v${session.sessionVersion} — awaiting a manifest with fresh K_t`);
  };

  return {
    async state(transferId) {
      const st = (await relay.relayState(transferId)) as unknown as RelayStateLike;
      checkVersion(st);
      return st;
    },
    async grow(transferId, blockCount, plan) { await relay.relayGrow(transferId, blockCount, plan); },
    async blockUrls(transferId, blocks, op) { return (await relay.relayBlockUrls(transferId, blocks, op)).urls; },
    async markUploaded(transferId, blocks) { await relay.relayMarkUploaded(transferId, blocks); },
    uploadBlock: (op) => native.uploadBlock(op as any),
    downloadBlock: (op) => native.downloadBlock(op as any),
    nextBlockBytes: async () => (await store.startingGeometry(null)).blockBytes,
    // Concurrency comes from the MEMORY budget, not the core count: a worker
    // holds the buffer it is writing and the one it is filling next, so more
    // cores on the same block size means more bytes resident for no more
    // throughput. Battery still caps it — a low battery is a reason to do less
    // work, independent of how much memory is free.
    parallelism: async () => {
      const { planWorkers } = await import('./memory');
      const blockBytes = (await store.startingGeometry(null)).blockBytes;
      const plan = planWorkers({ physicalUnitBytes: blockBytes, cores: cpuCores() });
      return Math.max(1, Math.min(plan.workers, await batteryCap()));
    },
  };
}

/** Logical cores, conservatively. Unknown ⇒ 4, the common phone. */
function cpuCores(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os');
    const n = os?.cpus?.().length;
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* not Node — react-native has no core count to offer */ }
  return 4;
}

/**
 * Battery ceiling, mirroring lib/vaultBeamTransfer's §14 rule: halve the
 * concurrent block ops on a low, non-charging battery or in OS low-power mode.
 * A cap, not a target — it can only ever lower the memory-derived number.
 */
async function batteryCap(): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const B = require('expo-battery');
    const s = await B.getPowerStateAsync();
    const charging = s?.batteryState === B.BatteryState?.CHARGING || s?.batteryState === B.BatteryState?.FULL;
    if (s?.lowPowerMode || (typeof s?.batteryLevel === 'number' && s.batteryLevel >= 0 && s.batteryLevel < 0.2 && !charging)) return 2;
  } catch { /* no battery module — no cap */ }
  return Infinity;
}

const b64 = {
  decode: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
  encode: (b: Uint8Array) => Buffer.from(b).toString('base64'),
};

export interface RunOpts {
  transferId: string;
  sessionVersion: number;
  manifest: VBManifestLike;
  peerId: string;
  /** sender */ srcPath?: string;
  /** recipient */ dstPath?: string;
  signal?: AbortSignal;
  onChange?: (s: TransferSession) => void;
}

/**
 * Drive one transfer to a terminal state (or a park) with seamless resume.
 * Same code for both roles: the role only changes which drivers make sense and
 * which work-list the session derives.
 */
export async function runTransfer(opts: RunOpts): Promise<TransferSession> {
  const role = opts.srcPath ? 'sender' : 'recipient';
  const eng = await engine();
  const mgr = eng.manager;
  const session = eng.session({
    transferId: opts.transferId, sessionVersion: opts.sessionVersion,
    manifest: opts.manifest, role,
  });
  // Per transfer, not per engine: the engine outlives any one transfer.
  if (opts.onChange) eng.setSink(opts.transferId, opts.onChange);
  // Where the durability barrier flushes. Registered before any driver runs, so
  // a recipient can never reach `commitDurable` with nothing to fsync.
  if (opts.dstPath) eng.setDestination(opts.transferId, opts.dstPath);

  /** Set once the server reports a newer session version — see relayIOFor. */
  let staleVersion: number | null = null;

  const native = await import('../vaultBeamStreamNative');
  const direct = await import('../vaultBeamDirect');

  // ── transports ────────────────────────────────────────────────────
  let channel: ReturnType<typeof channelFromDataChannel> | null = null;
  let lanEndpoint: { host: string; port: number } | null = null;
  let directSettled = false;
  const startedAt = Date.now();

  // The channel and the LAN endpoint do not exist until negotiation produces
  // them, so both are read through getters and the gates below keep each driver
  // unavailable until its transport is real. The throw is unreachable via the
  // manager (it consults available() first) and exists so a future caller that
  // bypasses the gate fails loudly instead of moving bytes over `undefined`.
  const p2pOpts: P2pDriverOpts = {
    get channel(): P2pChannel {
      if (!channel) throw new Error('p2p driver run before its datachannel opened');
      return channel;
    },
    crypto: cryptoForSession(native, session, { srcPath: opts.srcPath, dstPath: opts.dstPath }, b64),
  };
  const p2p = new P2pDriver(p2pOpts);

  const lanOpts: LanDriverOpts = {
    native: lanNativeFrom(native),
    token: opts.manifest.token,
    chunkBytes: CHUNK_BYTES,
    srcPath: opts.srcPath,
    dstPath: opts.dstPath,
    get endpoint() { return lanEndpoint ?? undefined; },
  };
  const lan = new LanDriver(lanOpts);

  const relay = new RelayDriver({
    io: await relayIOFor(session, (v) => { staleVersion = v; }),
    srcPath: opts.srcPath,
    dstPath: opts.dstPath,
  });

  // Scoped to THIS transfer. These drivers hold per-transfer state — a source
  // path, a datachannel, a LAN endpoint — so a process-wide registry would serve
  // the second transfer using the first one's file.
  // Every gate also requires the session NOT to be stale. Once the server has
  // moved on, no transport may move a byte: they all seal under the same K_t,
  // so a stale P2P round is exactly as unsafe as a stale relay round.
  const fresh = () => staleVersion === null;
  mgr.setDriversFor(opts.transferId, [
    gateUntilReady(lan, () => fresh() && (role === 'sender' ? !!opts.srcPath : !!lanEndpoint)),
    gateUntilReady(p2p, () => fresh() && !!channel),
    // The relay is always reachable, so hold it back briefly or it wins every
    // first round and the direct tiers never get a chance.
    graceGate(relay, {
      graceMs: DIRECT_GRACE_MS, now: () => Date.now(),
      isReleased: () => directSettled, startedAt,
    }),
  ]);

  // ── negotiation (reused verbatim; only the data path is ours) ─────
  const geom = {
    transferId: opts.transferId, fileId: opts.manifest.fileId, keyB64: opts.manifest.keyB64,
    token: opts.manifest.token, peerId: opts.peerId,
    chunkBytes: CHUNK_BYTES, chunkCount: session.chunkCount, totalBytes: opts.manifest.size,
    signal: opts.signal,
  };
  const onChannel = async (dc: any): Promise<boolean> => {
    channel = channelFromDataChannel(dc);
    void mgr.poke(opts.transferId);        // a cheaper transport just appeared
    // The manager owns the data path now; negotiation only needed to hand us
    // the channel, so report "not finished here" and let the session decide.
    return false;
  };

  const negotiation = role === 'sender'
    ? direct.serveDirect({ ...geom, srcPath: opts.srcPath!, skipLanServe: true, onChannel })
    : direct.receiveDirect({
        ...geom, dstPath: opts.dstPath!, onChannel,
        onLan: async (host, port) => { lanEndpoint = { host, port }; void mgr.poke(opts.transferId); return false; },
      });
  negotiation.finally(() => { directSettled = true; void mgr.poke(opts.transferId); }).catch(() => {});

  // SENDER: forward the port its LAN driver binds, so the peer can dial in.
  const offBound = role === 'sender'
    ? native.onLanEvent('vbLanBound', (d: any) => { void (async () => {
        if (d?.transferId !== opts.transferId) return;
        try {
          const { getSocket } = await import('../socket');
          const ip = await native.lanIp().catch(() => null);
          (await getSocket()).emit('vaultbeam_ready', { to: opts.peerId, transferId: opts.transferId, lanIp: ip, lanPort: d.port });
        } catch { /* no socket → LAN simply will not be used */ }
      })(); })
    : () => {};

  try {
    await mgr.start(session);
    // With every gate closed a stale session merely PARKS, which would look like
    // a transient stall and silently wait forever. Make it terminal: this
    // session can never make progress, and only a new manifest (new K_t, new
    // session) can carry the transfer forward.
    if (staleVersion !== null && session.state === 'active') {
      session.finish('failed');
      eng.handleChange(session);
    }
  } finally {
    try { offBound(); } catch { /* already removed */ }
    if (session.state !== 'active') {
      mgr.releaseTransports(opts.transferId);
      eng.clearSink(opts.transferId);
      eng.clearDestination(opts.transferId);
    }
    await eng.flush();
  }
  return session;
}

export default {};
