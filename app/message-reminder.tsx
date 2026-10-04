// app/message-reminder.tsx — Per-message reminders (client-only).
//
// Two modes:
//   With ?chatId + ?messageId              → composer: pick a time, save.
//   Without params                         → list: pending reminders + cancel.
//
// Storage: AsyncStorage list of { id, chatId, messageId, when } — NO message
// text. The list re-reads each message's text from the local message cache
// (sealed SQLite) when it is shown, so no decrypted body sits in plain storage.
// Schedule: expo-notifications scheduleNotificationAsync with
//   data: { chatId, messageId } so the existing root tap handler routes
//   back into the chat when the user taps the notification. The notification
//   never carries message text: it follows the tray-privacy setting
//   (lib/privacyPrefs.ts), which deliberately has no "full text" mode.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui';
import { permissionDenied } from '../lib/permissionDenied';
import { getNotifPreview, notifContent } from '../lib/privacyPrefs';
import { getCachedMessagesByIds } from '../lib/localDb';
import { looksEncrypted } from '../lib/chatService';
import { E2EE_UNDECRYPTABLE, e2eeGetCached } from '../services/crypto/e2eeSession.rn';
import { isChatLocked } from '../lib/chatLock';
import { setPendingJump } from '../lib/chatJump';
import { MESSAGE_REMINDER_BODY, isMessageReminderRequest } from '../lib/messageReminderReset';
import { userErrorText } from '../lib/userErrorText';

type Router = ReturnType<typeof useRouter>;

const STORAGE_KEY = 'vc_message_reminders_v1';

