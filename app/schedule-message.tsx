// app/schedule-message.tsx — Schedule a text message to a specific chat.
//
// Reachable from the chat composer (long-press Send). The list of all
// scheduled messages lives at /scheduled (separate screen).
//
// Backend route: POST /user/scheduled-messages
//   { chatId, sendAt, type: 'text', content }
// A 30-second sweep loop in server.js delivers when sendAt <= NOW().

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { scheduleEncryptedMessage } from '../lib/chatService';
import { putScheduledCopy } from '../lib/scheduledLocalCopy';
import { AuroraBackground } from '../components/ui';

const QUICK_TIMES: { label: string; mins: number }[] = [
  { label: 'In 30 min',      mins: 30 },
  { label: 'In 1 hour',      mins: 60 },
  { label: 'In 3 hours',     mins: 180 },
  { label: 'Tomorrow 9 AM',  mins: -1 },
  { label: 'Tomorrow 6 PM',  mins: -2 },
];

function scheduleTimeFor(mins: number): Date {
  const now = new Date();
  if (mins === -1) {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    return t;
  }
  if (mins === -2) {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(18, 0, 0, 0);
    return t;
  }
  return new Date(now.getTime() + mins * 60_000);
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ScheduleMessageScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { chatId, peerName, initial } = useLocalSearchParams<{ chatId?: string; peerName?: string; initial?: string }>();

  const [message,    setMessage]    = useState(typeof initial === 'string' ? initial : '');
  const [scheduling, setScheduling] = useState(false);
  const [customWhen, setCustomWhen] = useState<Date | null>(null);

  // Reliable delivery via the SERVER sweep (fires even if the app is killed),
  // kept E2E-encrypted: content is sealed on-device before upload, so the server
  // only forwards ciphertext at send time. A local plaintext copy powers the tray.
  const doSchedule = useCallback(async (when: Date) => {
    const text = message.trim();
    if (!text) { Alert.alert('Empty message', 'Type something before scheduling.'); return; }
    if (!chatId) { Alert.alert('Missing chat', 'No chat context — open this screen from a chat.'); return; }
    if (when.getTime() <= Date.now() + 5000) { Alert.alert('Pick a future time', 'Choose a time at least a moment ahead.'); return; }
    setScheduling(true);
    try {
      const row = await scheduleEncryptedMessage(chatId as string, text, when.toISOString());
      if (row?.id) await putScheduledCopy(String(row.id), text);   // sender's tray preview
      Alert.alert(
        'Scheduled',
        `Your message will be delivered ${when.toLocaleString()}.\n\nIt's end-to-end encrypted and sent by the server — it goes even if the app is closed.`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (e: any) {
      Alert.alert('Could not schedule', e?.message ?? 'Try again');
    } finally {
      setScheduling(false);
    }
  }, [chatId, message, router]);

  const sendIn = useCallback((mins: number) => doSchedule(scheduleTimeFor(mins)), [doSchedule]);

  // Custom date → then time → set as the chosen datetime (Android sequential pickers).
  const pickCustom = useCallback(() => {
    const base = customWhen ?? new Date(Date.now() + 60 * 60 * 1000);
    DateTimePickerAndroid.open({
      value: base, mode: 'date', minimumDate: new Date(),
      onChange: (_e, date) => {
        if (!date) return;
        DateTimePickerAndroid.open({
          value: base, mode: 'time', is24Hour: false,
          onChange: (_e2, time) => {
            if (!time) return;
            const when = new Date(date);
            when.setHours(time.getHours(), time.getMinutes(), 0, 0);
            setCustomWhen(when);
          },
        });
      },
    });
  }, [customWhen]);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <StatusBar barStyle="light-content" />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Schedule message</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={S.label}>TO</Text>
        <Text style={S.who}>{peerName || 'Chat'}</Text>

        <Text style={[S.label, { marginTop: 16 }]}>MESSAGE</Text>
        <TextInput
          style={S.input}
          value={message}
          onChangeText={setMessage}
          placeholder="What should we send?"
          placeholderTextColor={colors.textDim}
          multiline
          maxLength={4000}
        />

        <Text style={[S.label, { marginTop: 20 }]}>WHEN</Text>
        <View style={S.quickGrid}>
          {QUICK_TIMES.map(t => {
            const when = scheduleTimeFor(t.mins);
            return (
              <TouchableOpacity
                key={t.label}
                style={[S.quickBtn, scheduling && S.quickBtnOff]}
                onPress={() => sendIn(t.mins)}
                disabled={scheduling}
                activeOpacity={0.85}
              >
                <Text style={S.quickLabel}>{t.label}</Text>
                <Text style={S.quickSub}>{when.toLocaleString([], {
                  weekday: 'short', month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Custom date + time */}
        <Text style={[S.label, { marginTop: 20 }]}>CUSTOM DATE & TIME</Text>
        <TouchableOpacity style={S.customBtn} onPress={pickCustom} disabled={scheduling} activeOpacity={0.85}>
          <Ionicons name="calendar-outline" size={20} color={colors.primary} />
          <Text style={S.customTxt}>
            {customWhen
              ? customWhen.toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : 'Pick an exact date & time'}
          </Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
        {customWhen && (
          <TouchableOpacity
            style={[S.scheduleBtn, scheduling && S.quickBtnOff]}
            onPress={() => doSchedule(customWhen)}
            disabled={scheduling}
            activeOpacity={0.85}
          >
            <Text style={S.scheduleBtnTxt}>Schedule for this time</Text>
          </TouchableOpacity>
        )}

        {scheduling && (
          <View style={S.busy}>
            <ActivityIndicator color={colors.primary} />
            <Text style={S.busyTxt}>Scheduling…</Text>
          </View>
        )}

        <Text style={S.note}>
          🔒 End-to-end encrypted before it leaves your device, then delivered by the server within
          ~30 seconds of the chosen time — so it sends even if the app is closed or swiped away.
          Cancel any pending one from <Text style={{ color: colors.primary }}>Scheduled</Text>.
        </Text>
      </ScrollView>
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 26, fontWeight: '600' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },
  who:           { color: c.text, fontSize: 16, fontWeight: '600' },
  input:         { color: c.text, backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, minHeight: 100, textAlignVertical: 'top' },

  quickGrid:     { gap: 8 },
  quickBtn:      { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  quickBtnOff:   { opacity: 0.5 },
  quickLabel:    { color: c.text, fontSize: 15, fontWeight: '700' },
  quickSub:      { color: c.textDim, fontSize: 12, marginTop: 2 },

  customBtn:     { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  customTxt:     { flex: 1, color: c.text, fontSize: 15, fontWeight: '600' },
  scheduleBtn:   { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  scheduleBtnTxt:{ color: '#fff', fontSize: 15, fontWeight: '800' },

  busy:          { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' },
  busyTxt:       { color: c.textDim, fontSize: 12 },

  note:          { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 24 },
});
