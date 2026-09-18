// lib/syncEngine.ts — forward catch-up (Phase 2).
//
// On every reconnect, pull everything missed while offline in ONE global ordered
// pass (GET /chats/delta), decrypt-once, and cache — including chats the client
// never knew existed. Complements on-demand scroll-back (chat.tsx onEndReached)
// and the live socket stream. All applies are idempotent (upsert by message id), so
// running alongside live events can't dup or reorder.

import { api, getAccessToken } from './api';
import { tokenSubject } from './tokenIdentity';
import { getGlobalSyncCursor, noteGlobalSyncCursor, cacheMessages, getCachedMessagesByIds, getMeta, setMeta } from './localDb';
import { metric } from './syncMetrics';
import { hydrateMessages, looksEncrypted, type Message } from './chatService';
import { normalizeMsgIds } from './msgIds';
import { markDeliveredDurable } from './receipts';
import { notifyBatch } from './messageNotifications';
import { addPersistentListener, onConnectionState } from './socket';

// Timestamp cursor for edits/deletes (they mutate a row in place, so the id
// cursor can't see them). Seeded on the first catch-up from the server's clock;
// afterwards we pull only mutations newer than this. Lives in localDb's kv
// table next to the id cursor it pairs with, so wiping the cache on logout
// can't leave a stale mutation cursor pointing past rows we no longer have.
const MUT_KEY = 'vc_mutated_since_v1';
const COLD_KEY = 'vc_sync_continuation_v1';

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

interface Delta { messages: (Message & { chatId: string })[]; nextSince: number; more: boolean; syncContinuation?: string; mutations?: (Message & { chatId: string })[]; nextMutationCursor?: string; serverTime?: string }

interface SyncResult { applied: number; error?: unknown }
let inflight: Promise<SyncResult> | null = null;
let ordinaryInflight: Promise<number> | null = null;
let rerunRequested = false;

