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
  View, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator,
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
  type GroupEvent, type Occurrence,
} from '../lib/groups/calendar';
import { syncEventReminders } from '../lib/groups/taskReminders';
import { GroupNotFound } from '../components/groups/GroupNotFound';
import {
  GroupEventComposer, REPEATS, dayLabel, timeLabel, type EventDraft,
} from '../components/groups/GroupEventComposer';
import { eventWriter, writerRecorded } from '../lib/groups/serverContracts';

const monthLabel = (ts: number) =>
  new Date(ts).toLocaleDateString([], { month: 'long', year: 'numeric' });

/** Who I am in this group, for the edit/delete gate (lib/groups/calendar eventActions). */
interface Access { typed: boolean; myRole: string | null; permissions: string[] }

/** Decrypted rows by id + ciphertext, so a row is opened once per screen visit.
 *  Failures are not remembered: a later load may have the sender's key. */
type DecryptMemo = Map<string, GroupEvent>;

/**
 * Decrypt server rows into events. Rows we cannot open or parse are skipped,
 * never fatal, and counted in `unreadable` so the screen can say so.
 */
async function decryptRows(groupId: string, rows: GroupEventRow[], memo: DecryptMemo) {
  const out: GroupEvent[] = [];
  const ids: Record<string, number> = {};
  let unreadable = 0;
  for (const r of rows) {
    // The month view and the reminder sync read overlapping rows; an edit
    // changes the payload, so the key never serves a stale event.
    const key = `${r.id}\n${r.payload}`;
    const hit = memo.get(key);
    if (hit) { out.push(hit); ids[hit.id] = r.id; continue; }
    try {
      // Sealed by the last writer: `updatedBy` once the server records it, else
      // the author (lib/groups/serverContracts eventWriter). The 'cal' cache
      // scope keeps row ids out of the chat messages' plaintext-cache slots.
      const json = await decryptFromChat(groupId, eventWriter(r), r.payload, r.id, false, 'cal');
      const e = JSON.parse(json) as GroupEvent;
      // The row id is the server's handle; the payload carries the rest.
      if (e && typeof e.startsAt === 'number' && e.title) {
        const ev = { ...e, id: String(r.id), createdBy: r.createdBy ?? e.createdBy };
        memo.set(key, ev);
        out.push(ev);
        ids[ev.id] = r.id;
      } else unreadable++;
    } catch { unreadable++; }
  }
  return { events: out, ids, unreadable, writerKnown: writerRecorded(rows) };
}

/**
 * Book this device's reminders for the next REMINDER_HORIZON_MS, independent of
 * which month is on screen (the reconciler would otherwise cancel reminders for
 * months that are not loaded). Never prompts for notification permission.
 */
