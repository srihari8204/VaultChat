// app/message-reminder.tsx — Per-message reminders (client-only).
//
// Two modes:
//   With ?chatId + ?messageId + ?preview   → composer: pick a time, save.
//   Without params                         → list: pending reminders + cancel.
//
// Storage: AsyncStorage list of { id, chatId, messageId, preview, when }.
// Schedule: expo-notifications scheduleNotificationAsync with
//   data: { chatId, messageId } so the existing root tap handler routes
//   back into the chat when the user taps the notification.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui';

const STORAGE_KEY = 'vc_message_reminders_v1';

interface ReminderRow {
  id:        string;     // expo-notifications identifier
  chatId:    string;
  messageId: string;
  preview:   string;
  when:      string;     // ISO timestamp
  createdAt: string;
}

const PRESETS: { label: string; mins: number }[] = [
  { label: 'In 30 minutes', mins: 30 },
  { label: 'In 1 hour',     mins: 60 },
  { label: 'In 3 hours',    mins: 180 },
  { label: 'Tonight at 8 PM',  mins: -1 },
  { label: 'Tomorrow 9 AM',    mins: -2 },
];

function whenFor(mins: number): Date {
  const now = new Date();
  if (mins === -1) {
    const t = new Date(now); t.setHours(20, 0, 0, 0);
    if (t.getTime() <= now.getTime() + 60_000) t.setDate(t.getDate() + 1);
    return t;
  }
  if (mins === -2) {
    const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
    return t;
  }
  return new Date(now.getTime() + mins * 60_000);
}

async function loadReminders(): Promise<ReminderRow[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ReminderRow[];
    // Drop any rows whose scheduled time has already passed (the notification
    // either fired or was cancelled; we don't need to keep them around).
    const now = Date.now();
    return list.filter(r => new Date(r.when).getTime() > now - 60_000);
  } catch { return []; }
}

async function saveReminders(list: ReminderRow[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function MessageReminderScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { chatId, messageId, preview } = useLocalSearchParams<{
    chatId?: string; messageId?: string; preview?: string;
  }>();

  const composeMode = !!(chatId && messageId);

  if (composeMode) return <Composer chatId={chatId!} messageId={messageId!} preview={preview ?? ''} router={router} />;
  return <RemindersList router={router} />;
}

function Composer({
  chatId, messageId, preview, router,
}: {
  chatId: string; messageId: string; preview: string; router: any;
}) {
  const S = useS();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);

  const schedule = useCallback(async (mins: number) => {
    if (busy) return;
    const when = whenFor(mins);
    if (when.getTime() <= Date.now()) {
      Alert.alert('Pick a future time', 'That preset has already passed today.');
      return;
    }
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) {
      const req = await Notifications.requestPermissionsAsync();
      if (!req.granted) {
        Alert.alert('Permission needed', 'Allow notifications so we can remind you on time.');
        return;
      }
    }

    setBusy(true);
    try {
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: '🔖 Message reminder',
          body:  preview ? `"${preview.slice(0, 140)}"` : 'You wanted a reminder about this message.',
          // Root layout's attachTapHandler reads data.chatId and routes
          // to /chat?id=<chatId> when the user taps the notification.
          data:  { chatId, messageId },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when } as any,
      });

      const list = await loadReminders();
      list.push({
        id, chatId, messageId, preview, when: when.toISOString(),
        createdAt: new Date().toISOString(),
      });
      await saveReminders(list);

      Alert.alert('Reminder set', `We'll notify you ${when.toLocaleString()}.`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert('Could not schedule', e?.message ?? 'Try again');
    } finally {
      setBusy(false);
    }
  }, [busy, chatId, messageId, preview, router]);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <StatusBar barStyle="light-content" />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Remind me about</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <View style={S.previewCard}>
          <Text style={S.previewLabel}>MESSAGE</Text>
          <Text style={S.previewBody} numberOfLines={4}>{preview || '(no preview)'}</Text>
        </View>

        <Text style={[S.previewLabel, { marginTop: 20 }]}>WHEN</Text>
        <View style={S.gridCol}>
          {PRESETS.map(p => {
            const when = whenFor(p.mins);
            return (
              <TouchableOpacity
                key={p.label}
                style={[S.preset, busy && S.presetOff]}
                onPress={() => schedule(p.mins)}
                disabled={busy}
                activeOpacity={0.85}
              >
                <Text style={S.presetLabel}>{p.label}</Text>
                <Text style={S.presetSub}>{when.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {busy && (
          <View style={S.busy}>
            <ActivityIndicator color={colors.primary} />
            <Text style={S.busyTxt}>Scheduling…</Text>
          </View>
        )}

        <Text style={S.note}>
          Reminders are device-only — they fire as a local notification at the
          chosen time and tap-open the chat. See all pending at <Text style={{ color: colors.primary }}>/message-reminder</Text>.
        </Text>
      </ScrollView>
    </View>
  );
}

function RemindersList({ router }: { router: any }) {
  const S = useS();
  const { colors } = useTheme();
  const [rows,    setRows]    = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const list = await loadReminders();
    setRows(list.sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime()));
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
  }, [load]);

  const cancel = useCallback((r: ReminderRow) => {
    Alert.alert('Cancel reminder?', r.preview || 'You won\'t be notified at the chosen time.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel', style: 'destructive', onPress: async () => {
          try { await Notifications.cancelScheduledNotificationAsync(r.id); } catch {}
          const next = (await loadReminders()).filter(x => x.id !== r.id);
          await saveReminders(next);
          setRows(next);
        }
      },
    ]);
  }, []);

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Reminders</Text>
      </View>

      {rows.length === 0 ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>No reminders set</Text>
          <Text style={S.emptySub}>
            Long-press any message in a chat → ⏰ Remind me about this — pick a time.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          renderItem={({ item: r }) => (
            <TouchableOpacity style={S.row} onPress={() => cancel(r)} activeOpacity={0.7}>
              <View style={S.iconBox}><Text style={S.iconTxt}>⏰</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowWhen} numberOfLines={1}>
                  Fires {new Date(r.when).toLocaleString()}
                </Text>
                <Text style={S.rowPreview} numberOfLines={2}>
                  {r.preview || '(no preview)'}
                </Text>
                <Text style={S.rowSub}>Tap to cancel</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  backBtn:      { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:      { color: c.text, fontSize: 26, fontWeight: '600' },
  title:        { color: c.text, fontSize: 22, fontWeight: '800' },

  previewCard:  { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 12 },
  previewLabel: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 6 },
  previewBody:  { color: c.text, fontSize: 14, lineHeight: 20 },

  gridCol:      { gap: 8 },
  preset:       { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  presetOff:    { opacity: 0.5 },
  presetLabel:  { color: c.text, fontSize: 15, fontWeight: '700' },
  presetSub:    { color: c.textDim, fontSize: 12, marginTop: 2 },

  busy:         { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' },
  busyTxt:      { color: c.textDim, fontSize: 12 },
  note:         { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 24 },

  emptyTitle:   { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:     { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  row:          { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  iconBox:      { width: 36, height: 36, borderRadius: 18, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
  iconTxt:      { fontSize: 18 },
  rowWhen:      { color: c.text, fontSize: 14, fontWeight: '700' },
  rowPreview:   { color: c.text, fontSize: 13, marginTop: 4 },
  rowSub:       { color: c.textDim, fontSize: 11, marginTop: 6 },
});
