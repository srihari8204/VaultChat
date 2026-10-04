// app/finance/chitti/new.tsx — Create a Lucky Draw group.

import React, { useRef, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../../components/ui';
import { View, Text, ScrollView, StyleSheet, Alert, AccessibilityInfo } from 'react-native';
import { useRouter } from 'expo-router';
import { useDatePicker } from '../../../components/finance/useDatePicker';
import { type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader, Label, Field, Btn, DateField, Segment } from '../../../components/finance/ui';
import { useMe } from '../../../components/finance/useMe';
import { fmtDate, num, formatINR } from '../../../utils/financeFormat';
import { toPaise } from '../../../utils/money';
import { insertGroup, type ChittiStatus } from '../../../db/chitti';
import { checkChittiForm, type ChittiFormField } from '../../../components/finance/chittiFormRules';
import { userErrorText } from '../../../lib/userErrorText';

export default function NewChitti() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const router = useRouter();
  const me = useMe();
  const picker = useDatePicker();
  const [name, setName] = useState('');
  const [chitValue, setChitValue] = useState('');
  const [installment, setInstallment] = useState('');
  const [members, setMembers] = useState('');
  const [duration, setDuration] = useState('');
  const [foreman, setForeman] = useState('');
  const [start, setStart] = useState<number>(Date.now());
  // A new group is Active or a Draft. Closed is where a group ends up (by
  // itself after its last auction, or from the group screen), not a start.
  const [status, setStatus] = useState<Exclude<ChittiStatus, 'closed'>>('active');
  // After a refused Create the checks run live, so each marked field clears as
  // soon as it is fixed (the LedgerForm pattern).
  const [tried, setTried] = useState(false);
  const checked = checkChittiForm({ name, chitValue, installment, members, duration });
  const errorAt = (f: ChittiFormField) =>
    tried && 'problems' in checked ? checked.problems.find((p) => p.field === f)?.message : undefined;

  // The installment × members check, shown next to the fields as they are
  // typed (paise-exact), and still confirmed on Create.
  const live = { cv: num(chitValue), inst: num(installment), mem: num(members) };
  const mismatch = live.cv > 0 && live.inst > 0 && Number.isInteger(live.mem) && live.mem >= 1
    && toPaise(live.inst) * live.mem !== toPaise(live.cv)
    ? `${formatINR(live.inst)} × ${live.mem} members is ${formatINR((toPaise(live.inst) * live.mem) / 100)}, not the chit value ${formatINR(live.cv)}.`
    : null;

  const onSave = async () => {
    if (!me) return;
    setTried(true);
    if ('problem' in checked) return Alert.alert(checked.problem.title, checked.problem.message);
    const { chitValue: cv, installment: inst, members: mem, duration: dur } = checked.ok;
    // In a standard chit every member pays the installment each month, so
    // installment × members is the chit value. A mismatch is usually a typo —
    // but some groups do run that way, so it is a question, not a refusal.
    if (toPaise(inst) * mem !== toPaise(cv)) {
      const go = await new Promise<boolean>((resolve) => Alert.alert(
        'Check the amounts',
        `${formatINR(inst)} × ${mem} members is ${formatINR((toPaise(inst) * mem) / 100)}, but the chit value is ${formatINR(cv)}. Create the group anyway?`,
        [{ text: 'Go back', style: 'cancel', onPress: () => resolve(false) }, { text: 'Create', onPress: () => resolve(true) }],
        { cancelable: true, onDismiss: () => resolve(false) },
      ));
      if (!go) return;
    }
    try {
      const g = await insertGroup({
        user_id: me.id, name: checked.ok.name, chit_value: cv, installment: inst,
        members: mem, duration: dur, start_date: start,
        foreman: foreman.trim() || null, status,
      });
      router.replace({ pathname: '/finance/chitti/[id]', params: { id: g.id } });
    } catch (e) { Alert.alert('Could not save', userErrorText(e, 'Try again')); }
  };

  // Leaving an amount field says the mismatch once (each distinct one), so a
  // screen-reader user hears it before Create, without per-keystroke chatter.
  const saidMismatch = useRef<string | null>(null);
  const sayMismatch = () => {
    if (mismatch && mismatch !== saidMismatch.current) AccessibilityInfo.announceForAccessibility(mismatch);
    saidMismatch.current = mismatch || null;
  };

  return (
    <View style={s.screen}>
      <FinHeader title="New Lucky Draw Group" />
      {picker.element}
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Label>Group Name</Label>
          <Field label="Group name" error={errorAt('name')} value={name} onChangeText={setName} placeholder="e.g. Sundar Group" />

          <Label>Chit Value</Label>
          <Field label="Chit value" error={errorAt('chitValue')} onBlur={sayMismatch} value={chitValue} onChangeText={setChitValue} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Monthly Installment</Label>
          <Field label="Monthly installment" error={errorAt('installment')} onBlur={sayMismatch} value={installment} onChangeText={setInstallment} placeholder="₹ 0" keyboardType="numeric" />

          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Label>Members</Label>
              <Field label="Members" error={errorAt('members')} onBlur={sayMismatch} value={members} onChangeText={setMembers} placeholder="e.g. 20" keyboardType="numeric" />
            </View>
            <View style={{ flex: 1 }}>
              <Label>Duration (months)</Label>
              <Field label="Duration in months" error={errorAt('duration')} value={duration} onChangeText={setDuration} placeholder="e.g. 20" keyboardType="numeric" />
            </View>
          </View>

          {/* Not a live region: it is rebuilt on every keystroke, and Android
              re-announced it while typing. It is spoken once when an amount
              field loses focus (sayMismatch), and Create confirms it. */}
          {mismatch && <Text style={s.mismatch}>{mismatch} Check the amounts, or create it anyway if your group runs that way.</Text>}

          <Label hint="(optional)">Foreman</Label>
          <Field label="Foreman, optional" value={foreman} onChangeText={setForeman} placeholder="Organizer name" />

          <Label>Start Date</Label>
          <DateField label="Start date" value={fmtDate(start)} onPress={() => picker.open(new Date(start), (d) => setStart(d.getTime()))} />

          <Label>Status</Label>
          <Segment<Exclude<ChittiStatus, 'closed'>> options={[{ k: 'active', label: 'Active' }, { k: 'draft', label: 'Draft' }]} value={status} onChange={setStatus} small label="Group status" />

          <View style={{ marginTop: 20 }}>
            <Btn label="Create Group" icon="checkmark" onPress={onSave} wide />
          </View>
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  row: { flexDirection: 'row', gap: 12 },
  mismatch: { color: FIN.warn, fontSize: 12.5, lineHeight: 18, marginTop: 8 },
});
