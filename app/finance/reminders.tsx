// app/finance/reminders.tsx — finance reminders (local notifications).
// Opened standalone, or from a ledger with ?refType&refId&title to prefill.

import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { FIN } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Btn, Pill, EmptyState, Card } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { fmtDateTime } from '../../utils/financeFormat';
import {
  insertReminder, listReminders, setReminderStatus, snoozeReminder, deleteReminder,
  type Reminder, type ReminderFreq,
} from '../../db/reminders';
import { scheduleAt, cancel } from '../../components/finance/notify';

const FREQ_LABEL: Record<ReminderFreq, string> = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

export default function Reminders() {
  const params = useLocalSearchParams<{ refType?: string; refId?: string; title?: string }>();
  const me = useMe();
  const [rows, setRows] = useState<Reminder[]>([]);
  const [showAdd, setShowAdd] = useState(!!params.title);
  const [title, setTitle] = useState(params.title ?? '');
  const [freq, setFreq] = useState<ReminderFreq>('monthly');
  const [when, setWhen] = useState<number>(Date.now() + 86400000);

  const reload = useCallback(() => { if (me) listReminders(me.id).then(setRows).catch(() => {}); }, [me]);
  useFocusEffect(reload);

  const pickWhen = () => {
    DateTimePickerAndroid.open({
      value: new Date(when), mode: 'date',
      onChange: (_e, d) => {
        if (!d) return;
        const base = d.getTime();
        DateTimePickerAndroid.open({
          value: new Date(when), mode: 'time',
          onChange: (_e2, t) => {
            const day = new Date(base);
            if (t) { day.setHours(t.getHours(), t.getMinutes(), 0, 0); }
            setWhen(day.getTime());
          },
        });
      },
    });
  };

  const onAdd = async () => {
    if (!me) return;
    if (!title.trim()) return Alert.alert('Title', 'Enter a reminder title.');
    const notifId = await scheduleAt('Vault Finance', title.trim(), when);
    await insertReminder({
      user_id: me.id,
      ref_type: (params.refType as any) ?? null,
      ref_id: params.refId ?? null,
      title: title.trim(), freq, next_at: when, notif_id: notifId,
    });
    setShowAdd(false); setTitle(''); reload();
  };

  const onDone = async (r: Reminder) => { await cancel(r.notif_id); await setReminderStatus(r.id, 'done'); reload(); };
  const onSnooze = async (r: Reminder) => {
    await cancel(r.notif_id);
    const next = Date.now() + 86400000;
    const notifId = await scheduleAt('Vault Finance', r.title, next);
    await snoozeReminder(r.id, next, notifId); reload();
  };
  const onDelete = async (r: Reminder) => { await cancel(r.notif_id); await deleteReminder(r.id); reload(); };

  const active = rows.filter(r => r.status === 'active');
  const done = rows.filter(r => r.status === 'done');

  return (
    <View style={s.screen}>
      <FinHeader title="Reminders" right={
        <TouchableOpacity onPress={() => setShowAdd(v => !v)} hitSlop={8}>
          <Ionicons name={showAdd ? 'close' : 'add-circle'} size={26} color={FIN.brandDeep} />
        </TouchableOpacity>
      } />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {showAdd && (
          <Card style={{ marginBottom: 8 }}>
            <Label>Title</Label>
            <Field value={title} onChangeText={setTitle} placeholder="e.g. Ramesh — interest due" />
            <Label>Repeat</Label>
            <Segment<ReminderFreq>
              options={[{ k: 'once', label: 'Once' }, { k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }]}
              value={freq} onChange={setFreq} small
            />
            <Label>When</Label>
            <TouchableOpacity style={s.whenBtn} onPress={pickWhen}>
              <Ionicons name="time-outline" size={18} color={FIN.brandDeep} />
              <Text style={s.whenTxt}>{fmtDateTime(when)}</Text>
            </TouchableOpacity>
            <View style={{ marginTop: 14 }}><Btn label="Add Reminder" icon="notifications" onPress={onAdd} wide /></View>
          </Card>
        )}

        {active.length === 0 && done.length === 0 && !showAdd && (
          <EmptyState icon="notifications-outline" title="No reminders" sub="Add reminders for interest dues, collections and auctions." />
        )}

        {active.length > 0 && <Text style={s.section}>Active</Text>}
        {active.map(r => (
          <View key={r.id} style={s.card}>
            <View style={s.dot} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.title} numberOfLines={1}>{r.title}</Text>
              <Text style={s.sub}>{fmtDateTime(r.next_at)}</Text>
            </View>
            <Pill label={FREQ_LABEL[r.freq]} fg={FIN.brandDeep} bg={FIN.brandSoft} />
            <TouchableOpacity onPress={() => onSnooze(r)} hitSlop={6} style={s.iconBtn}><Ionicons name="alarm-outline" size={18} color={FIN.warn} /></TouchableOpacity>
            <TouchableOpacity onPress={() => onDone(r)} hitSlop={6} style={s.iconBtn}><Ionicons name="checkmark-done" size={18} color={FIN.good} /></TouchableOpacity>
            <TouchableOpacity onPress={() => onDelete(r)} hitSlop={6} style={s.iconBtn}><Ionicons name="trash-outline" size={17} color={FIN.faint} /></TouchableOpacity>
          </View>
        ))}

        {done.length > 0 && <Text style={s.section}>Completed</Text>}
        {done.map(r => (
          <View key={r.id} style={[s.card, { opacity: 0.6 }]}>
            <Ionicons name="checkmark-circle" size={18} color={FIN.good} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[s.title, { textDecorationLine: 'line-through' }]} numberOfLines={1}>{r.title}</Text>
              <Text style={s.sub}>{fmtDateTime(r.next_at)}</Text>
            </View>
            <TouchableOpacity onPress={() => onDelete(r)} hitSlop={6} style={s.iconBtn}><Ionicons name="trash-outline" size={17} color={FIN.faint} /></TouchableOpacity>
          </View>
        ))}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16 },
  section: { color: FIN.text, fontSize: 14, fontWeight: '800', marginTop: 16, marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.border },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: FIN.good },
  title: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 3 },
  whenBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: FIN.brandSoft, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: FIN.brand },
  whenTxt: { color: FIN.brandDeep, fontSize: 14, fontWeight: '700' },
});
