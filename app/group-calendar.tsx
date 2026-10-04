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
  listGroupEvents, createGroupEvent, updateGroupEvent, deleteGroupEvent, getChat,
  encryptForChat, decryptFromChat, type GroupEventRow,
} from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  monthKeysInRange, monthBounds, bucketFor, occurrencesInRange,
  eventReminderItems, REMINDER_HORIZON_MS, eventActions,
  withDayOffset, withHour, isDayOffset,
  type GroupEvent, type Occurrence, type Recurrence,
} from '../lib/groups/calendar';
import { syncEventReminders } from '../lib/groups/taskReminders';
import { KeyboardSafe } from '../components/ui';
import { useDatePicker } from '../components/ui/useDatePicker';

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
const whenLabel = (ts: number) => `${dayLabel(ts)}, ${timeLabel(ts)}`;

/** A new event starts at 18:00 today unless the composer says otherwise. */
const defaultStart = () => withHour(Date.now(), 18);

/** Who I am in this group, for the edit/delete gate (lib/groups/calendar eventActions). */
interface Access { typed: boolean; myRole: string | null; permissions: string[] }

/**
 * Decrypt server rows into events. Rows we cannot open or parse are skipped,
 * never fatal, and counted in `unreadable` so the screen can say so.
 */
async function decryptRows(groupId: string, rows: GroupEventRow[]) {
  const out: GroupEvent[] = [];
  const ids: Record<string, number> = {};
  let unreadable = 0;
  for (const r of rows) {
    try {
      // ponytail: the row id doubles as the plaintext-cache message id, so it can
      // share a cache slot with a chat message of the same id in this group. A
      // collision makes one of the two unreadable. Needs a cache namespace in
      // decryptFromChat (lib/chatService.ts, not this screen's to change).
      const json = await decryptFromChat(groupId, r.createdBy ?? '', r.payload, r.id);
      const e = JSON.parse(json) as GroupEvent;
      // The row id is the server's handle; the payload carries the rest.
      if (e && typeof e.startsAt === 'number' && e.title) {
        out.push({ ...e, id: String(r.id), createdBy: r.createdBy ?? e.createdBy });
        ids[String(r.id)] = r.id;
      } else unreadable++;
    } catch { unreadable++; }
  }
  return { events: out, ids, unreadable };
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
  // The month failed to load: an error when nothing is on screen, a banner otherwise.
  const [failed, setFailed] = useState(false);
  // Events in this month this phone could not decrypt or parse.
  const [unreadable, setUnreadable] = useState(0);
  const [me, setMe] = useState<string | null>(null);
  // null until GET /chats/:id answers; then only my own events are editable.
  const [access, setAccess] = useState<Access | null>(null);
  // Only the latest load may write state: switching months quickly must not let
  // an older month's slower response overwrite the one being shown.
  const loadSeq = useRef(0);

  const [composing, setComposing] = useState(false);
  // The event being edited, or null for a new one.
  const [editing, setEditing] = useState<GroupEvent | null>(null);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [start, setStart] = useState(defaultStart);
  const [repeat, setRepeat] = useState<Recurrence>('none');
  const [busy, setBusy] = useState(false);
  const picker = useDatePicker();

  const bounds = useMemo(() => monthBounds(cursor), [cursor]);

  const load = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    const seq = ++loadSeq.current;
    try {
      const rows = await listGroupEvents(groupId, monthKeysInRange(bounds.from, bounds.to));
      const { events: out, ids, unreadable: bad } = await decryptRows(groupId, rows);
      if (seq !== loadSeq.current) return;
      setEvents(out);
      setRowIds(ids);
      setUnreadable(bad);
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
      if (groupId) {
        getChat(groupId)
          .then((c) => live && setAccess({ typed: !!c.groupType, myRole: c.myRole ?? null, permissions: (c.permissions ?? []) as string[] }))
          .catch(() => { /* unknown role: only my own events offer edit/delete */ });
      }
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

  const actionsFor = (e: GroupEvent) => eventActions({
    createdBy: e.createdBy, me, typed: access?.typed ?? false,
    myRole: access?.myRole ?? null, permissions: access?.permissions,
  });

  const openNew = () => {
    setEditing(null); setTitle(''); setLocation(''); setRepeat('none'); setStart(defaultStart());
    setComposing(true);
  };

  // A repeating event is edited as a series: the sheet shows the series start,
  // not the occurrence that was tapped.
  const openEdit = (e: GroupEvent) => {
    setEditing(e); setTitle(e.title); setLocation(e.location ?? ''); setRepeat(e.recurrence);
    setStart(e.startsAt);
    setComposing(true);
  };

  const save = async () => {
    const t = title.trim();
    if (!t || busy || !me) return;
    const rowId = editing ? rowIds[editing.id] : undefined;
    if (editing && !rowId) return;
    setBusy(true);
    try {
      const event: GroupEvent = editing
        ? { ...editing, title: t, location: location.trim() || null, startsAt: start, recurrence: repeat }
        : {
          id: '', title: t, location: location.trim() || null, notes: null,
          startsAt: start, durationMin: 60, allDay: false,
          recurrence: repeat, repeatUntil: null, createdBy: me, remindMin: 30,
        };
      // Seal with the group's own chat encryption: an event is exactly as
      // private as a message in the same group.
      const payload = await encryptForChat(groupId, JSON.stringify({ ...event, id: '' }));
      const body = { payload, monthKey: bucketFor(event), repeatUntil: null };
      if (editing && rowId) await updateGroupEvent(groupId, rowId, body);
      else await createGroupEvent(groupId, body);
      setComposing(false); setEditing(null);
      setTitle(''); setLocation(''); setRepeat('none');
      // Jump the view to the month the event landed in, so it is visible.
      setCursor(event.startsAt);
      await load();
      syncReminders(groupId, me).catch(() => {});
    } catch (e: any) {
      // The sheet stays open with everything typed, so Retry is one tap.
      Alert.alert(editing ? 'Could not save' : 'Could not add', e?.message ?? 'Try again.');
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
            if (editing?.id === o.event.id) { setComposing(false); setEditing(null); }
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
          <TouchableOpacity onPress={openNew} accessibilityRole="button" accessibilityLabel="New event" hitSlop={8} style={{ paddingHorizontal: 8 }}>
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
          {unreadable > 0 && <UnreadableNote count={unreadable} />}
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {failed && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Couldn't refresh this month. Showing what was loaded before. Retry"
              onPress={() => { setLoading(true); load(); }}
              style={[st.banner, { borderColor: colors.danger }]}>
              <Ionicons name="cloud-offline-outline" size={15} color={colors.danger} />
              <Text style={{ color: colors.danger, fontSize: 12.5, flex: 1 }}>Couldn’t refresh — this month may be out of date. Tap to retry.</Text>
            </TouchableOpacity>
          )}
          {days.map(([day, list]) => (
            <View key={day}>
              <Text style={[st.day, { color: colors.textDim }]} accessibilityRole="header">{dayLabel(list[0].startsAt)}</Text>
              {list.map((o) => (
                <EventRow
                  key={`${o.event.id}:${o.startsAt}`}
                  o={o}
                  actions={actionsFor(o.event)}
                  onEdit={() => openEdit(o.event)}
                  onDelete={() => remove(o)}
                />
              ))}
            </View>
          ))}
          {unreadable > 0 && <UnreadableNote count={unreadable} />}
          <Text style={{ color: colors.textFaint, fontSize: 11.5, textAlign: 'center', marginTop: 20 }}>
            Tap an event you added to change it.
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
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setComposing(false)}
            accessibilityRole="button" accessibilityLabel="Close without saving" />
          <View style={[st.sheet, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16, marginBottom: 14 }} accessibilityRole="header">
              {editing ? 'Edit event' : 'New event'}
            </Text>

            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              <Ionicons name="calendar" size={17} color={colors.textDim} />
              <TextInput value={title} onChangeText={setTitle} placeholder="What is it?" accessibilityLabel="Event title"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={140} />
            </View>
            <View style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, marginTop: 10 }]}>
              <Ionicons name="location-outline" size={17} color={colors.textDim} />
              <TextInput value={location} onChangeText={setLocation} placeholder="Where (optional)" accessibilityLabel="Where, optional"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} maxLength={140} />
            </View>

            <TouchableOpacity
              onPress={() => picker.open(new Date(start), (d) => setStart(d.getTime()), 'datetime')}
              accessibilityRole="button" accessibilityLabel={`Starts ${whenLabel(start)}`} accessibilityHint="Opens a date and time picker"
              style={[st.field, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft, marginTop: 10 }]}>
              <Ionicons name="time-outline" size={17} color={colors.textDim} />
              <Text style={{ color: colors.text, fontSize: 15, flex: 1 }}>{whenLabel(start)}</Text>
              <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>Change</Text>
            </TouchableOpacity>

            <View style={st.chips}>
              {WHEN.map((wd) => {
                const on = isDayOffset(start, wd.addDays, Date.now());
                return (
                  <TouchableOpacity key={wd.label} onPress={() => setStart((s0) => withDayOffset(s0, wd.addDays, Date.now()))}
                    accessibilityRole="radio" accessibilityLabel={wd.label} accessibilityState={{ selected: on, checked: on }}
                    style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? brandAlpha(0.1) : 'transparent' }]}>
                    <Text style={{ color: on ? colors.primary : colors.text, fontSize: 12.5 }}>{wd.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }} contentContainerStyle={{ gap: 7 }}>
              {HOURS.map((h) => {
                const d = new Date(start);
                const on = d.getHours() === h && d.getMinutes() === 0;
                return (
                  <TouchableOpacity key={h} onPress={() => setStart((s0) => withHour(s0, h))}
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

            {editing?.recurrence && editing.recurrence !== 'none' && (
              <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 12 }}>
                Changes apply to every repeat of this event.
              </Text>
            )}

            <TouchableOpacity onPress={save} disabled={!title.trim() || busy || !me}
              accessibilityRole="button" accessibilityState={{ disabled: !title.trim() || busy || !me, busy }}
              style={[st.btn, { backgroundColor: title.trim() && !busy && me ? colors.primary : colors.border }]}>
              {busy ? <ActivityIndicator color="#fff" />
                : <><Ionicons name="checkmark" size={18} color="#fff" /><Text style={st.btnTxt}>{editing ? 'Save changes' : 'Add to calendar'}</Text></>}
            </TouchableOpacity>
          </View>
          {picker.element}
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
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderWidth: 1, borderRadius: 12, marginBottom: 4 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11, minWidth: 0 },
  rowBtn: { padding: 8 },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 16 },
});

