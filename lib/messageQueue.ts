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
import * as Crypto from 'expo-crypto';
import { api } from './api';
import { encryptForChat, cacheOwnPlaintext, editMessage, deleteMessage, type Message } from './chatService';
import { wrapWithPreview } from './linkPreview';
import { type MsgState } from './messageState';
import perf from './perf';

const STORAGE_KEY      = 'vc_msg_queue_v1';
const BACKOFF_MS       = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000]; // caps at 60s, then holds
const PERIODIC_FLUSH_MS = 30_000;

// WhatsApp model: a message is NEVER failed for lack of network — it stays a
// clock and retries on every reconnect/foreground/periodic flush, forever. Only
// a PERMANENT server rejection turns it red ("not sent"): blocked / not-a-member
// (403), gone (404), malformed (400), too large (413). 401 is a token refresh
// (api() handles it) and 5xx/timeout/offline are all transient → keep the clock.
function isPermanent(status?: number): boolean {
  return status === 400 || status === 403 || status === 404 || status === 413;
}
// A no-session / prekeys-not-fetched failure — same clock, tagged WAITING_KEYS.
function isKeysError(msg?: string | null): boolean {
  return !!msg && /keys.*(available|ready)|not resolved|Encryption not ready|no session and no X3DH/i.test(msg);
}

// The outbox carries every user op that must survive offline, not just text:
//   'send'   → POST a new message (text, media-caption, or a reaction message)
//   'edit'   → PATCH an existing message's content (targetId)
//   'delete' → DELETE-for-everyone an existing message (targetId)
// All three get the same durability: clock-forever retry, survive restart,
// flush on reconnect — the WhatsApp offline guarantee. Only 'send' owns a
// pending timeline bubble; 'edit'/'delete' apply optimistically by id in the UI
// and ride the queue silently.
export interface QueuedMessage {
  tempId:    string;                 // client uuid, used to dedupe the pending bubble
  clientId:  string;                 // STABLE idempotency key sent to the server; identical across retries (F7)
  chatId:    string;
  op?:       'send' | 'edit' | 'delete';  // default 'send' (back-compat with items already on disk)
  type:      Message['type'];        // 'text' | 'reaction' | media types…
  targetId?: number | null;          // edit/delete: the message being mutated
  plaintext: string;                 // send/edit: content to encrypt; delete: ''
  replyToId: number | null;
  // Optional non-PII metadata (invisibleInk, etc.). Encrypted-server seam
  // doesn't touch this — it travels through as-is into messages.meta.
  meta:      any | null;
  attempts:  number;
  createdAt: number;
  lastError: string | null;
  state?:    MsgState;               // QUEUED | WAITING_KEYS (clock in both cases)
}

