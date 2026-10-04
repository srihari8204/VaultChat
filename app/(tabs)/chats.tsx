// app/(tabs)/chats.tsx — WhatsApp-style chat list (Obsidian Aurora).
//
// Postgres backend (/chats REST + realtime new_message/presence). Swipe
// right → Pin / Mute; swipe left → Archive / Delete(hide). Sticky "Pinned"
// and "All Chats" sections. FAB → /new-chat. Data wiring (presence, folders,
// pin/archive/mute/hidden, unread) is preserved from the previous version.

import { useAuthHeader } from '../../hooks/useAuthHeader';
import { TAB_BAR_SPACE } from '../../constants/layout';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
// RN Text, not AppText, on purpose: every font size below is already multiplied
// by the vision-comfort scale (components/chats/chatListStyles `v`), and AppText
// applies that scale again, which would double it.
import { ActivityIndicator, Alert, AppState, InteractionManager, Modal, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { AuroraBackground, GlassChip } from '../../components/ui';
import { canSplit } from '../../lib/responsive';
import {
  archiveChat, listChats, listStoriesFeed, muteChat, pinChat, setFavourite, setHidden,
  hydrateOwnPreviews,
  myInvitations,
  type ChatSummary,
} from '../../lib/chatService';
import { registerPushToken } from '../../lib/push';
import ConnectionBanner from '../../components/ConnectionBanner';
import { ChatHeaderAction } from '../../components/chat/ChatHeaderAction';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cloudBackupMeta } from '../../lib/cloudBackup';
import { runScheduledBackupIfDue } from '../../lib/backupScheduler';
import { getSocket } from '../../lib/socket';
import { mark } from '../../lib/perf';
import { takePrimedChats } from '../../lib/chatsPrefetch';
import { applyLocalReadPointers, setUnreadTotal } from '../../lib/unreadStore';
import { getDraftMap } from '../../lib/drafts';
import { getLastMessagePerChat, getCachedChats, cacheChats, isVisibleChatRow, setCachedChatHidden } from '../../lib/localDb';
import { isLockedIn, lockedChatIds } from '../../lib/lockedChats';
import { getCurrentUserAsync } from '../(constants)/authService';
// The row, the avatar popup and the styles live in components/chats/ (split
// 2026-10-04 to keep this screen under ~800 lines; behaviour unchanged).
import { ChatListRow, ChatListSeparator, type LastMsg } from '../../components/chats/ChatListRow';
import { AvatarPopup } from '../../components/chats/AvatarPopup';
import { useChatListStyles } from '../../components/chats/chatListStyles';
import { userErrorText } from '../../lib/userErrorText';

// Row previews and the lock table, read together: a locked chat's text is never
// painted before its lock is known. lockedChatIds() never rejects (null = the
// lock table is unreadable → every row is treated as locked).
async function readPreviews() {
  const [msgs, locked] = await Promise.all([
    getLastMessagePerChat().then(hydrateOwnPreviews).catch(() => null),
    lockedChatIds(),
  ]);
  return { msgs, locked };
}

type FolderId = 'all' | 'unread' | 'favourites' | 'groups' | 'pinned' | 'archive';
const FOLDERS: { id: FolderId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'groups', label: 'Groups' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'archive', label: 'Archive' },
];

