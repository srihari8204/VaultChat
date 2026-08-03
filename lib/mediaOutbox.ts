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

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { sendMediaMessage, type MediaType } from './sendMedia';
import { type Message } from './chatService';

const STORAGE_KEY = 'vc_media_outbox_v1';
const OUTBOX_DIR = (FileSystem as any).documentDirectory + 'outbox/';
const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000];
const PERIODIC_MS = 30_000;

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
};
const listeners: { [K in keyof Events]?: Set<(d: Events[K]) => void> } = {};
function emit<K extends keyof Events>(e: K, d: Events[K]) { listeners[e]?.forEach(fn => { try { fn(d); } catch {} }); }
export function on<K extends keyof Events>(e: K, fn: (d: Events[K]) => void): () => void {
  (listeners[e] ??= new Set() as any).add(fn as any);
  return () => listeners[e]?.delete(fn as any);
}

// ── storage ──
async function load(): Promise<MediaOutboxItem[]> {
  try { const raw = await AsyncStorage.getItem(STORAGE_KEY); const p = raw ? JSON.parse(raw) : []; return Array.isArray(p) ? p : []; } catch { return []; }
}
async function save(q: MediaOutboxItem[]): Promise<void> { try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(q)); } catch {} }

const inFlight = new Set<string>();
const aborters = new Map<string, AbortController>();

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
    for (const item of q) {
      if (inFlight.has(item.tempId) || item.state === 'failed') continue;
      inFlight.add(item.tempId);
      const ac = new AbortController();
      aborters.set(item.tempId, ac);
      try {
        const real = await sendMediaMessage(
          item.chatId, item.type,
          { uri: item.srcPath, filename: item.filename, mime: item.mime },
          { caption: item.caption, viewOnce: item.viewOnce, metaExtra: item.metaExtra, signal: ac.signal, clientId: item.clientId },
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
          // Transient (offline / 5xx) → clock, retry forever.
          const cur = await load(); const it = cur.find(m => m.tempId === item.tempId);
          if (it) { it.attempts++; it.lastError = err?.message ?? null; await save(cur); anyRetry = true; }
        }
      } finally { inFlight.delete(item.tempId); aborters.delete(item.tempId); }
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
  NetInfo.addEventListener(s => {
    online = !!(s.isConnected && s.isInternetReachable !== false);
    if (online) flush().catch(() => {});
  });
  // Periodic safety net — but skip the DB/network work entirely when we know
  // we're offline (the reconnect listener above flushes as soon as we're back),
  // so a backgrounded, offline device isn't woken every PERIODIC_MS for nothing.
  setInterval(() => { if (online) flush().catch(() => {}); }, PERIODIC_MS);
  flush().catch(() => {});
}

export default {};
