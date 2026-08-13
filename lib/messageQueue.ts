// Persistent outgoing-message queue (Day 3).
//
// Goal: tapping Send works regardless of network state.
//   * Message immediately appears in the chat as "pending"
//   * Backend POST happens in the background
//   * On success: pending bubble is replaced with the server-issued message
//   * On transient failure: retry with backoff, kept across app restarts
//   * On permanent failure: bubble is marked "failed", user can retry / cancel
//
// Storage: SQLite (localDb `queues` table, sealed with the cache DEK). One row
//   per queued item — enqueue/ack/retry touch a single row instead of
//   rewriting a whole JSON array, and the pending PLAINTEXT is sealed at rest
//   like the rest of the message cache. Items written by older builds are
//   lifted out of AsyncStorage once, on first init.
// Network: NetInfo subscription auto-flushes when connection returns.
// UI: subscribe via .on('pending'|'sent'|'failed', ...) to mirror state.
//
// Scope (MVP):
//   * TEXT messages only (image/file/audio uploads still require live network
//     because the upload step is not in the queue yet — Phase 4b polish).

import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { api } from './api';
import { queuePut, queueList, queueListByTag, queueGet, queueDelete, queueMigrate } from './localDb';
import { encryptForChat, cacheOwnPlaintext, editMessage, deleteMessage, type Message } from './chatService';
import { wrapWithPreview } from './linkPreview';
import { type MsgState } from './messageState';
import perf from './perf';

const LEGACY_KEY       = 'vc_msg_queue_v1';   // pre-SQLite AsyncStorage array
const BACKOFF_MS       = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000]; // caps at 60s, then holds
const PERIODIC_FLUSH_MS = 30_000;
const PAGE             = 200;   // items pulled per flush pass (see load())

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
  /**
   * Server id, set once the POST is accepted. Its presence is what marks the
   * row as SERVER_ACCEPTED / AWAITING_DELIVERY rather than still-to-send.
   */
  serverId?: number;
  /** When the server accepted it — drives the bounded-retention reap below. */
  acceptedAt?: number;
  /**
   * The exact ciphertext that went to the server, kept ONLY while awaiting
   * delivery so the message can be re-bodied without re-encrypting.
   *
   * This is what an accepted row holds INSTEAD of `plaintext` — see the note on
   * AWAIT_DELIVERY_MAX_MS below. Re-upload is verbatim: a Double Ratchet
   * ciphertext stays decryptable by the recipient whenever it arrives, so
   * replaying the original bytes is both sufficient and cheaper than taking a
   * fresh ratchet step.
   */
  ciphertext?: string;
}

