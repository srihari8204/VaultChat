// app/(tabs)/chats.tsx — WhatsApp-style chat list (Obsidian Aurora).
//
// Postgres backend (/chats REST + realtime new_message/presence). Swipe
// right → Pin / Mute; swipe left → Archive / Delete(hide). Sticky "Pinned"
// and "All Chats" sections. FAB → /new-chat. Data wiring (presence, folders,
// pin/archive/mute/hidden, unread) is preserved from the previous version.

import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import { useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Modal, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { type Palette, brandAlpha } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { Avatar, AuroraBackground, GlassChip } from '../../components/ui';
import { canSplit } from '../../lib/responsive';
import { getAccessToken } from '../../lib/api';
import {
  archiveChat, attachmentUrl, listChats, listStoriesFeed, muteChat, pinChat, setFavourite, setHidden,
  hydrateOwnPreviews,
  myInvitations,
  type ChatSummary,
} from '../../lib/chatService';
import { registerPushToken } from '../../lib/push';
import ConnectionBanner from '../../components/ConnectionBanner';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cloudBackupMeta } from '../../lib/cloudBackup';
import { runScheduledBackupIfDue } from '../../lib/backupScheduler';
import { getSocket } from '../../lib/socket';
import { mark } from '../../lib/perf';
import { applyLocalReadPointers, setUnreadTotal } from '../../lib/unreadStore';
import { getDraftMap } from '../../lib/drafts';
import { getLastMessagePerChat, getCachedChats, cacheChats } from '../../lib/localDb';
import { getCurrentUserAsync } from '../(constants)/authService';
import { isFamEvent } from '../../lib/family/alerts';

type LastMsg = { content: string | null; type: string | null; senderId: string | null; id: number };

type FolderId = 'all' | 'unread' | 'favourites' | 'groups' | 'pinned' | 'archive';
const FOLDERS: { id: FolderId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'groups', label: 'Groups' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'archive', label: 'Archive' },
];