// P1.2: the ChatListRow memo compares `a.chat === b.chat` (object identity), so a
// full `setChats(freshList)` — brand-new objects on every socket event —
// re-rendered EVERY visible row even when only one chat changed. mergeChats
// reuses the previous object for any chat whose fields are unchanged, so the
// memoized rows skip re-render; it also reuses the array identity when the list
// is positionally identical, so the SectionList itself doesn't churn.
function chatsShallowEqual(a: ChatSummary, b: ChatSummary): boolean {
  const ka = Object.keys(a) as (keyof ChatSummary)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
function mergeChats(prev: ChatSummary[], next: ChatSummary[]): ChatSummary[] {
  if (!prev.length) return next;
  const byId = new Map(prev.map(c => [c.id, c]));
  const merged = next.map(n => {
    const p = byId.get(n.id);
    return p && chatsShallowEqual(p, n) ? p : n;   // reuse identity → memoized row skips
  });
  if (merged.length === prev.length && merged.every((c, i) => c === prev[i])) return prev;
  return merged;
}

function afterInteractions(task: () => void): () => void {
  const handle = InteractionManager.runAfterInteractions(task);
  return () => { try { handle.cancel(); } catch {} };
}

const useS = useChatListStyles;

export default function ChatsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const authHeader = useAuthHeader();
  const [folder, setFolder] = useState<FolderId>('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Real last-message previews from the local plaintext cache (WhatsApp-style).
  const [lastMsgs, setLastMsgs] = useState<Map<string, LastMsg>>(new Map());
  // Locked chats show no preview or draft text. undefined = not read yet (drafts wait for it).
  const [lockedIds, setLockedIds] = useState<Set<string> | null | undefined>(undefined);
  const [meId, setMeId] = useState<string | null>(null);
  const meIdRef = useRef<string | null>(null);
  useEffect(() => { meIdRef.current = meId; }, [meId]);
  // Chats with someone typing right now (chatId set) — shows "typing…" in the row.
  const [typingChats, setTypingChats] = useState<Set<string>>(new Set());
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const { width: winW, height: winH } = useWindowDimensions();
  const splitReady = canSplit(winW, winH);

  // Pending invitations awaiting MY answer (banner above the list). Refreshed
  // on focus and when the server pushes invitation_created, so an invite that
  // lands while the app is open shows up without a manual pull-to-refresh.
  const [pendingInvites, setPendingInvites] = useState(0);
  const refreshInvites = useCallback(async () => {
    try {
      const inv = await myInvitations();
      // Count what the invitee can ACT on, not what is literally 'pending'.
      //
      // These are not the same set, and the difference is a real trap. An
      // invitation stranded at 'accepted' — the invitee said yes, but the group
      // was on the old 'strict' default and the owner approval it waits for was
      // never surfaced anywhere (migration 077) — is offered again by the
      // server, which sets canAccept on exactly those rows, and the inbox
      // screen already draws an Accept button for them.
      //
      // Counting only 'pending' hid that banner, and for anyone not already in
      // a space the banner is the ONLY route to the inbox. So the recovery
      // existed on the server and in the screen, and could not be reached: the
      // invitee saw nothing, and the inviter watched them never join.
      //
      // `canAccept` is the server's own answer to "is there something to do
      // here", so use it. The status fallback keeps this correct against an
      // older server that does not send the flag.
      setPendingInvites(
        inv.filter((i) => (typeof i.canAccept === 'boolean' ? i.canAccept : i.status === 'pending')).length,
      );
    } catch { /* offline / not signed in — leave the banner hidden */ }
  }, []);
  const didInitialInviteFocus = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!didInitialInviteFocus.current) {
      didInitialInviteFocus.current = true;
      return afterInteractions(() => { refreshInvites(); });
    }
    refreshInvites();
  }, [refreshInvites]));
  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    const cancelStartup = afterInteractions(() => { (async () => {
      try {
        const { on } = await import('../../lib/socket');
        const unsub = await on('invitation_created', () => refreshInvites());
        if (dead) unsub(); else off = unsub;
      } catch {}
    })(); });
    return () => { dead = true; cancelStartup(); off?.(); };
  }, [refreshInvites]);

  // Core list load.
  const loadList = useCallback(async (refreshPreviews = true) => {
    // Previews come from the local DB and need NO network, but this used to sit
    // below `await listChats()` — so offline, that first line threw and every
    // row fell back to "Tap to open chat" even though the text was on disk.
    // Measured: online showed "You: Hiiiii", the same row offline showed the
    // placeholder. Load them first, unconditionally.
    if (refreshPreviews) {
      readPreviews().then(({ msgs, locked }) => { if (msgs) setLastMsgs(msgs); setLockedIds(locked); }).catch(() => {});
    }
    mark('chats_fetch_start');
    try {
      // Boot dispatched this request already (lib/chatsPrefetch.ts); take that
      // one rather than opening a second. Single-use and age-limited, so every
      // later refresh — pull-to-refresh, focus, socket events — fetches
      // normally. If the head start failed, fall back to a fresh request rather
      // than inheriting its error: the network may simply not have been up yet
      // at boot, and that must not become a permanent empty list.
      const primed = takePrimedChats();
      let list: Awaited<ReturnType<typeof listChats>>;
      if (primed) {
        try { list = await primed; }
        catch { mark('chats_prime_fallback'); list = await listChats(); }
      } else {
        list = await listChats();
      }
      mark('chats_fetch_done', { rows: list.length });
      setChats(prev => mergeChats(prev, list));                 // identity-preserving → memoized rows skip re-render
      cacheChats(list).catch(() => {});                         // persist for instant next-launch paint (op-sqlite engine)
      setError(null);
      // Publish total unread (non-archived) so the Chats tab can badge it.
      setUnreadTotal(list.reduce((n, c) => n + (c.archived ? 0 : (c.unreadCount > 0 ? 1 : 0)), 0));
    } catch (e: unknown) {
      mark('chats_fetch_error');
      setError(userErrorText(e, 'Failed to load chats'));
    }
  }, []);

  const fetchList = useCallback(() => loadList(), [loadList]);

  // P1.2: coalesce bursts of socket events (new/edited/deleted messages) into a
  // single lightweight refetch, instead of one full fetchList() per event.
  // Previously a chatty thread triggered a network listChats() + whole-list
  // re-render on every message.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;   // already scheduled → coalesce
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; loadList(); }, 350);
  }, [loadList]);

  // Clear coalescing + typing timers on unmount so they can't fire on an
  // unmounted screen (P1.4).
  useEffect(() => () => {
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    Object.values(typingTimers.current).forEach(t => clearTimeout(t));
    typingTimers.current = {};
  }, []);

  useEffect(() => {
    let cancel = false;
    (async () => {
      readPreviews().then(({ msgs, locked }) => {
        if (cancel) return;
        if (msgs) setLastMsgs(msgs);
        setLockedIds(locked);
      }).catch(() => {});
      // Paint cached chats instantly (WhatsApp-style) so there's no spinner on
      // cold start; the network fetch then reconciles in the background.
      try {
        // Not the hidden (PIN-gated) chats: opening one from Hidden chats
        // caches its row too (lib/localDb.getCachedVisibleChats).
        const cached = (await getCachedChats()).filter(isVisibleChatRow);
        // Same read-pointer correction listChats applies, because this row can
        // be OLDER than the list that wrote it: lib/localDb.cacheChatDetail
        // re-writes a chat's cached row from the ChatDetail fetched when the
        // chat is OPENED, i.e. with the unreadCount it still had before it was
        // read. Without this the badge comes back on every cold start (and
        // stays, offline) for exactly the chats you just finished reading.
        try {
          const { readPointers } = await import('../../lib/receipts');
          // `as any` is a no-op (getCachedChats returns any[]) kept because
          // lib/chatUnreadCursor.selftest.ts pins this exact line.
          applyLocalReadPointers(cached as any, await readPointers());
        } catch {}
        if (!cancel && cached.length) {
          setChats(cached); setLoading(false);
          mark('chats_paint_cache', { rows: cached.length });
        } else if (!cancel) mark('chats_cache_empty');
      } catch {}
      await loadList(false);
      if (!cancel) { setLoading(false); mark('chats_paint_net'); }
    })();
    return () => { cancel = true; };
  }, [loadList]);

  // Refresh the list (so unread counts clear after reading) + draft previews
  // whenever the screen regains focus — e.g. coming back from a chat.
  //
  // Skip the mount focus: the cold-start effect above already paints cache and
  // starts exactly one listChats() refresh. Running this focus callback too made
  // first launch do two identical /chats requests.
  const didInitialFocus = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!didInitialFocus.current) {
      didInitialFocus.current = true;
      return afterInteractions(() => { getDraftMap().then(setDrafts).catch(() => {}); });
    }
    fetchList();
    getDraftMap().then(setDrafts).catch(() => {});
  }, [fetchList]));
  useEffect(() => afterInteractions(() => { registerPushToken().catch(() => {}); }), []);

  // Auto-backup: a few seconds after the list is up, run a scheduled backup if
  // it's due and the network policy (Wi-Fi only / any) allows. Silent + safe.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const cancelStartup = afterInteractions(() => {
      t = setTimeout(() => { runScheduledBackupIfDue().catch(() => {}); }, 4000);
    });
    return () => { cancelStartup(); if (t) clearTimeout(t); };
  }, []);

  // Restore-on-reinstall (WhatsApp-style): once per install, if a cloud backup
  // exists, offer to restore it. AsyncStorage is wiped on reinstall, so the
  // "prompted" flag resets and a returning user is offered their backup again.
  useEffect(() => {
    const cancelStartup = afterInteractions(() => { (async () => {
      try {
        if (await AsyncStorage.getItem('vc_restore_prompted')) return;
        const meta = await cloudBackupMeta();
        // A NON-ANSWER MUST NOT BURN THE OFFER. This flag is once per install,
        // and it used to be written before `exists` was read — so a reinstall
        // whose first launch was offline (the common case, not the edge case)
        // marked itself prompted and never offered the backup again. Leave the
        // flag unset and ask on the next launch instead.
        if (meta.unavailable) return;
        await AsyncStorage.setItem('vc_restore_prompted', '1');
        if (meta.exists) {
          Alert.alert(
            'Restore your chats?',
            `A cloud backup${meta.messageCount != null ? ` with ${meta.messageCount} messages` : ''} was found for this account. Restore it on this device?`,
            [
              { text: 'Not now', style: 'cancel' },
              { text: 'Restore', onPress: () => router.push('/chat-backup') },
            ],
          );
        }
      } catch {}
    })(); });
    return cancelStartup;
  }, [router]);

  // Realtime: new messages refresh the list; presence patches in place.
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const s = await getSocket();
        const refresh = () => scheduleRefresh();   // P1.2: coalesced, history-free refetch
        const onPresence = (e: { userId: string; online: boolean; lastSeenAt: string | null }) => {
          if (!e?.userId) return;
          setChats(prev => prev.map(c => c.peerUserId === e.userId
            ? { ...c, peerOnline: e.online, peerLastSeenAt: e.lastSeenAt ?? c.peerLastSeenAt } : c));
        };
        const onTyping = (e: { uid?: string; chatId?: string }) => {
          // FAIL CLOSED WHEN WE DO NOT KNOW WHO WE ARE. `e.uid === null` is false
          // for every real id, so without the first clause an event arriving
          // before meId resolves skips the self-check entirely and the row shows
          // "typing…" because YOU are typing. Dropping a typing event for the few
          // ms before the id loads costs nothing — it is re-sent every keystroke.
          if (!meIdRef.current) return;
          if (!e?.chatId || !e.uid || e.uid === meIdRef.current) return;
          setTypingChats(prev => { const n = new Set(prev); n.add(e.chatId!); return n; });
          clearTimeout(typingTimers.current[e.chatId]);
          typingTimers.current[e.chatId] = setTimeout(() =>
            setTypingChats(prev => { const n = new Set(prev); n.delete(e.chatId!); return n; }), 6000);
        };
        const onTypingStop = (e: { chatId?: string }) => {
          if (!e?.chatId) return;
          clearTimeout(typingTimers.current[e.chatId]);
          setTypingChats(prev => { const n = new Set(prev); n.delete(e.chatId!); return n; });
        };
        // RESYNC ON RECONNECT — the list has no other way to learn what it missed.
        //
        // Realtime events do not replay every event sent while a client was away, so a
        // message that arrives during a drop (backgrounded, doze, a tunnel) is
        // simply never seen by this screen. The only other refresh triggers are
        // a socket event and useFocusEffect — and if the user is ALREADY sitting
        // on the Chats tab, focus never changes, so the list stays stale
        // indefinitely.
        //
        // For an existing chat that shows as a stale preview. For a chat that
        // did not exist yet — someone messaging you for the first time — there
        // is no row at all, so the whole conversation is invisible until
        // something else happens to re-focus the tab. That is the reported bug:
        // "not showing in chats page, but if I open it from Contacts I can see
        // it" — navigating away and back is what silently fixed it.
        //
        // Same shape as the room re-join in lib/socket.ts, which exists because
        // this identical gap once stopped live location dead after any reconnect.
        const onReconnect = () => refresh();
        // Check BEFORE attaching, not after (2026-09-17). The seven listeners
        // below used to be registered first and the `if (!cancelled)` guard only
        // decided whether to BUILD the detach function — so unmounting while
        // getSocket() was still in flight left all seven attached with no way to
        // remove them. Each leaked `refresh` then ran listChats() on every
        // message in every chat for the rest of the process, and another seven
        // leaked on each remount. Returning early is the whole fix.
        if (cancelled) return;
        s.on('connect', onReconnect);
        s.on('new_message', refresh);
        s.on('message_deleted', refresh);
        s.on('message_edited', refresh);
        s.on('presence_changed', onPresence);
        s.on('typing_start', onTyping);
        s.on('typing_stop', onTypingStop);
        off = () => {
          s.off('connect', onReconnect);
          s.off('new_message', refresh); s.off('message_deleted', refresh);
          s.off('message_edited', refresh); s.off('presence_changed', onPresence);
          s.off('typing_start', onTyping); s.off('typing_stop', onTypingStop);
        };
      } catch (e: unknown) { if (!cancelled) setError(userErrorText(e, 'Realtime unavailable')); }
    })();
    return () => { cancelled = true; if (off) off(); };
  }, [scheduleRefresh]);

  // Resync when the app comes back to the foreground.
  //
  // The socket reconnect above covers most of it, but not the case where the
  // OS froze the process outright: on resume the socket may report itself
  // connected without ever firing 'connect', so no event arrives and — if the
  // Chats tab was already the focused one — useFocusEffect does not re-run
  // either. Coming back to a phone that was in a pocket is the single most
  // common way to be looking at a stale list.
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { if (s === 'active') scheduleRefresh(); });
    return () => sub.remove();
  }, [scheduleRefresh]);

  useEffect(() => afterInteractions(() => {
    getCurrentUserAsync().then(u => setMeId(u?.id ?? null)).catch(() => {});
  }), []);

  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchList(); setRefreshing(false); }, [fetchList]);
  const onOpenChat = useCallback((id: string) => router.push({ pathname: '/chat', params: { id } }), [router]);
  const onNewChat = () => router.push('/new-chat');

  // Temporary chat: choose the lifetime here, choose the person on /new-chat.
  const [tempSheet, setTempSheet] = useState(false);
  const startTemporary = useCallback((seconds: number) => {
    setTempSheet(false);
    router.push({ pathname: '/new-chat', params: { ttl: String(seconds) } });
  }, [router]);

  const openCode = useCallback((mode: 'share' | 'enter') => {
    setTempSheet(false);
    router.push({ pathname: '/chat-code', params: { mode } });
  }, [router]);

  // Avatar tap (WhatsApp): peer has a story → open it; else show photo popup.
  const [avatarView, setAvatarView] = useState<ChatSummary | null>(null);
  // Who has a story, remembered for a minute: a second avatar tap answers at
  // once instead of waiting on /stories/feed again. `avatarBusy` drops taps
  // that land while a lookup is still in flight (no double push), and
  // `avatarLoadingId` shows that wait on the row that was tapped.
  const storyUsers = useRef<{ at: number; ids: Set<string> } | null>(null);
  const avatarBusy = useRef(false);
  const [avatarLoadingId, setAvatarLoadingId] = useState<string | null>(null);
  const onAvatarPress = useCallback(async (chat: ChatSummary) => {
    if (avatarBusy.current) return;
    if (chat.type === 'direct' && chat.peerUserId) {
      avatarBusy.current = true;
      try {
        if (!storyUsers.current || Date.now() - storyUsers.current.at > 60_000) {
          setAvatarLoadingId(chat.id);
          const feed = await listStoriesFeed();
          storyUsers.current = { at: Date.now(), ids: new Set(feed.map(e => e.userId)) };
        }
        if (storyUsers.current.ids.has(chat.peerUserId)) {
          router.push({ pathname: '/story-viewer', params: { userId: chat.peerUserId, userName: chat.peerName ?? chat.name ?? '' } });
          return;
        }
      } catch {} finally { avatarBusy.current = false; setAvatarLoadingId(null); }
    }
    setAvatarView(chat);
  }, [router]);

  // Optimistic chat-row actions with rollback. Stable (useCallback), so the
  // memoised ChatListRow is not re-rendered by a fresh handler on every list update.
  const patch = useCallback((id: string, fields: Partial<ChatSummary>) =>
    setChats(prev => prev.map(c => c.id === id ? { ...c, ...fields } : c)), []);

  const doPin = useCallback(async (chat: ChatSummary) => {
    const next = !chat.pinned;
    patch(chat.id, { pinned: next });
    try { await pinChat(chat.id, next); await fetchList(); }
    catch (e: unknown) { patch(chat.id, { pinned: !next }); setError(userErrorText(e, 'Pin failed')); }
  }, [patch, fetchList]);
  const doMute = useCallback(async (chat: ChatSummary) => {
    const next = !chat.muted;
    patch(chat.id, { muted: next });
    try { await muteChat(chat.id, next); await fetchList(); }
    catch (e: unknown) { patch(chat.id, { muted: !next }); setError(userErrorText(e, 'Mute failed')); }
  }, [patch, fetchList]);
  const doArchive = useCallback(async (chat: ChatSummary) => {
    const next = !chat.archived;
    patch(chat.id, { archived: next });
    try { await archiveChat(chat.id, next); await fetchList(); }
    catch (e: unknown) { patch(chat.id, { archived: !next }); setError(userErrorText(e, 'Archive failed')); }
  }, [patch, fetchList]);
  const doDelete = useCallback((chat: ChatSummary) => {
    Alert.alert(
      'Delete chat?',
      'This removes it from your list. It stays reachable from Hidden chats.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            setChats(prev => prev.filter(c => c.id !== chat.id));
            try { await setHidden(chat.id, true); await setCachedChatHidden(chat.id, true).catch(() => {}); await fetchList(); }
            catch (e: unknown) { setError(userErrorText(e, 'Delete failed')); fetchList(); }
          },
        },
      ],
    );
  }, [fetchList]);

  // ── Multi-select (WhatsApp-style bulk actions) ───────────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
  const enterSelect = useCallback((id: string) => { setSelectMode(true); setSelected(new Set([id])); }, []);
  const toggleSelect = useCallback((id: string) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    if (n.size === 0) setSelectMode(false);
    return n;
  }), []);
  // The row's three taps, rebuilt only when selection mode flips (which
  // re-renders every row anyway, through its selectMode prop).
  const onRowPress = useCallback((c: ChatSummary) => { if (selectMode) toggleSelect(c.id); else onOpenChat(c.id); }, [selectMode, toggleSelect, onOpenChat]);
  const onRowAvatar = useCallback((c: ChatSummary) => { if (selectMode) toggleSelect(c.id); else onAvatarPress(c); }, [selectMode, toggleSelect, onAvatarPress]);
  const onRowLongPress = useCallback((c: ChatSummary) => { if (selectMode) toggleSelect(c.id); else enterSelect(c.id); }, [selectMode, toggleSelect, enterSelect]);
  // Per-item failures used to vanish into `catch {}` (2026-09-22). The
  // ROLLBACK was never the missing half — fetchList() refetches and replaces
  // the optimistic patch with server truth — the TELLING was: the selection is
  // cleared first, so a user whose Mute silently applied to 4 of 6 chats had
  // nothing on screen to say so and no selection left to retry with. Counted
  // and reported through the same `error` bar the single-chat actions use.
  // Reported AFTER the refetch is awaited, because loadList() calls
  // setError(null) on success and would otherwise erase the message.
  const bulkRun = async (fn: (id: string) => Promise<unknown>, label: string) => {
    const ids = [...selected];
    exitSelect();
    // In parallel: one slow request no longer holds up the rest.
    const results = await Promise.allSettled(ids.map(id => fn(id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    await fetchList();
    if (failed) setError(`${label} failed for ${failed} of ${ids.length} chat${ids.length > 1 ? 's' : ''}`);
  };
  const bulkPin     = () => bulkRun(id => { patch(id, { pinned: true });   return pinChat(id, true); }, 'Pin');
  // TOGGLE, not set-true (2026-09-17). setFavourite(id, false) used to be
  // reachable only from the long-press sheet that could never open — so NOTHING
  // in the app could un-favourite a chat and the Favourites folder filled up
  // permanently. That sheet has since been deleted (see the note further down),
  // which makes this the ONLY favourite path in the app: if everything selected
  // is already a favourite, the action removes them.
  const allSelectedFav = () => {
    const ids = [...selected];
    return ids.length > 0 && ids.every(id => chats.find(c => c.id === id)?.favourite);
  };
  const bulkFav     = () => { const on = !allSelectedFav(); return bulkRun(id => { patch(id, { favourite: on }); return setFavourite(id, on); }, on ? 'Favourite' : 'Remove from favourites'); };
  const bulkMute    = () => bulkRun(id => { patch(id, { muted: true });    return muteChat(id, true); }, 'Mute');
  const bulkArchive = () => bulkRun(id => { patch(id, { archived: true }); return archiveChat(id, true); }, 'Archive');
  const bulkDelete  = () => {
    const ids = [...selected];
    Alert.alert(`Delete ${ids.length} chat${ids.length > 1 ? 's' : ''}?`, 'They stay reachable from Hidden chats.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        exitSelect();
        setChats(prev => prev.filter(c => !ids.includes(c.id)));
        const results = await Promise.allSettled(ids.map(id => setHidden(id, true)));
        // This device's cached rows too, so global search and the Bookshelf
        // drop the hidden ones at once even if the refetch below fails.
        await Promise.all(ids.map((id, i) => (results[i].status === 'fulfilled' ? setCachedChatHidden(id, true).catch(() => {}) : null)));
        const failed = results.filter(r => r.status === 'rejected').length;
        await fetchList();
        // The refetch puts an undeleted chat straight back in the list, so the
        // row reappearing is the rollback; this names why it came back.
        if (failed) setError(`Delete failed for ${failed} of ${ids.length} chat${ids.length > 1 ? 's' : ''}`);
      } },
    ]);
  };

  const visibleChats = useMemo(() => {
    if (folder === 'archive') return chats.filter(c => c.archived);
    const base = chats.filter(c => !c.archived);
    switch (folder) {
      case 'unread': return base.filter(c => c.unreadCount > 0);
      case 'favourites': return base.filter(c => c.favourite);
      case 'groups': return base.filter(c => c.type === 'group');
      case 'pinned': return base.filter(c => c.pinned);
      default: return base;
    }
  }, [chats, folder]);

  // Sections: in "All", split pinned vs the rest with sticky headers.
  const sections = useMemo(() => {
    if (folder === 'all') {
      const pinned = visibleChats.filter(c => c.pinned);
      const rest = visibleChats.filter(c => !c.pinned);
      const out: { title: string; data: ChatSummary[] }[] = [];
      if (pinned.length) out.push({ title: 'Pinned', data: pinned });
      out.push({ title: 'All Chats', data: rest });
      return out;
    }
    return [{ title: FOLDERS.find(f => f.id === folder)?.label ?? '', data: visibleChats }];
  }, [visibleChats, folder]);

  // Folder chip counts, once per list change rather than four filters per render.
  const folderCounts = useMemo(() => {
    const n = { unread: 0, favourites: 0, pinned: 0, archive: 0 };
    for (const c of chats) {
      if (c.archived) { n.archive++; continue; }
      if (c.unreadCount > 0) n.unread++;
      if (c.favourite) n.favourites++;
      if (c.pinned) n.pinned++;
    }
    return n;
  }, [chats]);

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <AuroraBackground variant="chats" />
      {selectMode ? (
        <View style={S.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <TouchableOpacity onPress={exitSelect} hitSlop={10} accessibilityRole="button" accessibilityLabel="Cancel selection"><Ionicons name="close" size={24} color={colors.text} /></TouchableOpacity>
            <Text style={S.title} accessibilityLabel={`${selected.size} selected`}>{selected.size}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {/* Split view: shown only with EXACTLY two chats picked, and only
                when the window can fit two readable panes (lib/responsive).
                Selection mode is the natural home — choosing two chats is the
                gesture. The old long-press sheet this lived in is unreachable:
                onLongPress enters selection mode and never opens it. */}
            {splitReady && selected.size <= 2 && (
              <TouchableOpacity
                disabled={selected.size !== 2}
                onPress={() => { const [a, b] = [...selected]; exitSelect(); router.push({ pathname: '/split', params: { a, b } }); }}
                style={[S.headerBtn, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={selected.size === 2 ? 'Open the two selected chats side by side' : 'Split view: pick two chats'}
                accessibilityState={{ disabled: selected.size !== 2 }}
              >
                <Ionicons
                  name="git-compare-outline"
                  size={20}
                  color={selected.size === 2 ? colors.primary : colors.textDim}
                />
                {/* Labelled, and shown from the FIRST selection rather than only
                    at exactly two. The icon alone, appearing only once a second
                    chat was picked, meant the feature was reported as missing —
                    it was rendering correctly (this device passes canSplit at
                    820dp tall), just undiscoverable. Dimmed at one selection it
                    advertises itself and says what it is waiting for. */}
                <Text style={[S.splitLbl, { color: selected.size === 2 ? colors.primary : colors.textDim }]}>
                  {selected.size === 2 ? 'Split' : 'Pick 2'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={bulkPin} style={S.headerBtn} hitSlop={4} accessibilityRole="button" accessibilityLabel="Pin selected chats"><Ionicons name="pin" size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkFav} style={S.headerBtn} hitSlop={4} accessibilityRole="button" accessibilityLabel={allSelectedFav() ? 'Remove selected chats from favourites' : 'Add selected chats to favourites'}><Ionicons name={allSelectedFav() ? 'heart' : 'heart-outline'} size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkMute} style={S.headerBtn} hitSlop={4} accessibilityRole="button" accessibilityLabel="Mute selected chats"><Ionicons name="notifications-off-outline" size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkArchive} style={S.headerBtn} hitSlop={4} accessibilityRole="button" accessibilityLabel="Archive selected chats"><Ionicons name="archive-outline" size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkDelete} style={S.headerBtn} hitSlop={4} accessibilityRole="button" accessibilityLabel="Delete selected chats"><Ionicons name="trash-outline" size={20} color={colors.danger} /></TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={[S.header, winW < 360 && { paddingHorizontal: 12 }]}>
          <Text style={[S.title, { flexShrink: 1, marginRight: 8 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} accessibilityRole="header">Chats</Text>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {/* Split view's own entry point. It used to exist ONLY inside
                selection mode, so reaching it meant long-pressing a chat and
                picking a second — with nothing anywhere to suggest the feature
                existed, which is why it was reported missing. Hidden when the
                window is too small to show two usable panes (lib/responsive),
                since offering it there would just fail. */}
            {splitReady && (
              <TouchableOpacity
                onPress={() => { setSelectMode(true); setSelected(new Set()); }}
                style={S.headerBtn}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel="Split view: pick two chats"
              >
                <Ionicons name="git-compare-outline" size={22} color={colors.text} />
              </TouchableOpacity>
            )}
            <ChatHeaderAction action="search" label="Search" onPress={() => router.push('/search')} />
            <ChatHeaderAction action="alerts" label="Alerts" onPress={() => router.push('/alerts')} />
            {/* Was the Mini Apps shortcut. Dropped, not lost — /mini is the
                centre tab ("Apps"), so it already had a permanent home and this
                was a second door to the same room. The header slot buys more as
                a temporary chat, which has no entry point at all otherwise. */}
            <ChatHeaderAction action="temporary" label="Start a temporary chat" onPress={() => setTempSheet(true)} />
            <ChatHeaderAction action="contacts" label="Contacts" onPress={() => router.push('/contacts')} />
            <ChatHeaderAction action="broadcast" label="New broadcast" onPress={() => router.push('/broadcast')} />
          </View>
        </View>
      )}

      <ConnectionBanner />

      {/* Pending group/Family invitations. Without this the ONLY way to reach
          /group-invitations was the Family Space manage sheet, so anyone
          invited to a plain group chat got a push and then had nowhere in the
          app to accept it. Hidden entirely at zero. */}
      {pendingInvites > 0 && (
        <TouchableOpacity
          onPress={() => router.push('/group-invitations')}
          activeOpacity={0.8}
          style={S.inviteBanner}
          accessibilityRole="button"
          accessibilityLabel={`${pendingInvites === 1 ? '1 group invitation' : `${pendingInvites} group invitations`}. View`}
        >
          <Ionicons name="mail-unread-outline" size={18} color={colors.primary} />
          <Text style={S.inviteBannerTxt}>
            {pendingInvites === 1 ? '1 group invitation' : `${pendingInvites} group invitations`}
          </Text>
          <Text style={S.inviteBannerCta}>View</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.primary} />
        </TouchableOpacity>
      )}

      {/* Every row reads "Locked chat" when the lock table can't be read
          (fail closed); say why once, with a retry. */}
      {lockedIds === null && (
        <TouchableOpacity style={S.inviteBanner} onPress={onRefresh} disabled={refreshing} activeOpacity={0.8}
          accessibilityRole="button" accessibilityState={{ disabled: refreshing, busy: refreshing }}
          accessibilityLabel="Couldn't read your chat locks, so message previews are hidden. Tap to try again">
          <Ionicons name="lock-closed-outline" size={18} color={colors.primary} />
          <Text style={S.inviteBannerTxt}>Couldn’t read your chat locks, so previews are hidden. Tap to try again.</Text>
        </TouchableOpacity>
      )}

      {error && (
        <TouchableOpacity style={S.errorBar} onPress={onRefresh} disabled={refreshing} accessibilityRole="button" accessibilityLabel={`${error}. Tap to retry`}>
          <Text style={S.errorTxt}>{error} · Tap to retry</Text>
        </TouchableOpacity>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.folderScroll} contentContainerStyle={S.folderRow}>
        {FOLDERS.map(f => {
          const count = f.id === 'all' || f.id === 'groups' ? 0 : folderCounts[f.id];
          const active = folder === f.id;
          return (
            <GlassChip
              key={f.id}
              label={f.label}
              count={f.id === 'all' || f.id === 'groups' ? undefined : count}
              active={active}
              onPress={() => setFolder(f.id)}
            />
          );
        })}
      </ScrollView>

      {chats.length === 0 ? (
        // Refreshable, so an offline first launch with an empty cache can be
        // pulled to retry instead of leaving the tab being the only recovery.
        <ScrollView
          contentContainerStyle={[S.center, { flexGrow: 1, paddingHorizontal: 32 }]}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {/* A failed first load is not "no chats": the error bar above says
              what went wrong, and this must not contradict it. */}
          <Text style={S.emptyTitle}>{error ? 'Couldn’t load your chats' : 'No chats yet'}</Text>
          <Text style={S.emptySub}>{error ? 'Pull down to try again, or start a new chat.' : 'Tap the button below to start one.'}</Text>
          <TouchableOpacity style={S.emptyBtn} onPress={onNewChat} activeOpacity={0.85} accessibilityRole="button"><Text style={S.emptyBtnTxt}>Start a chat</Text></TouchableOpacity>
        </ScrollView>
      ) : visibleChats.length === 0 ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>Nothing here</Text>
          <Text style={S.emptySub}>No chats match “{FOLDERS.find(f => f.id === folder)?.label}”.</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(c) => c.id}
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) =>
            sections.length > 1 || section.title !== 'All Chats'
              ? <Text numberOfLines={1} style={S.sectionHeader} accessibilityRole="header">{section.title}</Text> : <View style={{ height: 4 }} />}
          renderItem={({ item }) => (
            <ChatListRow
              chat={item}
              authHeader={authHeader}
              draft={lockedIds === undefined ? undefined : drafts[item.id]}
              locked={lockedIds !== undefined && isLockedIn(lockedIds, item.id)}
              lastMsg={lastMsgs.get(item.id)}
              meId={meId}
              isTyping={typingChats.has(item.id)}
              selectMode={selectMode}
              isSelected={selected.has(item.id)}
              avatarBusy={avatarLoadingId === item.id}
              onPress={onRowPress}
              onAvatarPress={onRowAvatar}
              onLongPress={onRowLongPress}
              onPin={doPin}
              onMute={doMute}
              onArchive={doArchive}
              onDelete={doDelete}
            />
          )}
          ItemSeparatorComponent={ChatListSeparator}
          contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE + 16 }}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          removeClippedSubviews
          maxToRenderPerBatch={12}
          windowSize={11}
          initialNumToRender={14}
        />
      )}

      <TouchableOpacity style={S.fab} onPress={onNewChat} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="New chat">
        <Ionicons name="create-outline" size={26} color={colors.onPrimary} />
      </TouchableOpacity>

      {/* DELETED 2026-09-22: a long-press action sheet that could never open.
          `setMenuChat` existed but was only ever called with `null` — nothing
          assigned a chat to it — so `visible={!!menuChat}` was permanently
          false and all five rows were unreachable. onLongPress enters
          selection mode instead. Every action it offered is live elsewhere:
          Pin/Mute swipe left, Archive/Delete swipe right, and Favourite is the
          header heart in selection mode (`bulkFav`, which toggles). Removed
          rather than rewired — restoring it would take long-press away from
          selection mode, which Split view is reached through. */}

      {/* Temporary chat — pick how long messages live, then pick who with.
          The duration is carried to /new-chat and applied to whichever chat is
          opened there, so the choice is made once and cannot be forgotten
          halfway through. Values are the chat's existing disappearing-messages
          timer, not a new mechanism: the server already expires on
          chats.disappearing_seconds. */}
      <Modal visible={tempSheet} transparent animationType="fade" onRequestClose={() => setTempSheet(false)}>
        {/* The scrim is a sibling of the sheet, not its parent, so a screen
            reader reaches the sheet's rows instead of one "Close" around them. */}
        <View style={S.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setTempSheet(false)} accessibilityRole="button" accessibilityLabel="Close" />
          <View style={S.sheet} accessibilityViewIsModal>
            <View style={S.sheetHandle} />
            <Text style={S.sheetTitle}>TEMPORARY CHAT — MESSAGES DELETE THEMSELVES</Text>
            <SheetItem icon="timer-outline" label="1 hour" onPress={() => startTemporary(3600)} />
            <SheetItem icon="timer-outline" label="3 hours" onPress={() => startTemporary(10800)} />
            {/* The other half of the same question. Both rows above need someone
                already reachable — a contact, or a number on crazzychat. These two
                are for the person in front of you who is neither: a code opens
                the chat, so no number changes hands. Same sheet because "talk to
                someone without keeping it" is one intent, not two. */}
            <View style={S.sheetDivider} />
            <SheetItem icon="key-outline" label="Share a code" onPress={() => openCode('share')} />
            <SheetItem icon="keypad-outline" label="Enter a code" onPress={() => openCode('enter')} />
          </View>
        </View>
      </Modal>

      {/* Avatar photo popup (WhatsApp-style) — photo + quick actions */}
      <AvatarPopup chat={avatarView} authHeader={authHeader} onClose={() => setAvatarView(null)} onMessage={onOpenChat} />
    </View>
  );
}

function SheetItem({ icon, label, onPress, danger }: { icon: ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; danger?: boolean }) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <TouchableOpacity style={S.sheetItem} onPress={onPress} activeOpacity={0.7} accessibilityRole="button">
      <Ionicons name={icon} size={22} color={danger ? colors.danger : colors.text} />
      <Text style={[S.sheetItemTxt, danger && { color: colors.danger }]}>{label}</Text>
    </TouchableOpacity>
  );
}
