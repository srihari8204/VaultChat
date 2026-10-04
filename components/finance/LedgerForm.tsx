// components/finance/LedgerForm.tsx — the one ledger form, used by
// app/finance/ledger/new.tsx and app/finance/ledger/edit.tsx.
//
// The two screens each had their own copy of these fields and checks; this is
// that copy, once. The checks are components/finance/ledgerFormRules. The form
// owns its field state and the date picker; the screen decides what Save does.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, AccessibilityInfo } from 'react-native';
import { KeyboardSafe } from '../ui';
import { useFinanceTheme } from './useFinanceTheme';
import { useDatePicker } from './useDatePicker';
import { type FinancePalette } from '../../constants/financeTheme';
import { Label, Field, Segment, Radio, Btn, DateField } from './ui';
import { fmtDate, formatINR } from '../../utils/financeFormat';
import type { LedgerPeriod } from '../../utils/finance';
import { ledgerInterest, ledgerCompounding } from '../../utils/financeRules';
import { COMPOUNDING, ledgerInterestTypeLabel } from '../../lib/finance/compounding';
import { checkLedgerForm } from './ledgerFormRules';
import type { LedgerPrefill } from './ledgerPrefill';

export interface LedgerFormValues {
  direction: 'lend' | 'borrow'; name: string; mobile: string | null;
  interest_type: 'simple' | 'compound'; principal: number; rate: number; rate_mode: 'percent' | 'rupees';
  period: LedgerPeriod; start_date: number; end_date: number | null; notes: string | null;
  /** Compound only: periods per year (null for simple interest). */
  compounding: number | null;
}

