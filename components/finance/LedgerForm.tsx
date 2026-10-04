// components/finance/LedgerForm.tsx — the one ledger form, used by
// app/finance/ledger/new.tsx and app/finance/ledger/edit.tsx.
//
// The two screens each had their own copy of these fields and checks; this is
// that copy, once. The checks are components/finance/ledgerFormRules. The form
// owns its field state and the date picker; the screen decides what Save does.

import React, { useState } from 'react';
import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import { KeyboardSafe } from '../ui';
import { useFinanceTheme } from './useFinanceTheme';
import { useDatePicker } from './useDatePicker';
import { type FinancePalette } from '../../constants/financeTheme';
import { Label, Field, Segment, Radio, Btn, DateField } from './ui';
import { fmtDate } from '../../utils/financeFormat';
import type { LedgerPeriod } from '../../utils/finance';
import { checkLedgerForm } from './ledgerFormRules';

export interface LedgerFormValues {
  direction: 'lend' | 'borrow'; name: string; mobile: string | null;
  interest_type: 'simple' | 'compound'; principal: number; rate: number; rate_mode: 'percent' | 'rupees';
  period: LedgerPeriod; start_date: number; end_date: number | null; notes: string | null;
}

export function LedgerForm({ initial, directionEditable, saveLabel, onSave }: {
  /** The stored ledger when editing; omitted for a new one. */
  initial?: Omit<LedgerFormValues, 'mobile' | 'notes'> & { mobile: string | null; notes: string | null };
  /** Lend / Borrow can be chosen only when creating. */
  directionEditable: boolean;
  saveLabel: string;
  /** Called with checked values; a throw is shown as "Could not save". */
  onSave: (v: LedgerFormValues) => Promise<void>;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const picker = useDatePicker();

  const [direction, setDirection] = useState<'lend' | 'borrow'>(initial?.direction ?? 'lend');
  const [name, setName] = useState(initial?.name ?? '');
  const [mobile, setMobile] = useState(initial?.mobile ?? '');
  const [itype, setItype] = useState<'simple' | 'compound'>(initial?.interest_type ?? 'simple');
  const [principal, setPrincipal] = useState(initial ? String(initial.principal) : '');
  const [rateMode, setRateMode] = useState<'percent' | 'rupees'>(initial?.rate_mode ?? 'percent');
  const [rate, setRate] = useState(initial ? String(initial.rate) : '');
  const [period, setPeriod] = useState<LedgerPeriod>(initial?.period ?? 'monthly');
  const [start, setStart] = useState<number>(initial?.start_date ?? Date.now());
  const [end, setEnd] = useState<number | null>(initial?.end_date ?? null);
  const [notes, setNotes] = useState(initial?.notes ?? '');

  const pickDate = (which: 'start' | 'end') => {
    const cur = which === 'start' ? start : (end ?? Date.now());
    picker.open(new Date(cur), (d) => { if (which === 'start') setStart(d.getTime()); else setEnd(d.getTime()); });
  };

  const submit = async () => {
    const checked = checkLedgerForm({ name, mobile, principal, rate, start, end });
    if ('problem' in checked) return Alert.alert(checked.problem.title, checked.problem.message);
    const c = checked.ok;
    try {
      await onSave({
        direction, name: c.name, mobile: c.mobile, interest_type: itype, principal: c.principal,
        rate: c.rate, rate_mode: rateMode, period, start_date: start, end_date: end, notes: notes.trim() || null,
      });
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Try again');
    }
  };

  const who = direction === 'lend' ? 'Borrower' : 'Lender';
  return (
    <>
      {picker.element}
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {directionEditable && (
            <View style={s.radioRow} accessibilityRole="radiogroup" accessibilityLabel="Lend or borrow">
              <Radio label="Lend" active={direction === 'lend'} onPress={() => setDirection('lend')} />
              <Radio label="Borrow" active={direction === 'borrow'} onPress={() => setDirection('borrow')} />
            </View>
          )}

          <Label>{who} Name</Label>
          <Field label={`${who} name`} value={name} onChangeText={setName} placeholder="Enter name" />

          <Label hint="(optional)">Mobile Number</Label>
          <Field label="Mobile number, optional" value={mobile} onChangeText={setMobile} placeholder="Enter mobile number" keyboardType="phone-pad" />

          <Label>Principal Amount</Label>
          <Field label="Principal amount" value={principal} onChangeText={setPrincipal} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Interest Type</Label>
          <Segment<'simple' | 'compound'> options={[{ k: 'simple', label: 'Simple' }, { k: 'compound', label: 'Compound' }]} value={itype} onChange={setItype} />

          <Label>Rate Type</Label>
          <Segment<'percent' | 'rupees'> options={[{ k: 'percent', label: '% (percentage)' }, { k: 'rupees', label: '₹ per ₹100' }]} value={rateMode} onChange={setRateMode} />

          <Label>{rateMode === 'rupees' ? 'Interest Rate (₹ per ₹100)' : 'Interest Rate (%)'}</Label>
          <Field label={rateMode === 'rupees' ? 'Interest rate, rupees per 100' : 'Interest rate, percent'} value={rate} onChangeText={setRate} placeholder="Enter rate" keyboardType="numeric" />

          <Label>Interest Period</Label>
          <Segment<LedgerPeriod>
            options={[{ k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }, { k: 'yearly', label: 'Yearly' }]}
            value={period} onChange={setPeriod} small
          />

          <Label>Start Date</Label>
          <DateField label="Start date" value={fmtDate(start)} onPress={() => pickDate('start')} />
          <Label hint="(optional)">End Date</Label>
          <DateField label="End date" value={end ? fmtDate(end) : ''} onPress={() => pickDate('end')} onClear={() => setEnd(null)} />

          <Label hint="(optional)">Notes</Label>
          <Field label="Notes, optional" value={notes} onChangeText={setNotes} placeholder="Add a note" multiline />

          <View style={{ marginTop: 20 }}>
            <Btn label={saveLabel} icon="checkmark" onPress={submit} wide />
          </View>
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardSafe>
    </>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  radioRow: { flexDirection: 'row', gap: 28, marginTop: 8, marginBottom: 4 },
});

export default LedgerForm;