// Group caught-up rows by chat, decrypt once, cache. Reused for new messages and
// for mutations (edited/deleted rows carry the same shape).
async function applyByChat(rows: (Message & { chatId: string })[], owner: string): Promise<Map<string, Message[]>> {
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
      // ONE UNDECRYPTABLE MESSAGE MUST NOT DISCARD THE PAGE.
      //
      // hydrateMessages is try/FINALLY with no catch, so a decrypt that throws
      // propagates out of here, past cacheMessages (which then never runs), and
      // into catchUp's "offline / transient" catch. The whole page is dropped:
      // nothing stored, no delivery ack, the cursor never advances - and because
      // the same page is re-fetched on every reconnect, it fails again forever.
      // One message the device cannot open silently blocks catch-up for the
      // ENTIRE account, which is how a chat sits at delivered=6 with messages 7
      // and 8 retained and eligible on the server.
      //
      // Falling back to the RAW rows keeps the envelope. That is deliberately
      // "stored", not "displayable": cacheMessages persists the ciphertext, the
      // bubble renders its locked state, and app/chat.tsx's bounded retry can
      // open it once the key situation resolves. Storing it is also what makes
      // the delivery ack honest - the device really does hold the message.
      let hydrated: typeof todo;
      try {
        // Hydration walks newest-first input backwards. Delta rows arrive ASC,
        // and mutation pages are timestamp-ordered, so normalize this boundary.
        hydrated = await hydrateMessages(chatId, [...todo].sort((a, b) => b.id - a.id));
      } catch {
        metric('delta.hydrate_failed', todo.length);
        hydrated = todo;
      }
      if (tokenSubject(await getAccessToken()) !== owner) throw new Error('Sync account changed');
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

/**
 * A delta page that could not be turned into domain rows.
 *
 * TYPED and BOUNDED on purpose. It names the array and the index, and NOTHING
 * from the row: ids, ciphertext and meta are the payload this app exists to
 * keep private, and a decode failure is exactly when someone is tempted to log
 * "the bad value". The index is enough to correlate with a server-side trace.
 *
 * Throwing is the whole point. Filtering the row out would make a corrupt page
 * look like a shorter valid one, and runCatchUp would then ack, advance the
 * cursor past it and never fetch it again — silent, permanent message loss.
 * Rejecting makes a bad body look exactly like a failed fetch, which this
 * engine already handles by keeping the cache and re-fetching from the
 * unmoved cursor on the next reconnect.
 */
export class DeltaDecodeError extends Error {
  constructor(readonly field: 'messages' | 'mutations', readonly index: number, readonly reason: string) {
    super(`delta ${field}[${index}] rejected: ${reason}`);
    this.name = 'DeltaDecodeError';
  }
}

// meta rides as EXACT JSON bytes (see THE `meta` DECISION in chats_delta.proto).
// `fatal: true` so invalid UTF-8 rejects instead of decoding to U+FFFD and
// silently corrupting an attachment id — precedent: lib/ccwire/codec.ts.
//
// Built on first use, not at module scope: lib/syncEngine.mutations.selftest.ts
// and lib/syncEngine.hydrateFailure.selftest.ts evaluate this module's source
// inside a bare `vm.runInNewContext` sandbox that has no TextDecoder, and a
// module-scope `new TextDecoder()` makes those suites throw on import.
let META_UTF8: TextDecoder | null = null;

/**
 * Binary `DeltaReply` -> the SAME `Delta` object the JSON path produces.
 *
 * Passing this to api() only OFFERS protobuf (Batch C pattern, mirrors
 * chatService.decodeChatList). A server that answers JSON — every deployed one
 * until the Go half ships — is parsed by the unchanged path inside api(), with
 * no second request and no behaviour change here.
 *
 * The ENTIRE page is decoded and validated before it is returned, so api()
 * hands runCatchUp either a complete usable page or an error. No partial page
 * can reach applyByChat, the ack batch, or the cursor.
 */
async function decodeDelta(bytes: Uint8Array): Promise<Delta> {
  // No `.js` suffix: Metro cannot resolve one, and tsc will not catch it.
  //
  // startupMessage is imported here rather than at module scope for the same
  // reason: lib/syncEngine.delta.selftest.ts copies this file into a temp dir
  // and rewrites every top-level import to a stub, and an unstubbed one is a
  // hard failure there. The whole CC-Wire boundary staying lazy also keeps it
  // off the cold-start import graph, which is where it belongs.
  const [{ DeltaReply }, { startupMessage }] = await Promise.all([
    import('./ccwire/gen/ccwire/v1/chats_delta_pb'),
    import('./ccwire/startupAdapter'),
  ]);
  const reply = DeltaReply.fromBinary(bytes);
  META_UTF8 ??= new TextDecoder('utf-8', { fatal: true });

  const rows = (list: typeof reply.messages, field: 'messages' | 'mutations') =>
    list.map((m, i): Message & { chatId: string } => {
      let meta: any = null;
      if (m.metaJson !== undefined) {
        try { meta = JSON.parse(META_UTF8!.decode(m.metaJson)); }
        catch { throw new DeltaDecodeError(field, i, 'meta is not JSON'); }
      }
      // THE BATCH A NORMALISATION, APPLIED HERE — before anything numeric.
      // syncEngine filters `typeof id === 'number'` (applyByChat) and sorts
      // `b.id - a.id` (hydration); a string or bigint at either is silent loss
      // or a hard TypeError inside a try/finally with no catch.
      const row = startupMessage({
        id:        m.id,
        chatId:    m.chatId,
        senderId:  m.senderId,
        type:      m.type as Message['type'],
        // JSON emits an explicit null for every nullable column (no omitempty
        // on chatsPublicMsg), so absence becomes null here, not undefined —
        // the cached row must keep the shape older builds wrote.
        content:   m.content ?? null,
        meta,
        replyToId: m.replyToId,
        editedAt:  m.editedAt ?? null,
        deletedAt: m.deletedAt ?? null,
        createdAt: m.createdAt,
        expiresAt: m.expiresAt ?? null,
        vanishAfterRead: m.vanishAfterRead,
      });
      if (!row) throw new DeltaDecodeError(field, i, 'unusable id or chatId');
      return row as Message & { chatId: string };
    });

  return {
    messages: rows(reply.messages, 'messages'),
    mutations: rows(reply.mutations, 'mutations'),
    // JSON emits nextSince as a NUMBER; the wire carries JS_STRING so it can
    // never arrive as a lossy double. Coerced here only to match the JSON
    // shape — the value is still validated by the isSafeInteger gate below,
    // which is what actually protects the durable high-water mark.
    nextSince: Number(reply.nextSince),
    more: reply.more,
    // Opaque tokens. '' means "none" on both paths, and both are consumed with
    // `|| null` / `||` below, so '' and undefined are indistinguishable there.
    syncContinuation: reply.syncContinuation,
    nextMutationCursor: reply.nextMutationCursor,
    serverTime: reply.serverTime,
  };
}

// Send both parameters during a rolling upgrade. Older servers ignore the
// keyset token but still receive a usable timestamp, including its boundary.
function mutationParams(cursor: string | null): string {
  if (!cursor) return '';
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return `&mutatedSince=${encodeURIComponent(cursor)}`;
  const fallback = new Date(Date.parse(cursor.slice(0, sep)) - 1).toISOString();
  return `&mutationCursor=${encodeURIComponent(cursor)}&mutatedSince=${encodeURIComponent(fallback)}`;
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
  if (!inflight) {
    inflight = drainRequestedSync();
    ordinaryInflight = inflight.then((result) => result.applied);
  }
  return ordinaryInflight!;
}

/** Protocol resync requires a fresh, fully persisted drain, not a best-effort
 * cache read. Share the work but keep failure attached to this exact flight. */
export function resyncRequired(): Promise<void> {
  if (inflight) rerunRequested = true;
  catchUp();
  return inflight!.then((result) => {
    if ('error' in result) throw result.error;
  });
}

/** A new event may postdate the in-flight response snapshot. Drain again before
 * resolving its waiters; ordinary cache readers can still just join catchUp. */
export function requestCatchUp(): Promise<number> {
  if (inflight) rerunRequested = true;
  return catchUp();
}

async function drainRequestedSync(): Promise<SyncResult> {
  const result: SyncResult = { applied: 0 };
  try {
    do {
      rerunRequested = false;
      const pass = await runCatchUp();
      result.applied += pass.applied;
      if ('error' in pass) result.error = pass.error;
    } while (rerunRequested);
    return result;
  } finally {
    inflight = null;
    ordinaryInflight = null;
  }
}

async function runCatchUp(): Promise<SyncResult> {
  let applied = 0;
  try {
    const owner = tokenSubject(await getAccessToken());
    if (!owner) throw new Error('Sync requires an authenticated account');
    let since = Math.max(0, (await getGlobalSyncCursor()) - LOOKBACK);
    const sinceOrig = since;   // mutation pages keep the original id window
    const mutatedSince = await getMeta(MUT_KEY);   // null on first-ever sync
    let syncContinuation = (await getMeta(COLD_KEY)) || null;
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      // Ask for mutations only on the FIRST page (they're time-, not id-paginated).
      const mutParam = guard === 0 ? mutationParams(mutatedSince) : '';
      metric(since === 0 ? 'cold_sync.requests' : 'delta.requests');
      const coldParam = syncContinuation
        ? `&syncContinuation=${encodeURIComponent(syncContinuation)}` : '';
      const r = normDelta(await api<Delta>(`/chats/delta?since=${since}&limit=${PAGE}${mutParam}${coldParam}`, { expectedUserId: owner, proto: decodeDelta }));
      if (tokenSubject(await getAccessToken()) !== owner) throw new Error('Sync account changed');
      metric(since === 0 ? 'cold_sync.rows' : 'delta.rows', r?.messages?.length ?? 0);

      if (guard === 0) {
        let mutationPage = r;
        let cursor = mutatedSince;
        for (let mp = 0; mp < MAX_MUT_PAGES; mp++) {
          const muts = mutationPage?.mutations ?? [];
          await applyByChat(muts, owner);
          const maxTs = maxMutationTs(muts);
          // Older servers cannot page timestamp ties. Re-read the boundary
          // rather than skip it; stop if that server cannot make progress.
          const next = mutationPage?.nextMutationCursor || (maxTs
            ? new Date(Date.parse(maxTs) - 1).toISOString()
            : cursor || mutationPage?.serverTime);
          const progressed = next && next !== cursor;
          if (progressed) {
            await setMeta(MUT_KEY, next);
            cursor = next;
          }
          if (muts.length < MUT_PAGE || !progressed) break;
          if (mp === MAX_MUT_PAGES - 1) {
            throw new Error('Mutation sync page cap reached');
          }
          mutationPage = normDelta(await api<Delta>(`/chats/delta?since=${sinceOrig}&limit=1${mutationParams(cursor)}`, { expectedUserId: owner, proto: decodeDelta }));
          if (tokenSubject(await getAccessToken()) !== owner) throw new Error('Sync account changed');
        }
      }

      const msgs = r?.messages ?? [];
      if (msgs.length === 0) {
        // A page with exactly PAGE rows is conservatively marked `more` by
        // older servers. Its follow-up is empty; clear the cold continuation
        // here or every later catch-up remains under the cold-history filter.
        if (r && syncContinuation && !r.syncContinuation) {
          syncContinuation = null;
          await setMeta(COLD_KEY, '');
        }
        break;
      }
      const byChat = await applyByChat(msgs, owner);
      for (const [chatId, list] of byChat) {
        // WhatsApp: delivered (✓✓) fires the moment the device HAS the message,
        // not when the user opens the chat. Batch-ack the caught-up messages so
        // the sender's double-tick lands immediately on our reconnect.
        const maxId = Math.max(0, ...list.map((m) => Number(m.id)).filter(Number.isFinite));
        if (maxId > 0) markDeliveredDurable(chatId, maxId, owner).catch(() => {});
        // No-GMS: a catch-up that ran in the background (foreground-service
        // connection) is our only chance to tell the user. Gated internally so
        // it no-ops on push-capable devices and while the app is foregrounded.
        notifyBatch(chatId, list as any).catch(() => {});
      }
      applied += msgs.length;
      const nextSince = Number(r.nextSince);
      // isSafeInteger, not isFinite. This is a trust-boundary value from the
      // network, and `Number()` + `isFinite` is not validation — proven against
      // real SQLite in lib/syncCursorRegression.selftest.ts §6:
      //
      //   '123.5'             -> passed, wrote a FRACTIONAL durable cursor, and
      //                          the next request became `?since=123.4`
      //   '9007199254740995'  -> rounded UP to ...996, moving the high-water
      //                          mark PAST an id that was never delivered. The
      //                          mark is monotonic and survives deletion, so
      //                          that message is skipped permanently, on every
      //                          future launch.
      //   1e21                -> wrote an absurd mark that suppresses every
      //                          future delta row, silently, forever.
      //
      // `nextSince <= since` does not catch the rounding case because it rounds
      // FORWARD, and noteGlobalSyncCursor's `id > 0` does not either. Only the
      // integer check closes it. No legitimate page is affected: a BIGSERIAL id
      // is always a safe integer here.
      if (!Number.isSafeInteger(nextSince) || nextSince <= since) {
        throw new Error('Message sync cursor did not advance');
      }
      since = nextSince;
      // Keep the opaque cold policy before advancing its numeric cursor. A
      // crash between these writes can replay a page, but cannot widen it.
      syncContinuation = r.syncContinuation || null;
      await setMeta(COLD_KEY, syncContinuation ?? '');
      // Persist the high-water mark. Without this the cursor is re-derived from
      // MAX(id) of cached rows, so deleting messages (Clear chat, cache trim)
      // rewinds sync and re-downloads what was just removed.
      // `nextSince`, not `r.nextSince`. The coerced local is validated three
      // lines up; the raw field is whatever the server sent. They are the same
      // today only because the Go handler emits nextSince as a JSON number.
      //
      // noteGlobalSyncCursor gates on Number.isFinite (localDb.ts:1157), which
      // is FALSE for a string — so a string here makes the durable high-water
      // write a silent permanent no-op, and sync re-derives from MAX(id) on
      // every launch instead. The CC-Wire cursor proxy's own fixtures already
      // carry nextSince as a string, so this is one representation change away
      // from firing. Passing the validated local closes it for good.
      await noteGlobalSyncCursor(nextSince);
      if (!r.more) break;
      if (guard === MAX_PAGES - 1) {
        // The cursor and cold-policy token above are already durable. Yield to
        // rendering, then continue from that checkpoint in a fresh bounded
        // pass. An exact 100k backlog used to fail here even though all 500
        // pages had been stored successfully.
        metric('delta.page_cap_yields');
        rerunRequested = true;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        break;
      }
    }
  } catch (error) { return { applied, error }; }
  return { applied };
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
let liveSyncTimer: ReturnType<typeof setTimeout> | null = null;
const LIVE_SYNC_DEBOUNCE_MS = 250;

/**
 * A socket event can arrive while no ChatScreen is mounted (for example while
 * the user is on the chat list). In that state the per-screen new_message
 * listener does not exist, so schedule the authoritative delta pull here.
 * Coalescing a burst avoids one request per event while retaining prompt
 * foreground delivery.
 */
function scheduleLiveCatchUp(): void {
  if (liveSyncTimer) return;
  liveSyncTimer = setTimeout(() => {
    liveSyncTimer = null;
    requestCatchUp().catch(() => {});
  }, LIVE_SYNC_DEBOUNCE_MS);
}

/** Wire catch-up to run on every ONLINE transition. Call once at app boot. */
export function initSync(): void {
  if (armed) return;
  armed = true;
  onConnectionState((s) => { if (s === 'ONLINE') requestCatchUp().catch(() => {}); });
  // The per-chat listener is only mounted while a thread is open. Keep this
  // app-global listener across socket reconnects so a message arriving on the
  // chat list is fetched, cached and shown when that chat is opened.
  for (const event of ['new_message', 'message_edited', 'message_deleted']) {
    addPersistentListener(event, scheduleLiveCatchUp);
  }
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
  // Resume can postdate an in-flight response, so request a follow-up pass
  // while sharing the existing drain with ONLINE and push callers.
  try {
    const { AppState } = require('react-native');
    AppState.addEventListener('change', (s: string) => {
      if (s !== 'active') return;
      if (Date.now() - lastResumeSync < RESUME_MIN_GAP_MS) return;
      lastResumeSync = Date.now();
      requestCatchUp().catch(() => {});
    });
  } catch { /* non-RN (selftest under node) — the ONLINE hook is enough */ }
}

export default {};
