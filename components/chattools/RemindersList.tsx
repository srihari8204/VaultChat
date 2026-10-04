// components/chattools/RemindersList.tsx — app/message-reminder.tsx without
// params: the pending reminders, each opening its chat, with cancel.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../lib/theme';
import { AuroraBackground } from '../ui';
import { visibleCachedChatIds } from '../../lib/localDb';
import { isChatLocked } from '../../lib/chatLock';
import { setPendingJump } from '../../lib/chatJump';
import { userErrorText } from '../../lib/userErrorText';
import {
  LOCKED_TEXT, PROTECTED_TEXT, cachedText, loadReminders, offerClearReminders, saveReminders,
  type ReminderRow,
} from './reminderStore';
import { useReminderStyles } from './reminderStyles';

type Router = ReturnType<typeof useRouter>;

export default function RemindersList({ router }: { router: Router }) {
  const S = useReminderStyles();
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
    // unreadable lock table counts as locked (lib/chatLock fails closed). A
    // hidden (PIN-gated) chat is masked the same way: only chats the main list
    // may show (visibleCachedChatIds) are shown; an unreadable table masks all.
    const chatIds = [...new Set(list.map(r => r.chatId))];
    const lockedIds = new Set<string>();
    const visible = await visibleCachedChatIds().catch(() => null);
    await Promise.all(chatIds.map(async id => {
      if (visible === null || !visible.has(id) || await isChatLocked(id).catch(() => true)) lockedIds.add(id);
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
          {/* Only the message's own text in normal ink; a stand-in (hidden, locked, not on this phone) is dimmed. */}
          <Text style={[S.rowPreview, (!texts[r.id] || texts[r.id] === PROTECTED_TEXT || texts[r.id] === LOCKED_TEXT) && S.previewMissing]} numberOfLines={2}>
            {texts[r.id] || 'Message reminder'}
          </Text>
          {/* The stand-in fails closed: a chat this phone can't yet show (not in
              the cached chat list — e.g. just after a reinstall) reads the same
              as a locked or hidden one, so the row says why. */}
          <Text style={S.rowSub}>
            {texts[r.id] === LOCKED_TEXT
              ? 'Text hidden: the chat is locked, hidden, or not loaded on this phone yet. Tap to open it.'
              : 'Tap to open the chat'}
          </Text>
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
