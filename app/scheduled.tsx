// app/scheduled.tsx — Pending scheduled messages (Postgres).
//
// Lists all of my pending scheduled messages + recently-delivered ones
// (last 7 days). Tap a pending row to cancel it. Recently-sent rows are
// read-only confirmation that delivery fired. Reloads on focus, so a message
// scheduled from a chat shows up on return.
//
// The plain AsyncStorage list cache holds rows WITHOUT bodies; previews are
// re-read from the sender's local copy (lib/scheduledLocalCopy.ts) on paint.

import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
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
import { readCache, writeCache } from '../lib/localCache';
import {
  cancelScheduledMessage,
  listScheduledMessages,
  looksEncrypted,
  type ScheduledMessageRow,
} from '../lib/chatService';
import { getScheduledCopy, deleteScheduledCopy, pruneScheduledCopies } from '../lib/scheduledLocalCopy';
import { isChatLocked } from '../lib/chatLock';
import { AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { userErrorText } from '../lib/userErrorText';

const CACHE_KEY = 'scheduled';
/** GET /user/scheduled-messages returns at most this many rows (LIMIT 200). */
const SERVER_LIST_LIMIT = 200;

const withoutContent = (rows: ScheduledMessageRow[]) => rows.map(r => ({ ...r, content: null }));

/** Shown instead of the preview of a message scheduled into a locked chat. */
const LOCKED_TEXT = '🔒 Locked chat';

// The server holds E2E ciphertext; show the sender's own local plaintext copy,
// and never the ciphertext itself. A locked chat's preview is not shown here
// without unlocking it; an unreadable lock table counts as locked, as in
// bookmarks and reminders.
async function withLocalCopies(rows: ScheduledMessageRow[]): Promise<ScheduledMessageRow[]> {
  const lockedIds = new Set<string>();
  await Promise.all([...new Set(rows.map(r => r.chatId))].map(async id => {
    if (await isChatLocked(id).catch(() => true)) lockedIds.add(id);
  }));
  return Promise.all(rows.map(async r => {
    if (lockedIds.has(r.chatId)) return { ...r, content: LOCKED_TEXT };
    // A media row's content (caption/meta) is ciphertext too: never print it.
    if (r.type !== 'text') return r.content && looksEncrypted(r.content) ? { ...r, content: null } : r;
    const plain = await getScheduledCopy(String(r.id));
    if (plain != null) return { ...r, content: plain };
    return r.content && !looksEncrypted(r.content) ? r : { ...r, content: '🔒 Encrypted scheduled message' };
  }));
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ScheduledScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [rows,       setRows]       = useState<ScheduledMessageRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  // Set once the server answered, so a slower cache read cannot paint over it.
  const loadedRef = useRef(false);
  // Read in load's catch (outside any state updater, so StrictMode's double
  // invoke of updaters cannot run the side effect twice).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The cache paint and every load await storage and the network; none may
  // set state after the screen has closed.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const server = await listScheduledMessages();
      if (!alive.current) return;
      loadedRef.current = true;
      // Local copies of rows the server no longer lists (delivered > 7 days ago)
      // are dropped — but only from a complete list, never a truncated one.
      if (server.length < SERVER_LIST_LIMIT) pruneScheduledCopies(server.map(r => String(r.id))).catch(() => {});
      const list = await withLocalCopies(server);
      if (!alive.current) return;
      setRows(list);
      setError(null);
      writeCache(CACHE_KEY, withoutContent(list));
    } catch (e: any) {
      if (!alive.current) return;
      // Keep cached rows if we have them: over rows the error is a one-line
      // "Couldn't refresh"; on a cold load it is the full error state.
      setError(rowsRef.current.length ? "Couldn't refresh — showing the saved list. Pull down to try again."
        : userErrorText(e, 'Your scheduled messages could not be loaded.'));
    }
  }, []);

  // Paint the cached rows (no bodies) while the first server load runs.
  useEffect(() => {
    (async () => {
      const cached = await readCache<ScheduledMessageRow[]>(CACHE_KEY);
      if (!cached || loadedRef.current) return;
      // Older builds cached decrypted previews here; scrub them.
      if (cached.some(r => r.content != null)) writeCache(CACHE_KEY, withoutContent(cached));
      const rowsFromCache = await withLocalCopies(withoutContent(cached));
      if (loadedRef.current || !alive.current) return;
      setRows(rowsFromCache);
      setLoading(false);
    })();
  }, []);

  // The one server load: on first focus, and again on every return (e.g. after
  // scheduling from a chat).
  useFocusEffect(useCallback(() => {
    load().finally(() => { if (alive.current) setLoading(false); });
  }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (alive.current) setRefreshing(false);
  }, [load]);

  const removeRow = useCallback(async (row: ScheduledMessageRow) => {
    await cancelScheduledMessage(row.id);
    await deleteScheduledCopy(String(row.id));
    if (alive.current) setRows(prev => prev.filter(r => r.id !== row.id));
  }, []);

  const onCancel = useCallback((row: ScheduledMessageRow) => {
    Alert.alert(
      'Cancel scheduled message?',
      `"${(row.content || '').slice(0, 80) || row.type}" — scheduled for ${new Date(row.sendAt).toLocaleString()}.`,
      [
        { text: 'Cancel message', style: 'destructive', onPress: async () => {
          try { await removeRow(row); } catch (e: any) { Alert.alert('Could not cancel', `The message is still scheduled. ${userErrorText(e, 'Please try again.')}`); }
        } },
        { text: 'Keep', style: 'cancel' },
      ],
    );
  }, [removeRow]);

  const renderItem = useCallback(({ item: r }: { item: ScheduledMessageRow }) => (
    <TouchableOpacity
      style={[S.row, r.sentAt && S.rowSent]}
      onPress={() => r.sentAt ? null : onCancel(r)}
      disabled={!!r.sentAt}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${r.chatName || (r.chatType === 'group' ? 'Group' : 'Direct chat')}${r.sentAt ? ', delivered' : ''}: ${r.type === 'text' ? (r.content || 'empty message') : typeLabel(r.type)}. ${r.sentAt ? `Sent ${new Date(r.sentAt).toLocaleString()}` : `Sends ${formatFuture(r.sendAt)}`}`}
      accessibilityState={{ disabled: !!r.sentAt }}
      accessibilityHint={r.sentAt ? undefined : `Cancel the message scheduled to ${r.chatName || 'this chat'}`}
    >
      <View style={{ flex: 1 }}>
        <Text style={S.rowChatName} numberOfLines={1}>
          {r.chatName || (r.chatType === 'group' ? 'Group' : 'Direct chat')}
          {r.sentAt && <Text style={S.deliveredTag}>  · ✓ delivered</Text>}
        </Text>
        <Text style={S.rowContent} numberOfLines={2}>
          {r.type === 'text' ? (r.content || '(empty)') : `${typeLabel(r.type)}${r.content ? ' · ' + r.content : ''}`}
        </Text>
        <Text style={S.rowWhen}>
          {r.sentAt
            ? `Sent ${new Date(r.sentAt).toLocaleString()}`
            : `Sends ${formatFuture(r.sendAt)}`}
        </Text>
      </View>
      {!r.sentAt && <Text style={S.cancelTxt}>Cancel</Text>}
    </TouchableOpacity>
  ), [S, onCancel]);

  if (loading) {
    return <View style={[S.screen, S.center]}>
      <AuroraBackground /><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  const pending = rows.filter(r => !r.sentAt);
  const sent    = rows.filter(r =>  r.sentAt);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Scheduled</Text>
      </View>

      {error && rows.length > 0 && <Text style={S.errorTxt} accessibilityRole="alert">{error}</Text>}

      {rows.length === 0 ? (
        <ScrollView
          contentContainerStyle={[S.center, { flexGrow: 1, padding: 32, gap: 12 }]}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {error ? (
            // A failed cold load is not "No scheduled messages".
            <>
              <Ionicons name="cloud-offline-outline" size={48} color={colors.danger} />
              <Text style={S.emptyTitle}>{"Couldn't load scheduled messages"}</Text>
              <Text style={S.emptySub} accessibilityRole="alert">{error}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: refreshing }} disabled={refreshing} onPress={onRefresh} style={S.retryBtn}>
                <Text style={S.retryTxt}>Try again</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Ionicons name="time-outline" size={48} color={colors.primary} />
              <Text style={S.emptyTitle}>No scheduled messages</Text>
              <Text style={S.emptySub}>
                Open any chat, tap ⋮ and choose “Schedule a message” to send one later.
              </Text>
            </>
          )}
        </ScrollView>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ paddingBottom: SCREEN_BOTTOM + 16 }}
          ListHeaderComponent={
            <View style={S.intro}>
              <Text style={S.introTxt}>
                {pending.length} pending · {sent.length} delivered in the last 7 days
              </Text>
            </View>
          }
          renderItem={renderItem}
        />
      )}
    </View>
  );
}

function typeLabel(t: ScheduledMessageRow['type']): string {
  switch (t) {
    case 'image': return '📷 Photo';
    case 'video': return '🎥 Video';
    case 'audio': return '🎙️ Voice';
    case 'file':  return '📎 File';
    case 'system': return 'System';
    default:      return 'Text';
  }
}

function formatFuture(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const ms = t - Date.now();
    if (ms <= 0)             return 'any moment';
    if (ms < 60_000)         return `in ${Math.max(1, Math.floor(ms / 1000))}s`;
    if (ms < 3600_000)       return `in ${Math.floor(ms / 60_000)}m`;
    if (ms < 86400_000)      return `in ${Math.floor(ms / 3600_000)}h`;
    if (ms < 7 * 86400_000)  return `in ${Math.floor(ms / 86400_000)}d`;
    return `at ${new Date(iso).toLocaleString()}`;
  } catch { return ''; }
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:       { width: 44, height: 44, borderRadius: 16, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  errorTxt:      { color: c.danger, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },
  emptyTitle:    { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:      { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retryBtn:      { minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  retryTxt:      { color: c.onPrimary, fontWeight: '700' },

  intro:         { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  introTxt:      { color: c.textDim, fontSize: 12 },

  row:           { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 10, padding: 16, borderRadius: 20, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  rowSent:       { backgroundColor: c.glass },
  rowChatName:   { color: c.text, fontSize: 15, fontWeight: '600' },
  rowContent:    { color: c.text, fontSize: 14, lineHeight: 20, marginTop: 4 },
  rowWhen:       { color: c.textDim, fontSize: 12, marginTop: 6 },
  deliveredTag:  { color: c.success, fontSize: 12, fontWeight: '700' },
  cancelTxt:     { color: c.danger, fontSize: 12, fontWeight: '700' },
});
