// lib/receipts.ts — durable read/delivered receipts (Phase 3, WhatsApp parity).
//
// markRead/markDelivered were fire-once: read a chat offline → the receipt was
// dropped → the sender's ✓✓/blue tick never arrived. This records the highest
// read + delivered message id per chat, sends it coalesced (ONE call per chat,
// not per message — that's the "batching" 3.5 wants), and re-flushes any un-acked
// pointer on every reconnect. Pointers are monotonic + the server sets them
// idempotently, so re-sending is always safe.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { markRead, markDelivered } from './chatService';
import { onConnectionState } from './socket';

const KEY = 'vc_receipts_v1';
interface Ptr { read: number; delivered: number; ackedRead: number; ackedDelivered: number }
const state = new Map<string, Ptr>();
const get = (chatId: string): Ptr => {
  let p = state.get(chatId);
  if (!p) { p = { read: 0, delivered: 0, ackedRead: 0, ackedDelivered: 0 }; state.set(chatId, p); }
  return p;
};

let loaded = false;
async function load(): Promise<void> {
  if (loaded) return; loaded = true;
  try { const raw = await AsyncStorage.getItem(KEY); if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) state.set(k, v as Ptr); } catch {}
}
let saveT: any = null;
function persistSoon() {
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; AsyncStorage.setItem(KEY, JSON.stringify(Object.fromEntries(state))).catch(() => {}); }, 800);
}

let flushT: any = null;
function flushSoon() { if (flushT) return; flushT = setTimeout(() => { flushT = null; flush(); }, 300); }

/** Record that everything up to `msgId` is read in this chat. Coalesced + durable. */
export async function markReadDurable(chatId: string, msgId: number): Promise<void> {
  await load();
  const p = get(chatId);
  if (msgId > p.read) { p.read = msgId; persistSoon(); flushSoon(); }
}
/** Record that everything up to `msgId` is delivered to this device. */
export async function markDeliveredDurable(chatId: string, msgId: number): Promise<void> {
  await load();
  const p = get(chatId);
  if (msgId > p.delivered) { p.delivered = msgId; persistSoon(); flushSoon(); }
}

/**
 * A POINTER THE SERVER WILL NEVER ACCEPT IS PERMANENT, NOT TRANSIENT.
 *
 * These pointers are monotonic and PERSISTED: nothing ever lowers them. The
 * server now validates the cursor and answers 400 ("lastReadMessageId is not a
 * message in this chat") for one that belongs elsewhere. Swallowing that — the
 * bare `catch {}` this replaces — meant a single bad id (a foreign message id
 * written by any client bug) wedged the chat forever, across restarts: the
 * unread badge could never clear, read receipts never reached the peer, and
 * lib/messageNotifications' markSeen, which has the identical monotonic shape,
 * stopped too.
 *
 * So a rejection un-does the raise: drop back to the last value the server
 * actually acked, persist, and let the next genuine read re-advance it from a
 * known-good base. Everything without an HTTP status — offline, DNS, abort —
 * and every 5xx still falls through to the unchanged retry-forever path.
 *
 * `p.read === sent` guards the window: markReadDurable can raise the pointer to
 * a NEW, valid id while this request is in flight, and that one deserves its own
 * attempt rather than being rolled back with the bad one.
 */
function rejected(e: any): boolean {
  return e?.status === 400;
}

let flushing = false;
/** Send every un-acked pointer (one call per chat). Un-acked stay for next flush. */
export async function flush(): Promise<void> {
  if (flushing) return; flushing = true;
  try {
    await load();
    for (const [chatId, p] of state) {
      if (p.delivered > p.ackedDelivered) {
        const sent = p.delivered;
        try { await markDelivered(chatId, sent); p.ackedDelivered = sent; persistSoon(); }
        catch (e: any) { if (rejected(e) && p.delivered === sent) { p.delivered = p.ackedDelivered; persistSoon(); } }
      }
      if (p.read > p.ackedRead) {
        const sent = p.read;
        try { await markRead(chatId, sent); p.ackedRead = sent; persistSoon(); }
        catch (e: any) { if (rejected(e) && p.read === sent) { p.read = p.ackedRead; persistSoon(); } }
      }
    }
  } finally { flushing = false; }
}

let armed = false;
/** Flush receipts on every reconnect. Call once at boot. */
export function initReceipts(): void {
  if (armed) return; armed = true;
  onConnectionState((s) => { if (s === 'ONLINE') flush(); });
}

export default {};
