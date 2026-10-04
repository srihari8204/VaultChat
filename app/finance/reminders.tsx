// app/finance/reminders.tsx — finance reminders (local notifications).
// Opened standalone, or from a ledger with ?refType&refId&title to prefill,
// or from the calendar with ?focus=<reminder id> to show that reminder.

import React, { useCallback, useRef, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../components/ui';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, AccessibilityInfo } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useDatePicker } from '../../components/finance/useDatePicker';
import { FIN_SHADOW, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Btn, Pill, EmptyState, Card, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { fmtDateTime } from '../../utils/financeFormat';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  insertReminder, listReminders, setReminderStatus, snoozeReminder, deleteReminder, setReminderNotifId,
  type Reminder, type ReminderFreq,
} from '../../db/reminders';
import { scheduleReminder, scheduleAt, cancel, snoozedNotifIds, notificationsAllowed } from '../../components/finance/notify';
import { isUnscheduled, withRecurrence } from '../../components/finance/notifyIds';
import { nextOccurrence } from '../../utils/financeRules';
import { osTriggerFor, skipsSomePeriods, anchorOf } from '../../lib/finance/reminderSchedule';

/** Set once every recurring alert has been rebuilt from its anchor (below). */
const RETRIGGER_KEY = 'vc_fin_retrigger_anchor_v1';

/**
 * Recurring alerts scheduled before the trigger was built from the anchor
 * (it used max(now, picked time), so the phone alerted on a different day or
 * time than the app shows) are re-scheduled once from their anchor. The new
 * alert is stored before the old one is cancelled, so a failure keeps the old
 * alert rather than none. Never prompts: without permission it waits for a
 * later visit. Resolves true when every row was rebuilt; a row changed
 * meanwhile is left alone and retried on a later visit.
 */
async function retriggerFromAnchors(userId: string, rows: Reminder[]): Promise<boolean> {
  if (!(await notificationsAllowed())) return false;
  let all = true;
  for (const r of rows) {
    const old = (r.notif_id ?? '').split(',')[0];
    if (r.status !== 'active' || r.freq === 'once' || !old) continue;
    const fresh = await scheduleReminder('Vault Finance', r.title, r.freq, anchorOf(r));
    if (!fresh) { all = false; continue; }
    // Done, snoozed or deleted meanwhile: that action owns the row's alerts.
    const now = (await listReminders(userId).catch(() => [] as Reminder[])).find((x) => x.id === r.id);
    if (!now || now.status !== 'active' || now.notif_id !== r.notif_id) { await cancel(fresh); all = false; continue; }
    try { await setReminderNotifId(r.id, withRecurrence(r.notif_id, fresh)); }
    catch { await cancel(fresh); all = false; continue; }
    await cancel(old);
  }
  return all;
}

const FREQ_LABEL: Record<ReminderFreq, string> = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

export default function Reminders() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const params = useLocalSearchParams<{ refType?: string; refId?: string; title?: string; focus?: string }>();
  const me = useMe();
  const [rows, setRows] = useState<Reminder[]>([]);
  const [showAdd, setShowAdd] = useState(!!params.title);
  const [title, setTitle] = useState(params.title ?? '');
  const [freq, setFreq] = useState<ReminderFreq>('monthly');
  const [when, setWhen] = useState<number>(Date.now() + 86400000);

  // aliased: this screen already has a `done` list of completed reminders
  const { status, begin: beginLoad, done: loadOk, fail: loadFail } = useLoadStatus();
  const retriggered = useRef(false);
  const reload = useCallback(() => {
    if (!me) return;
    beginLoad();
    listReminders(me.id).then(r => {
      setRows(r); loadOk();
      if (retriggered.current) return;
      retriggered.current = true;
      (async () => {
        if ((await AsyncStorage.getItem(RETRIGGER_KEY)) === '1') return;
        if (await retriggerFromAnchors(me.id, r)) await AsyncStorage.setItem(RETRIGGER_KEY, '1');
        setRows(await listReminders(me.id));   // the rebuilt ids
      })().catch(() => {});
    }).catch(loadFail);
  }, [me, beginLoad, loadOk, loadFail]);
  useFocusEffect(reload);

  // The calendar opens a reminder by id: it is outlined and scrolled to once.
  const scroller = useRef<ScrollView>(null);
  const scrolledTo = useRef<string | null>(null);
  const focusAt = (r: Reminder, y: number) => {
    if (r.id !== params.focus || scrolledTo.current === r.id) return;
    scrolledTo.current = r.id;
    scroller.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
    // The outline is visual only; a screen reader hears which reminder opened.
    AccessibilityInfo.announceForAccessibility(`Showing reminder ${r.title}, ${r.status === 'done' ? 'completed' : `due ${fmtDateTime(r.next_at)}`}`);
  };

  // One action per reminder at a time: two taps on Snooze scheduled two
  // alerts, and only the last id was kept to cancel.
  const busy = useRef(new Set<string>());
  const once = (r: Reminder, work: () => Promise<void>) => async () => {
    if (busy.current.has(r.id)) return;
    busy.current.add(r.id);
    try { await work(); } finally { busy.current.delete(r.id); }
  };

  const picker = useDatePicker();
  const pickWhen = () => picker.open(new Date(when), (d) => setWhen(d.getTime()), 'datetime');

  // A reminder whose notification could not be scheduled (permission denied,
  // or the OS refused) is still worth keeping as a note, but it must not look
  // like it will alert anyone.
  // Permission is checked here, so a trigger the OS refused is not blamed on it.
  const warnUnscheduled = async () => {
    if (await notificationsAllowed()) {
      Alert.alert('Alert not scheduled',
        'The reminder is saved, but your phone did not accept its alert, so it will not alert you. Delete it and add it again.');
    } else {
      Alert.alert('Notifications are off',
        'The reminder is saved, but it will not alert you. Allow notifications for this app in your phone settings, then add it again.');
    }
  };

  const confirm = (t: string, msg: string, ok: string) => new Promise<boolean>((resolve) => Alert.alert(t, msg, [
    { text: 'Go back', style: 'cancel', onPress: () => resolve(false) },
    { text: ok, onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));

  const onAdd = async () => {
    if (!me) return;
    if (!title.trim()) return Alert.alert('Title', 'Enter a reminder title.');
    // A one-off in the past can never fire; a recurring one just starts at
    // its next occurrence.
    if (freq === 'once' && when <= Date.now()) return Alert.alert('When', 'Pick a time in the future.');
    const day = new Date(when).getDate();
    if (skipsSomePeriods(freq, when) && !await confirm(
      freq === 'monthly' ? `Day ${day} is not in every month` : '29 February is not in every year',
      freq === 'monthly'
        ? `Phones schedule a monthly reminder on day ${day} only in months that have it, so some months will have no alert. Pick day 28 or earlier to be reminded every month.`
        : 'Phones schedule a yearly reminder on 29 February only in leap years, so three years in four will have no alert. Pick 28 February or 1 March to be reminded every year.',
      freq === 'monthly' ? 'Keep day ' + day : 'Keep 29 February',
    )) return;
    // Phones repeat by day and time with no start date, so a series that
    // starts more than one period ahead also alerts before it starts. Starting
    // the series at that first alert instead makes the app and the phone agree
    // (same day and time, so the same phone trigger; reminderSchedule.selftest).
    let start = when;
    const { earlyAt } = osTriggerFor(freq, when, Date.now());
    if (earlyAt != null) {
      const pick = await new Promise<'back' | 'early' | 'keep'>((resolve) => Alert.alert(
        'Your phone will alert early',
        `Phones repeat a reminder from today, so this one will also alert from ${fmtDateTime(earlyAt)}, before its first date, ${fmtDateTime(when)}. Start the reminder on ${fmtDateTime(earlyAt)} instead, so the app shows every alert?`,
        [
          { text: 'Go back', style: 'cancel', onPress: () => resolve('back') },
          { text: 'Start earlier', onPress: () => resolve('early') },
          { text: 'Add anyway', onPress: () => resolve('keep') },
        ],
        { cancelable: true, onDismiss: () => resolve('back') },
      ));
      if (pick === 'back') return;
      if (pick === 'early') { start = earlyAt; setWhen(earlyAt); }
    }
    const ref = params.refType === 'ledger' || params.refType === 'chitti' ? params.refType : null;
    try {
      const notifId = await scheduleReminder('Vault Finance', title.trim(), freq, start);
      await insertReminder({
        user_id: me.id,
        ref_type: ref,
        ref_id: ref ? params.refId ?? null : null,
        // The picked time anchors the series; next_at is its next occurrence.
        title: title.trim(), freq, next_at: nextOccurrence(freq, start, Date.now()), anchor_at: start, notif_id: notifId,
      });
      if (!notifId) void warnUnscheduled();
      setShowAdd(false); setTitle(''); reload();
    } catch (e: any) { Alert.alert('Could not add the reminder', e?.message ?? 'Try again.'); }
  };

  const onDone = (r: Reminder) => once(r, async () => {
    try { await cancel(r.notif_id); await setReminderStatus(r.id, 'done'); reload(); }
    catch (e: any) { Alert.alert('Could not update the reminder', e?.message ?? 'Try again.'); }
  })();
  const onSnooze = (r: Reminder) => once(r, async () => {
    try {
      const next = Date.now() + 86400000;
      const snoozeId = await scheduleAt('Vault Finance', r.title, next);
      // A recurring reminder keeps its own schedule; the snooze is one extra
      // alert tomorrow. Cancelling the recurrence here used to turn a monthly
      // reminder into a one-off without saying so.
      const ids = snoozedNotifIds(r.freq, r.notif_id, snoozeId);
      await cancel(ids.cancel);
      await snoozeReminder(r.id, next, ids.keep);
      if (!snoozeId) void warnUnscheduled();
      // The snooze itself may be fine while the repeating alert never was.
      else if (isUnscheduled(r.freq, ids.keep)) {
        Alert.alert('Snoozed, but not repeating',
          'You will be reminded tomorrow, but the repeating reminder is not scheduled, so it will not alert you after that. Allow notifications for this app in your phone settings, then add it again.');
      }
      reload();
    } catch (e: any) { Alert.alert('Could not snooze the reminder', e?.message ?? 'Try again.'); }
  })();
  const onDelete = (r: Reminder) => Alert.alert('Delete reminder?', r.title, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: once(r, async () => {
      try { await cancel(r.notif_id); await deleteReminder(r.id); reload(); }
      catch (e: any) { Alert.alert('Could not delete the reminder', e?.message ?? 'Try again.'); }
    }) },
  ]);

  const active = rows.filter(r => r.status === 'active');
  const done = rows.filter(r => r.status === 'done');

  return (
    <View style={s.screen}>
      {picker.element}
      <FinHeader title="Reminders" right={
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: showAdd }}
          accessibilityLabel={showAdd ? 'Close the new reminder form' : 'Add a reminder'} onPress={() => setShowAdd(v => !v)} hitSlop={8}>
          <Ionicons name={showAdd ? 'close' : 'add-circle'} size={26} color={FIN.brandDeep} />
        </TouchableOpacity>
      } />
      <KeyboardSafe>
      <ScrollView ref={scroller} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {showAdd && (
          <Card style={{ marginBottom: 8 }}>
            <Label>Title</Label>
            <Field label="Reminder title" value={title} onChangeText={setTitle} placeholder="e.g. Ramesh — interest due" />
            <Label>Repeat</Label>
            <Segment<ReminderFreq>
              options={[{ k: 'once', label: 'Once' }, { k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }, { k: 'yearly', label: 'Yearly' }]}
              value={freq} onChange={setFreq} small label="Repeat"
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
          <View key={r.id} style={[s.card, s.activeCard, r.id === params.focus && s.focused]}
            onLayout={(ev) => focusAt(r, ev.nativeEvent.layout.y)}>
            <View style={s.reminderHeading}>
              <View style={s.dot} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.title} numberOfLines={2}>{r.title}</Text>
                <Text style={s.sub}>{fmtDateTime(r.next_at)}</Text>
                {isUnscheduled(r.freq, r.notif_id) && <Text style={[s.sub, { color: FIN.bad }]}>Not scheduled: no phone alert</Text>}
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
          <View key={r.id} style={[s.card, r.id === params.focus && s.focused]}
            onLayout={(ev) => focusAt(r, ev.nativeEvent.layout.y)}>
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
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  section: { color: FIN.text, fontSize: 14, fontWeight: '800', marginTop: 16, marginBottom: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: FIN.good },
  title: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  sub: { color: FIN.sub, fontSize: 12, marginTop: 2 },
  activeCard: { flexDirection: 'column', alignItems: 'stretch' },
  focused: { borderColor: FIN.brand, borderWidth: 2 },
  reminderHeading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: FIN.border, paddingTop: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: FIN.cardStrong, borderRadius: 12 },
  whenBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: FIN.brandSoft, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: FIN.brand },
  whenTxt: { color: FIN.brandDeep, fontSize: 14, fontWeight: '700' },
});
