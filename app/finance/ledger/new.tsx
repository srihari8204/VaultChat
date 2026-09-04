// app/finance/ledger/new.tsx — Add a Lend / Borrow ledger entry.

import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { FIN } from '../../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Radio, Btn, DateField } from '../../../components/finance/ui';
import { useMe } from '../../../components/finance/useMe';
import { fmtDate, num } from '../../../utils/financeFormat';
import { insertLedger } from '../../../db/ledger';
import type { LedgerPeriod } from '../../../utils/finance';

export default function NewLedger() {
  const router = useRouter();
  const me = useMe();

  const [direction, setDirection] = useState<'lend' | 'borrow'>('lend');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [itype, setItype] = useState<'simple' | 'compound'>('simple');
  const [principal, setPrincipal] = useState('');
  const [rateMode, setRateMode] = useState<'percent' | 'rupees'>('percent');
  const [rate, setRate] = useState('');
  const [period, setPeriod] = useState<LedgerPeriod>('monthly');
  const [start, setStart] = useState<number>(Date.now());
  const [end, setEnd] = useState<number | null>(null);
  const [notes, setNotes] = useState('');

  const pickDate = (which: 'start' | 'end') => {
    const cur = which === 'start' ? start : (end ?? Date.now());
    DateTimePickerAndroid.open({
      value: new Date(cur), mode: 'date',
      onChange: (_e, d) => { if (d) which === 'start' ? setStart(d.getTime()) : setEnd(d.getTime()); },
    });
  };

  const onSave = async () => {
    if (!me) return;
    if (!name.trim()) return Alert.alert('Name', 'Enter a name.');
    const P = num(principal), R = num(rate);
    if (!(P > 0)) return Alert.alert('Principal', 'Enter a principal greater than 0.');
    if (!(R > 0)) return Alert.alert('Rate', 'Enter an interest rate greater than 0.');
    try {
      await insertLedger({
        user_id: me.id, direction, name: name.trim(), mobile: mobile.trim() || null,
        interest_type: itype, principal: P, rate: R, rate_mode: rateMode, period,
        start_date: start, end_date: end, notes: notes.trim() || null,
      });
      router.back();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again');
    }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Add Ledger" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={s.radioRow}>
            <Radio label="Lend" active={direction === 'lend'} onPress={() => setDirection('lend')} />
            <Radio label="Borrow" active={direction === 'borrow'} onPress={() => setDirection('borrow')} />
          </View>

          <Label>{direction === 'lend' ? 'Borrower Name' : 'Lender Name'}</Label>
          <Field value={name} onChangeText={setName} placeholder="Enter name" />

          <Label hint="(optional)">Mobile Number</Label>
          <Field value={mobile} onChangeText={setMobile} placeholder="Enter mobile number" keyboardType="phone-pad" />

          <Label>Principal Amount</Label>
          <Field value={principal} onChangeText={setPrincipal} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Interest Type</Label>
          <Segment<'simple' | 'compound'> options={[{ k: 'simple', label: 'Simple' }, { k: 'compound', label: 'Compound' }]} value={itype} onChange={setItype} />

          <Label>Rate Type</Label>
          <Segment<'percent' | 'rupees'> options={[{ k: 'percent', label: '% (percentage)' }, { k: 'rupees', label: '₹ per ₹100' }]} value={rateMode} onChange={setRateMode} />

          <Label>{rateMode === 'rupees' ? 'Interest Rate (₹ per ₹100)' : 'Interest Rate (%)'}</Label>
          <Field value={rate} onChangeText={setRate} placeholder="Enter rate" keyboardType="numeric" />

          <Label>Interest Period</Label>
          <Segment<LedgerPeriod>
            options={[{ k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }, { k: 'yearly', label: 'Yearly' }]}
            value={period} onChange={setPeriod} small
          />

          <Label>Start Date</Label>
          <DateField value={fmtDate(start)} onPress={() => pickDate('start')} />
          <Label hint="(optional)">End Date</Label>
          <DateField value={end ? fmtDate(end) : ''} onPress={() => pickDate('end')} />

          <Label hint="(optional)">Notes</Label>
          <Field value={notes} onChangeText={setNotes} placeholder="Add a note" multiline />

          <View style={{ marginTop: 20 }}>
            <Btn label="Save Ledger" icon="checkmark" onPress={onSave} wide />
          </View>
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  radioRow: { flexDirection: 'row', gap: 28, marginTop: 8, marginBottom: 4 },
});
