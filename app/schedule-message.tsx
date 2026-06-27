// app/schedule-message.tsx — Schedule a text message to a specific chat.
//
// Reachable from the chat composer (long-press Send). The list of all
// scheduled messages lives at /scheduled (separate screen).
//
// Backend route: POST /user/scheduled-messages
//   { chatId, sendAt, type: 'text', content }
// A 30-second sweep loop in server.js delivers when sendAt <= NOW().

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
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { scheduleMessage } from '../lib/chatService';

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
  const { chatId, peerName } = useLocalSearchParams<{ chatId?: string; peerName?: string }>();

  const [message,    setMessage]    = useState('');
  const [scheduling, setScheduling] = useState(false);

  const sendIn = useCallback(async (mins: number) => {
    const text = message.trim();
    if (!text) { Alert.alert('Empty message', 'Type something before scheduling.'); return; }
    if (!chatId) { Alert.alert('Missing chat', 'No chat context — open this screen from a chat.'); return; }
    setScheduling(true);
    try {
      const when = scheduleTimeFor(mins);
      await scheduleMessage({
        chatId:  chatId as string,
        sendAt:  when.toISOString(),
        type:    'text',
        content: text,
      });
      Alert.alert(
        'Scheduled',
        `Your message will be delivered ${when.toLocaleString()}.`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (e: any) {
      Alert.alert('Could not schedule', e?.message ?? 'Try again');
    } finally {
      setScheduling(false);
    }
  }, [chatId, message, router]);

  return (
    <View style={S.screen}>
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

        {scheduling && (
          <View style={S.busy}>
            <ActivityIndicator color={colors.primary} />
            <Text style={S.busyTxt}>Scheduling…</Text>
          </View>
        )}

        <Text style={S.note}>
          Server stores the pending message and delivers it within 30 seconds of the chosen time.
          You can cancel any pending one from <Text style={{ color: colors.primary }}>/scheduled</Text>.
        </Text>
      </ScrollView>
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen:        { flex: 1, backgroundColor: c.bg },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
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

  busy:          { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' },
  busyTxt:       { color: c.textDim, fontSize: 12 },

  note:          { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 24 },
});
