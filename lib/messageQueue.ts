// Persistent outgoing-message queue (Day 3).
//
// Goal: tapping Send works regardless of network state.
//   * Message immediately appears in the chat as "pending"
//   * Backend POST happens in the background
//   * On success: pending bubble is replaced with the server-issued message
//   * On transient failure: retry with backoff, kept across app restarts
//   * On permanent failure: bubble is marked "failed", user can retry / cancel
//
// Storage: AsyncStorage under VC_MSG_QUEUE_KEY (single JSON array).
// Network: NetInfo subscription auto-flushes when connection returns.
// UI: subscribe via .on('pending'|'sent'|'failed', ...) to mirror state.
//
// Scope (MVP):
//   * TEXT messages only (image/file/audio uploads still require live network
//     because the upload step is not in the queue yet — Phase 4b polish).

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { api } from './api';
import { encryptForChat, cacheOwnPlaintext, type Message } from './chatService';
import perf from './perf';

const STORAGE_KEY      = 'vc_msg_queue_v1';
const MAX_ATTEMPTS     = 5;
const BACKOFF_MS       = [1_000, 3_000, 8_000, 20_000, 60_000]; // capped
const PERIODIC_FLUSH_MS = 30_000;

export interface QueuedMessage {
  tempId:    string;                 // client uuid, used to dedupe the pending bubble
  chatId:    string;
  type:      'text';                 // only text for MVP
  plaintext: string;
  replyToId: number | null;
  // Optional non-PII metadata (invisibleInk, etc.). Encrypted-server seam
  // doesn't touch this — it travels through as-is into messages.meta.
  meta:      any | null;
  attempts:  number;
  createdAt: number;
  lastError: string | null;
}

// ─── Tiny event bus (avoids a dependency) ─────────────────────
type QueueEvents = {
  pending: { msg: QueuedMessage };
  sent:    { tempId: string; chatId: string; real: Message };
  failed:  { tempId: string; chatId: string; error: string };
  retry:   { tempId: string; chatId: string; attempt: number };
};
type Listener<T> = (data: T) => void;
const listeners: { [K in keyof QueueEvents]?: Set<Listener<QueueEvents[K]>> } = {};
function emit<K extends keyof QueueEvents>(event: K, data: QueueEvents[K]) {
  listeners[event]?.forEach(fn => { try { (fn as any)(data); } catch {} });
}
export function on<K extends keyof QueueEvents>(event: K, fn: Listener<QueueEvents[K]>): () => void {
  if (!listeners[event]) listeners[event] = new Set() as any;
  listeners[event]!.add(fn as any);
  return () => listeners[event]?.delete(fn as any);
}

// ─── Storage ──────────────────────────────────────────────────
async function load(): Promise<QueuedMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
async function save(q: QueuedMessage[]): Promise<void> {
  try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(q)); } catch {}
}