interface ReminderRow {
  id:        string;     // expo-notifications identifier
  chatId:    string;
  messageId: string;
  /** Legacy rows only; never written now. Display text is read at list time. */
  preview?:  string;
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

// Throws when the stored list cannot be read, so callers can tell "no
// reminders" apart from "could not read them" (the list shows an error, the
// composer undoes the notification it just scheduled).
async function loadReminders(): Promise<ReminderRow[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const list = JSON.parse(raw) as ReminderRow[];
  if (!Array.isArray(list)) throw new Error('Reminder list is unreadable');
  // Drop any rows whose scheduled time has already passed (the notification
  // either fired or was cancelled; we don't need to keep them around), and
  // the plaintext preview older builds stored. Persist when either changed,
  // so expired rows and old plaintext do not accumulate.
  const now = Date.now();
  const kept = list
    .filter(r => new Date(r.when).getTime() > now - 60_000)
    .map(({ preview: _drop, ...r }) => r);
  if (kept.length !== list.length || list.some(r => r.preview)) {
    await saveReminders(kept).catch(() => {});
  }
  return kept;
}

/** Shown instead of the text of a view-once / Invisible Ink message. */
const PROTECTED_TEXT = 'View-once or Invisible Ink message — text hidden';

// The message text for display, from the local message cache. Null when the
// message is not cached on this device or not readable.
async function cachedText(r: Pick<ReminderRow, 'chatId' | 'messageId'>): Promise<string | null> {
  try {
    const [m] = await getCachedMessagesByIds(r.chatId, [Number(r.messageId)]);
    // View-once / Invisible Ink text is never shown outside its bubble.
    if (m?.meta?.viewOnce || m?.meta?.invisibleInk) return PROTECTED_TEXT;
    const t = m?.type === 'text' ? m.content : null;
    if (!t) return null;
    if (!looksEncrypted(t)) return t;
    // Still stored as an envelope: the bubble's own decrypt cached the text,
    // checked against this ciphertext.
    const pt = await e2eeGetCached(r.chatId, Number(r.messageId), t);
    return pt && pt !== E2EE_UNDECRYPTABLE ? pt : null;
  } catch { return null; }
}

/** Shown instead of the message text for a reminder in a locked chat. */
const LOCKED_TEXT = '🔒 Locked chat';

async function saveReminders(list: ReminderRow[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Recovery for a list that cannot be read: its rows hold the cancel ids, so
 *  cancel every pending notification this screen scheduled (matched by its
 *  fixed body + chat/message data), then drop the stored list. */
async function clearReminders(): Promise<void> {
  const pending = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(pending.filter(isMessageReminderRequest)
    .map(r => Notifications.cancelScheduledNotificationAsync(r.identifier)));
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/** Confirm, then clear the unreadable list; `after` runs once it is cleared. */
function offerClearReminders(after: () => void) {
  Alert.alert(
    'Saved reminders can\'t be read',
    'The reminder list on this device is damaged, so reminders can\'t be saved or cancelled here. Clearing it cancels every message reminder you have set.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Clear reminders', style: 'destructive', onPress: async () => {
        try { await clearReminders(); }
        catch { Alert.alert('Could not clear reminders', 'Please try again.'); return; }
        after();
      } },
    ],
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function MessageReminderScreen() {
  const router = useRouter();
  const { chatId, messageId } = useLocalSearchParams<{ chatId?: string; messageId?: string }>();

  const composeMode = !!(chatId && messageId);

  if (composeMode) return <Composer chatId={chatId!} messageId={messageId!} router={router} />;
  return <RemindersList router={router} />;
}

function Composer({
  chatId, messageId, router,
}: {
  chatId: string; messageId: string; router: Router;
}) {
  const S = useS();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  // Synchronous twin of `busy`: two taps in one frame both see busy=false.
  const busyRef = useRef(false);
  // The text comes from the sealed local cache by id, like the list — never
  // from the route, so message text does not travel in params.
  const [cached, setCached] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    cachedText({ chatId, messageId }).then(t => { if (alive) setCached(t); });
    return () => { alive = false; };
  }, [chatId, messageId]);

  const schedule = useCallback(async (mins: number) => {
    if (busyRef.current) return;
    const when = whenFor(mins);
    if (when.getTime() <= Date.now()) {
      Alert.alert('Pick a future time', 'That preset has already passed today.');
      return;
    }
    // Busy BEFORE the permission awaits, so a double tap cannot schedule twice.
    busyRef.current = true;
    setBusy(true);
    try {
      const perm = await Notifications.getPermissionsAsync();
      if (!perm.granted) {
        const req = await Notifications.requestPermissionsAsync();
        if (!req.granted) {
          permissionDenied('Permission needed', 'Allow notifications so we can remind you on time.', req.canAskAgain);
          return;
        }
      }
      // Tray privacy: the user's notification-preview choice decides what may
      // appear; no choice shows message text.
      const tray = notifContent(await getNotifPreview(), '🔖 Message reminder');
      if (!tray) {
        Alert.alert(
          'Notifications are hidden',
          'Your privacy setting shows nothing in the notification tray, so a reminder could not appear. Change it in Settings → Privacy to use reminders.',
        );
        return;
      }
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: tray.title,
          body:  MESSAGE_REMINDER_BODY,
          // Root layout's attachTapHandler reads data.chatId and routes
          // to /chat?id=<chatId> when the user taps the notification.
          data:  { chatId, messageId },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
      });

      let list: ReminderRow[];
      try {
        list = await loadReminders();
      } catch {
        // A damaged list would refuse every new reminder: take this one back
        // out and offer the reset, then schedule again once it is cleared.
        await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
        offerClearReminders(() => { void schedule(mins); });
        return;
      }
      try {
        list.push({
          id, chatId, messageId, when: when.toISOString(),
          createdAt: new Date().toISOString(),
        });
        await saveReminders(list);
      } catch (e) {
        // Without a stored row the reminder could never be cancelled from the
        // app, so take the notification back out before reporting failure.
        await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
        throw e;
      }

      Alert.alert('Reminder set', `We'll notify you ${when.toLocaleString()}.`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert('Could not schedule', userErrorText(e, 'The reminder could not be set. Please try again.'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [chatId, messageId, router]);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Remind me about</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <View style={S.previewCard}>
          <Text style={S.previewLabel}>MESSAGE</Text>
          <Text style={[S.previewBody, !cached && S.previewMissing]} numberOfLines={4}>
            {cached || 'This message’s text is not saved on this phone — the reminder still opens it.'}
          </Text>
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
                accessibilityRole="button"
                accessibilityLabel={`Remind me ${p.label.toLowerCase()}`}
                accessibilityState={{ disabled: busy }}
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
          chosen time and tap-open the chat. See all pending in Settings → Message reminders.
        </Text>
      </ScrollView>
    </View>
  );
}

function RemindersList({ router }: { router: Router }) {
  const S = useS();
  const { colors } = useTheme();
  const [rows,    setRows]    = useState<ReminderRow[]>([]);
  // Display-only message text, keyed by reminder id (never persisted).
  const [texts,   setTexts]   = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  // load() awaits storage and the message cache; none of it may set state
  // after the screen has closed.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    let list: ReminderRow[];
    try {
      list = await loadReminders();
    } catch {
      if (alive.current) setError('Your reminders could not be read from this device.');
      return;
    }
    if (!alive.current) return;
    setError(null);
    setRows(list.sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime()));
    // A locked chat's text is not shown here without unlocking it. An
    // unreadable lock table counts as locked (lib/chatLock fails closed).
    const chatIds = [...new Set(list.map(r => r.chatId))];
    const lockedIds = new Set<string>();
    await Promise.all(chatIds.map(async id => {
      if (await isChatLocked(id).catch(() => true)) lockedIds.add(id);
    }));
    const pairs = await Promise.all(list.map(async r =>
      [r.id, lockedIds.has(r.chatId) ? LOCKED_TEXT : await cachedText(r)] as const));
    if (alive.current) setTexts(Object.fromEntries(pairs));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true); await load(); if (alive.current) setLoading(false);
  }, [load]);