// ─── Tiny event bus (avoids a dependency) ─────────────────────
type QueueEvents = {
  pending: { msg: QueuedMessage };
  sent:    { tempId: string; chatId: string; real: Message | null }; // null = delete (no row)
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

// The default outbox item — every enqueue* helper overrides only what differs.
function baseItem(chatId: string): QueuedMessage {
  return {
    tempId:    newTempId(),
    clientId:  Crypto.randomUUID(),   // persisted → identical on every retry → server dedups
    chatId,
    op:        'send',
    type:      'text',
    targetId:  null,
    plaintext: '',
    replyToId: null,
    meta:      null,
    attempts:  0,
    createdAt: Date.now(),
    lastError: null,
    state:     'QUEUED',
  };
}

async function enqueue(msg: QueuedMessage): Promise<QueuedMessage> {
  const q = await load();
  q.push(msg);
  await save(q);
  emit('pending', { msg });
  flush().catch(() => {});   // background — don't make the caller wait
  return msg;
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
  return enqueue({ ...baseItem(chatId), type: 'text', plaintext,
    replyToId: opts.replyToId ?? null, meta: opts.meta ?? null });
}

/**
 * Enqueue a reaction (add/remove). A reaction is a normal E2EE message whose
 * {reactsTo, op, emoji} payload rides inside the content, so it flows through
 * the same 'send' path — the server only ever sees ciphertext. Returns the
 * tempId so the caller's optimistic reaction row reconciles on the 'sent' event.
 */
export async function enqueueReaction(
  chatId: string, msgId: number, emoji: string, op: 'add' | 'remove',
): Promise<QueuedMessage> {
  return enqueue({ ...baseItem(chatId), type: 'reaction',
    plaintext: JSON.stringify({ reactsTo: msgId, op, emoji }) });
}

/** Enqueue an edit of an existing message. Content is re-encrypted at flush. */
export async function enqueueEdit(
  chatId: string, msgId: number, plaintext: string,
): Promise<QueuedMessage> {
  return enqueue({ ...baseItem(chatId), op: 'edit', targetId: msgId, plaintext });
}

/** Enqueue a delete-for-everyone of an existing message. */
export async function enqueueDelete(
  chatId: string, msgId: number,
): Promise<QueuedMessage> {
  return enqueue({ ...baseItem(chatId), op: 'delete', targetId: msgId });
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

/** Pending 'send' entries for a chat (text + reaction) for initial-render restore.
 *  edit/delete ops mutate an existing row by id and carry no bubble, so they're
 *  excluded here — they still flush from the queue in the background.
 *  ponytail: a pending edit/delete isn't re-applied optimistically after a cold
 *  restart while still offline (shows pre-edit text until reconnect+reload).
 *  Add a re-apply pass here if that offline tail matters. */
export async function pendingForChat(chatId: string): Promise<QueuedMessage[]> {
  const q = await load();
  return q.filter(m => m.chatId === chatId && (m.op ?? 'send') === 'send')
          .sort((a, b) => a.createdAt - b.createdAt);
}

// ─── Flush loop ───────────────────────────────────────────────

let flushing = false;
let flushScheduled: any = null;

async function postOnce(item: QueuedMessage): Promise<Message | null> {
  // Non-'send' ops mutate an existing message by id. Reuse chatService's exact
  // encrypt+verb logic; the queue only adds durability around it.
  if (item.op === 'delete') {
    await deleteMessage(item.chatId, item.targetId!);
    return null;
  }
  if (item.op === 'edit') {
    return editMessage(item.chatId, item.targetId!, item.plaintext);
  }

  // F5 (E2EE link previews): the sender-resolved preview lives in LOCAL meta
  // (meta.linkPreview) so the optimistic bubble can render it, but it must
  // NEVER ride in the plaintext server meta. Fold it INSIDE the E2EE content
  // (wrapWithPreview) and strip it from the POSTed meta. If encryption doesn't
  // actually happen (rare graceful-plaintext fallback), send the bare text and
  // drop the preview rather than leak it.
  const { linkPreview, ...restMeta } = (item.meta ?? {}) as any;
  const serverMeta = Object.keys(restMeta).length ? restMeta : null;
  const wire = linkPreview ? wrapWithPreview(item.plaintext, linkPreview) : item.plaintext;

  // Perf: split encrypt (X3DH/ratchet) vs POST round-trip — this is the REAL
  // text send path (the queue), so this is what drives the pending→sent tick.
  const _t0 = Date.now();
  let content = await encryptForChat(item.chatId, wire);
  const encrypted = content !== wire;
  if (!encrypted && linkPreview) content = item.plaintext;   // plaintext fallback: never leak the wrapper
  const _tEnc = Date.now();
  perf.mark('queue_encrypt_done', { chatId: item.chatId, ms: _tEnc - _t0, encrypted });
  const real = await api<Message>(`/chats/${encodeURIComponent(item.chatId)}/messages`, {
    method: 'POST',
    json: { content, type: item.type, replyToId: item.replyToId, meta: serverMeta, clientId: item.clientId },
  });
  // The POST ack returns `id` as a STRING, but GET /chats and socket payloads
  // deliver it as a NUMBER. Left as a string, the UI's `x.id === real.id`
  // dedup fails (optimistic + synced rows collide on the same React key) and
  // the local cache drops it (cacheMessages skips non-number ids). Normalize.
  if (real && real.id != null) (real as any).id = Number(real.id);
  const _tAck = Date.now();
  perf.recordSend({
    id: String(real?.id ?? item.tempId),
    tapToEncrypt: _tEnc - _t0,
    encryptToAck: _tAck - _tEnc,
    totalMs: _tAck - _t0,
    transport: perf.snapshot().transport,
    at: _tAck,
  });
  // Cache the WRAPPED plaintext (text + preview) so the sender's own bubble
  // keeps its preview across reloads — hydrateMessages unwraps it on read.
  if (encrypted) await cacheOwnPlaintext(item.chatId, real?.id, wire);
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
        item.lastError = err?.message ?? 'unknown error';
        if (isPermanent(err?.status)) {
          // "Not sent" — the only case WhatsApp turns a message red. Drop from
          // the queue; the UI keeps a failed bubble with tap-to-retry.
          item.state = 'FAILED';
          emit('failed', { tempId: item.tempId, chatId: item.chatId, error: item.lastError });
          continue;
        }
        // Transient (offline / 5xx / timeout) or WAITING_KEYS → clock stays,
        // retry forever. attempts only drives the backoff cadence, never a fail.
        item.state = isKeysError(item.lastError) ? 'WAITING_KEYS' : 'QUEUED';
        item.attempts++;
        emit('retry', { tempId: item.tempId, chatId: item.chatId, attempt: item.attempts });
        remaining.push(item);
      }
    }
    await save(remaining);

    // Backoff off the worst attempt (all remaining items have attempts ≥ 1),
    // capped at 60s then held — the periodic + reconnect flush keep it alive.
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
let online = true;   // P1.4: track connectivity so the periodic safety-net can no-op while offline.
export function initQueue() {
  if (initialized) return;
  initialized = true;

  // Reconnect → flush
  NetInfo.addEventListener(state => {
    online = !!(state.isConnected && state.isInternetReachable !== false);
    if (online) {
      flush().catch(() => {});
    }
  });

  // Periodic safety net (covers cases where NetInfo doesn't fire). Skips the
  // work while known-offline so a backgrounded device isn't woken for nothing.
  setInterval(() => { if (online) flush().catch(() => {}); }, PERIODIC_FLUSH_MS);

  // Initial drain on app boot
  flush().catch(() => {});
}

// Default export to silence expo-router's route warning
export default {};