export function LedgerForm({ initial, prefill, directionEditable, saveLabel, onSave }: {
  /** The stored ledger when editing; omitted for a new one. */
  initial?: LedgerFormValues;
  /** Starting terms for a new ledger (the calculator's "Save as ledger"). */
  prefill?: LedgerPrefill;
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
  const seed: LedgerPrefill | undefined = initial ?? prefill;
  const [itype, setItype] = useState<'simple' | 'compound'>(seed?.interest_type ?? 'simple');
  const [principal, setPrincipal] = useState(seed?.principal != null ? String(seed.principal) : '');
  const [rateMode, setRateMode] = useState<'percent' | 'rupees'>(seed?.rate_mode ?? 'percent');
  const [rate, setRate] = useState(seed?.rate != null ? String(seed.rate) : '');
  const [period, setPeriod] = useState<LedgerPeriod>(seed?.period ?? 'monthly');
  const [start, setStart] = useState<number>(seed?.start_date ?? Date.now());
  const [end, setEnd] = useState<number | null>(seed?.end_date ?? null);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  // Yearly unless chosen: every ledger was computed that way before the choice
  // existed, so a stored NULL stays yearly (utils/financeRules ledgerCompounding).
  const [perYear, setPerYear] = useState<number>(ledgerCompounding({ compounding: seed?.compounding }));
  // After a refused Save the checks run live, so the marked field clears as
  // soon as it is fixed.
  const [tried, setTried] = useState(false);

  const pickDate = (which: 'start' | 'end') => {
    const cur = which === 'start' ? start : (end ?? Date.now());
    picker.open(new Date(cur), (d) => { if (which === 'start') setStart(d.getTime()); else setEnd(d.getTime()); });
  };

  const checked = checkLedgerForm({ name, mobile, principal, rate, start, end });
  // Every failing field is marked, not only the first.
  const problems = tried && 'problems' in checked ? checked.problems : [];
  const errorAt = (f: string) => problems.find((p) => p.field === f)?.message;
  const compounding = itype === 'compound' ? perYear : null;
  // What these terms come to, and what the stored ones did, so an edit shows
  // its effect on the interest before it is saved.
  const terms = (v: Pick<LedgerFormValues, 'principal' | 'rate'>) => ({
    principal: v.principal, rate: v.rate, rate_mode: rateMode, period, interest_type: itype, start_date: start, end_date: end, compounding,
  });
  const preview = 'ok' in checked ? ledgerInterest(terms(checked.ok)) : null;
  const was = initial ? ledgerInterest(initial) : null;
  const previewLine = preview
    ? `${ledgerInterestTypeLabel({ interest_type: itype, compounding })}. ${preview.projected ? 'Interest over 1 year (no end date)' : 'Interest to end date'}: ${formatINR(preview.interest)}${was && was.interest !== preview.interest ? ` (was ${formatINR(was.interest)})` : ''}`
    : null;
  // A change of interest type or compounding is spoken with its effect; the
  // line is not a live region because typing a rate would re-read it per key.
  const choiceKey = `${itype}:${perYear}`;
  const lastChoice = useRef(choiceKey);
  useEffect(() => {
    if (lastChoice.current === choiceKey) return;
    lastChoice.current = choiceKey;
    if (previewLine) AccessibilityInfo.announceForAccessibility(previewLine);
  }, [choiceKey, previewLine]);

  const submit = async () => {
    setTried(true);
    if ('problem' in checked) return Alert.alert(checked.problem.title, checked.problem.message);
    const c = checked.ok;
    try {
      await onSave({
        direction, name: c.name, mobile: c.mobile, interest_type: itype, principal: c.principal,
        rate: c.rate, rate_mode: rateMode, period, start_date: start, end_date: end, notes: notes.trim() || null,
        compounding,
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
          <Field label={`${who} name`} value={name} onChangeText={setName} placeholder="Enter name" error={errorAt('name')} />

          <Label hint="(optional)">Mobile Number</Label>
          <Field label="Mobile number, optional" value={mobile} onChangeText={setMobile} placeholder="Enter mobile number" keyboardType="phone-pad" error={errorAt('mobile')} />

          <Label>Principal Amount</Label>
          <Field label="Principal amount" value={principal} onChangeText={setPrincipal} placeholder="₹ 0" keyboardType="numeric" error={errorAt('principal')} />

          <Label>Interest Type</Label>
          <Segment<'simple' | 'compound'> options={[{ k: 'simple', label: 'Simple' }, { k: 'compound', label: 'Compound' }]} value={itype} onChange={setItype} label="Interest type" />
          {itype === 'compound' && (<>
            <Label>Compounded</Label>
            <Segment<string>
              options={COMPOUNDING.map(c => ({ k: String(c.n), label: c.label }))}
              value={String(perYear)} onChange={(k) => setPerYear(Number(k))} small label="Compounded"
            />
          </>)}

          <Label>Rate Type</Label>
          <Segment<'percent' | 'rupees'> options={[{ k: 'percent', label: '% (percentage)' }, { k: 'rupees', label: '₹ per ₹100' }]} value={rateMode} onChange={setRateMode} label="Rate type" />

          <Label>{rateMode === 'rupees' ? 'Interest Rate (₹ per ₹100)' : 'Interest Rate (%)'}</Label>
          <Field label={rateMode === 'rupees' ? 'Interest rate, rupees per 100' : 'Interest rate, percent'} value={rate} onChangeText={setRate} placeholder="Enter rate" keyboardType="numeric" error={errorAt('rate')} />

          <Label>Interest Period</Label>
          <Segment<LedgerPeriod>
            options={[{ k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }, { k: 'yearly', label: 'Yearly' }]}
            value={period} onChange={setPeriod} small label="Interest period"
          />

          <Label>Start Date</Label>
          <DateField label="Start date" value={fmtDate(start)} onPress={() => pickDate('start')} />
          <Label hint="(optional)">End Date</Label>
          <DateField label="End date" value={end ? fmtDate(end) : ''} onPress={() => pickDate('end')} onClear={() => setEnd(null)} />
          {errorAt('end') ? <Text style={s.err} accessibilityLiveRegion="polite">{errorAt('end')}</Text> : null}

          <Label hint="(optional)">Notes</Label>
          <Field label="Notes, optional" value={notes} onChangeText={setNotes} placeholder="Add a note" multiline />

          {previewLine && <Text style={s.preview}>{previewLine}</Text>}

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
  err: { color: FIN.bad, fontSize: 12.5, fontWeight: '600', marginTop: 6 },
  preview: { color: FIN.sub, fontSize: 13, lineHeight: 19, marginTop: 18 },
});

export default LedgerForm;
