// app/finance/reminders.tsx — finance reminders (local notifications).
// Opened standalone, or from a ledger with ?refType&refId&title to prefill.

import React, { useCallback, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useDatePicker } from '../../components/finance/useDatePicker';
import { type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Btn, Pill, EmptyState, Card, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { fmtDateTime } from '../../utils/financeFormat';
import {
  insertReminder, listReminders, setReminderStatus, snoozeReminder, deleteReminder,
  type Reminder, type ReminderFreq,
} from '../../db/reminders';
import { scheduleReminder, scheduleAt, cancel, snoozedNotifIds } from '../../components/finance/notify';
import { isUnscheduled } from '../../components/finance/notifyIds';

const FREQ_LABEL: Record<ReminderFreq, string> = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

export default function Reminders() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const params = useLocalSearchParams<{ refType?: string; refId?: string; title?: string }>();
  const me = useMe();
  const [rows, setRows] = useState<Reminder[]>([]);
  const [showAdd, setShowAdd] = useState(!!params.title);
  const [title, setTitle] = useState(params.title ?? '');
  const [freq, setFreq] = useState<ReminderFreq>('monthly');
  const [when, setWhen] = useState<number>(Date.now() + 86400000);

  // aliased: this screen already has a `done` list of completed reminders
  const { status, begin: beginLoad, done: loadOk, fail: loadFail } = useLoadStatus();
  const reload = useCallback(() => {
    if (!me) return;
    beginLoad();
    listReminders(me.id).then(r => { setRows(r); loadOk(); }).catch(loadFail);
  }, [me, beginLoad, loadOk, loadFail]);
  useFocusEffect(reload);

  const picker = useDatePicker();
  const pickWhen = () => picker.open(new Date(when), (d) => setWhen(d.getTime()), 'datetime');

  // A reminder whose notification could not be scheduled (permission denied,
  // or the OS refused) is still worth keeping as a note, but it must not look
  // like it will alert anyone.
  const warnUnscheduled = () => Alert.alert(
    'Notifications are off',
    'The reminder is saved, but it will not alert you. Allow notifications for this app in your phone settings, then add it again.',
  );

  const onAdd = async () => {
    if (!me) return;
    if (!title.trim()) return Alert.alert('Title', 'Enter a reminder title.');
    try {
      const notifId = await scheduleReminder('Vault Finance', title.trim(), freq, when);
      await insertReminder({
        user_id: me.id,
        ref_type: (params.refType as any) ?? null,
        ref_id: params.refId ?? null,
        title: title.trim(), freq, next_at: when, notif_id: notifId,
      });
      if (!notifId) warnUnscheduled();
      setShowAdd(false); setTitle(''); reload();
    } catch (e: any) { Alert.alert('Could not add the reminder', e?.message ?? 'Try again.'); }
  };

  const onDone = async (r: Reminder) => {
    try { await cancel(r.notif_id); await setReminderStatus(r.id, 'done'); reload(); }
    catch (e: any) { Alert.alert('Could not update the reminder', e?.message ?? 'Try again.'); }
  };
  const onSnooze = async (r: Reminder) => {
    try {
      const next = Date.now() + 86400000;
      const snoozeId = await scheduleAt('Vault Finance', r.title, next);
      // A recurring reminder keeps its own schedule; the snooze is one extra
      // alert tomorrow. Cancelling the recurrence here used to turn a monthly
      // reminder into a one-off without saying so.
      const ids = snoozedNotifIds(r.freq, r.notif_id, snoozeId);
      await cancel(ids.cancel);
      await snoozeReminder(r.id, next, ids.keep);
      if (!snoozeId) warnUnscheduled();
      reload();
    } catch (e: any) { Alert.alert('Could not snooze the reminder', e?.message ?? 'Try again.'); }
  };
  const onDelete = (r: Reminder) => Alert.alert('Delete reminder?', r.title, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      try { await cancel(r.notif_id); await deleteReminder(r.id); reload(); }
      catch (e: any) { Alert.alert('Could not delete the reminder', e?.message ?? 'Try again.'); }
    } },
  ]);

  const active = rows.filter(r => r.status === 'active');
  const done = rows.filter(r => r.status === 'done');

  return (
    <View style={s.screen}>
      {picker.element}
      <FinHeader title="Reminders" right={
        <TouchableOpacity accessibilityLabel={showAdd ? "Close the new reminder form" : "Add a reminder"} onPress={() => setShowAdd(v => !v)} hitSlop={8}>
          <Ionicons name={showAdd ? 'close' : 'add-circle'} size={26} color={FIN.brandDeep} />
        </TouchableOpacity>
      } />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {showAdd && (
          <Card style={{ marginBottom: 8 }}>
            <Label>Title</Label>
            <Field label="Reminder title" value={title} onChangeText={setTitle} placeholder="e.g. Ramesh — interest due" />
            <Label>Repeat</Label>
            <Segment<ReminderFreq>
              options={[{ k: 'once', label: 'Once' }, { k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }]}
              value={freq} onChange={setFreq} small
            />
            <Label>When</Label>
            <TouchableOpacity style={s.whenBtn} onPress={pickWhen} accessibilityRole="button"
              accessibilityLabel={`When: ${fmtDateTime(when)}. Change date and time`}>
              <Ionicons name="time-outline" size={18} color={FIN.brandDeep} />
              <Text style={s.whenTxt}>{fmtDateTime(when)}</Text>
            </TouchableOpacity>
            <View style={{ marginTop: 14 }}><Btn label="Add Reminder" icon="notifications" onPress={onAdd} wide /></View>
          </Card>
        )}

        {status === 'loading' && <LoadingState label="Loading reminders" />}
        {status === 'error' && (
          <ErrorState title="Could not load reminders" sub="Your reminders could not be read. Nothing has been lost." onRetry={reload} />
        )}
        {status === 'ready' && active.length === 0 && done.length === 0 && !showAdd && (
          <EmptyState icon="notifications-outline" title="No reminders" sub="Add reminders for interest dues, collections and auctions." />
        )}

        {active.length > 0 && <Text style={s.section}>Active</Text>}
        {active.map(r => (
          <View key={r.id} style={[s.card, s.activeCard]}>
            <View style={s.reminderHeading}>
              <View style={s.dot} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.title} numberOfLines={2}>{r.title}</Text>
                <Text style={s.sub}>{fmtDateTime(r.next_at)}</Text>
                {isUnscheduled(r.freq, r.notif_id) && <Text style={[s.sub, { color: FIN.bad }]}>Not scheduled: notifications are off</Text>}
              </View>
            </View>
            <View style={s.actions}>
              <Pill label={FREQ_LABEL[r.freq]} fg={FIN.brandDeep} bg={FIN.brandSoft} />
              <View style={{ flex: 1 }} />
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Snooze ${r.title} for a day`} onPress={() => onSnooze(r)} style={s.iconBtn}><Ionicons name="alarm-outline" size={18} color={FIN.warn} /></TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Mark ${r.title} done`} onPress={() => onDone(r)} style={s.iconBtn}><Ionicons name="checkmark-done" size={18} color={FIN.good} /></TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete ${r.title}`} onPress={() => onDelete(r)} style={s.iconBtn}><Ionicons name="trash-outline" size={17} color={FIN.faint} /></TouchableOpacity>
            </View>
          </View>
        ))}

        {done.length > 0 && <Text style={s.section}>Completed</Text>}
        {done.map(r => (
          <View key={r.id} style={s.card}>
            <Ionicons name="checkmark-circle" size={18} color={FIN.good} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.title, { textDecorationLine: 'line-through' }]} numberOfLines={1}>{r.title}</Text>
              <Text style={s.sub}>{fmtDateTime(r.next_at)}</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete ${r.title}`} onPress={() => onDelete(r)} style={s.iconBtn}><Ionicons name="trash-outline" size={17} color={FIN.faint} /></TouchableOpacity>
          </View>
        ))}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  section: { color: FIN.text, fontSize: 14, fontWeight: '800', marginTop: 16, marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: FIN.good },
  title: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  activeCard: { flexDirection: 'column', alignItems: 'stretch' },
  reminderHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: FIN.border, paddingTop: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: FIN.cardStrong, borderRadius: 12 },
  whenBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: FIN.brandSoft, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: FIN.brand },
  whenTxt: { color: FIN.brandDeep, fontSize: 14, fontWeight: '700' },
});
