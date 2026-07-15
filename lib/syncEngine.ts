// lib/syncEngine.ts — forward catch-up (Phase 2).
//
// On every reconnect, pull everything missed while offline in ONE global ordered
// pass (GET /chats/delta), decrypt-once, and cache — including chats the client
// never knew existed. Complements historySync (backward scroll-back) and the
// live socket stream. All applies are idempotent (upsert by message id), so
// running alongside live events can't dup or reorder.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import { getGlobalSyncCursor, cacheMessages } from './localDb';
import { hydrateMessages, type Message } from './chatService';
import { markDeliveredDurable } from './receipts';
import { notifyBatch } from './messageNotifications';
import { onConnectionState } from './socket';

// Timestamp cursor for edits/deletes (they mutate a row in place, so the id
// cursor can't see them). Seeded on the first catch-up from the server's clock;
// afterwards we pull only mutations newer than this.
const MUT_KEY = 'vc_mutated_since_v1';

// Re-scan the last few ids each reconnect so a message that committed just after
// our cursor (bigserial commit-order window) isn't skipped. Idempotent re-apply.
const LOOKBACK = 25;
const PAGE = 200;

interface Delta { messages: (Message & { chatId: string })[]; nextSince: number; more: boolean; mutations?: (Message & { chatId: string })[]; serverTime?: string }

let running = false;

// Group caught-up rows by chat, decrypt once, cache. Reused for new messages and
// for mutations (edited/deleted rows carry the same shape).
async function applyByChat(rows: (Message & { chatId: string })[]): Promise<Map<string, Message[]>> {
  const byChat = new Map<string, Message[]>();
  for (const m of rows) { const c = (m as any).chatId; if (!c) continue; const a = byChat.get(c) ?? []; a.push(m); byChat.set(c, a); }
  for (const [chatId, list] of byChat) {
    const hydrated = await hydrateMessages(chatId, list);
    await cacheMessages(chatId, hydrated);   // upsert by id → edits overwrite, deletes tombstone
  }
  return byChat;
}

/** Drain the global delta from (cursor − lookback) to head. Returns #applied. */
export async function catchUp(): Promise<number> {
  if (running) return 0;
  running = true;
  let applied = 0;
  try {
    let since = Math.max(0, (await getGlobalSyncCursor()) - LOOKBACK);
    const mutatedSince = await AsyncStorage.getItem(MUT_KEY);   // null on first-ever sync
    for (let guard = 0; guard < 100; guard++) { // hard cap: 100 * 200 = 20k msgs/run
      // Ask for mutations only on the FIRST page (they aren't id-paginated).
      const mutParam = (guard === 0 && mutatedSince) ? `&mutatedSince=${encodeURIComponent(mutatedSince)}` : '';
      const r = await api<Delta>(`/chats/delta?since=${since}&limit=${PAGE}${mutParam}`);

      // Edits/deletes to old messages — apply in place (no receipt/notify).
      if (guard === 0 && r?.mutations?.length) await applyByChat(r.mutations);
      // Advance the mutation cursor to the server clock (seeds it the first time).
      if (guard === 0 && r?.serverTime) await AsyncStorage.setItem(MUT_KEY, r.serverTime).catch(() => {});

      const msgs = r?.messages ?? [];
      if (msgs.length === 0) break;
      const byChat = await applyByChat(msgs);
      for (const [chatId, list] of byChat) {
        // WhatsApp: delivered (✓✓) fires the moment the device HAS the message,
        // not when the user opens the chat. Batch-ack the caught-up messages so
        // the sender's double-tick lands immediately on our reconnect.
        const maxId = Math.max(0, ...list.map((m) => Number(m.id)).filter(Number.isFinite));
        if (maxId > 0) markDeliveredDurable(chatId, maxId).catch(() => {});
        // No-GMS: a catch-up that ran in the background (foreground-service
        // connection) is our only chance to tell the user. Gated internally so
        // it no-ops on push-capable devices and while the app is foregrounded.
        notifyBatch(chatId, list as any).catch(() => {});
      }
      applied += msgs.length;
      since = r.nextSince;
      if (!r.more) break;
    }
  } catch { /* offline / transient — next reconnect retries */ }
  finally { running = false; }
  return applied;
}

let armed = false;
/** Wire catch-up to run on every ONLINE transition. Call once at app boot. */
export function initSync(): void {
  if (armed) return;
  armed = true;
  onConnectionState((s) => { if (s === 'ONLINE') catchUp().catch(() => {}); });
}

export default {};
