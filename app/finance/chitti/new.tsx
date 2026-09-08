// app/finance/chitti/new.tsx — Create a Lucky Draw group.

import React, { useState } from 'react';
import { KeyboardSafe } from '../../../components/ui';
import { View, ScrollView, StyleSheet, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { FIN } from '../../../constants/financeTheme';
import { FinHeader, Label, Field, Btn, DateField, Segment } from '../../../components/finance/ui';
import { useMe } from '../../../components/finance/useMe';
import { fmtDate, num } from '../../../utils/financeFormat';
import { insertGroup, type ChittiStatus } from '../../../db/chitti';

export default function NewChitti() {
  const router = useRouter();
  const me = useMe();
  const [name, setName] = useState('');
  const [chitValue, setChitValue] = useState('');
  const [installment, setInstallment] = useState('');
  const [members, setMembers] = useState('');
  const [duration, setDuration] = useState('');
  const [foreman, setForeman] = useState('');
  const [start, setStart] = useState<number>(Date.now());
  const [status, setStatus] = useState<ChittiStatus>('active');

  const onSave = async () => {
    if (!me) return;
    if (!name.trim()) return Alert.alert('Name', 'Enter a group name.');
    const cv = num(chitValue), inst = num(installment), mem = num(members), dur = num(duration);
    if (!(cv > 0)) return Alert.alert('Chit value', 'Enter a chit value greater than 0.');
    if (!(inst > 0)) return Alert.alert('Installment', 'Enter a monthly installment.');
    if (!(mem > 0)) return Alert.alert('Members', 'Enter the number of members.');
    if (!(dur > 0)) return Alert.alert('Duration', 'Enter the duration in months.');
    try {
      const g = await insertGroup({
        user_id: me.id, name: name.trim(), chit_value: cv, installment: inst,
        members: Math.round(mem), duration: Math.round(dur), start_date: start,
        foreman: foreman.trim() || null, status,
      });
      router.replace({ pathname: '/finance/chitti/[id]', params: { id: g.id } });
    } catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="New Lucky Draw Group" />
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Label>Group Name</Label>
          <Field value={name} onChangeText={setName} placeholder="e.g. Sundar Group" />

          <Label>Chit Value</Label>
          <Field value={chitValue} onChangeText={setChitValue} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Monthly Installment</Label>
          <Field value={installment} onChangeText={setInstallment} placeholder="₹ 0" keyboardType="numeric" />

          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Label>Members</Label>
              <Field value={members} onChangeText={setMembers} placeholder="e.g. 20" keyboardType="numeric" />
            </View>
            <View style={{ flex: 1 }}>
              <Label>Duration (months)</Label>
              <Field value={duration} onChangeText={setDuration} placeholder="e.g. 20" keyboardType="numeric" />
            </View>
          </View>

          <Label hint="(optional)">Foreman</Label>
          <Field value={foreman} onChangeText={setForeman} placeholder="Organizer name" />

          <Label>Start Date</Label>
          <DateField value={fmtDate(start)} onPress={() => DateTimePickerAndroid.open({ value: new Date(start), mode: 'date', onChange: (_e, d) => d && setStart(d.getTime()) })} />

          <Label>Status</Label>
          <Segment<ChittiStatus> options={[{ k: 'active', label: 'Active' }, { k: 'draft', label: 'Draft' }, { k: 'closed', label: 'Closed' }]} value={status} onChange={setStatus} small />

          <View style={{ marginTop: 20 }}>
            <Btn label="Create Group" icon="checkmark" onPress={onSave} wide />
          </View>
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  row: { flexDirection: 'row', gap: 12 },
});
