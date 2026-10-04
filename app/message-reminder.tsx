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
//   (lib/privacyPrefs.ts), which deliberately has no "full text" mode.//
// The list lives in components/chattools/RemindersList.tsx, the stored list
// in components/chattools/reminderStore.ts.

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui';
import { permissionDenied } from '../lib/permissionDenied';
import { getNotifPreview, notifContent } from '../lib/privacyPrefs';
import { MESSAGE_REMINDER_BODY } from '../lib/messageReminderReset';
import { userErrorText } from '../lib/userErrorText';
import RemindersList from '../components/chattools/RemindersList';
import {
  PROTECTED_TEXT, cachedText, loadReminders, offerClearReminders, saveReminders,
  type ReminderRow,
} from '../components/chattools/reminderStore';
import { useReminderStyles } from '../components/chattools/reminderStyles';

type Router = ReturnType<typeof useRouter>;

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
  const S = useReminderStyles();
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
          <Text style={[S.previewBody, (!cached || cached === PROTECTED_TEXT) && S.previewMissing]} numberOfLines={4}>
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
