// app/(tabs)/chats.tsx — WhatsApp-style chat list (Obsidian Aurora).
//
// Postgres backend (/chats REST + Socket.IO new_message/presence). Swipe
// right → Pin / Mute; swipe left → Archive / Delete(hide). Sticky "Pinned"
// and "All Chats" sections. FAB → /new-chat. Data wiring (presence, folders,
// pin/archive/mute/hidden, unread) is preserved from the previous version.

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Pressable, RefreshControl, ScrollView, SectionList,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { Avatar } from '../../components/ui';
import { getAccessToken } from '../../lib/api';
import {
  archiveChat, attachmentUrl, listChats, muteChat, pinChat, setHidden,
  type ChatSummary,
} from '../../lib/chatService';
import { registerPushToken } from '../../lib/push';
import { getSocket } from '../../lib/socket';
import { setUnreadTotal } from '../../lib/unreadStore';
import { getDraftMap } from '../../lib/drafts';

type FolderId = 'all' | 'unread' | 'groups' | 'pinned' | 'archive';
const FOLDERS: { id: FolderId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'groups', label: 'Groups' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'archive', label: 'Archive' },
];

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
  const [menuChat, setMenuChat] = useState<ChatSummary | null>(null);   // long-press action sheet

  useEffect(() => {
    let cancel = false;
    (async () => {
      const tok = await getAccessToken();
      if (!cancel) setAuthHeader(tok ? `Bearer ${tok}` : null);
    })();
    return () => { cancel = true; };
  }, []);

  const fetchList = useCallback(async () => {
    try {
      const list = await listChats();
      setChats(list);
      setError(null);
      // Publish total unread (non-archived) so the Chats tab can badge it.
      setUnreadTotal(list.reduce((n, c) => n + (c.archived ? 0 : (c.unreadCount > 0 ? 1 : 0)), 0));
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load chats');
    }
  }, []);

  useEffect(() => { (async () => { setLoading(true); await fetchList(); setLoading(false); })(); }, [fetchList]);

  // Refresh the list (so unread counts clear after reading) + draft previews
  // whenever the screen regains focus — e.g. coming back from a chat.
  useFocusEffect(useCallback(() => {
    fetchList();
    getDraftMap().then(setDrafts).catch(() => {});
  }, [fetchList]));
  useEffect(() => { registerPushToken().catch(() => {}); }, []);

  // Realtime: new messages refresh the list; presence patches in place.
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const s = await getSocket();
        const refresh = () => fetchList();
        const onPresence = (e: { userId: string; online: boolean; lastSeenAt: string | null }) => {
          if (!e?.userId) return;
          setChats(prev => prev.map(c => c.peerUserId === e.userId
            ? { ...c, peerOnline: e.online, peerLastSeenAt: e.lastSeenAt ?? c.peerLastSeenAt } : c));
        };
        s.on('new_message', refresh);
        s.on('message_deleted', refresh);
        s.on('message_edited', refresh);
        s.on('presence_changed', onPresence);
        if (!cancelled) off = () => {
          s.off('new_message', refresh); s.off('message_deleted', refresh);
          s.off('message_edited', refresh); s.off('presence_changed', onPresence);
        };
      } catch (e: any) { if (!cancelled) setError(e?.message ?? 'Realtime unavailable'); }
    })();
    return () => { cancelled = true; if (off) off(); };
  }, [fetchList]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchList(); setRefreshing(false); }, [fetchList]);
  const onOpenChat = (id: string) => router.push({ pathname: '/chat', params: { id } } as any);
  const onNewChat = () => router.push('/new-chat' as any);

  // Optimistic chat-row actions with rollback.
  const patch = (id: string, fields: Partial<ChatSummary>) =>
    setChats(prev => prev.map(c => c.id === id ? { ...c, ...fields } : c));

  const doPin = async (chat: ChatSummary) => {
    const next = !chat.pinned;
    patch(chat.id, { pinned: next });
    try { await pinChat(chat.id, next); await fetchList(); }
    catch (e: any) { patch(chat.id, { pinned: !next }); setError(e?.message ?? 'Pin failed'); }
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

  const visibleChats = useMemo(() => {
    if (folder === 'archive') return chats.filter(c => c.archived);
    const base = chats.filter(c => !c.archived);
    switch (folder) {
      case 'unread': return base.filter(c => c.unreadCount > 0);
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
      <View style={S.header}>
        <Text style={S.title}>Chats</Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <TouchableOpacity onPress={() => router.push('/search' as any)} style={S.headerBtn}><Ionicons name="search" size={22} color={colors.text} /></TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/contacts' as any)} style={S.headerBtn}><Ionicons name="people-outline" size={22} color={colors.text} /></TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/broadcast' as any)} style={S.headerBtn}><Ionicons name="megaphone-outline" size={22} color={colors.text} /></TouchableOpacity>
        </View>
      </View>

      {error && <View style={S.errorBar}><Text style={S.errorTxt}>{error}</Text></View>}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.folderScroll} contentContainerStyle={S.folderRow}>
        {FOLDERS.map(f => {
          const count = f.id === 'unread' ? chats.filter(c => !c.archived && c.unreadCount > 0).length
            : f.id === 'pinned' ? chats.filter(c => !c.archived && c.pinned).length
            : f.id === 'archive' ? chats.filter(c => c.archived).length : 0;
          const active = folder === f.id;
          return (
            <TouchableOpacity key={f.id} onPress={() => setFolder(f.id)} activeOpacity={0.7} style={[S.folderChip, active && S.folderChipActive]}>
              <Text style={[S.folderTxt, active && S.folderTxtActive]}>{f.label}</Text>
              {count > 0 && f.id !== 'all' && f.id !== 'groups' && (
                <Text style={[S.folderCount, active && S.folderCountActive]}>{count}</Text>
              )}
            </TouchableOpacity>
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
              ? <Text style={S.sectionHeader}>{section.title}</Text> : <View style={{ height: 4 }} />}
          renderItem={({ item }) => (
            <ChatRow
              chat={item}
              authHeader={authHeader}
              draft={drafts[item.id]}
              onPress={() => onOpenChat(item.id)}
              onLongPress={() => setMenuChat(item)}
              onPin={() => doPin(item)}
              onMute={() => doMute(item)}
              onArchive={() => doArchive(item)}
              onDelete={() => doDelete(item)}
            />
          )}
          ItemSeparatorComponent={() => <View style={S.separator} />}
          contentContainerStyle={{ paddingBottom: 110 }}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          removeClippedSubviews
          maxToRenderPerBatch={12}
          windowSize={11}
          initialNumToRender={14}
        />
      )}

      <TouchableOpacity style={S.fab} onPress={onNewChat} activeOpacity={0.85}>
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
            <SheetItem icon={menuChat?.muted ? 'notifications-outline' : 'notifications-off-outline'} label={menuChat?.muted ? 'Unmute' : 'Mute'} onPress={() => { const c = menuChat!; setMenuChat(null); doMute(c); }} />
            <SheetItem icon={menuChat?.archived ? 'archive' : 'archive-outline'} label={menuChat?.archived ? 'Unarchive' : 'Archive'} onPress={() => { const c = menuChat!; setMenuChat(null); doArchive(c); }} />
            <SheetItem icon="trash-outline" label="Delete chat" danger onPress={() => { const c = menuChat!; setMenuChat(null); doDelete(c); }} />
          </Pressable>
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

function ChatRow({
  chat, authHeader, draft, onPress, onLongPress, onPin, onMute, onArchive, onDelete,
}: {
  chat: ChatSummary; authHeader: string | null; draft?: string;
  onPress: () => void; onLongPress: () => void; onPin: () => void; onMute: () => void; onArchive: () => void; onDelete: () => void;
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
  const preview = draftText || (chat.unreadCount > 0 ? 'New messages' : (chat.lastMessageId ? 'Tap to open chat' : 'No messages yet'));

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
      <TouchableOpacity style={[S.action, { backgroundColor: '#475569' }]} onPress={() => act(onArchive)}>
        <Ionicons name={chat.archived ? 'archive' : 'archive-outline'} size={20} color="#fff" /><Text style={S.actionLbl}>{chat.archived ? 'Unarchive' : 'Archive'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[S.action, { backgroundColor: colors.danger }]} onPress={() => act(onDelete)}>
        <Ionicons name="trash-outline" size={20} color="#fff" /><Text style={S.actionLbl}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Swipeable ref={swipeRef} renderLeftActions={leftActions} renderRightActions={rightActions} overshootLeft={false} overshootRight={false} friction={2}>
      <TouchableOpacity style={S.row} onPress={onPress} onLongPress={onLongPress} delayLongPress={250} activeOpacity={0.7}>
        <View style={S.avatarWrap}>
          <Avatar
            uri={showPhoto ? attachmentUrl(photoId!) : null}
            headers={authHeader ? { Authorization: authHeader } : undefined}
            name={title}
            size={50}
            presence={chat.type === 'direct' && chat.peerOnline ? 'online' : null}
          />
        </View>

        <View style={S.rowBody}>
          <View style={S.rowTop}>
            {chat.pinned && <Text style={S.rowPin}>📌</Text>}
            <Text style={S.rowName} numberOfLines={1}>{title}</Text>
            {chat.muted && <Text style={S.rowMuted}>🔇</Text>}
            <Text style={S.rowTime}>{time}</Text>
          </View>
          <View style={S.rowBottom}>
            <Text style={[S.rowPreview, chat.unreadCount > 0 && S.rowPreviewUnread]} numberOfLines={1}>
              {draftText ? <Text style={S.draftLabel}>Draft: </Text> : null}{preview}
            </Text>
            {chat.unreadCount > 0 && (
              <View style={S.unreadBadge}><Text style={S.unreadTxt}>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</Text></View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}

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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 56, paddingBottom: 12 },
  title: { color: c.text, fontSize: 28, fontWeight: '800' },
  headerBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
  headerBtnTxt: { fontSize: 17 },
  errorBar: { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, padding: 10, borderRadius: 10 },
  errorTxt: { color: c.danger, fontSize: 12 },

  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub: { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  emptyBtn: { backgroundColor: c.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  emptyBtnTxt: { color: '#04130D', fontWeight: '800', fontSize: 14 },

  folderScroll: { flexGrow: 0, maxHeight: 50 },   // keep the chip row compact, never stretch vertically
  folderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  folderChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
  folderChipActive: { backgroundColor: c.primary, borderColor: c.primary },
  folderTxt: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  folderTxtActive: { color: '#04130D' },
  folderCount: { color: c.textDim, fontSize: 11, fontWeight: '700', backgroundColor: c.surface, paddingHorizontal: 6, borderRadius: 8, overflow: 'hidden', minWidth: 18, textAlign: 'center' },
  folderCountActive: { color: c.primary, backgroundColor: '#04130D' },

  sectionHeader: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6, backgroundColor: c.bg },
  separator: { height: 0.5, backgroundColor: c.separator, marginLeft: 82 },

  row: { flexDirection: 'row', height: 72, paddingHorizontal: 12, alignItems: 'center', gap: 12, backgroundColor: c.bg },
  avatarWrap: { width: 50, height: 50 },
  avatar: { width: 50, height: 50, borderRadius: 25, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarGroup: { backgroundColor: c.accent },
  avatarImg: { width: '100%', height: '100%' },
  avatarTxt: { color: '#04130D', fontSize: 20, fontWeight: '800' },
  presenceDot: { position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: c.online, borderWidth: 2.5, borderColor: c.bg },

  rowBody: { flex: 1, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowPin: { fontSize: 11 },
  rowName: { color: c.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  rowMuted: { fontSize: 12 },
  rowTime: { color: c.textFaint, fontSize: 12, marginLeft: 'auto' },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowPreview: { color: c.textDim, fontSize: 14, flex: 1 },
  rowPreviewUnread: { color: c.text, fontWeight: '600' },
  // Long-press action sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32, paddingTop: 10 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginBottom: 8 },
  sheetTitle: { color: c.textDim, fontSize: 13, fontWeight: '700', paddingHorizontal: 20, paddingVertical: 10 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 15 },
  sheetItemTxt: { color: c.text, fontSize: 16, fontWeight: '500' },
  draftLabel: { color: c.danger, fontWeight: '700' },
  unreadBadge: { backgroundColor: c.primary, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  unreadTxt: { color: '#04130D', fontSize: 12, fontWeight: '800' },

  actionsRow: { flexDirection: 'row' },
  action: { width: 76, alignItems: 'center', justifyContent: 'center', gap: 4 },
  actionIcon: { fontSize: 20 },
  actionLbl: { color: '#fff', fontSize: 11, fontWeight: '700' },

  fab: { position: 'absolute', right: 20, bottom: 92, width: 58, height: 58, borderRadius: 29, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', elevation: 8, shadowColor: c.primary, shadowOpacity: 0.4, shadowOffset: { width: 0, height: 4 }, shadowRadius: 10 },
  fabTxt: { fontSize: 22 },
});
