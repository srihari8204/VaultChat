// components/chat/useMessagePaging.ts — the chat thread's in-memory window:
// paging older (disk first, then server), paging back toward the newest rows,
// "return to latest", the post-paint prefetch, the MAX_LOADED cap, and the
// jump-to-message used by search, the pinned bar and replies. Moved out of
// app/chat.tsx unchanged. The screen owns every piece of state; this hook only
// holds the callbacks and effects that read and write it, called at the same
// point in the screen so the effects keep their order.

import { useCallback, useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { InteractionManager, type FlatList } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  cacheMessages, getCachedMessages, getCachedMessagesAfter, getCachedMessagesAround,
  getCachedMessagesBefore, hasCachedNewerMessages, hasCachedOlderMessages,
} from '../../lib/localDb';
import { getMessages, hydrateMessages } from '../../lib/chatService';
import { metric } from '../../lib/syncMetrics';
import { resetAlbumCache } from '../../lib/albumGrouping';
import { consumePendingJump } from '../../lib/chatJump';
import type { DisplayMessage } from './chatStyles';

export const INITIAL_PAGE_SIZE = 50;
export const PREFETCH_PAGE_SIZE = 50;
export const SCROLL_PAGE_SIZE = 100;
/**
 * Most messages kept in JS state at once — eight pages.
 *
 * Enough that ordinary scrolling never touches disk, small enough that a chat
 * left open all day does not accumulate every message it has ever shown. Only
 * enforced while the user is at the bottom; see the trim effect below.
 */
export const MAX_LOADED = 400;

type SetS<T> = Dispatch<SetStateAction<T>>;