  useEffect(() => { reload(); }, [reload]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); if (alive.current) setRefreshing(false);
  }, [load]);

  // Open the chat at the message (chat.tsx consumes the jump on focus and
  // applies the chat's own lock).
  const openChat = useCallback((r: ReminderRow) => {
    if (Number(r.messageId) > 0) setPendingJump(r.chatId, Number(r.messageId));
    router.push({ pathname: '/chat', params: { id: r.chatId } });
  }, [router]);

  const cancel = useCallback((r: ReminderRow) => {
    Alert.alert('Cancel reminder?', 'You won\'t be notified at the chosen time.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel', style: 'destructive', onPress: async () => {
          // DELETE THE ROW ONLY IF THE OS ACTUALLY CANCELLED.
          //
          // This used to swallow the cancel failure and drop the row anyway.
          // `r.id` IS the cancellation handle, so erasing it while the
          // notification survives left the user with an alert that will fire at
          // the chosen time and no way — in the app or out of it — to stop it.
          // The dialog they just confirmed says "You won't be notified".
          try {
            await Notifications.cancelScheduledNotificationAsync(r.id);
          } catch (e: any) {
            Alert.alert('Could not cancel', `The reminder is still set. ${userErrorText(e, 'Please try again.')}`);
            return;
          }
          try {
            const next = (await loadReminders()).filter(x => x.id !== r.id);
            await saveReminders(next);
          } catch {
            Alert.alert('Reminder cancelled', 'You won\'t be notified, but the list could not be updated on this device.');
          }
          if (alive.current) setRows(prev => prev.filter(x => x.id !== r.id));
        }
      },
    ]);
  }, []);

  const renderItem = useCallback(({ item: r }: { item: ReminderRow }) => (
    <View style={S.row}>
      <TouchableOpacity
        style={S.rowMain}
        onPress={() => openChat(r)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Reminder for ${new Date(r.when).toLocaleString()}: ${texts[r.id] || 'Message reminder'}`}
        accessibilityHint="Opens the chat at this message"
        accessibilityActions={[{ name: 'cancelReminder', label: 'Cancel reminder' }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'cancelReminder') cancel(r); }}
      >
        <View style={S.iconBox} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden><Text style={S.iconTxt}>⏰</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={S.rowWhen} numberOfLines={1}>
            Fires {new Date(r.when).toLocaleString()}
          </Text>
          <Text style={S.rowPreview} numberOfLines={2}>
            {texts[r.id] || 'Message reminder'}
          </Text>
          <Text style={S.rowSub}>Tap to open the chat</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={S.cancelBtn}
        onPress={() => cancel(r)}
        accessibilityRole="button"
        accessibilityLabel="Cancel reminder"
      >
        <Ionicons name="close-circle-outline" size={24} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  ), [S, colors, texts, openChat, cancel]);

  if (loading) {
    return <View style={[S.screen, S.center]}><AuroraBackground /><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Reminders</Text>
      </View>

      {error ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>{"Couldn't load reminders"}</Text>
          <Text style={S.emptySub} accessibilityRole="alert">{error}</Text>
          <TouchableOpacity accessibilityRole="button" onPress={reload} style={S.retryBtn}>
            <Text style={S.retryTxt}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear reminders" onPress={() => offerClearReminders(reload)} style={S.clearBtn}>
            <Text style={S.clearTxt}>Clear reminders</Text>
          </TouchableOpacity>
        </View>
      ) : rows.length === 0 ? (
        <ScrollView
          contentContainerStyle={[S.center, { flexGrow: 1, paddingHorizontal: 32 }]}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        >
          <Text style={S.emptyTitle}>No reminders set</Text>
          <Text style={S.emptySub}>
            Long-press any message in a chat → Remind, then pick a time.
          </Text>
        </ScrollView>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          renderItem={renderItem}
        />
      )}
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:      { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title:        { color: c.text, fontSize: 22, fontWeight: '800' },

  previewCard:  { backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, padding: 12 },
  previewLabel: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 6 },
  previewBody:  { color: c.text, fontSize: 14, lineHeight: 20 },
  previewMissing: { color: c.textDim, fontStyle: 'italic' },

  gridCol:      { gap: 8 },
  preset:       { backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16 },
  presetOff:    { opacity: 0.5 },
  presetLabel:  { color: c.text, fontSize: 15, fontWeight: '700' },
  presetSub:    { color: c.textDim, fontSize: 12, marginTop: 2 },

  busy:         { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, justifyContent: 'center' },
  busyTxt:      { color: c.textDim, fontSize: 12 },
  note:         { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 24 },

  emptyTitle:   { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:     { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retryBtn:     { marginTop: 20, minHeight: 44, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  retryTxt:     { color: c.onPrimary, fontWeight: '700' },
  clearBtn:     { marginTop: 8, minHeight: 44, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },
  clearTxt:     { color: c.danger, fontWeight: '700' },

  row:          { flexDirection: 'row', alignItems: 'center', paddingRight: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  rowMain:      { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingLeft: 20, paddingRight: 4, paddingVertical: 14 },
  cancelBtn:    { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  iconBox:      { width: 36, height: 36, borderRadius: 18, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  iconTxt:      { fontSize: 18 },
  rowWhen:      { color: c.text, fontSize: 14, fontWeight: '700' },
  rowPreview:   { color: c.text, fontSize: 13, marginTop: 4 },
  rowSub:       { color: c.textDim, fontSize: 11, marginTop: 6 },
});
