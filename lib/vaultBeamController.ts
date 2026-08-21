// lib/vaultBeamController.ts — VaultBeam chat entry point (P5).
//
// Bridges the in-chat UI ↔ the P1 native byte pipeline (lib/vaultBeamTransfer)
// ↔ the P0 R2 relay control plane, and delivers the transfer manifest as a
// normal E2EE chat message (WhatsApp model): the message row IS the invite, so
// it persists, syncs offline, and arrives live through the existing new_message
// pipeline with no extra socket wiring.
//
// Zero-knowledge split — the relay/server never sees a secret:
//   message.content  (E2EE)      = { v:'vbm1', keyB64, fileId, name, mime, size }
//   message.meta     (plaintext) = { vaultbeam:true, transferId, size }
// transferId + size are already known to the server (relay/init created the
// vb_transfer row from them); the per-transfer key K_t, the fileId that binds
// the per-chunk AAD, and the filename ride ONLY inside the ratchet-encrypted
// content. 1:1 only (v1) — matches the relay's per-peer key model.
//
// Runtime transfer state (progress/status) lives here, NOT in the message, so a
// progress tick never re-renders the whole message list — bubbles subscribe to
// just their transferId via useTransfer().

import { useSyncExternalStore } from 'react';
import perf from './perf';
import { randomBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { sendMessage, type Message } from './chatService';
import { sendTransfer, receiveTransfer } from './vaultBeamTransfer';
import { persistVbTransfer, loadVbTransfers, pruneVbTransfers } from './localDb';
import NetInfo from '@react-native-community/netinfo';
import { serveDirect, receiveDirect } from './vaultBeamDirect';
import { markStart, markComplete, report, forget as forgetMetrics, noteFallbackStart } from './vaultBeam/transferMetrics';
import { beginEpoch, guard as epochGuard, endTransfer as endEpochs } from './vaultBeam/transportEpoch';
import { openLocalFile, type OpenResult } from './vaultBeam/openFile';
import { syncService } from './vaultBeam/backgroundService';
import { classifyTransport, type TransportKind } from './vaultBeam/transportLabel';
import { normalizeDigest } from './vaultBeam/fileDigest';
import { isNativeStreamAvailable } from './vaultBeamStreamNative';
import { isOfferExpired } from './vaultBeam/offerExpiry';
import { loadRecvBitmap } from './vaultBeamRecvBitmap';
import { relayAbort, MAX_BYTES, CHUNK_BYTES } from './vaultbeamRelay';

// vbm2 (2026-07): manifest gained the segmented-geometry `plan`. A version bump
// (not an additive field) on purpose — an old client that ignored `plan` would
// read the server's CONSTANT geometry from relay/state and fail every GCM open
// on an adaptively-sized transfer. Bumping makes old↔new a clean reject, never a
// corrupt decrypt. VaultBeam is 1:1 same-app + 24h-ephemeral, so this is safe.
export const VB_MANIFEST_VERSION = 'vbm2';

export type VBStatus =
  | 'uploading'   // sender: pushing blocks to R2
  | 'sent'        // sender: all blocks uploaded, waiting for peer to pull
  | 'incoming'    // recipient: manifest received, not yet accepted
  | 'queued'      // recipient: auto-download accepted, waiting for a queue slot
  | 'receiving'   // recipient: pulling blocks from R2
  | 'paused'      // recipient: auto-download paused (e.g. left Wi-Fi)
  | 'complete'    // done (delivered / saved)
  | 'cancelled'
  | 'failed'
  | 'expired';   // recipient: the offer aged out before anyone accepted it

export interface VBTransfer {
  transferId: string;
  role: 'sender' | 'recipient';
  status: VBStatus;
  done: number;        // blocks done
  total: number;       // total blocks
  bytes: number;       // bytes moved (approx for recipient)
  totalBytes: number;
  name: string;
  error?: string;
  /** The local file this bubble refers to: the receiver's copy once complete,
   *  or — for a sender — the source it picked, so BOTH ends can open it. The
   *  sender's copy sits in the DocumentPicker cache, which Android may evict;
   *  a missing file there is normal, not a fault. */
  savedPath?: string;
  // Which pipe is moving bytes right now. When a direct tier (LAN/P2P) dies and
  // the relay takes over, the upload genuinely RESTARTS from 0 — the bubble
  // shows "via relay" so the bar reset reads as a tier switch, not a glitch.
  tier?: 'direct' | 'relay';
  /**
   * WHAT ACTUALLY MOVED THE BYTES — 'LAN' | 'WEBRTC_DIRECT' | 'WEBRTC_TURN' |
   * 'R2_RELAY'. Diagnostic only; nothing branches on it.
   *
   * `tier` above cannot answer this: TURN is an ICE candidate type inside
   * WebRTC, not a tier, so a relayed transfer and a peer-to-peer one are both
   * `tier: 'direct'`. That distinction is the difference between free and paid.
   *
   * Address-free by construction — see lib/vaultBeam/transportLabel.ts.
   */
  /**
   * How many logical chunks the RECEIVER has verified, from the server's
   * `vb_have` nudge. Sender-side only: a sender's own progress is what it has
   * pushed, which is not the same as what the peer has actually verified — on a
   * direct transfer that broke, the two diverge sharply.
   */
  peerVerified?: number;
  transport?: TransportKind;
  /** Address-free candidate-pair detail, e.g. 'srflx-relay / IPv4'. */
  transportDetail?: string;
  auto?: boolean;      // this receive was auto-started (no manual Accept)
  // Live meter (computed from VERIFIED progress ticks — same truth as the bar).
  rateBps?: number;    // rolling ~5s window
  avgBps?: number;     // whole-transfer average
  peakBps?: number;
  etaSec?: number;     // remaining bytes / rolling rate
}

// ── tiny external store keyed by transferId ─────────────────────────
const states = new Map<string, VBTransfer>();
const subs = new Map<string, Set<() => void>>();
const controllers = new Map<string, AbortController>();

function emit(id: string) {
  const s = subs.get(id);
  if (s) for (const cb of s) { try { cb(); } catch {} }
}
// P0-2: mirror runtime state to op-sqlite so it survives remount/restart. Flush
// immediately on a status change; throttle the frequent progress ticks.
const persistT = new Map<string, any>();
function persistSoon(id: string, immediate: boolean) {
  const flush = () => { persistT.delete(id); const s = states.get(id); if (s) persistVbTransfer(s).catch(() => {}); };
  const pend = persistT.get(id);
  if (immediate) { if (pend) clearTimeout(pend); flush(); return; }
  if (pend) return;
  persistT.set(id, setTimeout(flush, 750));
}
// ── live speed meter ────────────────────────────────────────────────
// Rolling byte samples per transfer; rate over the last ~5s window, ETA from
// that rate. Fed ONLY by verified progress ticks, so the meter can't claim
// speed for bytes the peer hasn't confirmed. A tier switch resets the window
// (bytes restart from 0 on the relay), keeping the rate honest.
const METER_WINDOW_MS = 5000;
const meters = new Map<string, { samples: Array<{ t: number; b: number }>; startT: number; peak: number }>();
function meterTick(id: string, bytes: number, totalBytes: number): Partial<VBTransfer> {
  const now = Date.now();
  let m = meters.get(id);
  if (!m || (m.samples.length && bytes < m.samples[m.samples.length - 1].b)) {
    m = { samples: [], startT: now, peak: m?.peak ?? 0 }; // new transfer or tier restart
    meters.set(id, m);
  }
  m.samples.push({ t: now, b: bytes });
  while (m.samples.length > 2 && m.samples[0].t < now - METER_WINDOW_MS) m.samples.shift();
  const first = m.samples[0];
  const dt = (now - first.t) / 1000;
  const rateBps = dt > 0.5 ? Math.max(0, (bytes - first.b) / dt) : 0;
  if (rateBps > m.peak) m.peak = rateBps;
  const elapsed = (now - m.startT) / 1000;
  const avgBps = elapsed > 1 ? bytes / elapsed : rateBps;
  const etaSec = rateBps > 0 && totalBytes > bytes ? (totalBytes - bytes) / rateBps : undefined;
  return { rateBps, avgBps, peakBps: m.peak, etaSec };
}
const ACTIVE = (s?: VBStatus) => s === 'uploading' || s === 'receiving';
function setState(id: string, patch: Partial<VBTransfer>) {
  const prev = states.get(id);
  // Any progress tick with a byte count feeds the meter; terminal states drop it.
  if (patch.bytes !== undefined && ACTIVE(patch.status)) {
    Object.assign(patch, meterTick(id, patch.bytes, patch.totalBytes ?? prev?.totalBytes ?? 0));
  } else if (patch.status && !ACTIVE(patch.status)) {
    // §16 diagnostics: one summary mark per transfer, on the first terminal/idle
    // transition out of an active state. Content-free (sizes/speeds/tier only).
    if (ACTIVE(prev?.status)) {
      const m = meters.get(id);
      try {
        perf.mark('vaultbeam_summary', {
          status: patch.status, role: prev?.role, tier: prev?.tier,
          bytes: patch.bytes ?? prev?.bytes ?? 0, totalBytes: prev?.totalBytes ?? 0,
          avgBps: Math.round(prev?.avgBps ?? 0), peakBps: Math.round(prev?.peakBps ?? 0),
          durMs: m ? Date.now() - m.startT : undefined,
          // §5 timings. `ttfvcMs` is the honest one — it is stamped only after a
          // chunk passed GCM, was written at its offset and committed, so it can
          // be undefined on a transport (LAN) that verifies inside native code.
          ...(() => {
            if (patch.status === 'complete') markComplete(id, patch.bytes ?? prev?.bytes);
            const r = report(id);
            return r ? { connectMs: r.connectMs, ttfbMs: r.ttfbMs, ttfvcMs: r.timeToFirstVerifiedChunkMs,
                         stallMs: r.directStallDurationMs, fallbackReason: r.fallbackReason } : {};
          })(),
        });
      } catch {}
    }
    forgetMetrics(id);
    endEpochs(id);   // any tier still talking after this is stale by definition
    meters.delete(id);
    patch = { ...patch, rateBps: undefined, etaSec: undefined };
  }
  const next = { ...(prev ?? ({ transferId: id } as VBTransfer)), ...patch } as VBTransfer;
  states.set(id, next);
  // Reconcile the Android foreground service against the whole store. Driven
  // from here because setState is the one place every transfer state change
  // passes through, so the service can never drift from reality. Derived, never
  // authoritative — and it swallows its own errors.
  try { syncService(states.values()); } catch {}
  emit(id);
  persistSoon(id, patch.status !== undefined);
  // §13: mirror the set of active transfers into the Android foreground-service
  // notification so a minimized app keeps big transfers alive.
  try {
    let count = 0, bytes = 0, totalBytes = 0;
    for (const s of states.values()) if (ACTIVE(s.status)) { count++; bytes += s.bytes | 0; totalBytes += s.totalBytes | 0; }
    require('./transferForeground').updateTransferForeground(count ? { count, bytes, totalBytes } : null);
  } catch {}
}
export function getTransfer(id: string): VBTransfer | undefined { return states.get(id); }

// P0-2: rebuild the in-memory store from op-sqlite at launch so bubbles show
// their last-known progress/status. An in-flight transfer that never finished is
// surfaced as 'failed' (senders are then re-driven live by resumePendingSends);
// terminal states (complete/cancelled/failed) show exactly as they ended.
let _hydrated = false;
export async function hydrateTransfers(): Promise<void> {
  if (_hydrated) return; _hydrated = true;
  try {
    for (const r of await loadVbTransfers()) {
      const id = r.transfer_id;
      if (states.has(id)) continue;   // a live transfer wins over the persisted snapshot
      const status: VBStatus = (r.status === 'uploading' || r.status === 'receiving') ? 'failed' : r.status;
      states.set(id, {
        transferId: id, role: r.role, status,
        done: r.done | 0, total: r.total | 0, bytes: r.bytes | 0, totalBytes: r.total_bytes | 0,
        name: r.name ?? '', error: r.error ?? undefined, savedPath: r.saved_path ?? undefined,
      } as VBTransfer);
      emit(id);
    }
    pruneVbTransfers().catch(() => {});
  } catch {}
}
export function subscribeTransfer(id: string, cb: () => void): () => void {
  let set = subs.get(id);
  if (!set) { set = new Set(); subs.set(id, set); }
  set.add(cb);
  return () => { subs.get(id)?.delete(cb); };
}

// React hook: a bubble subscribes to just its own transfer's live state.
export function useTransfer(id: string | undefined): VBTransfer | undefined {
  return useSyncExternalStore(
    (cb) => (id ? subscribeTransfer(id, cb) : () => {}),
    () => (id ? states.get(id) : undefined),
    () => (id ? states.get(id) : undefined),
  );
}

// ── helpers ─────────────────────────────────────────────────────────
const hex = (n: number) => Buffer.from(randomBytes(n)).toString('hex');           // 2n chars, [0-9a-f] ⊂ transferId regex
const sanitize = (name: string) => (name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
const VB_DIR = `${FileSystem.documentDirectory}VaultBeam`;

// The manifest that rides inside the E2EE message content. `token` authenticates
// the LAN direct connection (an outsider on the same Wi-Fi can't guess it).
// `plan` is the serialized segmented-geometry manifest (vaultBeamSegments) — the
// relay tier reads it for per-block chunk/block sizes + offsets. Absent on a
// direct-only (LAN/P2P) transfer, which stays uniform 512 KiB.
export interface VBManifest {
  v: string; keyB64: string; fileId: string; name: string; mime: string; size: number; token: string;
  plan?: string;
  /**
   * Whole-file SHA-256, lowercase hex. OPTIONAL and permanently so.
   *
   * The receiver's gate already existed in vaultBeamTransfer (hash, compare,
   * throw BEFORE relayComplete); it was simply never fed. This is what feeds
   * it. Absent — an older sender, or a source we could not hash — keeps the
   * previous behaviour exactly: per-chunk AES-GCM plus bitmap completeness.
   * Absent must never mean fail-closed, or every in-flight legacy transfer
   * would break.
   */
  sha256?: string;
}

export function parseManifest(plainContent: string | null | undefined): VBManifest | null {
  if (!plainContent) return null;
  try {
    const m = JSON.parse(plainContent);
    if (m?.v === VB_MANIFEST_VERSION && m.keyB64 && m.fileId) {
      return { v: m.v, keyB64: m.keyB64, fileId: m.fileId, name: m.name || 'file',
        mime: m.mime || 'application/octet-stream', size: Number(m.size) || 0, token: m.token || '',
        plan: typeof m.plan === 'string' ? m.plan : undefined,
        // Validated here so a malformed or hostile digest becomes 'absent'
        // (legacy path) rather than something the gate would try to enforce.
        sha256: normalizeDigest(m.sha256) };
    }
  } catch {}
  return null;
}

// Geometry is derivable from size alone (canonical 512 KiB chunk) — no relay call.
const chunkCountFor = (size: number) => Math.ceil(size / CHUNK_BYTES);

async function getLinkType(): Promise<string | null> {
  try { return (await NetInfo.fetch()).type ?? null; } catch { return null; }
}

// ── Sender crash/restart resume ─────────────────────────────────────
// A relay upload that dies mid-flight (app killed) is resumed on next launch:
// the manifest was already delivered + the relay row exists, so we just re-run
// the upload, which skips blocks already on R2 (server bitmask). The recipient
// already resumes symmetrically. Persisted only for the sender (it alone holds
// the source file); dropped the moment the send reaches a terminal state.
const SENDS_KEY = 'vc_vaultbeam_sends';
interface PersistedSend { transferId: string; srcPath: string; name: string; size: number; fileId: string; keyB64: string; plan?: string; linkType?: string | null }
async function readSends(): Promise<PersistedSend[]> {
  try { const raw = await AsyncStorage.getItem(SENDS_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function persistSend(r: PersistedSend): Promise<void> {
  try {
    const all = (await readSends()).filter((x) => x.transferId !== r.transferId);
    all.unshift(r);
    await AsyncStorage.setItem(SENDS_KEY, JSON.stringify(all.slice(0, 50)));
  } catch {}
}
async function unpersistSend(transferId: string): Promise<void> {
  try { await AsyncStorage.setItem(SENDS_KEY, JSON.stringify((await readSends()).filter((x) => x.transferId !== transferId))); } catch {}
}

// Call once on app launch (app/_layout). Resumes each interrupted send over the
// relay; a send whose source file was evicted from cache is marked failed + dropped.
export async function resumePendingSends(): Promise<void> {
  await hydrateTransfers();               // P0-2: restore last-known transfer states first
  if (!isNativeStreamAvailable()) return;
  for (const r of await readSends()) {
    if (controllers.has(r.transferId)) continue; // already running (double-mount guard)
    const fi: any = await FileSystem.getInfoAsync(r.srcPath).catch(() => null);
    if (!fi?.exists) { await unpersistSend(r.transferId); continue; }
    setState(r.transferId, { transferId: r.transferId, role: 'sender', status: 'uploading', tier: 'relay', done: 0, total: 0, bytes: 0, totalBytes: r.size, name: r.name });
    ensureListeners();
    const ac = new AbortController();
    controllers.set(r.transferId, ac);
    (async () => {
      try {
        await sendTransfer({
          srcPath: r.srcPath, totalBytes: r.size, fileId: r.fileId, transferId: r.transferId, keyB64: r.keyB64,
          linkType: r.linkType, signal: ac.signal,
          onProgress: (p) => setState(r.transferId, { status: 'uploading', done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes }),
        });
        setState(r.transferId, { status: 'sent' });
      } catch (e: any) {
        setState(r.transferId, ac.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: e?.message });
      } finally { controllers.delete(r.transferId); await unpersistSend(r.transferId); }
    })();
  }
}

// vb_complete / vb_abort are live nudges so BOTH parties see the final state
// without polling. Registered once, lazily, the first time a transfer starts.
let _listenersArmed = false;
async function ensureListeners() {
  if (_listenersArmed) return;
  _listenersArmed = true;
  // Cancel tapped on the foreground-service notification. The service knows
  // nothing about transfers, so it just says "the user asked to cancel" and the
  // decision of WHAT that means is made here, through the normal cancel path.
  // Cancels every active transfer, because one consolidated notification cannot
  // express which of several the user meant.
  try {
    const { DeviceEventEmitter } = require('react-native');
    DeviceEventEmitter.addListener('vbServiceCancel', () => {
      for (const [id, st] of states) {
        if (st.status === 'uploading' || st.status === 'receiving' || st.status === 'queued') {
          cancelTransfer(id).catch(() => {});
        }
      }
    });
  } catch {}
  try {
    const { addPersistentListener } = await import('./socket');
    addPersistentListener('vb_complete', (d: any) => {
      const id = d?.transferId; if (!id) return;
      const s = states.get(id);
      if (s && s.role === 'sender') setState(id, { status: 'complete', done: s.total, bytes: s.totalBytes });
    });
    // RECEIVER PROGRESS, PUSHED.
    //
    // relay/received already emits this to the sender the moment the receiver
    // commits verified chunks — the server comment calls it a nudge "so it
    // re-derives its work-list immediately rather than waiting for its next
    // poll" — but nothing was listening, so the signal went nowhere.
    //
    // DELIBERATELY PASSIVE. It records what the peer holds and does NOT kick a
    // re-send: sendTransfer re-derives its work-list from relayState on its next
    // pass, and forcing a second derivation from here could stage the same block
    // twice, which is exactly the duplicate sending this must not cause.
    // Monotonic, so an out-of-order nudge cannot walk the count backwards.
    addPersistentListener('vb_have', (d: any) => {
      const id = d?.transferId; if (!id) return;
      const got = Number(d?.received);
      if (!Number.isFinite(got) || got < 0) return;
      const s = states.get(id);
      if (!s || s.role !== 'sender') return;
      if (s.status === 'complete' || s.status === 'cancelled' || s.status === 'failed') return;
      if (typeof s.peerVerified === 'number' && got <= s.peerVerified) return;
      setState(id, { peerVerified: got });
    });
    addPersistentListener('vb_abort', (d: any) => {
      const id = d?.transferId; if (!id) return;
      const s = states.get(id);
      if (s && s.status !== 'complete') {
        controllers.get(id)?.abort();
        setState(id, { status: 'cancelled' });
      }
    });
  } catch { _listenersArmed = false; }
}

// ── SENDER ──────────────────────────────────────────────────────────
// Pick-to-send: open a relay transfer, post the E2EE manifest message (returned
// so the chat screen inserts it optimistically), and kick off the block upload
// in the background. Progress flows into the store; the bubble reads it live.
export async function startSend(opts: {
  chatId: string; recipientId: string; srcPath: string; name: string; mime: string; size: number;
}): Promise<Message> {
  if (!isNativeStreamAvailable()) throw new Error('Large-file transfer needs the latest app build (Android).');
  if (!(opts.size > 0)) throw new Error('Could not read the file size.');
  if (opts.size > MAX_BYTES) throw new Error('File exceeds the 12 GB limit.');
  if (!opts.recipientId) throw new Error('VaultBeam is 1:1 only — open a direct chat.');

  const transferId = hex(16); // 32 hex chars → matches server /^[A-Za-z0-9]{16,64}$/
  const fileId = hex(16);
  const keyB64 = Buffer.from(randomBytes(32)).toString('base64');
  const token = Buffer.from(randomBytes(16)).toString('base64'); // LAN direct-connect auth

  // v2: open the relay with an EMPTY plan (0 blocks). sendTransfer grows it
  // reactively from live throughput; the recipient reads the growing plan from
  // relay/state. linkType seeds/tags the throughput history.
  const linkType = await getLinkType();
  const { relayInit } = await import('./vaultbeamRelay');
  await relayInit(transferId, opts.recipientId, opts.size, opts.chatId, 0, '');

  setState(transferId, {
    transferId, role: 'sender', status: 'uploading',
    done: 0, total: 0, bytes: 0, totalBytes: opts.size, name: opts.name,
    // The sender keeps a handle on what it sent, so its own bubble can open the
    // file too — previously only the recipient could. Same content-URI path;
    // DocumentPicker already copied it somewhere the FileProvider covers.
    savedPath: opts.srcPath,
  });

  // Hash the SOURCE once, before the manifest goes out. Best-effort: a file we
  // cannot hash still transfers, it just travels without the extra gate — the
  // same position every pre-digest transfer is already in.
  let srcDigest: string | undefined;
  try {
    const { sha256File, isNativeStreamAvailable } = await import('./vaultBeamStreamNative');
    if (isNativeStreamAvailable()) srcDigest = normalizeDigest(await sha256File(opts.srcPath));
  } catch { /* no digest — legacy behaviour */ }

  const manifest: VBManifest = { v: VB_MANIFEST_VERSION, keyB64, fileId, name: opts.name, mime: opts.mime, size: opts.size, token, sha256: srcDigest };
  const meta = { vaultbeam: true, transferId, size: opts.size };
  const msg = await sendMessage(opts.chatId, JSON.stringify(manifest), 'vaultbeam', { meta });
  // Persist so a killed relay upload resumes on next launch (manifest already sent).
  await persistSend({ transferId, srcPath: opts.srcPath, name: opts.name, size: opts.size, fileId, keyB64, linkType });

  ensureListeners();
  const ac = new AbortController();
  controllers.set(transferId, ac);
  const chunkCount = chunkCountFor(opts.size);
  (async () => {
    try {
      // One measurement window per TRANSFER, not per transport: a direct tier
      // that starves and hands over to the relay is still the same transfer, so
      // the clock starts here and survives every tier change below.
      markStart(transferId);
      // Tier 1/2: serve the peer directly (LAN then P2P) if it comes online and
      // asks. Returns the tier used, or null → nobody pulled → use the relay.
      const directEpoch = beginEpoch(transferId);   // §8, same race as the receive path
      const tier = await serveDirect({
        transferId, fileId, keyB64, token, peerId: opts.recipientId,
        chunkBytes: CHUNK_BYTES, chunkCount, totalBytes: opts.size, srcPath: opts.srcPath, signal: ac.signal,
        onProgress: epochGuard(transferId, directEpoch, (done: number, total: number) => setState(transferId, {
          status: 'uploading', tier: 'direct', done, total,
          // Clamped: the last chunk is usually partial, so done*CHUNK_BYTES can
          // exceed the file and would render as >100%.
          bytes: Math.min(done * CHUNK_BYTES, opts.size), totalBytes: opts.size,
        })),
      });
      if (tier) {
        noteTransport(transferId, tier);   // 'lan' | 'p2p' — ICE already refined p2p
        setState(transferId, { status: 'complete', done: chunkCount, total: chunkCount, bytes: opts.size }); // delivered peer-to-peer
        return;
      }
      // Tier 3: R2 relay (guaranteed baseline — works even if the peer is offline).
      beginEpoch(transferId);   // every direct callback is stale from here on
      noteFallbackStart(transferId, 'R2_RELAY');   // SLA clock stops here
      setState(transferId, { status: 'uploading', tier: 'relay', done: 0, total: 0, bytes: 0, totalBytes: opts.size });
      noteTransport(transferId, 'relay');
      await sendTransfer({
        srcPath: opts.srcPath, totalBytes: opts.size, fileId, transferId, keyB64, linkType, signal: ac.signal,
        onProgress: (p) => setState(transferId, { status: 'uploading', done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes }),
      });
      setState(transferId, { status: 'sent' }); // on R2; peer pulls next
    } catch (e: any) {
      if (__DEV__) console.warn('[vb] send failed:', e?.code ?? '', e?.message ?? e);
      setState(transferId, ac.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: e?.message });
    } finally { controllers.delete(transferId); await unpersistSend(transferId); }
  })();

  return msg;
}

// ── RECIPIENT ───────────────────────────────────────────────────────
// Accept an incoming transfer: preallocate + pull every block (resumes against
// the server bitmask), verify natively, and land the plaintext file locally.
export async function startReceive(opts: {
  transferId: string; manifest: VBManifest; peerId: string; auto?: boolean;
  /**
   * Message.createdAt of the offer — the SERVER's stamp, passed straight
   * through. Optional: an offer that arrives without one is accepted exactly
   * as it is today (see offerExpiry's fail-open note).
   */
  offerCreatedAt?: string | null;
}): Promise<void> {
  if (!isNativeStreamAvailable()) throw new Error('Large-file transfer needs the latest app build (Android).');
  const { transferId, manifest, peerId } = opts;
  // Single-flight: auto + manual (or a double-tap) must never both drive one
  // transferId. A live controller or an already-finished/receiving state wins.
  if (controllers.has(transferId)) return;
  const cur = states.get(transferId);
  if (cur && (cur.status === 'receiving' || cur.status === 'complete')) return;

  // OFFER AGE — checked here and nowhere else, because here is the only place a
  // transfer is ACCEPTED. Everything past this line is an accepted transfer and
  // must never be interrupted by the offer's age, however long it runs.
  //
  // `alreadyStarted` comes from the persisted receive bitmap: a non-empty one
  // proves this transfer was accepted before, so a resume after an app restart
  // — which re-enters this function with the same old message — is recognised
  // as a resume rather than expired out of existence.
  const startedBefore = (await loadRecvBitmap(transferId).catch(() => new Set<number>())).size > 0;
  if (isOfferExpired({ offerCreatedAt: opts.offerCreatedAt, now: Date.now(), alreadyStarted: startedBefore })) {
    setState(transferId, {
      transferId, role: 'recipient', status: 'expired',
      done: 0, total: 0, bytes: 0, totalBytes: manifest.size, name: manifest.name,
    });
    return;                                     // no transport, no file, no retry
  }
  const dstPath = `${VB_DIR}/${sanitize(manifest.name)}`;
  const chunkCount = chunkCountFor(manifest.size);

  setState(transferId, {
    transferId, role: 'recipient', status: 'receiving', auto: !!opts.auto,
    done: 0, total: 0, bytes: 0, totalBytes: manifest.size, name: manifest.name,
  });
  ensureListeners();
  const ac = new AbortController();
  controllers.set(transferId, ac);
  try {
    await FileSystem.makeDirectoryAsync(VB_DIR, { intermediates: true }).catch(() => {});

    // Tier 1/2: try to pull directly (LAN then P2P) while the sender is online.
    // Direct chunks land contiguously (ordered channel), so the high-water mark
    // is a verified plaintext prefix the relay tier can credit instead of
    // re-downloading — a 50% direct transfer resumes at 50% on the relay.
    let directDone = 0;      // chunks VERIFIED (may contain gaps) — for the UI
    let directPrefix = 0;    // chunks verified from 0 with NO gap — for haveBytes
    markStart(transferId);   // spans direct → relay handover; see the sender side
    // §8 epoch. A tier that loses its stall race is NOT cancelled — p2pReceive's
    // promise never settles, so its datachannel stays open and keeps calling
    // back. Stamping the callback with the epoch it was opened under means the
    // abandoned tier can keep talking without being able to move `tier` back to
    // 'direct' or regress `done`.
    const directEpoch = beginEpoch(transferId);
    const gotDirect = manifest.token ? await receiveDirect({
      transferId, fileId: manifest.fileId, keyB64: manifest.keyB64, token: manifest.token, peerId,
      chunkBytes: CHUNK_BYTES, chunkCount, totalBytes: manifest.size, dstPath, signal: ac.signal,
      onProgress: epochGuard(transferId, directEpoch, (done: number, total: number, contiguous?: number) => {
        if (done > directDone) directDone = done;
        // TWO DIFFERENT NUMBERS. `directDone` is how many chunks are verified —
        // what the bar shows. `directPrefix` is how many are verified from 0
        // with no gap, and it is the ONLY one that may become a byte offset.
        // A transport that streams strictly sequentially omits `contiguous`,
        // and for those `done` already is a prefix.
        const c = contiguous ?? done;
        if (c > directPrefix) directPrefix = c;
        setState(transferId, { status: 'receiving', tier: 'direct', done, total, bytes: Math.min(done * CHUNK_BYTES, manifest.size), totalBytes: manifest.size });
      }),
    }) : false;

    if (!gotDirect) {
      // Tier 3: pull from the R2 relay (the sender uploads there as the baseline).
      // New epoch FIRST: from here on every direct callback is stale by definition.
      beginEpoch(transferId);
      noteFallbackStart(transferId, 'R2_RELAY');
      setState(transferId, { status: 'receiving', tier: 'relay', done: 0, total: 0, bytes: 0 });
      noteTransport(transferId, 'relay');
      await receiveTransfer({
        transferId, dstPath, totalBytes: manifest.size, fileId: manifest.fileId, keyB64: manifest.keyB64,
        linkType: await getLinkType(),
        // Contiguous prefix ONLY. Using the verified count here would claim a
        // chunk sitting behind a gap is on disk; the relay tier would then skip
        // fetching it and the hole would survive to the whole-file digest.
        haveBytes: Math.max(0, Math.min(directPrefix * CHUNK_BYTES, manifest.size)),
        // Feeds the gate that already lives in vaultBeamTransfer: it hashes the
        // assembled file and throws BEFORE relayComplete, so a corrupt result
        // never causes the relay copy — the only thing left to retry from — to
        // be purged. Undefined ⇒ the gate is skipped, exactly as before.
        expectedSha256: manifest.sha256,
        signal: ac.signal,
        onProgress: (p) => setState(transferId, { status: 'receiving', done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes }),
      });
    } else {
      // F-2: a transfer delivered over LAN/P2P used to return here without ever
      // finalizing the relay row, so it sat at 'pending' until the 24 h sweep and
      // the sender never got its vb_complete nudge. Completion is a property of
      // the TRANSFER, not of the transport that happened to win, so record it
      // whichever tier delivered. Best-effort: the direct transfer already
      // succeeded, and failing to finalize must not fail it.
      // SAME GATE ON THE DIRECT PATH. relayComplete purges the relay objects,
      // so the digest must be checked first here too — otherwise a file that
      // arrived corrupt over LAN/P2P would destroy the recoverable copy.
      if (manifest.sha256) {
        const { sha256File } = await import('./vaultBeamStreamNative');
        const got = normalizeDigest(await sha256File(dstPath));
        if (got !== manifest.sha256) {
          throw new Error('sha256 mismatch — file corrupt, not purging relay');
        }
      }
      const { relayComplete } = await import('./vaultbeamRelay');
      await relayComplete(transferId).catch(() => {});
    }
    setState(transferId, { status: 'complete', savedPath: dstPath, bytes: manifest.size });
  } catch (e: any) {
    if (__DEV__) console.warn('[vb] receive failed:', e?.code ?? '', e?.message ?? e);
    setState(transferId, ac.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: e?.message });
  } finally { controllers.delete(transferId); }
}

// ── Auto-download (UITE F2) ─────────────────────────────────────────
// Mark a transfer as queued for auto-download (waiting for a queue slot) so the
// bubble can show "Queued" before the receive actually starts.
export function markTransferQueued(transferId: string, name: string, totalBytes: number): void {
  const cur = states.get(transferId);
  if (cur && (cur.status === 'receiving' || cur.status === 'complete')) return;
  setState(transferId, { transferId, role: 'recipient', status: 'queued', auto: true, done: 0, total: 0, bytes: 0, totalBytes, name });
}

// Auto-accept an incoming transfer. Thin wrapper over startReceive with the auto
// flag; the single-flight guard inside startReceive prevents a double-start if
// the user also tapped Accept. Errors surface via the transfer store, not throw.
export async function autoStartReceive(opts: { transferId: string; manifest: VBManifest; peerId: string; offerCreatedAt?: string | null }): Promise<void> {
  try { await startReceive({ ...opts, auto: true }); }
  catch (e: any) { setState(opts.transferId, { status: 'failed', error: e?.message }); }
}

/**
 * Record which transport carried this transfer, and — for WebRTC — whether the
 * winning ICE pair was relayed.
 *
 * Best-effort and never throws: observability must not be able to fail a
 * transfer. Only ever called with candidate TYPES; classifyTransport emits from
 * a closed set of constants, so nothing here can put an address into the state.
 */
export function noteTransport(
  transferId: string,
  driverId: string | null | undefined,
  ice?: { localType?: string; remoteType?: string; isIPv6?: boolean } | null,
): void {
  try {
    const cur = states.get(transferId);
    if (!cur) return;
    const label = classifyTransport(driverId, ice);
    // A BLIND CALL MUST NEVER DEMOTE AN OBSERVED ONE.
    //
    // Two things report a p2p transfer: the ICE hook, which knows the candidate
    // pair, and the tier return, which knows only "p2p". Classifying the latter
    // yields WEBRTC_DIRECT — so letting it land after the ICE hook would rewrite
    // a genuine WEBRTC_TURN as direct and quietly zero the relay-rate metric.
    // Evidence wins over inference; equal-evidence still refreshes.
    if (!ice && cur.transport && cur.transport.startsWith('WEBRTC') && label.kind.startsWith('WEBRTC')) return;
    if (cur.transport === label.kind && cur.transportDetail === label.detail) return;
    setState(transferId, { transport: label.kind, transportDetail: label.detail });
  } catch { /* diagnostics never break a transfer */ }
}

// Cancel an in-flight transfer (either side): abort the byte pipeline + purge
// the relay copy (best-effort) so R2 doesn't hold an orphaned partial.
export async function cancelTransfer(transferId: string): Promise<void> {
  controllers.get(transferId)?.abort();
  setState(transferId, { status: 'cancelled' });
  await unpersistSend(transferId);
  try { await relayAbort(transferId); } catch {}
}

// Open / share a received file with the OS handler.
/**
 * Open a finished VaultBeam file in whatever app handles its type.
 *
 * Was `Sharing.shareAsync(path)`, which could not work: the file lives in
 * app-private storage, and Android has rejected `file://` URIs handed to other
 * apps since API 24 — hence the "Cannot open" every recipient saw. It was also
 * the wrong verb; a share sheet is not "play this video".
 *
 * Returns a structured failure instead of throwing so the bubble can say
 * something true. See lib/vaultBeam/openFile.ts for why no new FileProvider.
 */
export async function openSaved(path: string, name?: string): Promise<OpenResult> {
  return openLocalFile(path, name);
}

export default {};