/** One occurrence. Tapping edits it (your own events only); delete is a visible button. */
function EventRow({ o, actions, onEdit, onDelete }: {
  o: Occurrence;
  actions: { canEdit: boolean; canDelete: boolean };
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();
  const when = o.event.allDay ? 'All day' : timeLabel(o.startsAt);
  const repeats = o.event.recurrence !== 'none'
    ? REPEATS.find((r) => r.key === o.event.recurrence)?.label : null;
  const label = [when, o.event.title, o.event.location, repeats && `repeats ${repeats.toLowerCase()}`]
    .filter(Boolean).join(', ');
  return (
    <View style={[st.row, { borderColor: colors.glassStroke }]}>
      <TouchableOpacity
        onPress={onEdit}
        disabled={!actions.canEdit}
        activeOpacity={0.75}
        accessibilityRole={actions.canEdit ? 'button' : 'text'}
        accessibilityLabel={label}
        accessibilityHint={actions.canEdit ? 'Edit this event' : undefined}
        accessibilityActions={actions.canDelete ? [{ name: 'delete', label: 'Delete event' }] : undefined}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') onDelete(); }}
        style={st.rowMain}
      >
        <View style={[st.time, { backgroundColor: brandAlpha(0.1) }]}>
          <Text style={{ color: colors.primary, fontSize: 11.5, fontWeight: '800' }}>{when}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: colors.text, fontSize: 14.5, fontWeight: '600' }} numberOfLines={1}>
            {o.event.title}
          </Text>
          {(o.event.location || repeats) && (
            <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
              {[o.event.location, repeats].filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
        {!!repeats && <Ionicons name="repeat" size={15} color={colors.textFaint} />}
      </TouchableOpacity>
      {actions.canDelete && (
        <TouchableOpacity onPress={onDelete} hitSlop={6} style={st.rowBtn}
          accessibilityRole="button" accessibilityLabel={`Delete the event ${o.event.title}`}>
          <Ionicons name="trash-outline" size={17} color={colors.textFaint} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function UnreadableNote({ count }: { count: number }) {
  const { colors } = useTheme();
  return (
    <View style={st.note} accessibilityRole="text">
      <Ionicons name="lock-closed-outline" size={14} color={colors.textDim} />
      <Text style={{ color: colors.textDim, fontSize: 12, lineHeight: 16, flex: 1 }}>
        {count} event{count === 1 ? '' : 's'} this month could not be opened on this phone, so {count === 1 ? 'it is' : 'they are'} not shown.
      </Text>
    </View>
  );
}
