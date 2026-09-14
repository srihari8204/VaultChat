// lib/syncEngine.ts — forward catch-up (Phase 2).
//
// On every reconnect, pull everything missed while offline in ONE global ordered
// pass (GET /chats/delta), decrypt-once, and cache — including chats the client
// never knew existed. Complements on-demand scroll-back (chat.tsx onEndReached)
// and the live socket stream. All applies are idempotent (upsert by message id), so
// running alongside live events can't dup or reorder.

import { api } from './api';
import { getGlobalSyncCursor, noteGlobalSyncCursor, cacheMessages, getCachedMessagesByIds, getMeta, setMeta } from './localDb';
import { metric } from './syncMetrics';
import { hydrateMessages, looksEncrypted, type Message } from './chatService';
import { normalizeMsgIds } from './msgIds';
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

let inflight: Promise<number> | null = null;

// Group caught-up rows by chat, decrypt once, cache. Reused for new messages and
// for mutations (edited/deleted rows carry the same shape).
async function applyByChat(rows: (Message & { chatId: string })[]): Promise<Map<string, Message[]>> {
  const byChat = new Map<string, Message[]>();
  for (const m of rows) { const c = (m as any).chatId; if (!c) continue; const a = byChat.get(c) ?? []; a.push(m); byChat.set(c, a); }
  for (const [chatId, list] of byChat) {
    // Decrypt only what this device has NOT already stored as readable text.
    //
    // `since` deliberately rewinds by LOOKBACK, so every catch-up re-delivers
    // rows that were decrypted on a previous run. Re-hydrating them repeats the
    // full ratchet work — and for history whose keys are gone it repeats a
    // decrypt that CANNOT succeed, every single launch. Measured on device: 72
    // such messages re-processed at each boot, with 0.5–0.9s gaps between them,
    // while the user watched a white screen.
    //
    // Rows still needing work (never seen, or cached as an unopened envelope)
    // are hydrated exactly as before, so nothing is skipped that has a chance
    // of becoming readable.
    let todo = list;
    try {
      const ids = list.map(m => m.id).filter(id => typeof id === 'number' && id > 0);
      if (ids.length) {
        const known = await getCachedMessagesByIds(chatId, ids);
        const readable = new Set(
          known.filter(m => m.content != null && !looksEncrypted(m.content)).map(m => m.id),
        );
        // …but a MUTATION row must always be applied. An edited or revoked
        // message still carries readable plaintext, so it landed in `readable`,
        // `todo` came back empty, and cacheMessages never ran — the delete was
        // dropped on the floor and the message came back on the next open,
        // still in the search index and still in the chat-list preview.
        // Re-hydrating these is cheap: they are a handful of rows, not history.
        if (readable.size) {
          todo = list.filter(m => !readable.has(m.id) || m.editedAt || m.deletedAt);
          // Rows the server re-sent that this device had already decrypted.
          metric('delta.duplicates', list.length - todo.length);
        }
      }
    } catch { /* cache unavailable → hydrate everything, as before */ }

    if (todo.length) {
      metric('delta.decrypts', todo.length);
      const hydrated = await hydrateMessages(chatId, todo);
      await cacheMessages(chatId, hydrated);   // upsert by id → edits overwrite, deletes tombstone
    }
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

/**
 * Coerce a delta page's wire ids to numbers.
 *
 * `/chats/delta` serializes `id`/`replyToId` as STRINGS like every other
 * endpoint, and everything downstream of here is number-keyed: `cacheMessages`
 * skips a row whose id is not a number, so an un-normalized page decrypted
 * fine, rendered fine, and then persisted NOTHING — the history was gone on the
 * next cold start. Both arrays go through it; mutations are message rows too.
 */
function normDelta(d: Delta | null | undefined): Delta | null | undefined {
  d?.messages?.forEach(normalizeMsgIds);
  d?.mutations?.forEach(normalizeMsgIds);
  return d;
}

/** Drain the global delta from (cursor − lookback) to head. Returns #applied. */
// COALESCE on the in-flight run; do NOT return early.
//
// Callers await this to mean "the delta has landed". The old guard returned 0
// immediately while a run was in flight, which is a different promise: on an
// AppState resume, initSync's listener starts a run and synchronously takes
// the flag, so app/chat.tsx's top-up then awaited a no-op and re-read the
// cache BEFORE the round trip had written anything. The chat was already
// focused, so no later focus event existed to retry, and the message the user
// had just been notified about still did not appear.
//
// Sharing the promise keeps the single-flight property that guard was for
// while making the await mean what every caller reads it as.
export function catchUp(): Promise<number> {
  if (!inflight) inflight = runCatchUp().finally(() => { inflight = null; });
  return inflight;
}

async function runCatchUp(): Promise<number> {
  let applied = 0;
  try {
    let since = Math.max(0, (await getGlobalSyncCursor()) - LOOKBACK);
    const sinceOrig = since;   // mutation pages keep the original id window
    const mutatedSince = await getMeta(MUT_KEY);   // null on first-ever sync
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      // Ask for mutations only on the FIRST page (they're time-, not id-paginated).
      const mutParam = (guard === 0 && mutatedSince) ? `&mutatedSince=${encodeURIComponent(mutatedSince)}` : '';
      metric(since === 0 ? 'cold_sync.requests' : 'delta.requests');
      const r = normDelta(await api<Delta>(`/chats/delta?since=${since}&limit=${PAGE}${mutParam}`));
      metric(since === 0 ? 'cold_sync.rows' : 'delta.rows', r?.messages?.length ?? 0);

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
          const rm = normDelta(await api<Delta>(`/chats/delta?since=${sinceOrig}&limit=1&mutatedSince=${encodeURIComponent(cursor)}`));
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
      // Persist the high-water mark. Without this the cursor is re-derived from
      // MAX(id) of cached rows, so deleting messages (Clear chat, cache trim)
      // rewinds sync and re-downloads what was just removed.
      await noteGlobalSyncCursor(r.nextSince).catch(() => {});
      if (!r.more) break;
      if (guard === MAX_PAGES - 1) console.warn(`[sync] catch-up hit ${MAX_PAGES}-page cap after ${applied} msgs — resuming next reconnect`);
    }
  } catch { /* offline / transient — next reconnect retries */ }
  return applied;
}

// Minimum gap between AppState-triggered runs.
//
// On Android 'active' fires on return from the image picker, the document
// picker, the camera, the share sheet, an OS permission dialog and the
// biometric prompt - all of which the chat screen itself invokes. Attaching
// three photos in a row would otherwise be three full delta round trips. The
// ONLINE trigger is deliberately NOT throttled: a reconnect is exactly when a
// catch-up is worth paying for.
const RESUME_MIN_GAP_MS = 5000;
let lastResumeSync = 0;

let armed = false;
/** Wire catch-up to run on every ONLINE transition. Call once at app boot. */
export function initSync(): void {
  if (armed) return;
  armed = true;
  onConnectionState((s) => { if (s === 'ONLINE') catchUp().catch(() => {}); });
  // AppState is a SECOND trigger, not a duplicate of the one above.
  //
  // ONLINE only fires on a TRANSITION. A device that was backgrounded with a
  // live socket, or that got its message by FCM push while the socket was
  // parked, can come back to the foreground without the connection state ever
  // changing — so nothing pulled the delta, and messages received while away
  // were never fetched. app/chat.tsx only queries the server when its cache is
  // EMPTY, so for any chat with history those messages appeared nowhere: the
  // push notification had already fired, and opening the chat showed the old
  // cache. Their ids also stayed above the read cursor, which is why the
  // unread badge could not be cleared by reading.
  //
  // catchUp() COALESCES on the in-flight run rather than dropping the call, so
  // overlapping with the ONLINE path joins that run instead of starting a
  // second one - and an awaiting caller still waits for real work.
  try {
    const { AppState } = require('react-native');
    AppState.addEventListener('change', (s: string) => {
      if (s !== 'active') return;
      if (Date.now() - lastResumeSync < RESUME_MIN_GAP_MS) return;
      lastResumeSync = Date.now();
      catchUp().catch(() => {});
    });
  } catch { /* non-RN (selftest under node) — the ONLINE hook is enough */ }
}

export default {};
