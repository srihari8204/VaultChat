// app/scheduled.tsx — Pending scheduled messages (Postgres).
//
// Lists all of my pending scheduled messages + recently-delivered ones
// (last 7 days). Tap a pending row to cancel it. Recently-sent rows are
// read-only confirmation that delivery fired.

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
  cancelScheduledMessage,
  listScheduledMessages,
  type ScheduledMessageRow,
} from '../lib/chatService';

export default function ScheduledScreen() {
  const router = useRouter();
  const [rows,       setRows]       = useState<ScheduledMessageRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await listScheduledMessages();
      setRows(list);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load');
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

  const onCancel = useCallback((row: ScheduledMessageRow) => {
    Alert.alert(
      'Cancel scheduled message?',
      `"${(row.content || '').slice(0, 80) || row.type}" — scheduled for ${new Date(row.sendAt).toLocaleString()}.`,
      [
        { text: 'Keep', style: 'cancel' },
        { text: 'Cancel message', style: 'destructive', onPress: async () => {
            try {
              await cancelScheduledMessage(row.id);
              setRows(prev => prev.filter(r => r.id !== row.id));
            } catch (e: any) {
              Alert.alert('Could not cancel', e?.message ?? 'Try again');
            }
          }
        },
      ],
    );
  }, []);

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={ACCENT} size="large" /></View>;
  }

  const pending = rows.filter(r => !r.sentAt);
  const sent    = rows.filter(r =>  r.sentAt);

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <Text style={S.title}>Scheduled</Text>
      </View>

      {error && <Text style={S.errorTxt}>{error}</Text>}

      {rows.length === 0 ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>No scheduled messages</Text>
          <Text style={S.emptySub}>
            Open any chat, long-press the Send button, and pick a future time to schedule a message.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          refreshControl={<RefreshControl tintColor={ACCENT} refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListHeaderComponent={
            <View style={S.intro}>
              <Text style={S.introTxt}>
                {pending.length} pending · {sent.length} delivered in the last 7 days
              </Text>
            </View>
          }
          renderItem={({ item: r }) => (
            <TouchableOpacity
              style={[S.row, r.sentAt && S.rowSent]}
              onPress={() => r.sentAt ? null : onCancel(r)}
              disabled={!!r.sentAt}
              activeOpacity={0.7}
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
          )}
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

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: TEXT, fontSize: 26, fontWeight: '600' },
  title:         { color: TEXT, fontSize: 22, fontWeight: '800' },

  errorTxt:      { color: DANGER, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },
  emptyTitle:    { color: TEXT, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:      { color: SUBTLE, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  intro:         { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  introTxt:      { color: SUBTLE, fontSize: 12 },

  row:           { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  rowSent:       { opacity: 0.6 },
  rowChatName:   { color: TEXT, fontSize: 15, fontWeight: '600' },
  rowContent:    { color: TEXT, fontSize: 13, marginTop: 4 },
  rowWhen:       { color: SUBTLE, fontSize: 11, marginTop: 4 },
  deliveredTag:  { color: '#22C55E', fontSize: 11, fontWeight: '700' },
  cancelTxt:     { color: DANGER, fontSize: 12, fontWeight: '700' },
});
