// lib/mediaOutbox.ts — durable outbox for media sends (offline parity).
//
// Text/reactions/edits/deletes already send offline via lib/messageQueue. Media
// didn't: sendMediaMessage uploaded inline and threw if the network was down, so
// a photo picked in airplane mode just failed. This persists the send intent +
// a COPY of the file, then drives (resumable upload → message) with retry on
// reconnect/boot — so media "sends" the moment you're back online, exactly like
// WhatsApp. Reuses sendMediaMessage as the unit of work.
//
// Idempotency: each item carries a STABLE clientId, so a re-drive after a crash
// (upload succeeded, message POST didn't) re-sends the same clientId and the
// server dedups — no duplicate message. (A re-upload can orphan one attachment;
// the R2 lifecycle rule reaps it — see [[vaultbeam-p2p-hardening]].)

import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { UPLOAD_PROGRESS } from '../constants/flags';
import { sendMediaMessage, type MediaType, type UploadPhase } from './sendMedia';
import { type Message } from './chatService';
import { queueList, queueReplace, queueMigrate } from './localDb';

const LEGACY_KEY = 'vc_media_outbox_v1';   // pre-SQLite AsyncStorage array
// Whole-queue reads: the cap must stay far above any real backlog, because
// save() replaces the queue with exactly what load() returned.
const READ_CAP   = 10_000;
const OUTBOX_DIR = (FileSystem as any).documentDirectory + 'outbox/';
const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000];
const PERIODIC_MS = 30_000;
/** Transient failures beyond this degrade to 'failed' (tap-to-retry). The
 *  ceiling is what stops a poisoned item from grinding the app forever. */
const MAX_TRANSIENT_ATTEMPTS = 8;

// A media rejection is only PERMANENT for the same reasons a text one is
// (mirrors messageQueue): blocked/not-a-member, gone, malformed, too large.
function isPermanent(status?: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 413;
}

export interface MediaOutboxItem {
  tempId: string;
  clientId: string;
  chatId: string;
  type: MediaType;
  srcPath: string;        // persistent COPY under OUTBOX_DIR (survives restart)
  filename: string;
  mime: string;
  caption?: string;
  viewOnce?: boolean;
  metaExtra?: Record<string, any>;
  attempts: number;
  createdAt: number;
  lastError?: string | null;
  state?: 'pending' | 'failed';
}

// ── event bus (mirrors messageQueue) ──
type Events = {
  sent:   { tempId: string; chatId: string; real: Message };
  failed: { tempId: string; chatId: string; error: string };
  progress: { tempId: string; chatId: string; phase: UploadPhase; frac: number };
};

/**
 * Rate-limit progress samples so a big upload can't drive a React re-render per
 * network packet. Caps at ~100 renders per phase (1% granularity) plus the two
 * phase transitions.
 *
 * `prev` is per-ATTEMPT, not per-item: a retry legitimately restarts from
 * 'preparing' 0 (the encrypted path re-encrypts to a fresh temp), so the caller
 * resets it when an attempt begins rather than this refusing to go backwards
 * forever. The backwards guard below only suppresses out-of-order samples
 * WITHIN one attempt — which is what stops a failed multipart part from
 * yanking the ring back to 0 while earlier parts are still valid.
 */
export function shouldEmitProgress(
  prev: { phase: UploadPhase; frac: number } | undefined,
  next: { phase: UploadPhase; frac: number },
): boolean {
  if (!prev) return true;
  if (prev.phase !== next.phase) return true;
  if (next.frac < prev.frac) return false;
  if (next.frac >= 1 && prev.frac < 1) return true;   // always land the final sample
  return next.frac - prev.frac >= 0.01;
}

