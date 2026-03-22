// @ts-nocheck
// app/message-reminder.tsx — Message Reminder
// Set a timed reminder for a specific message. Presets + custom picker.
// Saves to AsyncStorage, schedules local notification via expo-notifications.

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, Alert, ScrollView, Platform,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import * as Notifications from 'expo-notifications';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import 'react-native-get-random-values';
import { v4 as uuid } from 'uuid';

const C = { bg: '#020B18', accent: '#4A9FFF', cyan: '#00E5FF', card: '#0A1628', border: '#112240' };
const STORAGE_KEY = 'vc_reminders';

interface Reminder {
  id: string;
  messageText: string;
  chatId: string;
  messageId: string;
  remindAt: number; // timestamp ms
  createdAt: number;
  notifId?: string;
}

// Ensure notifications show in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function MessageReminderScreen() {
  const router = useRouter();
  const { messageText, chatId, messageId } = useLocalSearchParams<{
    messageText: string;
    chatId: string;
    messageId: string;
  }>();

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customDate, setCustomDate] = useState(new Date(Date.now() + 3600000));
  const [pickerMode, setPickerMode] = useState<'date' | 'time'>('date');

  // Load existing reminders
  useEffect(() => {
    loadReminders();
  }, []);

  const loadReminders = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const all: Reminder[] = JSON.parse(raw);
        // Filter out expired reminders
        const active = all.filter(r => r.remindAt > Date.now());
        setReminders(active);
      }
    } catch (e) {
      console.warn('[Reminder] load error:', e);
    }
  };

  const saveReminder = async (remindAt: Date) => {
    if (remindAt.getTime() <= Date.now()) {
      Alert.alert('Invalid Time', 'Please select a future time.');
      return;
    }

    try {
      // Request notification permissions
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Enable notifications to use reminders.');
        return;
      }

      // Schedule local notification
      const notifId = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Message Reminder',
          body: (messageText || '').substring(0, 100),
          data: { chatId, messageId, type: 'message_reminder' },
          sound: 'default',
        },
        trigger: {
          date: remindAt,
          type: Notifications.SchedulableTriggerInputTypes.DATE,
        },
      });

      const newReminder: Reminder = {
        id: uuid(),
        messageText: messageText || '',
        chatId: chatId || '',
        messageId: messageId || '',
        remindAt: remindAt.getTime(),
        createdAt: Date.now(),
        notifId,
      };

      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const all: Reminder[] = raw ? JSON.parse(raw) : [];
      all.push(newReminder);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(all));

      setReminders(prev => [...prev, newReminder]);
      Alert.alert('Reminder Set', `You'll be reminded ${formatRelative(remindAt)}.`);
    } catch (e) {
      console.warn('[Reminder] save error:', e);
      Alert.alert('Error', 'Failed to set reminder.');
    }
  };

  const deleteReminder = async (reminder: Reminder) => {
    try {
      // Cancel scheduled notification
      if (reminder.notifId) {
        await Notifications.cancelScheduledNotificationAsync(reminder.notifId);
      }
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const all: Reminder[] = raw ? JSON.parse(raw) : [];
      const updated = all.filter(r => r.id !== reminder.id);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setReminders(prev => prev.filter(r => r.id !== reminder.id));
    } catch (e) {
      console.warn('[Reminder] delete error:', e);
    }
  };

  const formatRelative = (date: Date) => {
    const diff = date.getTime() - Date.now();
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `in ${mins} min`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `in ${hrs} hour${hrs > 1 ? 's' : ''}`;
    const days = Math.round(hrs / 24);
    return `in ${days} day${days > 1 ? 's' : ''}`;
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
      ' at ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Preset calculations
  const getPresets = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    const nextMonday = new Date(now);
    const dayOfWeek = nextMonday.getDay();
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
    nextMonday.setHours(9, 0, 0, 0);

    return [
      { label: 'In 30 minutes', icon: 'time-outline', date: new Date(now.getTime() + 30 * 60000) },
      { label: 'In 1 hour', icon: 'time-outline', date: new Date(now.getTime() + 60 * 60000) },
      { label: 'In 3 hours', icon: 'time-outline', date: new Date(now.getTime() + 180 * 60000) },
      { label: 'Tomorrow 9 AM', icon: 'sunny-outline', date: tomorrow },
      { label: 'Next Monday', icon: 'calendar-outline', date: nextMonday },
    ];
  };

  const handleCustomDateChange = (_: any, selected?: Date) => {
    if (Platform.OS === 'android') {
      if (!selected) {
        setShowCustomPicker(false);
        return;
      }
      if (pickerMode === 'date') {
        setCustomDate(selected);
        setPickerMode('time');
      } else {
        setCustomDate(selected);
        setShowCustomPicker(false);
        setPickerMode('date');
        saveReminder(selected);
      }
    } else {
      if (selected) setCustomDate(selected);
    }
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <LinearGradient colors={['#0A1628', C.bg]} style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Set Reminder</Text>
        <View style={{ width: 36 }} />
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Message preview */}
        {messageText ? (
          <View style={s.previewCard}>
            <View style={s.previewHeader}>
              <Ionicons name="chatbubble-outline" size={16} color={C.cyan} />
              <Text style={s.previewLabel}>Message</Text>
            </View>
            <Text style={s.previewText} numberOfLines={4}>
              {messageText}
            </Text>
          </View>
        ) : null}

        {/* Quick presets */}
        <Text style={s.sectionTitle}>Quick Remind</Text>
        {getPresets().map((preset, i) => (
          <TouchableOpacity
            key={i}
            style={s.presetBtn}
            activeOpacity={0.7}
            onPress={() => saveReminder(preset.date)}
          >
            <View style={s.presetLeft}>
              <View style={s.presetIcon}>
                <Ionicons name={preset.icon as any} size={20} color={C.accent} />
              </View>
              <Text style={s.presetLabel}>{preset.label}</Text>
            </View>
            <Text style={s.presetTime}>
              {preset.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </TouchableOpacity>
        ))}

        {/* Custom picker */}
        <Text style={[s.sectionTitle, { marginTop: 24 }]}>Custom Time</Text>
        <TouchableOpacity
          style={s.customBtn}
          activeOpacity={0.7}
          onPress={() => {
            setShowCustomPicker(true);
            setPickerMode('date');
          }}
        >
          <Ionicons name="calendar" size={20} color={C.cyan} />
          <Text style={s.customBtnText}>Pick Date & Time</Text>
        </TouchableOpacity>

        {showCustomPicker && (
          <View style={s.pickerWrap}>
            <DateTimePicker
              value={customDate}
              mode={pickerMode}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              minimumDate={new Date()}
              onChange={handleCustomDateChange}
              textColor="#fff"
              themeVariant="dark"
            />
            {Platform.OS === 'ios' && (
              <View style={s.iosPickerActions}>
                <TouchableOpacity onPress={() => setShowCustomPicker(false)}>
                  <Text style={[s.iosBtn, { color: '#889' }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => {
                  setShowCustomPicker(false);
                  saveReminder(customDate);
                }}>
                  <Text style={s.iosBtn}>Set Reminder</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Active reminders */}
        {reminders.length > 0 && (
          <>
            <Text style={[s.sectionTitle, { marginTop: 28 }]}>
              Active Reminders ({reminders.length})
            </Text>
            {reminders.map(r => (
              <View key={r.id} style={s.reminderCard}>
                <View style={{ flex: 1 }}>
                  <Text style={s.reminderMsg} numberOfLines={2}>{r.messageText}</Text>
                  <View style={s.reminderMeta}>
                    <Ionicons name="alarm-outline" size={13} color={C.accent} />
                    <Text style={s.reminderTime}>{formatDate(r.remindAt)}</Text>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() =>
                    Alert.alert('Delete Reminder', 'Remove this reminder?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => deleteReminder(r) },
                    ])
                  }
                  style={s.deleteBtn}
                >
                  <Ionicons name="trash-outline" size={18} color="#F44" />
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  backBtn: { width: 36 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  previewCard: {
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginBottom: 24,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  previewLabel: {
    color: C.cyan,
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  previewText: {
    color: '#CCD',
    fontSize: 14,
    lineHeight: 20,
  },
  sectionTitle: {
    color: '#8899AA',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  presetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginBottom: 8,
  },
  presetLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  presetIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: C.accent + '15',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  presetLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  presetTime: {
    color: '#667',
    fontSize: 13,
  },
  customBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.cyan + '33',
    padding: 14,
    gap: 8,
  },
  customBtnText: {
    color: C.cyan,
    fontSize: 15,
    fontWeight: '600',
  },
  pickerWrap: {
    backgroundColor: C.card,
    borderRadius: 12,
    marginTop: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  iosPickerActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  iosBtn: {
    color: C.accent,
    fontSize: 16,
    fontWeight: '600',
  },
  reminderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginBottom: 8,
  },
  reminderMsg: {
    color: '#CCD',
    fontSize: 14,
    lineHeight: 19,
    marginBottom: 6,
  },
  reminderMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  reminderTime: {
    color: C.accent,
    fontSize: 12,
    fontWeight: '500',
  },
  deleteBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#F4414115',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
  },
});
