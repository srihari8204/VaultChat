// app/group-calendar.tsx — the group's shared calendar (Groups & Circles, G4.3).
//
// The server holds each event as ciphertext plus a month bucket, so this screen
// does all the real work: it fetches the buckets a month view touches, decrypts
// each payload, expands recurrences into occurrences, and orders them
// (lib/groups/calendar.ts). Nothing about an event's content or exact time is
// ever legible server-side.
//
// Events are sealed with the group's own chat encryption, so a calendar entry
// is exactly as private as a message in the same group.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, StyleSheet, TouchableOpacity, ScrollView, TextInput, Alert,
  ActivityIndicator, Modal,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { AppText as Text } from '../components/ui/Text';
import { brandAlpha } from '../constants/theme';
import {
  listGroupEvents, createGroupEvent, deleteGroupEvent,
  encryptForChat, decryptFromChat, type GroupEventRow,
} from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  monthKeysInRange, monthBounds, bucketFor, occurrencesInRange,
  eventReminderItems, REMINDER_HORIZON_MS,
  type GroupEvent, type Occurrence, type Recurrence,
} from '../lib/groups/calendar';
import { syncEventReminders } from '../lib/groups/taskReminders';
import { KeyboardSafe } from '../components/ui';

const REPEATS: { key: Recurrence; label: string }[] = [
  { key: 'none', label: 'Once' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'yearly', label: 'Yearly' },
];

const WHEN: { label: string; addDays: number }[] = [
  { label: 'Today', addDays: 0 },
  { label: 'Tomorrow', addDays: 1 },
  { label: 'Next week', addDays: 7 },
];

const HOURS = [8, 9, 10, 12, 14, 16, 18, 19, 20];

const monthLabel = (ts: number) =>
  new Date(ts).toLocaleDateString([], { month: 'long', year: 'numeric' });
const dayLabel = (ts: number) =>
  new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const timeLabel = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Decrypt server rows into events; rows we cannot read or parse are skipped. */
async function decryptRows(groupId: string, rows: GroupEventRow[]) {
  const out: GroupEvent[] = [];
  const ids: Record<string, number> = {};
  for (const r of rows) {
    let json = '';
    try { json = await decryptFromChat(groupId, r.createdBy ?? '', r.payload, r.id); } catch { continue; }
    try {
      const e = JSON.parse(json) as GroupEvent;
      // The row id is the server's handle; the payload carries the rest.
      if (e && typeof e.startsAt === 'number' && e.title) {
        out.push({ ...e, id: String(r.id), createdBy: r.createdBy ?? e.createdBy });
        ids[String(r.id)] = r.id;
      }
    } catch { /* a payload we cannot parse is skipped, never fatal */ }
  }
  return { events: out, ids };
}

/**
 * Book this device's reminders for the next REMINDER_HORIZON_MS, independent of
 * which month is on screen (the reconciler would otherwise cancel reminders for
 * months that are not loaded). Never prompts for notification permission.
 */
async function syncReminders(groupId: string, me: string): Promise<void> {
  const now = Date.now(), to = now + REMINDER_HORIZON_MS;
  const { events } = await decryptRows(groupId, await listGroupEvents(groupId, monthKeysInRange(now, to)));
  await syncEventReminders(groupId, eventReminderItems(occurrencesInRange(events, now, to), me), me, now);
}