// P1.2: the ChatRow memo compares `a.chat === b.chat` (object identity), so a
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

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ChatsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderId>('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Real last-message previews from the local plaintext cache (WhatsApp-style).
  const [lastMsgs, setLastMsgs] = useState<Map<string, LastMsg>>(new Map());
  const [meId, setMeId] = useState<string | null>(null);
  const meIdRef = useRef<string | null>(null);
  useEffect(() => { meIdRef.current = meId; }, [meId]);
  // Chats with someone typing right now (chatId set) — shows "typing…" in the row.
  const [typingChats, setTypingChats] = useState<Set<string>>(new Set());
  const typingTimers = useRef<Record<string, any>>({});
  const [menuChat, setMenuChat] = useState<ChatSummary | null>(null);   // long-press action sheet
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
  useFocusEffect(useCallback(() => { refreshInvites(); }, [refreshInvites]));
  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    (async () => {
      try {
        const { on } = await import('../../lib/socket');
        const unsub = await on('invitation_created', () => refreshInvites());
        if (dead) unsub(); else off = unsub;
      } catch {}
    })();
    return () => { dead = true; off?.(); };
  }, [refreshInvites]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const tok = await getAccessToken();
      if (!cancel) setAuthHeader(tok ? `Bearer ${tok}` : null);
    })();
    return () => { cancel = true; };
  }, []);

  // Core list load.
  const loadList = useCallback(async () => {
    // Previews come from the local DB and need NO network, but this used to sit
    // below `await listChats()` — so offline, that first line threw and every
    // row fell back to "Tap to open chat" even though the text was on disk.
    // Measured: online showed "You: Hiiiii", the same row offline showed the
    // placeholder. Load them first, unconditionally.
    getLastMessagePerChat().then(hydrateOwnPreviews).then(setLastMsgs).catch(() => {});
    try {
      const list = await listChats();
      setChats(prev => mergeChats(prev, list));                 // identity-preserving → memoized rows skip re-render
      cacheChats(list).catch(() => {});                         // persist for instant next-launch paint (op-sqlite engine)
      setError(null);
      // Publish total unread (non-archived) so the Chats tab can badge it.
      setUnreadTotal(list.reduce((n, c) => n + (c.archived ? 0 : (c.unreadCount > 0 ? 1 : 0)), 0));
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load chats');
    }
  }, []);

  const fetchList = useCallback(() => loadList(), [loadList]);

  // P1.2: coalesce bursts of socket events (new/edited/deleted messages) into a
  // single lightweight refetch, instead of one full fetchList() per event.
  // Previously a chatty thread triggered a network listChats() + whole-list
  // re-render on every message.
  const refreshTimer = useRef<any>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;   // already scheduled → coalesce
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; loadList(); }, 350);
  }, [loadList]);

  // Clear coalescing + typing timers on unmount so they can't fire on an
  // unmounted screen (P1.4).
  useEffect(() => () => {
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    Object.values(typingTimers.current).forEach((t: any) => clearTimeout(t));
    typingTimers.current = {};
  }, []);

  useEffect(() => {
    let cancel = false;
    (async () => {
      // Paint cached chats instantly (WhatsApp-style) so there's no spinner on
      // cold start; the network fetch then reconciles in the background.
      try {
        const cached = await getCachedChats();
        // Same read-pointer correction listChats applies, because this row can
        // be OLDER than the list that wrote it: lib/localDb.cacheChatDetail
        // re-writes a chat's cached row from the ChatDetail fetched when the
        // chat is OPENED, i.e. with the unreadCount it still had before it was
        // read. Without this the badge comes back on every cold start (and
        // stays, offline) for exactly the chats you just finished reading.
        try {
          const { readPointers } = await import('../../lib/receipts');
          applyLocalReadPointers(cached as any, await readPointers());
        } catch {}
        if (!cancel && cached.length) {
          setChats(cached as any); setLoading(false);
          mark('chats_paint_cache', { rows: cached.length });
        } else if (!cancel) mark('chats_cache_empty');
      } catch {}
      await fetchList();
      if (!cancel) { setLoading(false); mark('chats_paint_net'); }
    })();
    return () => { cancel = true; };
  }, [fetchList]);

  // Refresh the list (so unread counts clear after reading) + draft previews
  // whenever the screen regains focus — e.g. coming back from a chat.
  useFocusEffect(useCallback(() => {
    fetchList();
    getDraftMap().then(setDrafts).catch(() => {});
  }, [fetchList]));
  useEffect(() => { registerPushToken().catch(() => {}); }, []);

  // Auto-backup: a few seconds after the list is up, run a scheduled backup if
  // it's due and the network policy (Wi-Fi only / any) allows. Silent + safe.
  useEffect(() => {
    const t = setTimeout(() => { runScheduledBackupIfDue().catch(() => {}); }, 4000);
    return () => clearTimeout(t);
  }, []);

  // Restore-on-reinstall (WhatsApp-style): once per install, if a cloud backup
  // exists, offer to restore it. AsyncStorage is wiped on reinstall, so the
  // "prompted" flag resets and a returning user is offered their backup again.
  useEffect(() => {
    (async () => {
      try {
        if (await AsyncStorage.getItem('vc_restore_prompted')) return;
        const meta = await cloudBackupMeta();
        await AsyncStorage.setItem('vc_restore_prompted', '1');
        if (meta.exists) {
          Alert.alert(
            'Restore your chats?',
            `A cloud backup${meta.messageCount != null ? ` with ${meta.messageCount} messages` : ''} was found for this account. Restore it on this device?`,
            [
              { text: 'Not now', style: 'cancel' },
              { text: 'Restore', onPress: () => router.push('/chat-backup' as any) },
            ],
          );
        }
      } catch {}
    })();
  }, []);

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
      } catch (e: any) { if (!cancelled) setError(e?.message ?? 'Realtime unavailable'); }
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

  useEffect(() => { getCurrentUserAsync().then(u => setMeId(u?.id ?? null)).catch(() => {}); }, []);

  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchList(); setRefreshing(false); }, [fetchList]);
  const onOpenChat = (id: string) => router.push({ pathname: '/chat', params: { id } } as any);
  const onNewChat = () => router.push('/new-chat' as any);

  // Temporary chat: choose the lifetime here, choose the person on /new-chat.
  const [tempSheet, setTempSheet] = useState(false);
  const startTemporary = useCallback((seconds: number) => {
    setTempSheet(false);
    router.push({ pathname: '/new-chat', params: { ttl: String(seconds) } } as any);
  }, [router]);

  const openCode = useCallback((mode: 'share' | 'enter') => {
    setTempSheet(false);
    router.push({ pathname: '/chat-code', params: { mode } } as any);
  }, [router]);

  // Avatar tap (WhatsApp): peer has a story → open it; else show photo popup.
  const [avatarView, setAvatarView] = useState<ChatSummary | null>(null);
  const onAvatarPress = useCallback(async (chat: ChatSummary) => {
    if (chat.type === 'direct' && chat.peerUserId) {
      try {
        const feed = await listStoriesFeed();
        if (feed.some(e => e.userId === chat.peerUserId)) {
          router.push({ pathname: '/story-viewer' as any, params: { userId: chat.peerUserId, userName: chat.peerName ?? chat.name ?? '' } });
          return;
        }
      } catch {}
    }
    setAvatarView(chat);
  }, [router]);

  // Optimistic chat-row actions with rollback.
  const patch = (id: string, fields: Partial<ChatSummary>) =>
    setChats(prev => prev.map(c => c.id === id ? { ...c, ...fields } : c));

  const doPin = async (chat: ChatSummary) => {
    const next = !chat.pinned;
    patch(chat.id, { pinned: next });
    try { await pinChat(chat.id, next); await fetchList(); }
    catch (e: any) { patch(chat.id, { pinned: !next }); setError(e?.message ?? 'Pin failed'); }
  };
  const doFavourite = async (chat: ChatSummary) => {
    const next = !chat.favourite;
    patch(chat.id, { favourite: next });
    try { await setFavourite(chat.id, next); await fetchList(); }
    catch (e: any) { patch(chat.id, { favourite: !next }); setError(e?.message ?? 'Favourite failed'); }
  };
  const doMute = async (chat: ChatSummary) => {
    const next = !chat.muted;
    patch(chat.id, { muted: next });
    try { await muteChat(chat.id, next); await fetchList(); }
    catch (e: any) { patch(chat.id, { muted: !next }); setError(e?.message ?? 'Mute failed'); }
  };
  const doArchive = async (chat: ChatSummary) => {
    const next = !chat.archived;
    patch(chat.id, { archived: next });
    try { await archiveChat(chat.id, next); await fetchList(); }
    catch (e: any) { patch(chat.id, { archived: !next }); setError(e?.message ?? 'Archive failed'); }
  };
  const doDelete = (chat: ChatSummary) => {
    Alert.alert(
      'Delete chat?',
      'This removes it from your list. It stays reachable from Hidden chats.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            setChats(prev => prev.filter(c => c.id !== chat.id));
            try { await setHidden(chat.id, true); await fetchList(); }
            catch (e: any) { setError(e?.message ?? 'Delete failed'); fetchList(); }
          },
        },
      ],
    );
  };

  // ── Multi-select (WhatsApp-style bulk actions) ───────────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
  const enterSelect = (id: string) => { setSelectMode(true); setSelected(new Set([id])); };
  const toggleSelect = (id: string) => setSelected(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    if (n.size === 0) setSelectMode(false);
    return n;
  });
  const bulkRun = async (fn: (id: string) => Promise<any>) => {
    const ids = [...selected];
    exitSelect();
    for (const id of ids) { try { await fn(id); } catch {} }
    fetchList();
  };
  const bulkPin     = () => bulkRun(id => { patch(id, { pinned: true });   return pinChat(id, true); });
  // TOGGLE, not set-true (2026-09-17). setFavourite(id, false) was reachable
  // only from doFavourite, whose sole caller is the long-press sheet that
  // onLongPress never opens (see the note further down) — so NOTHING in the app
  // could un-favourite a chat and the Favourites folder filled up permanently.
  // Selection mode is the live path, so the toggle belongs here: if everything
  // selected is already a favourite, the action removes them.
  const allSelectedFav = () => {
    const ids = [...selected];
    return ids.length > 0 && ids.every(id => chats.find(c => c.id === id)?.favourite);
  };
  const bulkFav     = () => { const on = !allSelectedFav(); return bulkRun(id => { patch(id, { favourite: on }); return setFavourite(id, on); }); };
  const bulkMute    = () => bulkRun(id => { patch(id, { muted: true });    return muteChat(id, true); });
  const bulkArchive = () => bulkRun(id => { patch(id, { archived: true }); return archiveChat(id, true); });
  const bulkDelete  = () => {
    const ids = [...selected];
    Alert.alert(`Delete ${ids.length} chat${ids.length > 1 ? 's' : ''}?`, 'They stay reachable from Hidden chats.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        exitSelect();
        setChats(prev => prev.filter(c => !ids.includes(c.id)));
        for (const id of ids) { try { await setHidden(id, true); } catch {} }
        fetchList();
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

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <AuroraBackground variant="chats" />
      {selectMode ? (
        <View style={S.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <TouchableOpacity onPress={exitSelect} hitSlop={8} accessibilityLabel="Cancel selection"><Ionicons name="close" size={24} color={colors.text} /></TouchableOpacity>
            <Text style={S.title}>{selected.size}</Text>
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
                onPress={() => { const [a, b] = [...selected]; exitSelect(); router.push({ pathname: '/split', params: { a, b } } as any); }}
                style={[S.headerBtn, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}
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
                <Text style={{ color: selected.size === 2 ? colors.primary : colors.textDim, fontSize: 13 }}>
                  {selected.size === 2 ? 'Split' : 'Pick 2'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={bulkPin} style={S.headerBtn} accessibilityLabel="Pin selected chats"><Ionicons name="pin" size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkFav} style={S.headerBtn} accessibilityLabel={allSelectedFav() ? 'Remove selected chats from favourites' : 'Add selected chats to favourites'}><Ionicons name={allSelectedFav() ? 'heart' : 'heart-outline'} size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkMute} style={S.headerBtn} accessibilityLabel="Mute selected chats"><Ionicons name="notifications-off-outline" size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkArchive} style={S.headerBtn} accessibilityLabel="Archive selected chats"><Ionicons name="archive-outline" size={20} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={bulkDelete} style={S.headerBtn} accessibilityLabel="Delete selected chats"><Ionicons name="trash-outline" size={20} color={colors.danger} /></TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={S.header}>
          <Text style={S.title}>Chats</Text>
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
                accessibilityLabel="Split view: pick two chats"
              >
                <Ionicons name="git-compare-outline" size={22} color={colors.text} />
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => router.push('/search' as any)} style={S.headerBtn} accessibilityLabel="Search"><Ionicons name="search" size={22} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/alerts' as any)} style={S.headerBtn} accessibilityLabel="Alerts"><Ionicons name="notifications-outline" size={22} color={colors.text} /></TouchableOpacity>
            {/* Was the Mini Apps shortcut. Dropped, not lost — /mini is the
                centre tab ("Apps"), so it already had a permanent home and this
                was a second door to the same room. The header slot buys more as
                a temporary chat, which has no entry point at all otherwise. */}
            <TouchableOpacity onPress={() => setTempSheet(true)} style={S.headerBtn} accessibilityLabel="Start a temporary chat"><Ionicons name="timer-outline" size={22} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/contacts' as any)} style={S.headerBtn} accessibilityLabel="Contacts"><Ionicons name="people-outline" size={22} color={colors.text} /></TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/broadcast' as any)} style={S.headerBtn} accessibilityLabel="New broadcast"><Ionicons name="megaphone-outline" size={22} color={colors.text} /></TouchableOpacity>
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
          onPress={() => router.push('/group-invitations' as any)}
          activeOpacity={0.8}
          style={S.inviteBanner}
        >
          <Ionicons name="mail-unread-outline" size={18} color={colors.primary} />
          <Text style={S.inviteBannerTxt}>
            {pendingInvites === 1 ? '1 group invitation' : `${pendingInvites} group invitations`}
          </Text>
          <Text style={S.inviteBannerCta}>View</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.primary} />
        </TouchableOpacity>
      )}

      {error && <View style={S.errorBar}><Text style={S.errorTxt}>{error}</Text></View>}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.folderScroll} contentContainerStyle={S.folderRow}>
        {FOLDERS.map(f => {
          const count = f.id === 'unread' ? chats.filter(c => !c.archived && c.unreadCount > 0).length
            : f.id === 'favourites' ? chats.filter(c => !c.archived && c.favourite).length
            : f.id === 'pinned' ? chats.filter(c => !c.archived && c.pinned).length
            : f.id === 'archive' ? chats.filter(c => c.archived).length : 0;
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
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>No chats yet</Text>
          <Text style={S.emptySub}>Tap the button below to start one.</Text>
          <TouchableOpacity style={S.emptyBtn} onPress={onNewChat} activeOpacity={0.85}><Text style={S.emptyBtnTxt}>Start a chat</Text></TouchableOpacity>
        </View>
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
              ? <Text numberOfLines={1} style={S.sectionHeader}>{section.title}</Text> : <View style={{ height: 4 }} />}
          renderItem={({ item }) => (
            <ChatRow
              chat={item}
              authHeader={authHeader}
              draft={drafts[item.id]}
              lastMsg={lastMsgs.get(item.id)}
              meId={meId}
              isTyping={typingChats.has(item.id)}
              selectMode={selectMode}
              isSelected={selected.has(item.id)}
              onPress={() => selectMode ? toggleSelect(item.id) : onOpenChat(item.id)}
              onAvatarPress={() => selectMode ? toggleSelect(item.id) : onAvatarPress(item)}
              onLongPress={() => selectMode ? toggleSelect(item.id) : enterSelect(item.id)}
              onPin={() => doPin(item)}
              onMute={() => doMute(item)}
              onArchive={() => doArchive(item)}
              onDelete={() => doDelete(item)}
            />
          )}
          ItemSeparatorComponent={() => <View style={S.separator} />}
          contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE + 16 }}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          removeClippedSubviews
          maxToRenderPerBatch={12}
          windowSize={11}
          initialNumToRender={14}
        />
      )}

      <TouchableOpacity style={S.fab} onPress={onNewChat} activeOpacity={0.85} accessibilityLabel="New chat">
        <Ionicons name="create-outline" size={26} color="#fff" />
      </TouchableOpacity>

      {/* Long-press action sheet (WhatsApp-style) */}
      <Modal visible={!!menuChat} transparent animationType="fade" onRequestClose={() => setMenuChat(null)}>
        <Pressable style={S.sheetBackdrop} onPress={() => setMenuChat(null)}>
          <Pressable style={S.sheet} onPress={() => {}}>
            <View style={S.sheetHandle} />
            <Text style={S.sheetTitle} numberOfLines={1}>
              {menuChat ? (menuChat.type === 'direct' ? (menuChat.peerName || menuChat.name || 'Direct chat') : (menuChat.name || 'Group chat')) : ''}
            </Text>
            <SheetItem icon={menuChat?.pinned ? 'pin' : 'pin-outline'} label={menuChat?.pinned ? 'Unpin' : 'Pin'} onPress={() => { const c = menuChat!; setMenuChat(null); doPin(c); }} />
            <SheetItem icon={menuChat?.favourite ? 'heart' : 'heart-outline'} label={menuChat?.favourite ? 'Remove from favourites' : 'Add to favourites'} onPress={() => { const c = menuChat!; setMenuChat(null); doFavourite(c); }} />
            <SheetItem icon={menuChat?.muted ? 'notifications-outline' : 'notifications-off-outline'} label={menuChat?.muted ? 'Unmute' : 'Mute'} onPress={() => { const c = menuChat!; setMenuChat(null); doMute(c); }} />
            <SheetItem icon={menuChat?.archived ? 'archive' : 'archive-outline'} label={menuChat?.archived ? 'Unarchive' : 'Archive'} onPress={() => { const c = menuChat!; setMenuChat(null); doArchive(c); }} />
            <SheetItem icon="trash-outline" label="Delete chat" danger onPress={() => { const c = menuChat!; setMenuChat(null); doDelete(c); }} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Temporary chat — pick how long messages live, then pick who with.
          The duration is carried to /new-chat and applied to whichever chat is
          opened there, so the choice is made once and cannot be forgotten
          halfway through. Values are the chat's existing disappearing-messages
          timer, not a new mechanism: the server already expires on
          chats.disappearing_seconds. */}
      <Modal visible={tempSheet} transparent animationType="fade" onRequestClose={() => setTempSheet(false)}>
        <Pressable style={S.sheetBackdrop} onPress={() => setTempSheet(false)}>
          <Pressable style={S.sheet} onPress={() => {}}>
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
          </Pressable>
        </Pressable>
      </Modal>

      {/* Avatar photo popup (WhatsApp-style) — photo + quick actions */}
      <Modal visible={!!avatarView} transparent animationType="fade" onRequestClose={() => setAvatarView(null)}>
        <Pressable style={S.avBackdrop} onPress={() => setAvatarView(null)}>
          {avatarView && (() => {
            const av = avatarView;
            const isDirect = av.type === 'direct';
            const avTitle = isDirect ? (av.peerName || av.name || 'Direct chat') : (av.name || 'Group chat');
            const avPhoto = isDirect ? av.peerPhotoURL : av.photoURL;
            const peerUid = av.peerUserId ?? '';
            const go = (fn: () => void) => { setAvatarView(null); fn(); };
            return (
              <Pressable style={S.avCard} onPress={() => {}}>
                <View style={S.avImgWrap}>
                  {avPhoto && authHeader ? (
                    <Image source={{ uri: attachmentUrl(avPhoto), headers: { Authorization: authHeader } }} style={S.avImg} contentFit="cover" cachePolicy="memory-disk" />
                  ) : (
                    <View style={[S.avImg, S.avInitials]}><Text style={S.avInitialsTxt}>{(avTitle.trim()[0] ?? '?').toUpperCase()}</Text></View>
                  )}
                  <View style={S.avNameBar}><Text style={S.avNameTxt} numberOfLines={1}>{avTitle}</Text></View>
                </View>
                <View style={S.avActions}>
                  <TouchableOpacity style={S.avActionBtn} onPress={() => go(() => onOpenChat(av.id))}>
                    <Ionicons name="chatbubble-ellipses" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Message</Text>
                  </TouchableOpacity>
                  {isDirect && (
                    <>
                      <TouchableOpacity style={S.avActionBtn} onPress={() => go(() => router.push({ pathname: '/voicecall' as any, params: { chatId: av.id, peerUid, peerName: avTitle } }))}>
                        <Ionicons name="call" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Audio</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={S.avActionBtn} onPress={() => go(() => router.push({ pathname: '/videocall' as any, params: { chatId: av.id, peerUid, peerName: avTitle } }))}>
                        <Ionicons name="videocam" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Video</Text>
                      </TouchableOpacity>
                    </>
                  )}
                  <TouchableOpacity style={S.avActionBtn} onPress={() => go(() => isDirect
                    ? router.push({ pathname: '/contact-info' as any, params: { chatId: av.id, peerUid, peerName: avTitle } })
                    // group-info reads `id`, not `chatId` — see app/chat.tsx.
                    : router.push({ pathname: '/group-info' as any, params: { id: av.id } }))}>
                    <Ionicons name="information-circle" size={22} color={colors.primary} /><Text style={S.avActionTxt}>Info</Text>
                  </TouchableOpacity>
                </View>
              </Pressable>
            );
          })()}
        </Pressable>
      </Modal>
    </View>
  );
}