const listeners: { [K in keyof Events]?: Set<(d: Events[K]) => void> } = {};
function emit<K extends keyof Events>(e: K, d: Events[K]) { listeners[e]?.forEach(fn => { try { fn(d); } catch {} }); }
export function on<K extends keyof Events>(e: K, fn: (d: Events[K]) => void): () => void {
  (listeners[e] ??= new Set() as any).add(fn as any);
  return () => listeners[e]?.delete(fn as any);
}

// ── storage ──
// SQLite-backed (localDb `queues`), sealed at rest with the cache DEK — the
// caption and filename of an unsent photo no longer wait in the clear.
async function load(): Promise<MediaOutboxItem[]> {
  try { return await queueList<MediaOutboxItem>('media', READ_CAP); } catch { return []; }
}
async function save(q: MediaOutboxItem[]): Promise<void> {
  try { await queueReplace('media', q.map(m => ({ id: m.tempId, item: m, createdAt: m.createdAt, tag: m.chatId }))); } catch {}
}

const inFlight = new Set<string>();
const aborters = new Map<string, AbortController>();

// ── background transfer (Android foreground service) ──
//
// Without this, minimising the app suspends the JS thread and a photo/video/file
// send just stops partway — only VaultBeam survived backgrounding, because only
// it held the FGS. Each in-flight item counts as 100 units of work so the
// notification can show a true aggregate percentage without stat-ing every file
// for its size.
const UNITS = 100;
const fgsProgress = new Map<string, number>();   // tempId → 0..1 across BOTH phases

function publishFgs(): void {
  const count = fgsProgress.size;
  try {
    const { updateTransferForeground } = require('./transferForeground');
    updateTransferForeground(
      count ? {
        count,
        bytes: Math.round([...fgsProgress.values()].reduce((s, f) => s + f, 0) * UNITS),
        totalBytes: count * UNITS,
      } : null,
      'media',
    );
  } catch {}
}

// Encryption then upload are sequential, so treat them as two halves of one
// bar — otherwise the notification races to 100% and then restarts.
function phaseFraction(phase: UploadPhase, frac: number): number {
  return phase === 'preparing' ? frac * 0.5 : 0.5 + frac * 0.5;
}

async function ensureDir(): Promise<void> { try { await FileSystem.makeDirectoryAsync(OUTBOX_DIR, { intermediates: true }); } catch {} }

/**
 * Persist a media send + a durable copy of the file, then kick a flush. Returns
 * the item so the caller can paint an optimistic bubble keyed by tempId.
 */
export async function enqueueMedia(
  chatId: string, type: MediaType,
  file: { uri: string; filename: string; mime: string },
  opts: { caption?: string; viewOnce?: boolean; metaExtra?: Record<string, any> } = {},
): Promise<MediaOutboxItem> {
  await ensureDir();
  const tempId = 'm_' + Crypto.randomUUID();
  // Copy the picked file into our own storage so a restart (or the picker cache
  // being evicted) can't lose the bytes before the upload finishes.
  const safe = (file.filename || 'file').replace(/[^\w.\- ]+/g, '_');
  const srcPath = `${OUTBOX_DIR}${tempId}_${safe}`;
  try { await FileSystem.copyAsync({ from: file.uri, to: srcPath }); } catch { /* fall back to the original uri */ }
  const usable = (await FileSystem.getInfoAsync(srcPath).catch(() => null as any))?.exists ? srcPath : file.uri;

  const item: MediaOutboxItem = {
    tempId, clientId: Crypto.randomUUID(), chatId, type, srcPath: usable,
    filename: file.filename, mime: file.mime, caption: opts.caption, viewOnce: opts.viewOnce,
    metaExtra: opts.metaExtra, attempts: 0, createdAt: Date.now(), lastError: null, state: 'pending',
  };
  const q = await load(); q.push(item); await save(q);
  flush().catch(() => {});
  return item;
}

/** Pending items for a chat (to restore optimistic bubbles on chat open). */
export async function pendingForChat(chatId: string): Promise<MediaOutboxItem[]> {
  return (await load()).filter(m => m.chatId === chatId).sort((a, b) => a.createdAt - b.createdAt);
}