export function useMessagePaging({
  chatId, chatIdRef, loading, messages, setMessages, messagesRef, hasMore, setHasMore, hasNewer, setHasNewer,
  setNewerGapBeforeId, setLoadingOlder, setLoadingNewer, pagingChatRef, prefetchedChatRef, atBottomRef,
  setShowScrollDown, setNewSinceUp, setFlashId, listRef,
}: {
  chatId: string;
  chatIdRef: MutableRefObject<string>;
  loading: boolean;
  messages: DisplayMessage[];
  setMessages: SetS<DisplayMessage[]>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  hasMore: boolean;
  setHasMore: SetS<boolean>;
  hasNewer: boolean;
  setHasNewer: SetS<boolean>;
  setNewerGapBeforeId: SetS<number | null>;
  setLoadingOlder: SetS<boolean>;
  setLoadingNewer: SetS<boolean>;
  pagingChatRef: MutableRefObject<string | null>;
  prefetchedChatRef: MutableRefObject<string | null>;
  atBottomRef: MutableRefObject<boolean>;
  setShowScrollDown: SetS<boolean>;
  setNewSinceUp: SetS<number>;
  setFlashId: SetS<number | null>;
  listRef: RefObject<FlatList | null>;
}) {
  // ── Load older on scroll-up ───────────────────────────────
  const onEndReached = useCallback(async () => {
    if (pagingChatRef.current || !hasMore || messages.length === 0) return;
    const oldest = messages[messages.length - 1]?.id;
    if (!oldest) return;
    // Same pane-swap hazard as the initial load: chatId can change on a mounted
    // instance while these reads are in flight, and appending the previous
    // chat's page to the one now on screen is worse than not paging at all.
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    pagingChatRef.current = cid;
    prefetchedChatRef.current = cid;
    setLoadingOlder(true);
    try {
      // Disk first. These rows are already plaintext, so a cached page costs no
      // network call and no decrypt — and it works offline, which the
      // server-only path never did. Only past the cache horizon do we ask the
      // server, which is also the only case where hydrate/re-cache is needed.
      let older = await getCachedMessagesBefore(
        cid, Number(oldest), SCROLL_PAGE_SIZE,
      ) as DisplayMessage[];
      metric(older.length ? 'local.message_hits' : 'local.message_misses');

      // A FULL page from disk answered the request: no network, no decrypt.
      // A SHORT page means the cache horizon, not the end of history — so top
      // up from the server rather than ending pagination on a cache boundary.
      //
      // …unless we have paged into imported history (Exit Kit), which carries
      // NEGATIVE ids. The server has no copy of it, so `before=-17559…` would be
      // a guaranteed-empty round-trip on every scroll, and it would put a
      // synthetic local id on the wire. Imported history is the true start of the
      // conversation, so a short page there really is the end.
      const cachedPositiveCount = older.reduce((n, m) => n + (Number(m.id) > 0 ? 1 : 0), 0);
      if (cachedPositiveCount < SCROLL_PAGE_SIZE && Number(oldest) > 0) {
        try {
          const olderRaw = await getMessages(cid, { before: oldest, limit: SCROLL_PAGE_SIZE });
          const fetched = await hydrateMessages(cid, olderRaw);  // decrypt once at ingest
          cacheMessages(cid, fetched).catch(() => {});           // persist for instant scroll-back
          const seen = new Set(older.map(m => String(m.id)));
          older = [...older, ...fetched.filter(m => !seen.has(String(m.id)))]
            .sort((a, b) => Number(b.id) - Number(a.id));
          // Only the SERVER can say there is nothing older. Ending on a short
          // cached page would strand history the device simply had not fetched.
          if (fetched.length < SCROLL_PAGE_SIZE && alive()) {
            const pageOldest = older[older.length - 1]?.id;
            const localMore = pageOldest != null
              ? await hasCachedOlderMessages(cid, Number(pageOldest)).catch(() => false)
              : false;
            if (alive()) setHasMore(localMore);
          }
        } catch {
          // Offline. Whatever the cache gave us still renders, and hasMore is
          // deliberately left alone so a later attempt can resume.
        }
      } else if (older.length < SCROLL_PAGE_SIZE && Number(oldest) < 0) {
        // Inside imported history with nothing older on disk: this is the start
        // of the conversation. Nobody else can tell us so, because nobody else
        // has these messages.
        if (alive()) setHasMore(false);
      }
      if (!alive()) return;
      // Dedupe against what's already loaded — a page boundary can overlap and
      // would otherwise inject duplicate ids (duplicate React keys).
      const currentIds = new Set(messages.map(x => String(x.id)));
      const projected = [...messages, ...older.filter(m => !currentIds.has(String(m.id)))];
      const projectedSettled = projected.filter(m => !m._tempId);
      const trimNewer = projectedSettled.length > MAX_LOADED;
      if (trimNewer) {
        setHasNewer(true);
        setNewerGapBeforeId(projectedSettled[projectedSettled.length - MAX_LOADED]?.id ?? null);
      }
      setMessages(prev => {
        const have = new Set(prev.map(x => String(x.id)));
        const combined = [...prev, ...older.filter(m => !have.has(String(m.id)))];
        const pending = combined.filter(m => m._tempId);
        let settled = combined.filter(m => !m._tempId);
        if (trimNewer && settled.length > MAX_LOADED) {
          // The user is moving into older history. Keep the rows around that
          // viewport and make the discarded newer side pageable again.
          settled = settled.slice(settled.length - MAX_LOADED);
        }
        return [...pending, ...settled];
      });
    } catch {}
    finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
      if (alive()) setLoadingOlder(false);
    }
  }, [chatId, hasMore, messages, chatIdRef, pagingChatRef, prefetchedChatRef, setHasMore, setHasNewer, setLoadingOlder, setMessages, setNewerGapBeforeId]);

  // When an old search window (or an upward-trimmed long thread) is open,
  // page back toward the newest local rows without rebuilding the whole gap.
  const onStartReached = useCallback(async () => {
    if (pagingChatRef.current || !hasNewer || messages.length === 0) return;
    const newest = messages.find(m => !m._tempId)?.id;
    if (newest == null) return;
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    pagingChatRef.current = cid;
    setLoadingNewer(true);
    try {
      const newerAsc = await getCachedMessagesAfter(cid, Number(newest), SCROLL_PAGE_SIZE);
      if (!alive()) return;
      const newer = [...newerAsc].reverse() as DisplayMessage[];
      const nextNewest = newer[0]?.id ?? newest;
      const more = await hasCachedNewerMessages(cid, Number(nextNewest)).catch(() => false);
      if (!alive()) return;
      const currentIds = new Set(messages.filter(m => !m._tempId).map(m => String(m.id)));
      const willTrimOlder = currentIds.size + newer.filter(m => !currentIds.has(String(m.id))).length > MAX_LOADED;
      setMessages(prev => {
        const pending = prev.filter(m => m._tempId);
        const have = new Set(prev.map(m => String(m.id)));
        const settled = [
          ...newer.filter(m => !have.has(String(m.id))),
          ...prev.filter(m => !m._tempId),
        ].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, MAX_LOADED);
        return [...pending, ...settled];
      });
      if (willTrimOlder) setHasMore(true);
      setHasNewer(more);
      setNewerGapBeforeId(more ? Number(nextNewest) : null);
    } catch {
      // Local cache may be temporarily locked; retain the affordance to retry.
    } finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
      if (alive()) setLoadingNewer(false);
    }
  }, [chatId, hasNewer, messages, chatIdRef, pagingChatRef, setHasMore, setHasNewer, setLoadingNewer, setMessages, setNewerGapBeforeId]);

  const returnToLatest = useCallback(async () => {
    if (pagingChatRef.current) return;
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    pagingChatRef.current = cid;
    try {
      const latest = await getCachedMessages(cid, INITIAL_PAGE_SIZE + PREFETCH_PAGE_SIZE) as DisplayMessage[];
      if (!alive()) return;
      const latestId = latest[0]?.id ?? 0;
      setMessages(prev => {
        const pending = prev.filter(m => m._tempId);
        const justArrived = prev.filter(m => !m._tempId && Number(m.id) > Number(latestId));
        const seen = new Set<string>();
        const settled = [...justArrived, ...latest].filter(m => {
          const key = String(m.id);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, MAX_LOADED);
        return [...pending, ...settled];
      });
      const oldest = latest[latest.length - 1]?.id;
      const older = oldest != null
        ? await hasCachedOlderMessages(cid, Number(oldest)).catch(() => false)
        : false;
      if (!alive()) return;
      setHasMore(older || Number(oldest) > 0);
      setHasNewer(false);
      setNewerGapBeforeId(null);
      atBottomRef.current = true;
      setShowScrollDown(false);
      setNewSinceUp(0);
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
    } catch {
      // Keep the return affordance visible so a locked cache can be retried.
    } finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
    }
  }, [chatId, atBottomRef, chatIdRef, listRef, pagingChatRef, setHasMore, setHasNewer, setMessages, setNewSinceUp, setNewerGapBeforeId, setShowScrollDown]);

  // Album row identity is cached by albumId; drop it when the chat changes so a
  // row can never be reused across conversations.
  useEffect(() => { resetAlbumCache(); }, [chatId]);

  // Keep a ref to loaded messages for the jump-to-message paging loop.
  useEffect(() => { messagesRef.current = messages; }, [messages, messagesRef]);

  // Paint 50 rows first, then fill the in-memory window to roughly 100 from
  // SQLite after gestures/animations settle. This is local-only: opening a
  // chat never waits on network or a second decrypt batch.
  useEffect(() => {
    if (loading || prefetchedChatRef.current === chatId) return;
    const cid = chatId;
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(async () => {
      if (cancelled || chatIdRef.current !== cid) return;
      // A pane swap may leave the previous chat's read in flight. Its finally
      // block is ownership-checked, so the new pane can safely take the lock.
      if (pagingChatRef.current && pagingChatRef.current !== cid) pagingChatRef.current = null;
      if (pagingChatRef.current) return;
      const current = messagesRef.current;
      const oldest = current[current.length - 1]?.id;
      if (!oldest) return;
      prefetchedChatRef.current = cid;
      pagingChatRef.current = cid;
      try {
        const older = await getCachedMessagesBefore(cid, Number(oldest), PREFETCH_PAGE_SIZE);
        if (cancelled || chatIdRef.current !== cid) return;
        if (older.length) {
          setMessages(prev => {
            const have = new Set(prev.map(x => String(x.id)));
            return [...prev, ...older.filter(m => !have.has(String(m.id)))];
          });
        }
        const nextOldest = older[older.length - 1]?.id ?? oldest;
        const localOlder = await hasCachedOlderMessages(cid, Number(nextOldest)).catch(() => false);
        if (!cancelled && chatIdRef.current === cid) {
          setHasMore(localOlder || Number(nextOldest) > 0);
        }
      } catch {
        if (!cancelled && chatIdRef.current === cid) prefetchedChatRef.current = null;
      } finally {
        if (pagingChatRef.current === cid) pagingChatRef.current = null;
      }
    });
    return () => { cancelled = true; task.cancel(); };
  }, [chatId, loading, chatIdRef, messagesRef, pagingChatRef, prefetchedChatRef, setHasMore, setMessages]);

  /**
   * Cap the in-memory window.
   *
   * Nothing trimmed this array. A long-lived chat grew it forever — every
   * message ever paged in stayed in JS state, each one a decrypted string plus
   * a base64 thumbnail for media, and a single jumpToMessage could add two
   * thousand in one action. The cost is not only memory: every setMessages
   * re-derives the whole list, so the whole screen gets slower the longer it
   * stays open.
   *
   * ONLY WHEN AT THE BOTTOM, and that condition is the whole design. The tail
   * of this array is the OLDEST message (it is newest-first), so trimming while
   * the user is scrolled up — or has just jumped to a search hit — would delete
   * the messages they are looking at and yank the viewport. At the bottom they
   * are reading live and the tail is off-screen by definition.
   *
   * Dropping older messages means there is more to page again, so hasMore has
   * to go back to true even if we had previously reached the true start of the
   * conversation. onEndReached pages from the oldest LOADED id and the cache
   * still holds them, so scrolling up refills from disk with no network.
   *
   * As an effect rather than inside each setMessages: the array grows from six
   * different places (sends, socket arrivals, optimistic rows), and a guard in
   * one place cannot be forgotten by the seventh.
   */
  useEffect(() => {
    const settledCount = messages.reduce((n, m) => n + (m._tempId ? 0 : 1), 0);
    if (settledCount <= MAX_LOADED) return;
    if (hasNewer) {
      const retained = messages.filter(m => !m._tempId).slice(-MAX_LOADED);
      setNewerGapBeforeId(retained[0]?.id ?? null);
      setMessages(prev => {
        const pending = prev.filter(m => m._tempId);
        const settled = prev.filter(m => !m._tempId).slice(-MAX_LOADED);
        return [...pending, ...settled];
      });
      return;
    }
    if (!atBottomRef.current) return;
    setMessages(prev => {
      const pending = prev.filter(m => m._tempId);
      return [...pending, ...prev.filter(m => !m._tempId).slice(0, MAX_LOADED)];
    });
    setHasMore(true);
  }, [hasNewer, messages, atBottomRef, setHasMore, setMessages, setNewerGapBeforeId]);

  // Jump to a specific message (from in-chat search): page older until it's
  // loaded, scroll to it, and briefly flash it.
  const jumpToMessage = useCallback(async (targetId: number) => {
    // Pane-swap guard: paging another chat's history into this one is not recoverable.
    const cid = chatId;
    const alive = () => chatIdRef.current === cid;
    while (pagingChatRef.current && alive()) {
      await new Promise<void>(resolve => setTimeout(resolve, 16));
    }
    if (!alive()) return;
    pagingChatRef.current = cid;
    try {
    const startingWindow = messagesRef.current;
    let replacedWithSegment = false;
    let idx = messagesRef.current.findIndex(m => m.id === targetId);
    // Use the centred SQLite window only when it overlaps the loaded tail.
    // Appending a distant window would make FlatList place two non-contiguous
    // history ranges next to each other with no way to page the missing middle.
    if (idx < 0) {
      try {
        const loadedOldest = messagesRef.current[messagesRef.current.length - 1]?.id;
        const around = await getCachedMessagesAround(
          cid, targetId, Math.floor(PREFETCH_PAGE_SIZE / 2),
        ) as DisplayMessage[];
        if (!alive()) return;
        const overlapsLoadedTail = loadedOldest != null && around.some(m => m.id === loadedOldest);
        if (around.some(m => m.id === targetId)) {
          const seen = new Set<string>();
          const source = overlapsLoadedTail
            ? [...messagesRef.current, ...around]
            : [...messagesRef.current.filter(m => m._tempId), ...around];
          const combined = source.filter(m => {
            const key = m._tempId ?? String(m.id);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          const pending = combined.filter(m => m._tempId);
          const settled = combined.filter(m => !m._tempId).sort((a, b) => Number(b.id) - Number(a.id));
          messagesRef.current = [...pending, ...settled];
          idx = messagesRef.current.findIndex(m => m.id === targetId);
          if (!overlapsLoadedTail) {
            replacedWithSegment = true;
            const newestSegmentId = settled[0]?.id;
            const oldestSegmentId = settled[settled.length - 1]?.id;
            const [newer, older] = await Promise.all([
              newestSegmentId == null ? false : hasCachedNewerMessages(cid, Number(newestSegmentId)).catch(() => false),
              oldestSegmentId == null ? false : hasCachedOlderMessages(cid, Number(oldestSegmentId)).catch(() => false),
            ]);
            if (!alive()) return;
            setHasNewer(newer);
            setHasMore(older || Number(oldestSegmentId) > 0);
            setNewerGapBeforeId(newer ? Number(newestSegmentId) : null);
            atBottomRef.current = false;
            setShowScrollDown(true);
          }
        }
      } catch {}
    }
    let guard = 0;
    const maxJumpPages = Math.max(
      0, Math.ceil((MAX_LOADED - messagesRef.current.length) / SCROLL_PAGE_SIZE),
    );
    // Network fallback for a target absent from local storage.
    while (idx < 0 && guard < maxJumpPages) {
      guard++;
      const oldest = messagesRef.current[messagesRef.current.length - 1]?.id;
      if (!oldest) break;
      // Same disk-first rule as onEndReached — jumping to an old search hit
      // used to re-download up to 40 pages it already had.
      let older;
      try {
        older = await getCachedMessagesBefore(cid, Number(oldest), SCROLL_PAGE_SIZE);
        // Same rule as onEndReached: a negative id is imported history, which the
        // server has never seen. Asking it would be an empty round-trip and would
        // put a local-only id on the wire.
        const cachedPositiveCount = older.reduce((n, m) => n + (Number(m.id) > 0 ? 1 : 0), 0);
        if (cachedPositiveCount < SCROLL_PAGE_SIZE && Number(oldest) > 0) {
          const fetched = await hydrateMessages(
            cid, await getMessages(cid, { before: oldest, limit: SCROLL_PAGE_SIZE }),
          );
          cacheMessages(cid, fetched).catch(() => {});
          const cachedIds = new Set(older.map(m => String(m.id)));
          older = [...older, ...fetched.filter(m => !cachedIds.has(String(m.id)))]
            .sort((a, b) => Number(b.id) - Number(a.id));
        }
      } catch { break; }
      if (!alive()) return;
      if (!older.length) { setHasMore(false); break; }
      // Accumulate in the ref only. This used to setMessages on EVERY lap, so
      // jumping to an old search hit re-rendered a growing list up to forty
      // times — forty full re-derivations of a list on its way to two thousand
      // rows — before the user saw anything. The screen is committed once,
      // below, when we actually have the target.
      const have = new Set(messagesRef.current.map(m => m._tempId ?? String(m.id)));
      const room = Math.max(0, MAX_LOADED - messagesRef.current.length);
      const add = older.filter(m => !have.has(m._tempId ?? String(m.id))).slice(0, room);
      const next = [...messagesRef.current, ...add];
      messagesRef.current = next;
      idx = next.findIndex(m => m.id === targetId);
    }
    // MERGE, DON'T REPLACE.
    //
    // The paging loop above accumulates into messagesRef, a snapshot taken
    // before up to 40 round trips. Publishing it wholesale threw away anything
    // added to the rendered list in the meantime — an optimistic bubble the user
    // sent while the jump was still paging, or a message that arrived on the
    // socket. Both are newest, so they go back at the head; everything paged in
    // is older and keeps its order.
    const paged = messagesRef.current;
    const key = (x: DisplayMessage) => x._tempId ?? String(x.id);
    let committed = paged;
    const publish = () => setMessages(prev => {
      const have = new Set(paged.map(key));
      const startingKeys = new Set(startingWindow.map(key));
      const extra = prev.filter(x => !have.has(key(x)) &&
        (!replacedWithSegment || x._tempId || !startingKeys.has(key(x))));
      committed = extra.length ? [...extra, ...paged] : paged;
      if (replacedWithSegment) {
        const pending = committed.filter(m => m._tempId);
        const settled = committed.filter(m => !m._tempId)
          .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, MAX_LOADED);
        committed = [...pending, ...settled];
      }
      return committed;
    });
    if (idx < 0) {
      // A distant target needs a bidirectional/segmented window. Do not publish
      // thousands of intermediate rows or leave the ref ahead of the screen.
      messagesRef.current = startingWindow;
      return;
    }
    if (!alive()) return;
    publish();
    requestAnimationFrame(() => {
      const at = committed.findIndex(m => m.id === targetId);
      if (at < 0) return;
      try { listRef.current?.scrollToIndex({ index: at, animated: true, viewPosition: 0.5 }); } catch {}
    });
    setFlashId(targetId);
    setTimeout(() => setFlashId(null), 2500);
    } finally {
      if (pagingChatRef.current === cid) pagingChatRef.current = null;
    }
  }, [chatId, atBottomRef, chatIdRef, listRef, messagesRef, pagingChatRef, setFlashId, setHasMore, setHasNewer, setMessages, setNewerGapBeforeId, setShowScrollDown]);

  // Consume a pending jump when the screen regains focus (e.g. back from search).
  useFocusEffect(useCallback(() => {
    // A newly-pushed chat focuses before its asynchronous local page is ready.
    // Leave the single-shot handoff intact until that page has painted.
    if (loading) return;
    const target = consumePendingJump(chatId);
    if (target) jumpToMessage(target);
  }, [chatId, loading, jumpToMessage]));

  return { onEndReached, onStartReached, returnToLatest, jumpToMessage };
}
