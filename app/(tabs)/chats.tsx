// app/(tabs)/chats.tsx — Phase 3a chat list (Postgres backend).
//
// Talks to /chats (REST) for the list, listens on Socket.IO for `new_message`
// to refresh in real time. No Firebase. Tap a row → /chat?id=...
// FAB → /new-chat (email-based picker, since contact sync is still dark).

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getAccessToken } from '../../lib/api';
import { attachmentUrl, listChats, type ChatSummary } from '../../lib/chatService';
import { registerPushToken } from '../../lib/push';
import { getSocket } from '../../lib/socket';

export default function ChatsScreen() {
  const router = useRouter();
  const [chats,   setChats]   = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  // Auth header for the <Image> source so avatars come through /uploads.
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
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load chats');
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchList();
      setLoading(false);
    })();
  }, [fetchList]);

  // Register this device for push notifications (idempotent on the backend
  // via INSERT ... ON CONFLICT). Fire-and-forget on first chats-screen mount.
  useEffect(() => {
    registerPushToken().catch(() => {});
  }, []);

  // Live updates: any new message anywhere → refresh list (cheap, ~one query)
  // Presence updates: patch the peer's online/lastSeenAt in place — no refetch.
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const s = await getSocket();
        const refresh = () => { fetchList(); };
        const onPresence = (e: { userId: string; online: boolean; lastSeenAt: string | null }) => {
          if (!e?.userId) return;
          setChats(prev => prev.map(c => c.peerUserId === e.userId
            ? { ...c, peerOnline: e.online, peerLastSeenAt: e.lastSeenAt ?? c.peerLastSeenAt }
            : c
          ));
        };
        s.on('new_message',       refresh);
        s.on('message_deleted',   refresh);
        s.on('message_edited',    refresh);
        s.on('presence_changed',  onPresence);
        if (!cancelled) {
          off = () => {
            s.off('new_message',     refresh);
            s.off('message_deleted', refresh);
            s.off('message_edited',  refresh);
            s.off('presence_changed', onPresence);
          };
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Realtime unavailable');
      }
    })();
    return () => { cancelled = true; if (off) off(); };
  }, [fetchList]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchList();
    setRefreshing(false);
  }, [fetchList]);

  const onOpenChat = (id: string) => {
    router.push({ pathname: '/chat', params: { id } } as any);
  };

  const onNewChat = () => router.push('/new-chat' as any);

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={ACCENT} size="large" />
      </View>
    );
  }

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.title}>Chats</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={() => router.push('/search' as any)} activeOpacity={0.7} style={S.headerBtn}>
            <Text style={S.headerBtnTxt}>🔍</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/contacts' as any)} activeOpacity={0.7} style={S.headerBtn}>
            <Text style={S.headerBtnTxt}>📇</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onNewChat} activeOpacity={0.7} style={S.headerBtn}>
            <Text style={S.headerBtnTxt}>＋</Text>
          </TouchableOpacity>
        </View>
      </View>

      {error && (
        <View style={S.errorBar}>
          <Text style={S.errorTxt}>{error}</Text>
        </View>
      )}

      {chats.length === 0 ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>No chats yet</Text>
          <Text style={S.emptySub}>Tap ＋ to start one. You'll need the other person's email — they have to be signed up too.</Text>
          <TouchableOpacity style={S.emptyBtn} onPress={onNewChat} activeOpacity={0.85}>
            <Text style={S.emptyBtnTxt}>Start a chat</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <ChatRow chat={item} authHeader={authHeader} onPress={() => onOpenChat(item.id)} />}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={<RefreshControl tintColor={ACCENT} refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}

      <TouchableOpacity style={S.fab} onPress={onNewChat} activeOpacity={0.85}>
        <Text style={S.fabTxt}>＋</Text>
      </TouchableOpacity>
    </View>
  );
}

