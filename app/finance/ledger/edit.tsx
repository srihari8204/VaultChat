// app/finance/ledger/edit.tsx — edit an existing ledger's terms (not balance).

import React, { useCallback, useEffect, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../../components/ui';
import { View, ScrollView, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useDatePicker } from '../../../components/finance/useDatePicker';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Btn, DateField, LoadingState, ErrorState } from '../../../components/finance/ui';
import { fmtDate, num } from '../../../utils/financeFormat';
import { getLedger, updateLedgerDetails, type LedgerEntry } from '../../../db/ledger';
import type { LedgerPeriod } from '../../../utils/finance';
import { normalizeMobile, ledgerDatesProblem } from '../../../utils/financeRules';

export default function EditLedger() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [e, setE] = useState<LedgerEntry | null>(null);

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

  const picker = useDatePicker();
  const { status, begin, done, fail } = useLoadStatus();
  const load = useCallback(() => {
    if (!id) { fail(); return; }
    begin();
    getLedger(id).then((row) => { setE(row); done(); }).catch(fail);
  }, [id, begin, done, fail]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!e) return;
    setName(e.name); setMobile(e.mobile ?? ''); setItype(e.interest_type);
    setPrincipal(String(e.principal)); setRateMode(e.rate_mode); setRate(String(e.rate));
    setPeriod(e.period); setStart(e.start_date); setEnd(e.end_date); setNotes(e.notes ?? '');
  }, [e]);

  const pickDate = (which: 'start' | 'end') => {
    const cur = which === 'start' ? start : (end ?? Date.now());
    picker.open(new Date(cur), (d) => { if (which === 'start') setStart(d.getTime()); else setEnd(d.getTime()); });
  };

  const onSave = async () => {
    if (!e) return;
    if (!name.trim()) return Alert.alert('Name', 'Enter a name.');
    const P = num(principal), R = num(rate);
    if (!(P > 0)) return Alert.alert('Principal', 'Enter a principal greater than 0.');
    // 0% IS A REAL LOAN (2026-09-17): money lent to a relative at no interest is
    // the commonest informal ledger there is, and utils/finance.ts prices a 0%
    // rate deliberately (`r === 0 ? principal / months : ...`). `!(R > 0)`
    // refused to record it at all. A rate must be FINITE and NON-NEGATIVE, not
    // positive — NaN (a half-typed "1,2") and negatives are still refused.
    // app/finance/emi.tsx has used this exact shape since 2026-09-17.
    if (!Number.isFinite(R) || R < 0) return Alert.alert('Rate', 'Enter an interest rate of 0 or more.');
    // Stored normalised (10 digits), like Lucky Draw members, so the customer
    // profile can match the same person typed as "+91 98765 43210" elsewhere.
    let mob: string | null = null;
    if (mobile.trim()) {
      mob = normalizeMobile(mobile);
      if (!mob) return Alert.alert('Mobile number', 'Enter a valid 10-digit mobile number, or leave it empty.');
    }
    const dateProblem = ledgerDatesProblem(start, end);
    if (dateProblem) return Alert.alert('End date', dateProblem);
    try {
      await updateLedgerDetails(e.id, {
        name: name.trim(), mobile: mob, interest_type: itype, principal: P,
        rate: R, rate_mode: rateMode, period, start_date: start, end_date: end, notes: notes.trim() || null,
      });
      router.back();
    } catch (err: any) { Alert.alert('Could not save', err?.message ?? 'Try again'); }
  };

  if (!e) {
    return (
      <View style={s.screen}>
        <FinHeader title="Edit Ledger" />
        {status === 'loading' && <LoadingState label="Loading ledger" />}
        {status === 'error' && <ErrorState title="Could not load this ledger" sub="Nothing has been changed." onRetry={load} />}
        {status === 'ready' && <ErrorState title="Ledger not found" sub="It may have been deleted." />}
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <FinHeader title="Edit Ledger" />
      {picker.element}
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Label>Name</Label>
          <Field label="Name" value={name} onChangeText={setName} placeholder="Enter name" />
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
          <Segment<LedgerPeriod> options={[{ k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }, { k: 'yearly', label: 'Yearly' }]} value={period} onChange={setPeriod} small />
          <Label>Start Date</Label>
          <DateField label="Start date" value={fmtDate(start)} onPress={() => pickDate('start')} />
          <Label hint="(optional)">End Date</Label>
          <DateField label="End date" value={end ? fmtDate(end) : ''} onPress={() => pickDate('end')} onClear={() => setEnd(null)} />
          <Label hint="(optional)">Notes</Label>
          <Field label="Notes, optional" value={notes} onChangeText={setNotes} placeholder="Add a note" multiline />
          <View style={{ marginTop: 20 }}>
            <Btn label="Save Changes" icon="checkmark" onPress={onSave} wide />
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
});