/** User cancel: abort any in-flight upload (frees R2), delete the copy, drop it. */
export async function cancelMedia(tempId: string): Promise<void> {
  aborters.get(tempId)?.abort();
  const q = await load();
  const item = q.find(m => m.tempId === tempId);
  if (item) await FileSystem.deleteAsync(item.srcPath, { idempotent: true }).catch(() => {});
  await save(q.filter(m => m.tempId !== tempId));
}

/** Force a retry of a failed item. */
export async function retryMedia(tempId: string): Promise<void> {
  const q = await load();
  const m = q.find(x => x.tempId === tempId);
  if (!m) return;
  m.attempts = 0; m.lastError = null; m.state = 'pending';
  await save(q);
  flush().catch(() => {});
}

// ── flush loop ──
let flushing = false;
let scheduled: any = null;

export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const q = await load();
    let anyRetry = false;

    // PRE-FLIGHT: retire anything already past the attempt ceiling BEFORE
    // trying it. The post-attempt cap below cannot help an item that is
    // already poisoned: reaching that code costs one more full attempt, and a
    // full attempt re-encrypts the whole file on the JS thread — the exact
    // multi-second freeze this ceiling exists to stop. Devices upgrading from
    // the retry-forever build carry such items (found on the Honor at
    // attempts=15), so this doubles as their migration.
    const stale = q.filter((m) => m.state !== 'failed' && m.attempts >= MAX_TRANSIENT_ATTEMPTS);
    if (stale.length) {
      const cur = await load();
      for (const s of stale) {
        const it = cur.find((m) => m.tempId === s.tempId);
        if (it) { it.state = 'failed'; it.lastError = it.lastError ?? 'too many attempts'; }
      }
      await save(cur);
      for (const s of stale) {
        emit('failed', { tempId: s.tempId, chatId: s.chatId, error: s.lastError ?? 'too many attempts' });
      }
    }
    const retired = new Set(stale.map((m) => m.tempId));

    for (const item of q) {
      if (inFlight.has(item.tempId) || item.state === 'failed' || retired.has(item.tempId)) continue;
      inFlight.add(item.tempId);
      const ac = new AbortController();
      aborters.set(item.tempId, ac);
      try {
        // Per-ATTEMPT progress tracker — see shouldEmitProgress. Declared
        // inside the loop so a retry starts clean and its restart from
        // 'preparing' 0 reaches the UI instead of being swallowed as backwards.
        let lastProg: { phase: UploadPhase; frac: number } | undefined;
        // Claim a slot in the FGS aggregate for the whole attempt, so the
        // service is held from the first byte — not only once the first
        // progress sample happens to arrive.
        fgsProgress.set(item.tempId, 0);
        publishFgs();
        const real = await sendMediaMessage(
          item.chatId, item.type,
          { uri: item.srcPath, filename: item.filename, mime: item.mime },
          {
            caption: item.caption, viewOnce: item.viewOnce, metaExtra: item.metaExtra,
            signal: ac.signal, clientId: item.clientId,
            onProgress: (phase, frac) => {
              const next = { phase, frac: Math.max(0, Math.min(1, frac)) };
              if (!shouldEmitProgress(lastProg, next)) return;
              lastProg = next;
              // The FGS notification is fed even when the in-app readout is
              // flagged off: keeping the app alive in the background is not
              // part of the progress-display experiment.
              fgsProgress.set(item.tempId, phaseFraction(next.phase, next.frac));
              publishFgs();
              if (UPLOAD_PROGRESS) {
                emit('progress', { tempId: item.tempId, chatId: item.chatId, ...next });
              }
            },
          },
        );
        // Success → drop it + delete the durable copy.
        await FileSystem.deleteAsync(item.srcPath, { idempotent: true }).catch(() => {});
        await save((await load()).filter(m => m.tempId !== item.tempId));
        emit('sent', { tempId: item.tempId, chatId: item.chatId, real });
      } catch (err: any) {
        if (ac.signal.aborted) { /* cancelMedia already removed it */ }
        else if (isPermanent(err?.status)) {
          // "Not sent" — mark failed (tap-to-retry), keep the copy for the retry.
          const cur = await load(); const it = cur.find(m => m.tempId === item.tempId);
          if (it) { it.state = 'failed'; it.lastError = err?.message ?? 'failed'; await save(cur); }
          emit('failed', { tempId: item.tempId, chatId: item.chatId, error: err?.message ?? 'failed' });
        } else {
          // Transient (offline / 5xx) → clock and retry — but NOT forever.
          //
          // "Retry forever" froze the whole app: a file stuck at attempt 15
          // ("Vishwanath and Sons…", device-diagnosed 2026-08-22) re-ran
          // sendMediaMessage on every boot, reconnect and 30s tick, and each
          // attempt re-encrypts the ENTIRE file in ~3s pure-JS chunks on the
          // JS thread — 100% CPU, frozen taps, ANR, on every single launch.
          // A transient error that survives this many attempts is not
          // transient; it degrades to the failed state, where the bubble's
          // tap-to-retry (attempts reset to 0) remains the human escape hatch.
          const cur = await load(); const it = cur.find(m => m.tempId === item.tempId);
          if (it) {
            it.attempts++; it.lastError = err?.message ?? null;
            if (it.attempts >= MAX_TRANSIENT_ATTEMPTS) {
              it.state = 'failed';
              await save(cur);
              emit('failed', { tempId: item.tempId, chatId: item.chatId, error: it.lastError ?? 'failed' });
            } else {
              await save(cur); anyRetry = true;
            }
          }
        }
      } finally {
        inFlight.delete(item.tempId); aborters.delete(item.tempId);
        // In `finally`, so an abort or a throw releases the foreground service
        // too — a leaked slot would pin an ongoing notification (and the FGS
        // hold) for the rest of the app's life.
        fgsProgress.delete(item.tempId); publishFgs();
      }
    }
    if (anyRetry) {
      const worst = Math.max(1, ...(await load()).filter(m => m.state !== 'failed').map(m => m.attempts));
      const delay = BACKOFF_MS[Math.min(worst - 1, BACKOFF_MS.length - 1)];
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => { scheduled = null; flush(); }, delay);
    } else if ((await load()).some(m => m.state !== 'failed' && !inFlight.has(m.tempId))) {
      // Items enqueued WHILE we were uploading aren't in this pass's snapshot —
      // drain them promptly instead of waiting for the periodic flush.
      if (!scheduled) scheduled = setTimeout(() => { scheduled = null; flush(); }, 300);
    }
  } finally { flushing = false; }
}

let armed = false;
let online = true;   // P1.4: track connectivity so the periodic safety-net can no-op while offline.
/** Wire reconnect + periodic + initial flush. Call once at boot. */
export function initMediaOutbox(): void {
  if (armed) return;
  armed = true;
  // One-time lift of an older build's AsyncStorage queue (no-op afterwards).
  const migrated = queueMigrate('media', LEGACY_KEY, (m: MediaOutboxItem) => m.tempId,
    (m: MediaOutboxItem) => m.createdAt, (m: MediaOutboxItem) => m.chatId).catch(() => 0);
  NetInfo.addEventListener(s => {
    online = !!(s.isConnected && s.isInternetReachable !== false);
    if (online) flush().catch(() => {});
  });
  // Periodic safety net — but skip the DB/network work entirely when we know
  // we're offline (the reconnect listener above flushes as soon as we're back),
  // so a backgrounded, offline device isn't woken every PERIODIC_MS for nothing.
  setInterval(() => { if (online) flush().catch(() => {}); }, PERIODIC_MS);
  migrated.then(() => flush()).catch(() => {});
}

export default {};
