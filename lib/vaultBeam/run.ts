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
import { VaultBeamEngine, channelFromDataChannel, cryptoForSession, lanNativeFrom, registerAvailable, type VBManifestLike } from './wiring';
import { gateUntilReady, graceGate } from './gate';
import { RelayDriver, type RelayIO, type RelayStateLike } from './drivers/relay';
import { P2pDriver, type P2pDriverOpts, type P2pChannel } from './drivers/p2p';
import { LanDriver, type LanDriverOpts } from './drivers/lan';

/** How long the relay is held back so LAN/P2P can negotiate. */
const DIRECT_GRACE_MS = 8000;

let _engine: VaultBeamEngine | null = null;
let _manager: TransferManager | null = null;

/** Process-wide engine. Built once, lazily, so nothing loads react-native at import. */
export async function engine(onChange?: (s: TransferSession) => void): Promise<VaultBeamEngine> {
  if (_engine) return _engine;
  const { defaultSessionStore } = await import('./persistence');
  const store = await defaultSessionStore();
  const mgr = new TransferManager({ concurrency: 1 });
  _manager = mgr;
  const eng = new VaultBeamEngine({ manager: mgr, store, onChange });
  // The manager's change hook IS the persistence + progress seam, so a caller
  // cannot forget to wire one of them.
  mgr.setOnChange(eng.handleChange);
  _engine = eng;
  return eng;
}

export function currentManager(): TransferManager | null { return _manager; }

/**
 * A relay IO binding that adopts a newer server session version instead of
 * failing. A 409 means our view is stale — the correct response is to rehydrate
 * and re-derive, never to restart the transfer (design §7).
 */
async function relayIOFor(session: TransferSession): Promise<RelayIO> {
  const relay = await import('../vaultbeamRelay');
  const native = await import('../vaultBeamStreamNative');
  const store = await import('../networkStateStore');

  const adopt = (st: { sessionVersion?: number }) => {
    if (typeof st?.sessionVersion === 'number') session.adoptVersion(st.sessionVersion);
  };

  return {
    async state(transferId) {
      const st = (await relay.relayState(transferId)) as unknown as RelayStateLike;
      adopt(st);
      return st;
    },
    async grow(transferId, blockCount, plan) { await relay.relayGrow(transferId, blockCount, plan); },
    async blockUrls(transferId, blocks, op) { return (await relay.relayBlockUrls(transferId, blocks, op)).urls; },
    async markUploaded(transferId, blocks) { await relay.relayMarkUploaded(transferId, blocks); },
    uploadBlock: (op) => native.uploadBlock(op as any),
    downloadBlock: (op) => native.downloadBlock(op as any),
    nextBlockBytes: async () => (await store.startingGeometry(null)).blockBytes,
  };
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
  const eng = await engine(opts.onChange);
  const mgr = eng.manager;
  const session = eng.session({
    transferId: opts.transferId, sessionVersion: opts.sessionVersion,
    manifest: opts.manifest, role,
  });

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
    io: await relayIOFor(session),
    srcPath: opts.srcPath,
    dstPath: opts.dstPath,
  });

  registerAvailable(mgr, [
    gateUntilReady(lan, () => role === 'sender' ? !!opts.srcPath : !!lanEndpoint),
    gateUntilReady(p2p, () => !!channel),
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
  } finally {
    try { offBound(); } catch { /* already removed */ }
    await eng.flush();
  }
  return session;
}

export default {};
