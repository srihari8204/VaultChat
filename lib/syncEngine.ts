// lib/syncEngine.ts — forward catch-up (Phase 2).
//
// On every reconnect, pull everything missed while offline in ONE global ordered
// pass (GET /chats/delta), decrypt-once, and cache — including chats the client
// never knew existed. Complements historySync (backward scroll-back) and the
// live socket stream. All applies are idempotent (upsert by message id), so
// running alongside live events can't dup or reorder.

import { api } from './api';
import { getGlobalSyncCursor, cacheMessages, getMeta, setMeta } from './localDb';
import { hydrateMessages, type Message } from './chatService';
import { markDeliveredDurable } from './receipts';
import { notifyBatch } from './messageNotifications';
import { onConnectionState } from './socket';

// Timestamp cursor for edits/deletes (they mutate a row in place, so the id
// cursor can't see them). Seeded on the first catch-up from the server's clock;
// afterwards we pull only mutations newer than this. Lives in localDb's kv
// table next to the id cursor it pairs with, so wiping the cache on logout
// can't leave a stale mutation cursor pointing past rows we no longer have.
const MUT_KEY = 'vc_mutated_since_v1';

// Re-scan the last few ids each reconnect so a message that committed just after
// our cursor (bigserial commit-order window) isn't skipped. Idempotent re-apply.
const LOOKBACK = 25;
const PAGE = 200;
// P4.3: safety guards, not silent caps. The old guard (100 pages = 20k msgs)
// silently stopped mid-catch-up on busy servers — the global BIGSERIAL cursor
// advances with EVERYONE's traffic, so a normal account could blow it after a
// long offline stretch. 500 pages = 100k msgs; the trip is logged so an
// incomplete catch-up is visible instead of silent (next reconnect resumes
// from the persisted cursor either way).
const MAX_PAGES = 500;
const MUT_PAGE = 500;      // server-side LIMIT on the mutation query
const MAX_MUT_PAGES = 20;  // 10k mutations/run, logged when tripped

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

// Latest mutation timestamp in a page (edited_at/deleted_at are JS-style ISO
// strings from the server — same format, so lexicographic max is time max).
function maxMutationTs(rows: (Message & { chatId: string })[]): string | null {
  let max: string | null = null;
  for (const m of rows) {
    for (const ts of [m.editedAt, m.deletedAt]) {
      if (ts && (!max || ts > max)) max = ts;
    }
  }
  return max;
}

/** Drain the global delta from (cursor − lookback) to head. Returns #applied. */
export async function catchUp(): Promise<number> {
  if (running) return 0;
  running = true;
  let applied = 0;
  try {
    let since = Math.max(0, (await getGlobalSyncCursor()) - LOOKBACK);
    const sinceOrig = since;   // mutation pages keep the original id window
    const mutatedSince = await getMeta(MUT_KEY);   // null on first-ever sync
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      // Ask for mutations only on the FIRST page (they're time-, not id-paginated).
      const mutParam = (guard === 0 && mutatedSince) ? `&mutatedSince=${encodeURIComponent(mutatedSince)}` : '';
      const r = await api<Delta>(`/chats/delta?since=${since}&limit=${PAGE}${mutParam}`);

      if (guard === 0) {
        // Edits/deletes to old messages — apply in place (no receipt/notify).
        // P4.3: the server caps each mutation page at 500 and the old code read
        // only ONE page, silently dropping the rest. Drain by advancing the
        // mutatedSince cursor to the newest timestamp applied so far.
        let muts = r?.mutations ?? [];
        let cursor = mutatedSince;
        for (let mp = 0; muts.length > 0; mp++) {
          await applyByChat(muts);
          if (muts.length < MUT_PAGE) break;              // page not full → drained
          if (mp >= MAX_MUT_PAGES) { console.warn('[sync] mutation drain hit page cap — resuming next reconnect'); break; }
          const maxTs = maxMutationTs(muts);
          if (!maxTs) break;
          // Advance strictly so the loop can never re-fetch the same full page
          // forever. Trade-off: if a full page (500) shared ONE identical
          // timestamp, the +1 ms bump skips any further rows at that exact
          // instant — terminating beats spinning, and Postgres NOW() has
          // microsecond resolution, so 500 mutations in one millisecond is not
          // reachable in practice.
          cursor = (cursor && maxTs <= cursor)
            ? new Date(Date.parse(cursor) + 1).toISOString()
            : maxTs;
          const rm = await api<Delta>(`/chats/delta?since=${sinceOrig}&limit=1&mutatedSince=${encodeURIComponent(cursor)}`);
          muts = rm?.mutations ?? [];
        }
        // Advance the stored cursor to the server clock only AFTER the drain —
        // anything mutated during it is newer than serverTime and caught next run.
        if (r?.serverTime) await setMeta(MUT_KEY, r.serverTime).catch(() => {});
      }

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
      if (guard === MAX_PAGES - 1) console.warn(`[sync] catch-up hit ${MAX_PAGES}-page cap after ${applied} msgs — resuming next reconnect`);
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
