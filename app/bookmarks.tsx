// app/bookmarks.tsx — Saved messages (Postgres).
//
// Lists every bookmark across all chats, newest first. Tap a row to jump
// to that chat (we don't auto-scroll to the bookmarked message yet — the
// chat thread loads from newest). Long-press to remove. Each row shows
// chat name + sender + the message preview + relative time.

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  listBookmarks,
  removeBookmark,
  type BookmarkRow,
} from '../lib/chatService';

export default function BookmarksScreen() {
  const router = useRouter();
  const [rows,       setRows]       = useState<BookmarkRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listBookmarks());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load bookmarks');
    }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const onRow = useCallback((b: BookmarkRow) => {
    if (!b.message) {
      Alert.alert('Unavailable', 'The original message is no longer available.');
      return;
    }
    router.push({ pathname: '/chat', params: { id: b.message.chatId } } as any);
  }, [router]);

  const onLongPress = useCallback((b: BookmarkRow) => {
    Alert.alert(
      'Remove bookmark?',
      'The saved message will be removed from your bookmarks. The original message is not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: async () => {
            try {
              await removeBookmark(b.id);
              setRows(prev => prev.filter(r => r.id !== b.id));
            } catch (e: any) {
              Alert.alert('Failed', e?.message ?? 'Try again');
            }
          }
        },
      ],
    );
  }, []);

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={ACCENT} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <Text style={S.title}>Bookmarks</Text>
      </View>

      {error && <Text style={S.errorTxt}>{error}</Text>}

      {rows.length === 0 ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>No bookmarks yet</Text>
          <Text style={S.emptySub}>
            Long-press any message in a chat → 🔖 Bookmark to save it here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(b) => b.id}
          refreshControl={<RefreshControl tintColor={ACCENT} refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ paddingBottom: 32 }}
          renderItem={({ item: b }) => (
            <TouchableOpacity
              style={S.row}
              onPress={() => onRow(b)}
              onLongPress={() => onLongPress(b)}
              delayLongPress={300}
              activeOpacity={0.7}
            >
              <View style={S.iconBox}><Text style={S.iconTxt}>🔖</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowChat} numberOfLines={1}>
                  {b.message?.chatName
                    || (b.message?.chatType === 'group' ? 'Group' : 'Direct chat')
                    || '(deleted chat)'}
                </Text>
                <Text style={S.rowContent} numberOfLines={2}>
                  {b.message
                    ? b.message.deletedAt
                      ? '(message deleted by sender)'
                      : (b.message.content || typeLabel(b.message.type))
                    : '(message no longer available)'}
                </Text>
                <Text style={S.rowWhen}>Saved {formatAgo(b.createdAt)}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

function typeLabel(t: string): string {
  switch (t) {
    case 'image':   return '📷 Photo';
    case 'video':   return '🎥 Video';
    case 'audio':   return '🎙️ Voice message';
    case 'file':    return '📎 File';
    case 'sticker': return '🎨 Sticker';
    default:        return '(no text)';
  }
}

function formatAgo(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)    return 'just now';
    if (diff < 3600_000)  return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
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
  screen:       { flex: 1, backgroundColor: DARK_BG },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  backBtn:      { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:      { color: TEXT, fontSize: 26, fontWeight: '600' },
  title:        { color: TEXT, fontSize: 22, fontWeight: '800' },

  errorTxt:     { color: DANGER, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },
  emptyTitle:   { color: TEXT, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:     { color: SUBTLE, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  row:          { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  iconBox:      { width: 36, height: 36, borderRadius: 18, backgroundColor: CARD_BG, alignItems: 'center', justifyContent: 'center' },
  iconTxt:      { fontSize: 18 },
  rowChat:      { color: TEXT, fontSize: 14, fontWeight: '700' },
  rowContent:   { color: TEXT, fontSize: 13, marginTop: 4 },
  rowWhen:      { color: SUBTLE, fontSize: 11, marginTop: 4 },
});