function ChatRow({ chat, authHeader, onPress }: { chat: ChatSummary; authHeader: string | null; onPress: () => void }) {
  // For direct chats prefer the peer's name. For groups use the chat name.
  const title = chat.type === 'direct'
    ? (chat.peerName || chat.name || 'Direct chat')
    : (chat.name || 'Group chat');
  const subtitle = chat.lastMessageAt
    ? formatRelative(chat.lastMessageAt)
    : `Created ${formatRelative(chat.createdAt)}`;
  const avatarLetter = useMemo(() => (title.trim()[0] ?? '#').toUpperCase(), [title]);
  // photo: groups use chat.photoURL, directs use peerPhotoURL
  const photoId = chat.type === 'direct' ? chat.peerPhotoURL : chat.photoURL;
  const showPhoto = !!photoId && !!authHeader;

  return (
    <TouchableOpacity style={S.row} onPress={onPress} activeOpacity={0.7}>
      <View style={S.avatarWrap}>
        <View style={[S.avatar, chat.type === 'group' && S.avatarGroup]}>
          {showPhoto ? (
            <Image
              source={{ uri: attachmentUrl(photoId!), headers: { Authorization: authHeader! } }}
              style={S.avatarImg}
            />
          ) : (
            <Text style={S.avatarTxt}>{avatarLetter}</Text>
          )}
        </View>
        {chat.type === 'direct' && chat.peerOnline && <View style={S.presenceDot} />}
      </View>
      <View style={S.rowBody}>
        <View style={S.rowTop}>
          <Text style={S.rowName} numberOfLines={1}>{title}</Text>
          <Text style={S.rowTime}>{subtitle}</Text>
        </View>
        <View style={S.rowBottom}>
          <Text style={S.rowPreview} numberOfLines={1}>
            {chat.lastMessageId ? `Message #${chat.lastMessageId}` : 'No messages yet'}
          </Text>
          {chat.unreadCount > 0 && (
            <View style={S.unreadBadge}>
              <Text style={S.unreadTxt}>{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function formatRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000) return 'now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
    if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d`;
    return new Date(iso).toLocaleDateString();
  } catch { return ''; }
}

const DARK_BG = '#0D0F14';
const CARD_BG = '#161A22';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';
const DANGER  = '#EF4444';

const S = StyleSheet.create({
  screen:        { flex: 1, backgroundColor: DARK_BG },
  center:        { justifyContent: 'center', alignItems: 'center' },
  header:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16 },
  title:         { color: TEXT, fontSize: 28, fontWeight: '800' },
  headerBtn:     { width: 40, height: 40, borderRadius: 20, backgroundColor: CARD_BG, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: BORDER },
  headerBtnTxt:  { color: ACCENT, fontSize: 22, fontWeight: '600', marginTop: -2 },
  errorBar:      { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, padding: 10, borderRadius: 10 },
  errorTxt:      { color: DANGER, fontSize: 12 },

  emptyTitle:    { color: TEXT, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:      { color: SUBTLE, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  emptyBtn:      { backgroundColor: ACCENT, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  emptyBtnTxt:   { color: '#fff', fontWeight: '700', fontSize: 14 },

  row:           { flexDirection: 'row', paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', gap: 12 },
  avatarWrap:    { width: 52, height: 52 },
  avatar:        { width: 52, height: 52, borderRadius: 26, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarGroup:   { backgroundColor: '#22C55E' },
  avatarImg:     { width: '100%', height: '100%' },
  avatarTxt:     { color: '#fff', fontSize: 20, fontWeight: '700' },
  presenceDot:   { position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, borderRadius: 7, backgroundColor: '#22C55E', borderWidth: 2, borderColor: DARK_BG },
  rowBody:       { flex: 1, gap: 4 },
  rowTop:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rowName:       { color: TEXT, fontSize: 16, fontWeight: '600', flex: 1 },
  rowTime:       { color: SUBTLE, fontSize: 12, marginLeft: 8 },
  rowBottom:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowPreview:    { color: SUBTLE, fontSize: 13, flex: 1 },
  unreadBadge:   { backgroundColor: ACCENT, borderRadius: 10, minWidth: 20, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center' },
  unreadTxt:     { color: '#fff', fontSize: 11, fontWeight: '700' },

  fab:           { position: 'absolute', right: 24, bottom: 96, width: 56, height: 56, borderRadius: 28, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', elevation: 8, shadowColor: '#000', shadowOpacity: 0.3, shadowOffset: { width: 0, height: 4 }, shadowRadius: 8 },
  fabTxt:        { color: '#fff', fontSize: 28, fontWeight: '600', marginTop: -2 },
});