function SheetItem({ icon, label, onPress, danger }: { icon: any; label: string; onPress: () => void; danger?: boolean }) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <TouchableOpacity style={S.sheetItem} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={22} color={danger ? colors.danger : colors.text} />
      <Text style={[S.sheetItemTxt, danger && { color: colors.danger }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const ChatRow = memo(function ChatRow({
  chat, authHeader, draft, lastMsg, meId, isTyping, selectMode, isSelected, onPress, onAvatarPress, onLongPress, onPin, onMute, onArchive, onDelete,
}: {
  chat: ChatSummary; authHeader: string | null; draft?: string; lastMsg?: LastMsg; meId?: string | null; isTyping?: boolean;
  selectMode?: boolean; isSelected?: boolean;
  onPress: () => void; onAvatarPress: () => void; onLongPress: () => void; onPin: () => void; onMute: () => void; onArchive: () => void; onDelete: () => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  const swipeRef = useRef<Swipeable>(null);
  const title = chat.type === 'direct' ? (chat.peerName || chat.name || 'Direct chat') : (chat.name || 'Group chat');
  const avatarLetter = (title.trim()[0] ?? '#').toUpperCase();
  const photoId = chat.type === 'direct' ? chat.peerPhotoURL : chat.photoURL;
  const showPhoto = !!photoId && !!authHeader;
  const time = chat.lastMessageAt ? formatRelative(chat.lastMessageAt) : '';
  const draftText = draft && draft.trim() ? draft.trim() : '';
  // Real last-message preview from the local plaintext cache (WhatsApp-style).
  const previewBody = (() => {
    if (!lastMsg) return chat.lastMessageId ? 'Tap to open chat' : 'No messages yet';
    // famEvent envelopes are hidden from the thread, so they must not become a
    // row's "last message" TEXT either. This is a PREVIEW-ONLY fix: the row's
    // sort position and unread badge come from the server's chat.lastMessageAt/
    // unreadCount, which the server cannot correct for famEvent specifically —
    // it never sees plaintext content (E2EE), so it cannot tell a famEvent
    // system message apart from any other. A crossing can still bump a chat to
    // the top and mark it unread; opening it then shows nothing new. Accepted
    // trade-off, not silently swept: the alternative (client-side markRead up
    // to the famEvent's id) would also retroactively mark any REAL unread
    // message with a lower id as read, which is worse.
    if (isFamEvent(lastMsg.type, lastMsg.content)) {
      return 'Tap to open chat';
    }
    const t = lastMsg.type;
    // content is null for a text message whose ciphertext couldn't be decrypted
    // (the cache layer withholds raw envelopes) — show a lock, never blank/JSON.
    const textFallback = lastMsg.content || (chat.lastMessageId ? '🔒 Encrypted message' : '');
    const label = t === 'image' ? '📷 Photo'
      : t === 'video' ? '🎥 Video'
      : t === 'audio' ? '🎙️ Voice message'
      : t === 'file' ? '📎 File'
      : t === 'vaultbeam' ? '📦 File'
      : t === 'location' ? '📍 Location'
      : t === 'poll' ? '📊 Poll'
      : t === 'sticker' ? 'Sticker'
      : textFallback;
    const mine = !!meId && lastMsg.senderId === meId;
    return (mine ? 'You: ' : '') + label;
  })();
  const preview = draftText || previewBody;

  const close = () => swipeRef.current?.close();
  const act = (fn: () => void) => { close(); fn(); };

  const leftActions = () => (
    <View style={S.actionsRow}>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.primary }]} onPress={() => act(onPin)}>
        <Ionicons name={chat.pinned ? 'pin' : 'pin-outline'} size={20} color="#fff" /><Text style={S.actionLbl}>{chat.pinned ? 'Unpin' : 'Pin'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.purple }]} onPress={() => act(onMute)}>
        <Ionicons name={chat.muted ? 'notifications-outline' : 'notifications-off-outline'} size={20} color="#fff" /><Text style={S.actionLbl}>{chat.muted ? 'Unmute' : 'Mute'}</Text>
      </TouchableOpacity>
    </View>
  );
  const rightActions = () => (
    <View style={S.actionsRow}>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.surfaceSolid }]} onPress={() => act(onArchive)}>
        <Ionicons name={chat.archived ? 'archive' : 'archive-outline'} size={20} color="#fff" /><Text style={S.actionLbl}>{chat.archived ? 'Unarchive' : 'Archive'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.danger }]} onPress={() => act(onDelete)}>
        <Ionicons name="trash-outline" size={20} color="#fff" /><Text style={S.actionLbl}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Swipeable ref={swipeRef} enabled={!selectMode} renderLeftActions={leftActions} renderRightActions={rightActions} overshootLeft={false} overshootRight={false} friction={2}>
      <TouchableOpacity style={[S.row, isSelected && S.rowSelected]} onPress={onPress} onLongPress={onLongPress} delayLongPress={250} activeOpacity={0.7}>
        <TouchableOpacity style={S.avatarWrap} activeOpacity={0.7} onPress={onAvatarPress} accessibilityLabel="Open profile photo">
          <Avatar
            ring
            uri={showPhoto ? attachmentUrl(photoId!) : null}
            headers={authHeader ? { Authorization: authHeader } : undefined}
            name={title}
            size={50}
            presence={chat.type === 'direct' && chat.peerOnline ? 'online' : null}
            anon={!!chat.anonMasked}
          />
          {selectMode && (
            <View style={[S.selBadge, isSelected ? S.selBadgeOn : S.selBadgeOff]}>
              {isSelected && <Ionicons name="checkmark" size={13} color="#fff" />}
            </View>
          )}
        </TouchableOpacity>

        <View style={S.rowBody}>
          <View style={S.rowTop}>
            <Text style={S.rowName} numberOfLines={1}>{title}</Text>
            {/* THE FLAGS SHARE ONE BOX, and it is not decoration.
                rowTop has `gap`, which applies between EVERY child — so three
                loose icons cost four gaps plus their own marginLefts, ~31dp of
                spacing in the row where the name is competing for width. The
                name is the only flexible child, so every one of those pixels
                came out of it and turned readable names into ellipses.
                Grouped, the outer row has three children and two gaps, and the
                cluster spaces itself tightly. flexShrink: 0 because status must
                not be squeezed away — the NAME is what may truncate. */}
            {(chat.expiresAt || chat.muted || chat.pinned) && (
              <View style={S.rowFlags}>
                {/* This chat deletes itself (migration 120). A timer icon in the
                    list, not just inside the chat: the whole conversation is
                    about to go, and finding that out only by opening it is
                    finding out too late. */}
                {chat.expiresAt && (
                  <Ionicons
                    name="timer-outline"
                    size={14}
                    color={new Date(chat.expiresAt).getTime() - Date.now() <= 600_000 ? colors.danger : colors.textFaint}
                  />
                )}
                {chat.muted && <Ionicons name="volume-mute" size={15} color={colors.textFaint} />}
                {chat.pinned && <Ionicons name="pin" size={14} color={colors.textFaint} />}
              </View>
            )}
            {/* Capped and unshrinkable. A timestamp is a fixed-width fact, but
                at a 130% system font scale it grew ~25% wider and took that
                width straight off the name. 1.15 keeps it legible without
                letting it eat the thing people actually read. */}
            <Text
              style={[S.rowTime, chat.unreadCount > 0 && { color: colors.primary, fontWeight: '700' }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.15}
            >
              {time}
            </Text>
          </View>
          <View style={S.rowBottom}>
            {isTyping ? (
              <Text style={[S.rowPreview, { color: colors.primary }]} numberOfLines={1}>typing…</Text>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                {!draftText && !!lastMsg && !!meId && lastMsg.senderId === meId && chat.type === 'direct' && (
                  <Ionicons
                    name={((chat.peerLastReadMessageId ?? 0) >= lastMsg.id || (chat.peerLastDeliveredMessageId ?? 0) >= lastMsg.id) ? 'checkmark-done' : 'checkmark'}
                    size={15}
                    color={(chat.peerLastReadMessageId ?? 0) >= lastMsg.id ? '#4A9FFF' : colors.textDim}
                    style={{ marginRight: 3 }}
                  />
                )}
                <Text style={[S.rowPreview, chat.unreadCount > 0 && S.rowPreviewUnread]} numberOfLines={1}>
                  {draftText ? <Text style={S.draftLabel}>Draft: </Text> : null}{preview}
                </Text>
              </View>
            )}
            {chat.unreadCount > 0 && (
              <View style={S.unreadBadge}><Text style={S.unreadTxt}>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</Text></View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}, (a, b) =>
  // Re-render a row ONLY when its own data changes — not when an unrelated chat
  // updates (typing, draft, unread on another row). Handler props are inline
  // closures keyed by the stable chat id, so we deliberately ignore them.
  a.chat === b.chat &&
  a.authHeader === b.authHeader &&
  a.draft === b.draft &&
  a.lastMsg === b.lastMsg &&
  a.meId === b.meId &&
  a.isTyping === b.isTyping &&
  a.selectMode === b.selectMode &&
  a.isSelected === b.isSelected,
);

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso); const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'now';
    if (diff < 86400_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diff < 7 * 86400_000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  } catch { return ''; }
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  center: { justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: HEADER_TOP, paddingBottom: 14 },
  title: { color: c.text, fontSize: 28, fontWeight: '800' },
  headerBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  // Avatar photo popup
  avBackdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center', padding: 28 },
  avCard:       { width: '100%', maxWidth: 360, borderRadius: 16, overflow: 'hidden', backgroundColor: c.surfaceSolid },
  avImgWrap:    { width: '100%', aspectRatio: 1, backgroundColor: c.primary },
  avImg:        { width: '100%', height: '100%' },
  avInitials:   { alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  avInitialsTxt:{ color: '#fff', fontSize: 84, fontWeight: '800' },
  avNameBar:    { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(0,0,0,0.45)' },
  avNameTxt:    { color: '#fff', fontSize: 19, fontWeight: '700' },
  avActions:    { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, backgroundColor: c.surfaceSolid },
  avActionBtn:  { alignItems: 'center', gap: 4, paddingHorizontal: 6 },
  avActionTxt:  { color: c.primary, fontSize: 12, fontWeight: '600' },
  headerBtnTxt: { fontSize: 17 },
  inviteBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 11,
    backgroundColor: brandAlpha(0.10),
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke,
  },
  inviteBannerTxt: { flex: 1, color: c.text, fontSize: 14, fontWeight: '600' },
  inviteBannerCta: { color: c.primary, fontSize: 13, fontWeight: '800' },
  errorBar: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, padding: 10, borderRadius: 10 },
  errorTxt: { color: c.danger, fontSize: 12 },

  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  emptyBtn: { backgroundColor: c.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  emptyBtnTxt: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },

  folderScroll: { flexGrow: 0, maxHeight: 50 },   // keep the chip row compact, never stretch vertically
  folderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 8, gap: 8 },

  sectionHeader: { color: c.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', paddingHorizontal: 22, paddingTop: 14, paddingBottom: 6, backgroundColor: 'transparent' },
  // Inset = paddingLeft 12 + avatar 50 + gap 12, so the rule starts under the
  // text exactly like spec §6.4's 79. Was 88, left over from the 22pt padding.
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.hairline, marginLeft: 74 },

  // Aurora Glass: rows are undecorated on purpose. No fill, no border, no
  // shadow — the ground and the avatar ring carry the design, so the list stays
  // legible at a glance and costs nothing to scroll.
  // Geometry from Figma `ChatRow` (node 5:2) = WhatsApp spec §6.4: a FIXED
  // 72pt row, 12 padding, 12 gap. Was 76/22/14 — drift, not a decision.
  // minHeight, NOT height. The design says 72 and lib/responsiveLayout's
  // guard says never pin a row that holds text: at 130% OS font scale a
  // fixed 72 clips the name and the preview, which spec §10 forbids and
  // which this repo already has a failing test for. 72 is the resting
  // height — the rhythm the design wants — and the row grows only for a
  // reader who needs it.
  row: { flexDirection: 'row', minHeight: 72, paddingHorizontal: 12, alignItems: 'center', gap: 12, backgroundColor: 'transparent' },
  rowSelected: { backgroundColor: brandAlpha(0.14) },
  avatarWrap: { width: 50, height: 50 },
  selBadge: { position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.bg },
  selBadgeOn: { backgroundColor: c.primary },
  selBadgeOff: { backgroundColor: c.surfaceSolid, borderColor: c.textDim },
  avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarGroup: { backgroundColor: c.accent },
  avatarImg: { width: '100%', height: '100%' },
  avatarTxt: { color: '#FFFFFF', fontSize: 20, fontWeight: '800' },
  presenceDot: { position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: c.online, borderWidth: 2.5, borderColor: c.bg },

  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowPin: { fontSize: 11 },
  rowName: { color: c.text, fontSize: 17, lineHeight: 22, fontWeight: '600', flex: 1, minWidth: 0 },
  rowMuted: { fontSize: 12 },
  // flexShrink: 0 — the name is the flexible child and the only thing that may
  // truncate. marginLeft:'auto' is gone: it dates from when the name took its
  // natural width, and with the name at flex:1 there is no free space left for
  // an auto margin to absorb.
  rowTime: { color: c.textFaint, fontSize: 12.5, lineHeight: 16, flexShrink: 0 },
  // One box for the timer/mute/pin glyphs, tightly spaced among themselves, so
  // rowTop's gap is paid twice instead of four times.
  rowFlags: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowPreview: { color: c.textDim, fontSize: 14, lineHeight: 19, flex: 1, minWidth: 0 },
  rowPreviewUnread: { color: c.text, fontWeight: '600' },
  // Long-press action sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32, paddingTop: 10 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginBottom: 8 },
  sheetTitle: { color: c.textDim, fontSize: 13, fontWeight: '700', paddingHorizontal: 20, paddingVertical: 10 },
  sheetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 6, marginHorizontal: 20 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 15 },
  sheetItemTxt: { color: c.text, fontSize: 16, fontWeight: '500' },
  draftLabel: { color: c.danger, fontWeight: '700' },
  unreadBadge: { backgroundColor: c.primary, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  unreadTxt: { color: '#FFFFFF', fontSize: 11, lineHeight: 14, fontWeight: '600' },

  actionsRow: { flexDirection: 'row' },
  action: { width: 76, alignItems: 'center', justifyContent: 'center', gap: 4 },
  actionIcon: { fontSize: 20 },
  actionLbl: { color: '#fff', fontSize: 11, fontWeight: '700' },

  fab: { position: 'absolute', right: 22, bottom: TAB_BAR_SPACE + 18, width: 60, height: 60, borderRadius: 30, backgroundColor: c.accentDeep, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, elevation: 8, shadowColor: c.accentDeep, shadowOpacity: 0.55, shadowOffset: { width: 0, height: 10 }, shadowRadius: 24 },
  fabTxt: { fontSize: 22 },
});
