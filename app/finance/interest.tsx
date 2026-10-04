// app/finance/interest.tsx — Interest Calculator (simple/compound, %/₹, by
// dates or duration). Saves to on-device history; result exports to PDF.

import React, { useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../components/ui';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { useDatePicker } from '../../components/finance/useDatePicker';
import { FIN_HERO, TABULAR, type FinancePalette, HERO_INK } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Radio, Btn, DateField, HeroCard, Card, RowLine } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { fmtDate, num } from '../../utils/financeFormat';
import { round2, formatINR, type InterestType } from '../../utils/interest';
import type { LedgerPeriod } from '../../utils/finance';
import { calculateInterest, compoundingFor, compoundingWord, COMPOUNDING } from '../../lib/finance/compounding';
import { insertInterest } from '../../db/interestHistory';
import { sharePdf, pdfDocument, kvTable } from '../../utils/financeIO';

export default function InterestCalc() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const me = useMe();
  const [type, setType] = useState<InterestType>('simple');
  const [principal, setPrincipal] = useState('');
  const [rateMode, setRateMode] = useState<'percent' | 'rupees'>('percent');
  const [rate, setRate] = useState('');
  const [period, setPeriod] = useState<LedgerPeriod>('monthly');
  const [timeMode, setTimeMode] = useState<'dates' | 'duration'>('dates');
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number>(Date.now());
  const [durY, setDurY] = useState(''); const [durM, setDurM] = useState(''); const [durD, setDurD] = useState('');
  // Compounding periods per year. null follows the rate's period (2% a month
  // compounds monthly) until the user picks one.
  const [perYearPick, setPerYearPick] = useState<number | null>(null);
  const perYear = perYearPick ?? compoundingFor(period);
  // The result carries the inputs it was calculated from, so the PDF can never
  // pair edited form fields with a stale result (the bug emi.tsx already fixed).
  const [res, setRes] = useState<{
    interest: number; total: number; years: number;
    type: InterestType; principal: number; rate: number; rateMode: 'percent' | 'rupees'; period: LedgerPeriod;
    perYear: number; timeMode: 'dates' | 'duration';
  } | null>(null);
  const picker = useDatePicker();

  const pick = (which: 'from' | 'to') => {
    const cur = which === 'from' ? (from ?? Date.now()) : to;
    picker.open(new Date(cur), (d) => { if (which === 'from') setFrom(d.getTime()); else setTo(d.getTime()); });
  };

  const onCalc = async () => {
    const P = num(principal), R = num(rate);
    if (!(P > 0)) return Alert.alert('Principal', 'Enter a principal greater than 0.');
    // 0% is a real (family) loan — same rule as the ledger forms and EMI.
    if (!Number.isFinite(R) || R < 0) return Alert.alert('Rate', 'Enter an interest rate of 0 or more.');
    let years: number;
    if (timeMode === 'dates') {
      if (!from) return Alert.alert('From date', 'Pick a start date.');
      if (to <= from) return Alert.alert('Dates', 'End date must be after start date.');
      years = (to - from) / 31536000000;
    } else {
      // `|| 0` SWALLOWED THE HARDENED PARSER (2026-09-17). num() returns NaN
      // for a half-typed "1,2" so that `!(x > 0)` can reject it — but `|| 0`
      // turns that NaN back into a believable zero BEFORE the check, and the
      // check then passes on the strength of the other two boxes. Years "1,2"
      // with Months "6" calculated 0.5 years instead of 1.7 and WROTE that
      // duration to interest_history, with no alert and a plausible number on
      // the hero card. Blank is still 0 — num('') is 0, not NaN — so an
      // unfilled Months box costs nothing.
      const dY = num(durY), dM = num(durM), dD = num(durD);
      if (!Number.isFinite(dY) || !Number.isFinite(dM) || !Number.isFinite(dD)) {
        return Alert.alert('Duration', 'Years, months and days must be plain numbers. Use digits only — 1200 or 1,200 both work — or leave a box empty.');
      }
      // "2 years, −6 months" used to pass as 1.5 years because only the total
      // was checked; a negative part is a typo, not an instruction.
      if (dY < 0 || dM < 0 || dD < 0) return Alert.alert('Duration', 'Years, months and days cannot be negative.');
      years = dY + dM / 12 + dD / 365;
      if (!(years > 0)) return Alert.alert('Duration', 'Enter a duration greater than 0.');
    }
    const r = calculateInterest({ type, principal: P, rate: R, rateMode, period, years, perYear });
    // Nothing bounds the rate or the duration, and compounding overflows fast:
    // a daily rate annualises to ×365 and P·(1+r)^(n·T) with T = 999999999 is
    // Infinity. round2(Infinity) is Infinity, so the hero card read "₹∞" and
    // interest_history (REAL NOT NULL) took Infinity on disk, where nothing
    // downstream can recover from it. The bound is MAX_SAFE_INTEGER: past it a
    // double can no longer hold whole rupees, so round2() and the stored REAL
    // are already lying — a result we cannot represent is not a result we
    // should show or save (2026-09-17).
    if (!Number.isFinite(r.total) || Math.abs(r.total) > Number.MAX_SAFE_INTEGER) {
      return Alert.alert('Out of range', 'That rate and duration produce a number too large to calculate. Try a shorter duration or a lower rate.');
    }
    const out = { interest: round2(r.interest), total: round2(r.total), years, type, principal: P, rate: R, rateMode, period, perYear, timeMode };
    setRes(out);
    if (me) {
      try {
        await insertInterest({ user_id: me.id, user_name: me.name, type, principal: P, rate: R, time_years: round2(years), frequency: type === 'compound' ? perYear : null, interest: out.interest, total_amount: out.total, rate_mode: rateMode, period });
      } catch (e: any) {
        // `catch {}` made this file's own header comment ("Saves to on-device
        // history") a lie (2026-09-22). The result above is real and on screen,
        // but it is ephemeral — onClear and navigating away destroy it, and
        // unlike a ledger there is no detail route to reopen it — so a dropped
        // row is gone for good, while Saved & History tells the user "Nothing
        // has been lost". Announced exactly as a failed write is in
        // ledger/new.tsx; the title differs from that screen's 'Could not save'
        // because here the calculation itself DID succeed.
        Alert.alert('Not saved to history', `The result above is correct, but it could not be written to Saved & History. ${e?.message ?? 'Try again.'}`);
      }
    }
  };

  const onClear = () => { setPrincipal(''); setRate(''); setFrom(null); setTo(Date.now()); setDurY(''); setDurM(''); setDurD(''); setPerYearPick(null); setRes(null); };

  const onShare = async () => {
    if (!res) return;
    const html = pdfDocument('Interest Calculation', kvTable([
      { k: 'Interest type', v: res.type === 'simple' ? 'Simple' : 'Compound' },
      { k: 'Principal', v: formatINR(res.principal) },
      { k: 'Rate', v: `${res.rate}${res.rateMode === 'rupees' ? '₹ per ₹100' : '%'} ${res.period}` },
      ...(res.type === 'compound' ? [{ k: 'Compounded', v: compoundingWord(res.perYear) }] : []),
      { k: 'Duration', v: `${res.years.toFixed(2)} years` },
      { k: 'Interest', v: formatINR(res.interest) },
      { k: 'Total payable', v: formatINR(res.total), tot: true },
      { k: 'Day count', v: conventionNote(res.timeMode) },
      ...(res.type === 'compound' ? [{ k: 'Ledgers', v: LEDGER_NOTE }] : []),
    ]));
    try { await sharePdf(html, 'interest'); } catch (e: any) { Alert.alert('Share failed', e?.message ?? 'Try again'); }
  };

  const monthly = res ? round2(res.interest / (res.years * 12 || 1)) : 0;
  const daily = res ? round2(res.interest / (res.years * 365 || 1)) : 0;

  return (
    <View style={s.screen}>
      <FinHeader title="Interest Calculator" />
      {picker.element}
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Label>Interest Type</Label>
          <View style={s.radioRow} accessibilityRole="radiogroup" accessibilityLabel="Interest type">
            <Radio label="Simple" active={type === 'simple'} onPress={() => setType('simple')} />
            <Radio label="Compound" active={type === 'compound'} onPress={() => setType('compound')} />
          </View>

          <Label>Principal Amount</Label>
          <Field label="Principal amount" value={principal} onChangeText={setPrincipal} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Rate Type</Label>
          <Segment<'percent' | 'rupees'> options={[{ k: 'percent', label: '% (percentage)' }, { k: 'rupees', label: '₹ per ₹100' }]} value={rateMode} onChange={setRateMode} label="Rate type" />

          <Label>{rateMode === 'rupees' ? 'Interest Rate (₹ per ₹100)' : 'Interest Rate (%)'}</Label>
          <Field label={rateMode === 'rupees' ? 'Interest rate, rupees per 100' : 'Interest rate, percent'} value={rate} onChangeText={setRate} placeholder="Enter rate" keyboardType="numeric" />

          <Label>Interest Period</Label>
          <Segment<LedgerPeriod> options={[{ k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }, { k: 'yearly', label: 'Yearly' }]} value={period} onChange={setPeriod} small label="Interest period" />

          {type === 'compound' && (
            <>
              <Label hint="(follows the period until you pick)">Compounded</Label>
              <Segment<string>
                options={COMPOUNDING.map(c => ({ k: String(c.n), label: c.label }))}
                value={String(perYear)} onChange={(k) => setPerYearPick(Number(k))} small label="Compounded"
              />
            </>
          )}

          <View style={[s.radioRow, { marginTop: 16 }]} accessibilityRole="radiogroup" accessibilityLabel="Enter the time as">
            <Radio label="Dates" active={timeMode === 'dates'} onPress={() => setTimeMode('dates')} />
            <Radio label="Duration" active={timeMode === 'duration'} onPress={() => setTimeMode('duration')} />
          </View>

          {timeMode === 'dates' ? (
            <>
              <Label>From Date</Label>
              <DateField label="From date" value={from ? fmtDate(from) : ''} onPress={() => pick('from')} />
              <Label>To Date</Label>
              <DateField label="To date" value={fmtDate(to)} onPress={() => pick('to')} />
            </>
          ) : (
            <>
              <Label>Duration</Label>
              <View style={s.durRow}>
                <View style={s.durationField}><Field label="Duration in years" value={durY} onChangeText={setDurY} placeholder="Years" keyboardType="numeric" /></View>
                <View style={s.durationField}><Field label="Duration in months" value={durM} onChangeText={setDurM} placeholder="Months" keyboardType="numeric" /></View>
                <View style={s.durationField}><Field label="Duration in days" value={durD} onChangeText={setDurD} placeholder="Days" keyboardType="numeric" /></View>
              </View>
            </>
          )}

          <View style={s.btnRow}>
            <Btn label="Clear" kind="ghost" onPress={onClear} wide />
            <Btn label="Calculate" icon="calculator" onPress={onCalc} wide />
          </View>

          {res && (
            <>
              <HeroCard colors={FIN_HERO.good}>
                <Text style={s.heroLabel}>TOTAL (P + I)</Text>
                <Text style={s.heroVal}>{formatINR(res.total)}</Text>
              </HeroCard>
              <Card style={{ marginTop: 12 }}>
                <RowLine k="Interest" v={formatINR(res.interest)} bold />
                {res.type === 'compound' && <RowLine k="Compounded" v={compoundingWord(res.perYear)} />}
                <RowLine k="Monthly interest" v={formatINR(monthly)} />
                <RowLine k="Daily interest" v={formatINR(daily)} />
                <RowLine k="Duration" v={`${res.years.toFixed(2)} years`} />
                <Text style={s.note}>{conventionNote(res.timeMode)}</Text>
                {res.type === 'compound' && <Text style={s.note}>{LEDGER_NOTE}</Text>}
              </Card>
              <View style={s.btnRow}>
                <Btn label="Share PDF" kind="ghost" icon="share-outline" onPress={onShare} wide />
              </View>
            </>
          )}
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

/** A ledger with the same terms gives this answer only with the same compounding. */
const LEDGER_NOTE = 'A ledger compounds as chosen on that ledger; ledgers saved before the choice existed compound yearly.';

/** The day-count convention the duration was turned into years with. */
function conventionNote(mode: 'dates' | 'duration'): string {
  return mode === 'dates'
    ? 'Years are counted as days between the dates ÷ 365.'
    : 'A year is 365 days; a month is 1/12 of a year (about 30.4 days).';
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  radioRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 28, rowGap: 8, marginTop: 4 },
  durRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  durationField: { flexGrow: 1, flexBasis: 100, minWidth: 0 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 20 },
  note: { color: FIN.faint, fontSize: 12, lineHeight: 17, marginTop: 8 },
  // Hero ink: the FIN_HERO gradient is dark in both schemes (HERO_INK, constants/financeTheme).
  heroLabel: { color: HERO_INK.label, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: HERO_INK.strong, fontSize: 28, fontWeight: '800', marginTop: 6, ...TABULAR },
});