async function syncReminders(groupId: string, me: string, memo: DecryptMemo): Promise<void> {
  const now = Date.now(), to = now + REMINDER_HORIZON_MS;
  const { events } = await decryptRows(groupId, await listGroupEvents(groupId, monthKeysInRange(now, to)), memo);
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
  // The server records who last sealed each event (updatedBy), so an admin may
  // edit others' events too. False on today's server: edit stays author-only.
  const [writerKnown, setWriterKnown] = useState(false);
  // Only the latest load may write state: switching months quickly must not let
  // an older month's slower response overwrite the one being shown.
  const loadSeq = useRef(0);
  const memo = useRef<DecryptMemo>(new Map()).current;

  const [composing, setComposing] = useState(false);
  // The event being edited, or null for a new one.
  const [editing, setEditing] = useState<GroupEvent | null>(null);
  // Bumped on every open: the composer remounts and starts its draft afresh.
  const [composeKey, setComposeKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const bounds = useMemo(() => monthBounds(cursor), [cursor]);

  const load = useCallback(async () => {
    if (!groupId) { setLoading(false); return; }
    const seq = ++loadSeq.current;
    try {
      const rows = await listGroupEvents(groupId, monthKeysInRange(bounds.from, bounds.to));
      const { events: out, ids, unreadable: bad, writerKnown: wk } = await decryptRows(groupId, rows, memo);
      if (seq !== loadSeq.current) return;
      if (wk) setWriterKnown(true);
      setEvents(out);
      setRowIds(ids);
      setUnreadable(bad);
      setFailed(false);
    } catch {
      // Offline: keep what is on screen rather than blanking the month.
      if (seq === loadSeq.current) setFailed(true);
    } finally { if (seq === loadSeq.current) setLoading(false); }
  }, [groupId, bounds.from, bounds.to, memo]);

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
      if (u && groupId) syncReminders(groupId, String(u.id), memo).catch(() => {});
    })();
    return () => { live = false; };
  }, [load, groupId, memo]));

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
    myRole: access?.myRole ?? null, permissions: access?.permissions, writerKnown,
  });

  const openCompose = (e: GroupEvent | null) => {
    setEditing(e); setComposeKey((k) => k + 1); setComposing(true);
  };
  const openNew = () => openCompose(null);
  const openEdit = (e: GroupEvent) => openCompose(e);

  const save = async ({ title, location, start, repeat }: EventDraft) => {
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
      // Jump the view to the month the event landed in, so it is visible.
      setCursor(event.startsAt);
      await load();
      syncReminders(groupId, me, memo).catch(() => {});
    } catch (e: any) {
      // The sheet stays open with everything typed, so Retry is one tap.
      Alert.alert(editing ? 'Could not save' : 'Could not add', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  // One delete at a time, taken when the confirmation OPENS (two taps used to
  // open two dialogs and send two deletes); released by Cancel, an Android
  // outside-tap dismiss, or when the call settles. `deletingId` draws it.
  const deleteOpen = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const remove = (o: Occurrence) => {
    const rowId = rowIds[o.event.id];
    if (!rowId || deleteOpen.current) return;
    deleteOpen.current = true;
    const release = () => { deleteOpen.current = false; };
    const repeating = o.event.recurrence !== 'none';
    Alert.alert(
      repeating ? 'Delete repeating event?' : 'Delete event?',
      repeating
        ? `"${o.event.title}" and all of its repeats will be removed.`
        : `"${o.event.title}" will be removed for everyone.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: release },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          setDeletingId(o.event.id);
          try {
            await deleteGroupEvent(groupId, rowId); await load();
            if (me) syncReminders(groupId, me, memo).catch(() => {});
            if (editing?.id === o.event.id) { setComposing(false); setEditing(null); }
          }
          catch (e: any) { Alert.alert('Could not delete', e?.message ?? 'Try again.'); }
          finally { setDeletingId(null); release(); }
        } },
      ],
      { cancelable: true, onDismiss: release },
    );
  };

  const shiftMonth = (by: number) => {
    const d = new Date(cursor); d.setDate(1); d.setMonth(d.getMonth() + by);
    setCursor(d.getTime()); setLoading(true);
  };

  if (!groupId) return <GroupNotFound title="Calendar" />;

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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }} accessibilityRole="header">{monthLabel(cursor)}</Text>
          {/* Switching months keeps the list (dimmed) and shows this instead of
              a full-screen spinner; the full spinner is only for an empty list. */}
          {loading && days.length > 0 && <ActivityIndicator size="small" color={colors.primary} accessibilityLabel="Loading this month" />}
        </View>
        <TouchableOpacity onPress={() => shiftMonth(1)} accessibilityRole="button" accessibilityLabel="Next month" hitSlop={10} style={{ padding: 6 }}>
          <Ionicons name="chevron-forward" size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {loading && days.length === 0 ? (
        <View style={st.center}><ActivityIndicator color={colors.primary} /></View>
      ) : days.length === 0 && failed ? (
        <View style={[st.center, { padding: 34 }]}>
          <Ionicons name="cloud-offline-outline" size={30} color={colors.textFaint} />
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: 10 }}>Couldn’t load this month</Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading the calendar" onPress={() => { setLoading(true); load(); }}
            style={[st.btn, { backgroundColor: colors.primary, paddingHorizontal: 22 }]}>
            <Text style={[st.btnTxt, { color: colors.onPrimary }]}>Retry</Text>
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
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} style={loading ? { opacity: 0.55 } : undefined}>
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
                  deleting={deletingId === o.event.id}
                />
              ))}
            </View>
          ))}
          {unreadable > 0 && <UnreadableNote count={unreadable} />}
          <Text style={{ color: colors.textFaint, fontSize: 11.5, textAlign: 'center', marginTop: 20 }}>
            {writerKnown ? 'Tap an event to change it.' : 'Tap an event you added to change it.'}
          </Text>
        </ScrollView>
      )}

      <GroupEventComposer key={composeKey} visible={composing} editing={editing} busy={busy} canSave={!!me}
        onClose={() => setComposing(false)} onSave={save} />
    </View>
  );
}

const st = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  day: { fontSize: 11.5, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 18, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  time: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, minWidth: 62, alignItems: 'center' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 13, marginTop: 18 },
  btnTxt: { fontSize: 15, fontWeight: '800' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderWidth: 1, borderRadius: 12, marginBottom: 4 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11, minWidth: 0 },
  rowBtn: { padding: 8 },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 16 },
});

/** One occurrence. Tapping edits it (your own events only); delete is a visible button. */
function EventRow({ o, actions, onEdit, onDelete, deleting }: {
  o: Occurrence;
  actions: { canEdit: boolean; canDelete: boolean };
  onEdit: () => void;
  onDelete: () => void;
  /** Its delete is in flight. */
  deleting: boolean;
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
        <TouchableOpacity onPress={onDelete} hitSlop={6} style={st.rowBtn} disabled={deleting}
          accessibilityRole="button" accessibilityLabel={`Delete the event ${o.event.title}`}
          accessibilityState={{ busy: deleting, disabled: deleting }}>
          {deleting
            ? <ActivityIndicator size="small" color={colors.textFaint} />
            : <Ionicons name="trash-outline" size={17} color={colors.textFaint} />}
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
