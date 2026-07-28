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

let flushing = false;
/** Send every un-acked pointer (one call per chat). Un-acked stay for next flush. */
export async function flush(): Promise<void> {
  if (flushing) return; flushing = true;
  try {
    await load();
    for (const [chatId, p] of state) {
      if (p.delivered > p.ackedDelivered) {
        try { await markDelivered(chatId, p.delivered); p.ackedDelivered = p.delivered; persistSoon(); } catch {}
      }
      if (p.read > p.ackedRead) {
        try { await markRead(chatId, p.read); p.ackedRead = p.read; persistSoon(); } catch {}
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