export default function GroupCalendarScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ groupId?: string; name?: string }>();
  const groupId = String(params.groupId || '');

  const [cursor, setCursor] = useState(Date.now());
  const [events, setEvents] = useState<GroupEvent[]>([]);
  const [rowIds, setRowIds] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  // The month failed to load and nothing is on screen: an error, not "Nothing this month".
  const [failed, setFailed] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  // Only the latest load may write state: switching months quickly must not let
  // an older month's slower response overwrite the one being shown.
  const loadSeq = useRef(0);

  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [addDays, setAddDays] = useState(0);
  const [hour, setHour] = useState(18);
  const [repeat, setRepeat] = useState<Recurrence>('none');
  const [busy, setBusy] = useState(false);

  const bounds = useMemo(() => monthBounds(cursor), [cursor]);

  const load = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    const seq = ++loadSeq.current;
    try {
      const rows = await listGroupEvents(groupId, monthKeysInRange(bounds.from, bounds.to));
      const { events: out, ids } = await decryptRows(groupId, rows);
      if (seq !== loadSeq.current) return;
      setEvents(out);
      setRowIds(ids);
      setFailed(false);
    } catch {
      // Offline: keep what is on screen rather than blanking the month.
      if (seq === loadSeq.current) setFailed(true);
    } finally { if (seq === loadSeq.current) setLoading(false); }
  }, [groupId, bounds.from, bounds.to]);

  useFocusEffect(useCallback(() => {
    let live = true;
    (async () => {
      const u = await getCurrentUserAsync().catch(() => null);
      if (live) setMe(u ? String(u.id) : null);
      await load();
      if (u && groupId) syncReminders(groupId, String(u.id)).catch(() => {});
    })();
    return () => { live = false; };
  }, [load, groupId]));

  const occurrences = useMemo(
    () => occurrencesInRange(events, bounds.from, bounds.to),
    [events, bounds.from, bounds.to],
  );

  /** Group occurrences under day headers, which is how a month reads. */
  const days = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const o of occurrences) {
      const k = new Date(o.startsAt).toDateString();
      const arr = map.get(k);
      if (arr) arr.push(o); else map.set(k, [o]);
    }
    return [...map.entries()];
  }, [occurrences]);

  const add = async () => {
    const t = title.trim();
    if (!t || busy || !me) return;
    setBusy(true);
    try {
      const d = new Date();
      d.setDate(d.getDate() + addDays);
      d.setHours(hour, 0, 0, 0);

      const event: GroupEvent = {
        id: '', title: t, location: location.trim() || null, notes: null,
        startsAt: d.getTime(), durationMin: 60, allDay: false,
        recurrence: repeat, repeatUntil: null, createdBy: me, remindMin: 30,
      };
      // Seal with the group's own chat encryption: an event is exactly as
      // private as a message in the same group.
      const payload = await encryptForChat(groupId, JSON.stringify(event));
      await createGroupEvent(groupId, {
        payload,
        monthKey: bucketFor(event),
        repeatUntil: null,
      });
      setTitle(''); setLocation(''); setRepeat('none'); setAddDays(0);
      setComposing(false);
      // Jump the view to the month the event landed in, so it is visible.
      setCursor(event.startsAt);
      await load();
      syncReminders(groupId, me).catch(() => {});
    } catch (e: any) {
      Alert.alert('Could not add', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  const remove = (o: Occurrence) => {
    const rowId = rowIds[o.event.id];
    if (!rowId) return;
    const repeating = o.event.recurrence !== 'none';
    Alert.alert(
      repeating ? 'Delete repeating event?' : 'Delete event?',
      repeating
        ? `"${o.event.title}" and all of its repeats will be removed.`
        : `"${o.event.title}" will be removed for everyone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await deleteGroupEvent(groupId, rowId); await load();
            if (me) syncReminders(groupId, me).catch(() => {});
          }
          catch (e: any) { Alert.alert('Could not delete', e?.message ?? 'Try again.'); }
        } },
      ],
    );
  };

  const shiftMonth = (by: number) => {
    const d = new Date(cursor); d.setDate(1); d.setMonth(d.getMonth() + by);
    setCursor(d.getTime()); setLoading(true);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground variant="chat" />
      <Stack.Screen options={{ headerShown: true, headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
        title: 'Calendar', headerTitleAlign: 'center',
        headerRight: () => (
          <TouchableOpacity onPress={() => setComposing(true)} accessibilityRole="button" accessibilityLabel="New event" style={{ paddingHorizontal: 8 }}>
            <Ionicons name="add" size={24} color={colors.primary} />
          </TouchableOpacity>
        ),
      }} />

      <View style={[st.monthBar, { borderColor: colors.glassStroke }]}>
        <TouchableOpacity onPress={() => shiftMonth(-1)} accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={10} style={{ padding: 6 }}>
          <Ionicons name="chevron-back" size={20} color={colors.primary} />
        </TouchableOpacity>
        <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>{monthLabel(cursor)}</Text>
        <TouchableOpacity onPress={() => shiftMonth(1)} accessibilityRole="button" accessibilityLabel="Next month" hitSlop={10} style={{ padding: 6 }}>
          <Ionicons name="chevron-forward" size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : days.length === 0 && failed ? (
        <View style={[st.center, { padding: 34 }]}>
          <Ionicons name="cloud-offline-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>Couldn’t load this month</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading the calendar" onPress={() => { setLoading(true); load(); }}
            style={[st.btn, { backgroundColor: colors.primary, paddingHorizontal: 22 }]}>
            <Text style={st.btnTxt}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : days.length === 0 ? (
        <View style={[st.center, { padding: 34 }]}>
          <Ionicons name="calendar-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>Nothing this month</Text>
          <Text style={{ color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 4 }}>
            Birthdays, trips and meetings you add here are shared with the group and stay encrypted.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {days.map(([day, list]) => (
            <View key={day}>
              <Text style={[st.day, { color: colors.textDim }]}>{dayLabel(list[0].startsAt)}</Text>
              {list.map((o, i) => (
                <TouchableOpacity
                  key={`${o.event.id}:${o.startsAt}:${i}`}
                  onLongPress={() => remove(o)}
                  activeOpacity={0.75}
                  accessibilityLabel={`${o.event.allDay ? 'All day' : timeLabel(o.startsAt)}, ${o.event.title}`}
                  accessibilityHint="Long-press to delete"
                  accessibilityActions={[{ name: 'delete', label: 'Delete event' }]}
                  onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') remove(o); }}
                  style={[st.row, { borderColor: colors.glassStroke }]}
                >
                  <View style={[st.time, { backgroundColor: brandAlpha(0.1) }]}>
                    <Text style={{ color: colors.primary, fontSize: 11.5, fontWeight: '800' }}>
                      {o.event.allDay ? 'All day' : timeLabel(o.startsAt)}
                    </Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '600' }} numberOfLines={1}>
                      {o.event.title}
                    </Text>
                    {(o.event.location || o.event.recurrence !== 'none') && (
                      <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
                        {o.event.location ?? ''}
                        {o.event.location && o.event.recurrence !== 'none' ? ' · ' : ''}
                        {o.event.recurrence !== 'none' ? REPEATS.find((r) => r.key === o.event.recurrence)?.label : ''}
                      </Text>
                    )}
                  </View>
                  {o.event.recurrence !== 'none' && (
                    <Ionicons name="repeat" size={15} color={colors.textFaint} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          ))}
          <Text style={{ color: colors.textFaint, fontSize: 11.5, textAlign: 'center', marginTop: 20 }}>
            Long-press an event to remove it
          </Text>
        </ScrollView>
      )}

      <Modal visible={composing} transparent animationType="slide" onRequestClose={() => setComposing(false)}>
        {/* KeyboardSafe, not KeyboardAvoidingView (2026-09-17): a React Native
            <Modal> is its own Android window and never receives the activity's
            adjustResize, and KAV's 'padding' math mixes Modal-relative layout
            coords with absolute screen coords, so the lift came up short.
            keyboardOnly: this sheet already sets its own bottom padding. */}
        <KeyboardSafe keyboardOnly style={st.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setComposing(false)} />
          <View style={[st.sheet, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16, marginBottom: 14 }}>New event</Text>

            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              <Ionicons name="calendar" size={17} color={colors.textDim} />
              <TextInput value={title} onChangeText={setTitle} placeholder="What is it?"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={140} />
            </View>
            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, marginTop: 10 }]}>
              <Ionicons name="location-outline" size={17} color={colors.textDim} />
              <TextInput value={location} onChangeText={setLocation} placeholder="Where (optional)"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={140} />
            </View>

            <View style={st.chips}>
              {WHEN.map((wd) => {
                const on = addDays === wd.addDays;
                return (
                  <TouchableOpacity key={wd.label} onPress={() => setAddDays(wd.addDays)}
                    accessibilityRole="radio" accessibilityLabel={wd.label} accessibilityState={{ selected: on, checked: on }}
                    style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                    <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5 }}>{wd.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }} contentContainerStyle={{ gap: 7 }}>
              {HOURS.map((h) => {
                const on = hour === h;
                return (
                  <TouchableOpacity key={h} onPress={() => setHour(h)}
                    accessibilityRole="radio" accessibilityLabel={`${String(h).padStart(2, '0')}:00`} accessibilityState={{ selected: on, checked: on }}
                    style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                    <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5 }}>
                      {String(h).padStart(2, '0')}:00
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={st.chips}>
              {REPEATS.map((rp) => {
                const on = repeat === rp.key;
                return (
                  <TouchableOpacity key={rp.key} onPress={() => setRepeat(rp.key)}
                    accessibilityRole="radio" accessibilityLabel={`Repeat ${rp.label}`} accessibilityState={{ selected: on, checked: on }}
                    style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                    <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5 }}>{rp.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity onPress={add} disabled={!title.trim() || busy || !me}
              accessibilityRole="button" accessibilityState={{ disabled: !title.trim() || busy || !me, busy }}
              style={[st.btn, { backgroundColor: title.trim() && !busy && me ? colors.primary : colors.border }]}>
              {busy ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={st.btnTxt}>Add to calendar</Text></>}
            </TouchableOpacity>
          </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  day: { fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 18, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  time: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, minWidth: 62, alignItems: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, padding: 18, paddingBottom: 32 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48 },
  input: { flex: 1, fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 13, marginTop: 18 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
