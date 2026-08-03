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
import { isNativeStreamAvailable } from './vaultBeamStreamNative';
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
  | 'receiving'   // recipient: pulling blocks from R2
  | 'complete'    // done (delivered / saved)
  | 'cancelled'
  | 'failed';

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
  savedPath?: string;  // recipient: local path once complete
  // Which pipe is moving bytes right now. When a direct tier (LAN/P2P) dies and
  // the relay takes over, the upload genuinely RESTARTS from 0 — the bubble
  // shows "via relay" so the bar reset reads as a tier switch, not a glitch.
  tier?: 'direct' | 'relay';
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
        });
      } catch {}
    }
    meters.delete(id);
    patch = { ...patch, rateBps: undefined, etaSec: undefined };
  }
  const next = { ...(prev ?? ({ transferId: id } as VBTransfer)), ...patch } as VBTransfer;
  states.set(id, next);
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
export interface VBManifest { v: string; keyB64: string; fileId: string; name: string; mime: string; size: number; token: string; plan?: string }

export function parseManifest(plainContent: string | null | undefined): VBManifest | null {
  if (!plainContent) return null;
  try {
    const m = JSON.parse(plainContent);
    if (m?.v === VB_MANIFEST_VERSION && m.keyB64 && m.fileId) {
      return { v: m.v, keyB64: m.keyB64, fileId: m.fileId, name: m.name || 'file',
        mime: m.mime || 'application/octet-stream', size: Number(m.size) || 0, token: m.token || '',
        plan: typeof m.plan === 'string' ? m.plan : undefined };
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
  try {
    const { addPersistentListener } = await import('./socket');
    addPersistentListener('vb_complete', (d: any) => {
      const id = d?.transferId; if (!id) return;
      const s = states.get(id);
      if (s && s.role === 'sender') setState(id, { status: 'complete', done: s.total, bytes: s.totalBytes });
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
  });

  const manifest: VBManifest = { v: VB_MANIFEST_VERSION, keyB64, fileId, name: opts.name, mime: opts.mime, size: opts.size, token };
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
      // Tier 1/2: serve the peer directly (LAN then P2P) if it comes online and
      // asks. Returns the tier used, or null → nobody pulled → use the relay.
      const tier = await serveDirect({
        transferId, fileId, keyB64, token, peerId: opts.recipientId,
        chunkBytes: CHUNK_BYTES, chunkCount, totalBytes: opts.size, srcPath: opts.srcPath, signal: ac.signal,
        onProgress: (done, total) => setState(transferId, { status: 'uploading', tier: 'direct', done, total, bytes: done * CHUNK_BYTES, totalBytes: opts.size }),
      });
      if (tier) {
        setState(transferId, { status: 'complete', done: chunkCount, total: chunkCount, bytes: opts.size }); // delivered peer-to-peer
        return;
      }
      // Tier 3: R2 relay (guaranteed baseline — works even if the peer is offline).
      setState(transferId, { status: 'uploading', tier: 'relay', done: 0, total: 0, bytes: 0, totalBytes: opts.size });
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
  transferId: string; manifest: VBManifest; peerId: string;
}): Promise<void> {
  if (!isNativeStreamAvailable()) throw new Error('Large-file transfer needs the latest app build (Android).');
  const { transferId, manifest, peerId } = opts;
  const dstPath = `${VB_DIR}/${sanitize(manifest.name)}`;
  const chunkCount = chunkCountFor(manifest.size);

  setState(transferId, {
    transferId, role: 'recipient', status: 'receiving',
    done: 0, total: 0, bytes: 0, totalBytes: manifest.size, name: manifest.name,
  });
  ensureListeners();
  const ac = new AbortController();
  controllers.set(transferId, ac);
  try {
    await FileSystem.makeDirectoryAsync(VB_DIR, { intermediates: true }).catch(() => {});

    // Tier 1/2: try to pull directly (LAN then P2P) while the sender is online.
    const gotDirect = manifest.token ? await receiveDirect({
      transferId, fileId: manifest.fileId, keyB64: manifest.keyB64, token: manifest.token, peerId,
      chunkBytes: CHUNK_BYTES, chunkCount, totalBytes: manifest.size, dstPath, signal: ac.signal,
      onProgress: (done, total) => setState(transferId, { status: 'receiving', tier: 'direct', done, total, bytes: done * CHUNK_BYTES, totalBytes: manifest.size }),
    }) : false;

    if (!gotDirect) {
      // Tier 3: pull from the R2 relay (the sender uploads there as the baseline).
      setState(transferId, { status: 'receiving', tier: 'relay', done: 0, total: 0, bytes: 0 });
      await receiveTransfer({
        transferId, dstPath, totalBytes: manifest.size, fileId: manifest.fileId, keyB64: manifest.keyB64,
        linkType: await getLinkType(),
        signal: ac.signal,
        onProgress: (p) => setState(transferId, { status: 'receiving', done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes }),
      });
    }
    setState(transferId, { status: 'complete', savedPath: dstPath, bytes: manifest.size });
  } catch (e: any) {
    if (__DEV__) console.warn('[vb] receive failed:', e?.code ?? '', e?.message ?? e);
    setState(transferId, ac.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: e?.message });
  } finally { controllers.delete(transferId); }
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
export async function openSaved(path: string): Promise<void> {
  const Sharing = await import('expo-sharing');
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
}

export default {};