// ─── SERVER_ACCEPTED vs DELIVERED ─────────────────────────────────────
//
// HTTP 200 means the SERVER took the message. It does NOT mean the recipient
// received it, and the two stopped being interchangeable the moment the server
// stopped keeping message bodies indefinitely.
//
// This row used to be deleted on 200. That was safe only while the server was a
// durable archive that would hand the message over whenever the recipient
// eventually reconnected. With an ephemeral body store it is not: if the
// recipient is offline when the body is reclaimed, the server has nothing left
// to deliver and — with the row already gone — neither does the sender. The
// message would be lost with nobody able to notice.
//
// So an accepted row is KEPT, in state SENT, holding the plaintext that makes
// recovery possible. It is dropped when delivery is confirmed, or when the
// retention cap below makes recovery pointless anyway.
//
// The rows are inert while they wait: excluded from the flush loop (they must
// never be re-POSTed) and from pendingForChat (they are real messages now, and
// rendering them as pending bubbles would double every sent message on screen).
//
// THEY HOLD CIPHERTEXT, NOT PLAINTEXT.
//
// A queued row carries `plaintext` because it has not been encrypted yet —
// encryption happens at flush, against the peer's current ratchet. That was
// acceptable while a row lived for seconds; holding it for up to a WEEK is a
// different proposition entirely, and would have been a plaintext-at-rest
// regression introduced by this very feature. `encField` is a pass-through
// whenever VAULT_CACHE_ENCRYPTED is off (the current default), so those rows
// would sit in readable SQLite on the handset.
//
// So acceptance swaps the payload: the row keeps the exact ciphertext that went
// to the server and DROPS the plaintext. Recovery needs the bytes to re-upload,
// not the text — and the ciphertext is already sealed to the recipient, so it is
// worth nothing to anyone reading the database. Net effect is a reduction in
// local exposure versus the pre-change behaviour, not merely parity with it.
const AWAIT_DELIVERY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** True for a row that has been accepted by the server and is awaiting delivery. */
function isAwaitingDelivery(m: QueuedMessage): boolean {
  return typeof m.serverId === 'number' && m.serverId > 0;
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
// Oldest-first, and bounded per read: a long offline stretch drains over
// several flush passes rather than loading the whole backlog into memory.
// pageOffset rotates past a page that drained NOTHING, so items behind a wedged
// one still get their turn: 200 messages stuck WAITING_KEYS on one peer must not
// starve every other chat's sends. Reset to the head as soon as anything drains.
let pageOffset = 0;
async function load(): Promise<QueuedMessage[]> {
  try { return await queueList<QueuedMessage>('msg', PAGE, pageOffset); } catch { return []; }
}
async function put(m: QueuedMessage): Promise<void> {
  try { await queuePut('msg', m.tempId, m, m.createdAt, m.chatId); } catch {}
}
async function drop(tempId: string): Promise<void> {
  try { await queueDelete('msg', tempId); } catch {}
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
  await put(msg);
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
  await drop(tempId);
}

/** Force a retry on a specific tempId (e.g. user tapped Retry on a failed bubble). */
export async function retry(tempId: string): Promise<void> {
  const m = await queueGet<QueuedMessage>('msg', tempId).catch(() => null);
  if (!m) return;
  m.attempts = 0;
  m.lastError = null;
  await put(m);
  flush().catch(() => {});
}

/** Pending 'send' entries for a chat (text + reaction) for initial-render restore.
 *  edit/delete ops mutate an existing row by id and carry no bubble, so they're
 *  excluded here — they still flush from the queue in the background.
 *  ponytail: a pending edit/delete isn't re-applied optimistically after a cold
 *  restart while still offline (shows pre-edit text until reconnect+reload).
 *  Add a re-apply pass here if that offline tail matters. */
export async function pendingForChat(chatId: string): Promise<QueuedMessage[]> {
  const q = await queueListByTag<QueuedMessage>('msg', chatId).catch(() => []);
  // isAwaitingDelivery rows are excluded: the server has accepted them, so they
  // already exist as real messages in the timeline. Returning them here too
  // would render a pending bubble beside the real one — every sent message
  // duplicated on screen until the row was reaped.
  return q.filter(m => (m.op ?? 'send') === 'send' && !isAwaitingDelivery(m))
          .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Confirm delivery up to `lastDeliveredMessageId` for a chat and release the
 * rows that were waiting on it.
 *
 * Called from the sender's `message_delivered` handling. Delivery is the ONLY
 * clean release: at that point the recipient holds the message locally and the
 * server's copy is redundant, so the sender's recovery copy is too.
 */
export async function noteDelivered(chatId: string, lastDeliveredMessageId: number): Promise<void> {
  if (!(lastDeliveredMessageId > 0)) return;
  try {
    const q = await queueListByTag<QueuedMessage>('msg', chatId);
    for (const m of q) {
      if (isAwaitingDelivery(m) && (m.serverId as number) <= lastDeliveredMessageId) {
        await drop(m.tempId);
      }
    }
  } catch { /* best-effort: the age cap below reaps anything missed */ }
}

/**
 * Re-upload the body of a message the recipient still has not received.
 *
 * THIS IS WHAT THE RETAINED CIPHERTEXT IS FOR. Without it the outbox knows a
 * message was never delivered and does nothing about it — the row sits there
 * until the age cap quietly drops it, and the sender is never told. Storing the
 * ciphertext without this is dead weight.
 *
 * The server reclaims a message body once every active device has it, and
 * unconditionally at the retention deadline. If a recipient reappears after
 * that, the server has nothing left to hand over. Re-body puts the SAME
 * ciphertext back on the SAME message id — no new clientId, no new message, no
 * duplicate bubble.
 *
 * 410 is the important response, not the failure case. It means the retention
 * window has closed and the message can never be delivered. Surfacing that as
 * a failed send is the whole point: the alternative is a message the sender
 * believes was delivered and which the recipient never saw.
 */
async function reBodyAwaiting(): Promise<void> {
  // NEVER run this while offline, and never let it precede the send loop.
  //
  // api() puts no timeout on fetch, so a call made with no network hangs until
  // the OS gives up — which on Android can be tens of seconds. Recovering up to
  // a hundred rows serially in front of the send loop therefore stalled flush()
  // completely: messages queued while offline were never attempted, because the
  // queue was still waiting on the first doomed PUT. Sending is the job;
  // recovery is the optimisation, and an optimisation must never block it.
  if (!online) return;

  let rows: QueuedMessage[];
  try { rows = await queueList<QueuedMessage>('msg', 100, 0); } catch { return; }

  let attempts = 0;
  for (const m of rows) {
    if (!isAwaitingDelivery(m) || !m.ciphertext) continue;
    // A few per pass. Recovery is not urgent — the next flush picks up where
    // this one stopped, and a bounded pass cannot become a long stall.
    if (attempts >= RE_BODY_PER_FLUSH) break;
    // Give normal delivery a chance first — most messages are received in
    // seconds, and re-bodying one that is simply in flight is pure waste.
    if (Date.now() - (m.acceptedAt ?? m.createdAt) < RE_BODY_AFTER_MS) continue;
    attempts++;
    try {
      await api(`/chats/${encodeURIComponent(m.chatId)}/messages/${m.serverId}/body`, {
        method: 'PUT',
        json: { content: m.ciphertext },
      });
      // Body restored; keep waiting for the delivery receipt that releases it.
    } catch (err: any) {
      const status = err?.status;
      if (status === 410) {
        // Retention window closed — undeliverable, permanently. Tell the user
        // rather than dropping it silently.
        await drop(m.tempId);
        emit('failed', {
          tempId: m.tempId, chatId: m.chatId,
          error: 'Not delivered — this message expired before it reached them',
        });
      } else if (status === 404 || status === 403) {
        // Deleted, or no longer ours. Nothing to recover.
        await drop(m.tempId);
      } else if (!status) {
        // No HTTP status = the request never reached the server (dropped
        // connection, DNS, radio gone). Stop the whole pass: every remaining
        // row would fail the same way, one slow timeout at a time.
        return;
      }
      // Anything else (5xx) — leave it and retry on the next flush.
    }
  }
}

/** Recovery attempts per flush. Bounded so a pass can never become a stall. */
const RE_BODY_PER_FLUSH = 3;

/**
 * How long to wait after acceptance before attempting recovery.
 *
 * Long enough that an ordinary in-flight message is never re-bodied, short
 * enough to act well inside the server's retention window — re-body is refused
 * once that closes, so waiting too long turns every recovery into a 410.
 */
const RE_BODY_AFTER_MS = 10 * 60 * 1000;

/**
 * Drop accepted-but-unconfirmed rows past the retention cap.
 *
 * Without this the outbox becomes a second permanent archive — the exact thing
 * the server-side work is removing, relocated onto the handset. A recipient who
 * has not come back within the window is not coming back for this message, and
 * the sender still has it in their own chat history regardless; what is dropped
 * here is only the ability to RE-DELIVER it.
 */
async function reapAwaitingDelivery(): Promise<void> {
  const cutoff = Date.now() - AWAIT_DELIVERY_MAX_MS;
  try {
    const q = await queueList<QueuedMessage>('msg', 500, 0);
    for (const m of q) {
      if (isAwaitingDelivery(m) && (m.acceptedAt ?? m.createdAt) < cutoff) await drop(m.tempId);
    }
  } catch { /* best-effort */ }
}

// ─── Flush loop ───────────────────────────────────────────────

let flushing = false;
let flushScheduled: any = null;

/** Arm the next flush, replacing any pending one. */
function scheduleFlush(delayMs: number): void {
  if (flushScheduled) clearTimeout(flushScheduled);
  flushScheduled = setTimeout(() => { flushScheduled = null; flush(); }, delayMs);
}

/** What went on the wire, so the caller can retain the ciphertext (never the text). */
interface PostResult { real: Message | null; wire: string | null }

async function postOnce(item: QueuedMessage): Promise<PostResult> {
  // Non-'send' ops mutate an existing message by id. Reuse chatService's exact
  // encrypt+verb logic; the queue only adds durability around it.
  if (item.op === 'delete') {
    await deleteMessage(item.chatId, item.targetId!);
    return { real: null, wire: null };
  }
  if (item.op === 'edit') {
    return { real: await editMessage(item.chatId, item.targetId!, item.plaintext), wire: null };
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
  // Hand back the CIPHERTEXT (not `wire`, which is the pre-encryption text) so
  // the caller can retain it for recovery and discard the plaintext.
  return { real, wire: encrypted ? content : null };
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
    // Reap first: accepted-but-unconfirmed rows are inert, and leaving them in
    // place would let them fill a 200-item page and starve real sends behind
    // them. Cheap — it only touches rows past the cap.
    await reapAwaitingDelivery();
    const q = await load();
    if (q.length === 0) {
      // An empty page while rotated means we walked off the end. Rewind to the
      // head, but do NOT re-flush immediately: we just read every page and found
      // nothing to send, so an instant retry would read the same pages again.
      //
      // With an inert row count that is an exact multiple of PAGE that is
      // precisely a 0ms loop — page of inert rows advances the offset and
      // reschedules, the next page is empty and rewinds and reschedules, round
      // and round, re-unsealing hundreds of rows each lap and never sending
      // anything. Whatever makes a send possible (enqueue, reconnect, retry,
      // the periodic tick) calls flush itself, so stopping here loses nothing.
      if (pageOffset > 0) pageOffset = 0;
      return;
    }

    const remaining: QueuedMessage[] = [];
    // Accepted-but-unconfirmed rows are skipped below, but they are NOT drained
    // — they will still be there next pass. Counting them as drained reset
    // pageOffset to 0 on a page made entirely of them, and the immediate
    // re-flush then re-read that same page forever: a hot loop that sent
    // nothing, while genuinely queued messages sat behind it unreachable. They
    // are also the OLDEST rows, so they sort to the head of the page and this
    // was the normal case for an active user, not an edge one.
    let inert = 0;
    for (const item of q) {
      // Already accepted and waiting on delivery — NOT a send candidate.
      // Re-POSTing would be a no-op anyway (the server dedups on clientId) but
      // it would burn a request per flush per row, forever.
      if (isAwaitingDelivery(item)) { inert++; continue; }
      try {
        const { real, wire } = await postOnce(item);
        const serverId = Number(real?.id ?? 0);
        if ((item.op ?? 'send') === 'send' && serverId > 0 && wire) {
          // SERVER_ACCEPTED → hold the row until the recipient actually has the
          // message. This is the only copy that can recover an undelivered
          // message once the server body is reclaimed.
          //
          // Swap the payload: keep the CIPHERTEXT that was just sent, drop the
          // plaintext. Recovery re-uploads bytes; it never needs the text, and
          // leaving readable text in a row that now lives for days would be a
          // plaintext-at-rest regression created by this feature.
          item.ciphertext = wire;
          item.plaintext = '';
          item.serverId = serverId;
          item.acceptedAt = Date.now();
          item.state = 'SENT';
          item.lastError = null;
          await put(item);
        } else {
          // edit/delete ops mutate an existing message and carry no
          // recoverable payload of their own — nothing to hold on to.
          await drop(item.tempId);
        }
        emit('sent', { tempId: item.tempId, chatId: item.chatId, real });
      } catch (err: any) {
        item.lastError = err?.message ?? 'unknown error';
        if (isPermanent(err?.status)) {
          // "Not sent" — the only case WhatsApp turns a message red. Drop from
          // the queue; the UI keeps a failed bubble with tap-to-retry.
          item.state = 'FAILED';
          await drop(item.tempId);
          emit('failed', { tempId: item.tempId, chatId: item.chatId, error: item.lastError });
          continue;
        }
        // Transient (offline / 5xx / timeout) or WAITING_KEYS → clock stays,
        // retry forever. attempts only drives the backoff cadence, never a fail.
        item.state = isKeysError(item.lastError) ? 'WAITING_KEYS' : 'QUEUED';
        item.attempts++;
        await put(item);                      // same row, updated attempt count
        emit('retry', { tempId: item.tempId, chatId: item.chatId, attempt: item.attempts });
        remaining.push(item);
      }
    }

    // Page bookkeeping: anything that drained shrinks the queue under us, so go
    // back to the head. A full page where NOTHING drained is wedged — step past
    // it. Anything else means we've seen the tail, so start over next pass.
    const drained = q.length - remaining.length - inert;
    if (drained > 0 || q.length < PAGE) pageOffset = 0;
    else pageOffset += PAGE;

    // Backoff off the worst attempt (all remaining items have attempts ≥ 1),
    // capped at 60s then held — the periodic + reconnect flush keep it alive.
    // A full page that ALL drained means there may be more behind it: come
    // straight back for the next page instead of waiting for the 30 s tick.
    if (remaining.length > 0) {
      scheduleFlush(BACKOFF_MS[Math.min(Math.max(...remaining.map(m => m.attempts)) - 1, BACKOFF_MS.length - 1)]);
    } else if (q.length >= PAGE) {
      scheduleFlush(0);
    }
  } finally {
    flushing = false;
  }
  // Recovery runs AFTER sending, outside the flushing guard, and never blocks
  // it. Queued messages are what the user is waiting on; re-bodying one the
  // server already accepted is strictly less urgent.
  await reBodyAwaiting().catch(() => {});
}

// ─── Auto-flush on reconnect + periodic safety net ────────────

let initialized = false;
let online = true;   // P1.4: track connectivity so the periodic safety-net can no-op while offline.
export function initQueue() {
  if (initialized) return;
  initialized = true;

  // Lift any queue an older build left in AsyncStorage into SQLite, THEN drain.
  // No-op after the first run (the legacy key is removed once the rows commit).
  const migrated = queueMigrate('msg', LEGACY_KEY, (m: QueuedMessage) => m.tempId,
    (m: QueuedMessage) => m.createdAt, (m: QueuedMessage) => m.chatId).catch(() => 0);

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

  // Initial drain on app boot — after the migration, so a legacy item isn't
  // left sitting until the next reconnect.
  migrated.then(() => flush()).catch(() => {});
}

// Default export to silence expo-router's route warning
export default {};