function newTempId(): string {
  return 'temp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Enqueue a text message. Returns the tempId so the caller can render
 * the optimistic bubble. Triggers a flush attempt immediately.
 */
export async function enqueueText(
  chatId: string,
  plaintext: string,
  opts: { replyToId?: number | null; meta?: any | null } = {},
): Promise<QueuedMessage> {
  const msg: QueuedMessage = {
    tempId:    newTempId(),
    chatId,
    type:      'text',
    plaintext,
    replyToId: opts.replyToId ?? null,
    meta:      opts.meta       ?? null,
    attempts:  0,
    createdAt: Date.now(),
    lastError: null,
  };
  const q = await load();
  q.push(msg);
  await save(q);
  emit('pending', { msg });
  // Fire flush in the background — don't make the caller wait
  flush().catch(() => {});
  return msg;
}

/** Cancel a pending or failed message. */
export async function cancel(tempId: string): Promise<void> {
  const q = await load();
  await save(q.filter(m => m.tempId !== tempId));
}

/** Force a retry on a specific tempId (e.g. user tapped Retry on a failed bubble). */
export async function retry(tempId: string): Promise<void> {
  const q = await load();
  const m = q.find(x => x.tempId === tempId);
  if (!m) return;
  m.attempts = 0;
  m.lastError = null;
  await save(q);
  flush().catch(() => {});
}

/** All pending entries for a chat (for initial render restore). */
export async function pendingForChat(chatId: string): Promise<QueuedMessage[]> {
  const q = await load();
  return q.filter(m => m.chatId === chatId).sort((a, b) => a.createdAt - b.createdAt);
}

// ─── Flush loop ───────────────────────────────────────────────

let flushing = false;
let flushScheduled: any = null;

async function postOnce(item: QueuedMessage): Promise<Message> {
  // Perf: split encrypt (X3DH/ratchet) vs POST round-trip — this is the REAL
  // text send path (the queue), so this is what drives the pending→sent tick.
  const _t0 = Date.now();
  const content = await encryptForChat(item.chatId, item.plaintext);
  const _tEnc = Date.now();
  perf.mark('queue_encrypt_done', { chatId: item.chatId, ms: _tEnc - _t0, encrypted: content !== item.plaintext });
  const real = await api<Message>(`/chats/${encodeURIComponent(item.chatId)}/messages`, {
    method: 'POST',
    json: { content, type: item.type, replyToId: item.replyToId, meta: item.meta ?? null },
  });
  const _tAck = Date.now();
  perf.recordSend({
    id: String(real?.id ?? item.tempId),
    tapToEncrypt: _tEnc - _t0,
    encryptToAck: _tAck - _tEnc,
    totalMs: _tAck - _t0,
    transport: perf.snapshot().transport,
    at: _tAck,
  });
  if (content !== item.plaintext) await cacheOwnPlaintext(item.chatId, real?.id, item.plaintext);
  return real;
}

/**
 * Attempt to send every queued message. Each entry tries once per flush
 * call. On transient failure, scheduleNextFlush() arranges a retry with
 * backoff. On 5 failures the entry is marked failed and emitted.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const q = await load();
    if (q.length === 0) return;

    const remaining: QueuedMessage[] = [];
    for (const item of q) {
      try {
        const real = await postOnce(item);
        emit('sent', { tempId: item.tempId, chatId: item.chatId, real });
      } catch (err: any) {
        item.attempts++;
        item.lastError = err?.message ?? 'unknown error';
        if (item.attempts >= MAX_ATTEMPTS) {
          emit('failed', { tempId: item.tempId, chatId: item.chatId, error: item.lastError });
          // Drop from queue once we give up. UI keeps the failed bubble and
          // can re-enqueue via retry(tempId).
        } else {
          emit('retry', { tempId: item.tempId, chatId: item.chatId, attempt: item.attempts });
          remaining.push(item);
        }
      }
    }
    await save(remaining);

    if (remaining.length > 0) {
      const worstAttempts = Math.max(...remaining.map(m => m.attempts));
      const delay = BACKOFF_MS[Math.min(worstAttempts - 1, BACKOFF_MS.length - 1)];
      if (flushScheduled) clearTimeout(flushScheduled);
      flushScheduled = setTimeout(() => { flushScheduled = null; flush(); }, delay);
    }
  } finally {
    flushing = false;
  }
}

// ─── Auto-flush on reconnect + periodic safety net ────────────

let initialized = false;
export function initQueue() {
  if (initialized) return;
  initialized = true;

  // Reconnect → flush
  NetInfo.addEventListener(state => {
    if (state.isConnected && state.isInternetReachable !== false) {
      flush().catch(() => {});
    }
  });

  // Periodic safety net (covers cases where NetInfo doesn't fire)
  setInterval(() => { flush().catch(() => {}); }, PERIODIC_FLUSH_MS);

  // Initial drain on app boot
  flush().catch(() => {});
}

// Default export to silence expo-router's route warning
export default {};
