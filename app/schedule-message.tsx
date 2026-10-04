// app/schedule-message.tsx — Schedule a text message to a specific chat.
//
// Reachable from the chat's ⋮ menu → "Schedule a message". The list of all
// scheduled messages lives at /scheduled (separate screen).
//
// Backend route: POST /user/scheduled-messages
//   { chatId, sendAt, type: 'text', content }
// The Go jobs sweep (vaultchat-backend-go/internal/jobs, sweepScheduledMessages,
// every 30 s) delivers when sendAt <= NOW().

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import type { EventArg, NavigationAction } from '@react-navigation/native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { scheduleEncryptedMessage } from '../lib/chatService';
import { putScheduledCopy } from '../lib/scheduledLocalCopy';
import { AuroraBackground, KeyboardSafe } from '../components/ui';
import { userErrorText } from '../lib/userErrorText';
// Cross-platform picker (Android dialogs, iOS inline sheet); shared, not finance-specific in behaviour.
import { useDatePicker } from '../components/ui/useDatePicker';

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
  // Set synchronously, so a double tap cannot schedule the message twice
  // before the disabled state re-renders.
  const busyRef = useRef(false);

  // Leaving with a typed message asks first (header back, hardware back,
  // swipe), as create-poll does. `sent` lets the post-schedule pop through;
  // a prefilled `initial` the user has not changed is not worth a prompt.
  const sent = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = !!message.trim() && message !== initial;
  const navigation = useNavigation();
  // Typed by hand: with strictNullChecks off, the library's own event map
  // resolves beforeRemove as not preventable (`undefined extends true`).
  useEffect(() => navigation.addListener('beforeRemove', (e: EventArg<'beforeRemove', true, { action: NavigationAction }>) => {
    if (sent.current || !dirtyRef.current) return;
    e.preventDefault();
    Alert.alert('Discard message?', 'Your message has not been scheduled and will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
    ]);
  }), [navigation]);

  // Reliable delivery via the SERVER sweep (fires even if the app is killed),
  // kept E2E-encrypted: content is sealed on-device before upload, so the server
  // only forwards ciphertext at send time. A local plaintext copy powers the tray.
  const doSchedule = useCallback(async (when: Date) => {
    const text = message.trim();
    if (!text) { Alert.alert('Empty message', 'Type something before scheduling.'); return; }
    if (!chatId) { Alert.alert('Missing chat', 'No chat context — open this screen from a chat.'); return; }
    if (when.getTime() <= Date.now() + 5000) { Alert.alert('Pick a future time', 'Choose a time at least a moment ahead.'); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    setScheduling(true);
    try {
      const row = await scheduleEncryptedMessage(chatId as string, text, when.toISOString());
      if (row?.id) await putScheduledCopy(String(row.id), text);   // sender's tray preview
      sent.current = true;
      Alert.alert(
        'Scheduled',
        `Your message will be delivered ${when.toLocaleString()}.\n\nIt's end-to-end encrypted and sent by the server — it goes even if the app is closed.`,
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (e: any) {
      Alert.alert('Could not schedule', userErrorText(e, 'The message could not be scheduled. Please try again.'));
    } finally {
      busyRef.current = false;
      setScheduling(false);
    }
  }, [chatId, message, router]);

  const sendIn = useCallback((mins: number) => doSchedule(scheduleTimeFor(mins)), [doSchedule]);

  // Custom date + time. Android chains its date and time dialogs; iOS (which
  // has no DateTimePickerAndroid) gets an inline picker sheet. A past time is
  // refused as soon as it is picked, not later at Schedule (doSchedule checks
  // again, since a time can pass while the screen is open).
  // ponytail: components/ui/useDatePicker has no minimumDate, so the picker
  // still lets a past time be chosen; pass one once the hook takes it.
  const picker = useDatePicker();
  const pickCustom = useCallback(() => {
    picker.open(customWhen ?? new Date(Date.now() + 60 * 60 * 1000), (d) => {
      if (d.getTime() <= Date.now() + 60_000) {
        Alert.alert('Pick a future time', 'That time has already passed. Choose a later one.');
        return;
      }
      setCustomWhen(d);
    }, 'datetime');
  }, [customWhen, picker]);

  return (
    <KeyboardSafe style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Schedule message</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={S.label}>TO</Text>
        <Text numberOfLines={1} style={S.who}>{peerName || 'Chat'}</Text>

        <Text style={[S.label, { marginTop: 16 }]}>MESSAGE</Text>
        <TextInput
          style={S.input}
          value={message}
          onChangeText={setMessage}
          placeholder="What should we send?"
          placeholderTextColor={colors.textDim}
          accessibilityLabel="Message to schedule"
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
                accessibilityRole="button"
                accessibilityLabel={`Schedule ${t.label.toLowerCase()}`}
                accessibilityState={{ disabled: scheduling }}
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
        <TouchableOpacity style={S.customBtn} onPress={pickCustom} disabled={scheduling} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel={customWhen ? `Change custom time, ${customWhen.toLocaleString()}` : 'Pick an exact date and time'} accessibilityState={{ disabled: scheduling }}>
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
            accessibilityRole="button"
            accessibilityState={{ disabled: scheduling }}
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
          Cancel any pending one from Scheduled.
        </Text>
        <TouchableOpacity style={S.linkBtn} onPress={() => router.push('/scheduled')} accessibilityRole="link" accessibilityLabel="Open scheduled messages">
          <Ionicons name="time-outline" size={18} color={colors.primary} />
          <Text style={S.linkTxt}>Scheduled messages</Text>
        </TouchableOpacity>
      </ScrollView>
      {picker.element}
    </KeyboardSafe>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:       { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },
  who:           { color: c.text, fontSize: 16, fontWeight: '600' },
  input:         { color: c.text, backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, minHeight: 100, textAlignVertical: 'top' },

  quickGrid:     { gap: 8 },
  quickBtn:      { backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  quickBtnOff:   { opacity: 0.5 },
  quickLabel:    { color: c.text, fontSize: 15, fontWeight: '700' },
  quickSub:      { color: c.textDim, fontSize: 12, marginTop: 2 },

  customBtn:     { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  customTxt:     { flex: 1, color: c.text, fontSize: 15, fontWeight: '600' },
  scheduleBtn:   { backgroundColor: c.primary, borderRadius: 12, paddingVertical: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  scheduleBtnTxt:{ color: c.onPrimary, fontSize: 15, fontWeight: '800' },

  busy:          { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' },
  busyTxt:       { color: c.textDim, fontSize: 12 },

  note:          { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 24 },
  linkBtn:       { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, alignSelf: 'flex-start', marginTop: 4 },
  linkTxt:       { color: c.primary, fontSize: 14, fontWeight: '700' },
});
