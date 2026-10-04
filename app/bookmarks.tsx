// app/bookmarks.tsx — Saved messages (Postgres).
//
// Lists every bookmark across all chats, newest first. Tap a row to open the
// chat scrolled to that message (setPendingJump). Long-press, or the screen
// reader "Remove bookmark" action, removes it. Each row shows chat name, the
// message preview and relative time.
//
// Bodies come from the sealed local snapshot (lib/bookmarkBodies.ts); the
// plain AsyncStorage list cache holds rows WITHOUT bodies.

import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  dropBookmarkPlaintext,
  getBookmarkPlaintext,
  listBookmarks,
  looksEncrypted,
  removeBookmark,
  type BookmarkRow,
} from '../lib/chatService';
import { readCache, writeCache } from '../lib/localCache';
import { bookmarkBody, hasBodies, isProtectedMessage, withoutBodies } from '../lib/bookmarkBodies';
import { setPendingJump } from '../lib/chatJump';
import { isChatLocked } from '../lib/chatLock';
import { getCachedMessagesByIds, visibleCachedChatIds } from '../lib/localDb';
import { AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { userErrorText } from '../lib/userErrorText';

/** Shown instead of the body of a bookmark from a locked or hidden chat. */
const LOCKED_TEXT = '🔒 Locked chat';
/** Shown instead of the body of a view-once or Invisible Ink message. */
const PROTECTED_TEXT = '🔒 Protected message';

// Fill each row's body from the sealed local snapshot (or a non-ciphertext
// server body). Rows whose body is unreadable show their type label instead.
// A locked chat's body is not shown here without unlocking it; an unreadable
// lock table counts as locked (lib/chatLock fails closed). A hidden (PIN-gated)
// chat is masked the same way: only chats the main list may show
// (visibleCachedChatIds) are shown, and an unreadable chat table masks all.
async function withBodies(rows: BookmarkRow[]): Promise<BookmarkRow[]> {
  const chatIds = [...new Set(rows.flatMap(b => (b.message ? [b.message.chatId] : [])))];
  const lockedIds = new Set<string>();
  const visible = await visibleCachedChatIds().catch(() => null);
  // The server's meta is only the routing subset (lib/msgEnvelope
  // META_PUBLIC_KEYS): it carries viewOnce but NOT invisibleInk, which rides
  // inside the ciphertext. So the protected check also reads this phone's
  // decrypted copy of each message, where both flags are.
  const localMeta = new Map<number, unknown>();
  await Promise.all(chatIds.map(async id => {
    if (visible === null || !visible.has(id) || await isChatLocked(id).catch(() => true)) lockedIds.add(id);
    const ids = rows.flatMap(b => (b.message?.chatId === id ? [Number(b.message.id)] : []));
    for (const m of await getCachedMessagesByIds(id, ids).catch(() => [])) localMeta.set(m.id, m.meta);
  }));
  return Promise.all(rows.map(async (b) => {
    const id = Number(b.message?.id ?? 0);
    if (!b.message || !id) return b;
    // Hidden AND purged: a view-once / ink snapshot from before Star stopped
    // taking them must not outlive the bubble. The bookmark itself stays.
    // Purged before the lock check, so a locked chat's snapshot goes too.
    const isProtected = isProtectedMessage(b.message.meta) || isProtectedMessage(localMeta.get(id));
    if (isProtected) void dropBookmarkPlaintext(id).catch(() => {});
    if (lockedIds.has(b.message.chatId)) return { ...b, message: { ...b.message, content: LOCKED_TEXT } };
    if (isProtected) return { ...b, message: { ...b.message, content: PROTECTED_TEXT } };
    const local = await getBookmarkPlaintext(id);
    return { ...b, message: { ...b.message, content: bookmarkBody(b.message.content, local, looksEncrypted) } };
  }));
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function BookmarksScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [rows,       setRows]       = useState<BookmarkRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  // The server could not be reached, so the rows are the saved copy.
  const [stale,      setStale]      = useState(false);
  // load() awaits storage and the network; none of it may set state after the
  // screen has closed.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const load = useCallback(async () => {
    // Local-first: paint cached bookmarks instantly, then fetch fresh.
    const cached = await readCache<BookmarkRow[]>('bookmarks');
    // An empty saved list is a cold load: a failure must show the error, not
    // "Couldn't refresh" over "No bookmarks yet".
    const hasCache = !!cached?.length;
    if (cached && hasCache) {
      // Older builds cached decrypted bodies here; scrub them on first read.
      if (hasBodies(cached)) writeCache('bookmarks', withoutBodies(cached));
      const painted = await withBodies(withoutBodies(cached));
      if (!alive.current) return;
      setRows(painted);
      setLoading(false);
    }
    try {
      const fresh = await listBookmarks();
      // A bookmarked message's ciphertext is reclaimed on delivery like every
      // other message — bookmarks are deliberately NOT a server-side archive —
      // and while it exists it is ciphertext. The local snapshot taken at
      // bookmark time is the readable copy, and preferring it is what keeps a
      // saved message saved.
      const hydrated = await withBodies(fresh);
      if (!alive.current) return;
      setRows(hydrated);
      writeCache('bookmarks', withoutBodies(hydrated));
      setError(null);
      setStale(false);
    } catch (e: any) {
      if (!alive.current) return;
      // Keep cached rows for offline read, and say they are the saved copy.
      if (hasCache) setStale(true);
      else setError(userErrorText(e, 'Your bookmarks could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); if (alive.current) setLoading(false); })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (alive.current) setRefreshing(false);
  }, [load]);

  const onRow = useCallback((b: BookmarkRow) => {
    if (!b.message) {
      Alert.alert('Unavailable', 'The original message is no longer available.');
      return;
    }
    // chat.tsx consumes this on focus and scrolls to the message.
    if (Number(b.message.id) > 0) setPendingJump(b.message.chatId, Number(b.message.id));
    router.push({ pathname: '/chat', params: { id: b.message.chatId } });
  }, [router]);

  const onLongPress = useCallback((b: BookmarkRow) => {
    Alert.alert(
      'Remove bookmark?',
      'The saved message will be removed from your bookmarks. The original message is not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: async () => {
            try {
              await removeBookmark(b.id, Number(b.message?.id) || null);
              const next = rowsRef.current.filter(r => r.id !== b.id);
              writeCache('bookmarks', withoutBodies(next)); // keep instant-paint cache consistent
              if (alive.current) setRows(prev => prev.filter(r => r.id !== b.id));
            } catch (e: any) {
              Alert.alert('Could not remove the bookmark', userErrorText(e, 'Please try again.'));
            }
          }
        },
      ],
    );
  }, []);

  const renderItem = useCallback(({ item: b }: { item: BookmarkRow }) => (
    <TouchableOpacity
      style={S.row}
      onPress={() => onRow(b)}
      onLongPress={() => onLongPress(b)}
      delayLongPress={300}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${b.message?.chatName || (b.message?.chatType === 'group' ? 'Group' : 'Direct chat')}: ${b.message
        ? b.message.deletedAt ? 'message deleted by sender' : (b.message.content || typeLabel(b.message.type))
        : 'message no longer available'}. Saved ${formatAgo(b.createdAt)}`}
      accessibilityHint="Opens the chat at this message"
      accessibilityActions={[{ name: 'remove', label: 'Remove bookmark' }]}
      onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'remove') onLongPress(b); }}
    >
      <View style={S.iconBox}><Ionicons name="bookmark-outline" size={22} color={colors.primary} /></View>
      <View style={{ flex: 1 }}>
        <Text style={S.rowChat} numberOfLines={1}>
          {b.message?.chatName
            || (b.message?.chatType === 'group' ? 'Group' : 'Direct chat')}
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
  ), [S, colors.primary, onRow, onLongPress]);

  if (loading) {
    return <View style={[S.screen, S.center]}>
      <AuroraBackground /><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Bookmarks</Text>
      </View>

      {stale && (
        <Text style={S.staleTxt} accessibilityRole="alert">
          {"Couldn't refresh — showing your saved copy. Pull down to try again."}
        </Text>
      )}

      {rows.length === 0 ? (
        <ScrollView
          contentContainerStyle={[S.center, { flexGrow: 1, padding: 32, gap: 12 }]}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {error ? (
            // A failed load is not "No bookmarks yet".
            <>
              <Ionicons name="cloud-offline-outline" size={48} color={colors.danger} />
              <Text style={S.emptyTitle}>{"Couldn't load bookmarks"}</Text>
              <Text style={S.emptySub} accessibilityRole="alert">{error}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: refreshing }} disabled={refreshing} onPress={onRefresh} style={S.retryBtn}>
                <Text style={S.retryTxt}>Try again</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Ionicons name="bookmark-outline" size={48} color={colors.primary} />
              <Text style={S.emptyTitle}>No bookmarks yet</Text>
              <Text style={S.emptySub}>
                Long-press any message in a chat and choose Star to save it here.
              </Text>
            </>
          )}
        </ScrollView>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(b) => b.id}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: SCREEN_BOTTOM + 16 }}
          renderItem={renderItem}
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


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:      { width: 44, height: 44, borderRadius: 16, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  title:        { color: c.text, fontSize: 22, fontWeight: '800' },

  staleTxt:     { color: c.textDim, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },
  retryBtn:     { minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  retryTxt:     { color: c.onPrimary, fontWeight: '700' },
  emptyTitle:   { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:     { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  row:          { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginHorizontal: 16, marginBottom: 10, padding: 16, borderRadius: 20, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  iconBox:      { width: 36, height: 36, borderRadius: 18, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  rowChat:      { color: c.text, fontSize: 16, fontWeight: '700' },
  rowContent:   { color: c.text, fontSize: 14, lineHeight: 20, marginTop: 4 },
  rowWhen:      { color: c.textDim, fontSize: 12, marginTop: 6 },
});
