// app/finance/interest.tsx — Interest Calculator (simple/compound, %/₹, by
// dates or duration). Saves to on-device history; result exports to PDF.

import React, { useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../components/ui';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { useDatePicker } from '../../components/finance/useDatePicker';
import { FIN_HERO, TABULAR, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Radio, Btn, DateField, HeroCard, Card, RowLine } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { fmtDate, num } from '../../utils/financeFormat';
import { simpleInterest, compoundInterest, round2, formatINR, type InterestType } from '../../utils/interest';
import { periodRateToAnnualPct, type LedgerPeriod } from '../../utils/finance';
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
  // The result carries the inputs it was calculated from, so the PDF can never
  // pair edited form fields with a stale result (the bug emi.tsx already fixed).
  const [res, setRes] = useState<{
    interest: number; total: number; years: number;
    type: InterestType; principal: number; rate: number; rateMode: 'percent' | 'rupees'; period: LedgerPeriod;
  } | null>(null);
  const picker = useDatePicker();

  const pick = (which: 'from' | 'to') => {
    const cur = which === 'from' ? (from ?? Date.now()) : to;
    picker.open(new Date(cur), (d) => { if (which === 'from') setFrom(d.getTime()); else setTo(d.getTime()); });
  };

  const onCalc = async () => {
    const P = num(principal), R = num(rate);
    if (!(P > 0)) return Alert.alert('Principal', 'Enter a principal greater than 0.');
    if (!(R > 0)) return Alert.alert('Rate', 'Enter a rate greater than 0.');
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
      years = dY + dM / 12 + dD / 365;
      if (!(years > 0)) return Alert.alert('Duration', 'Enter a duration greater than 0.');
    }
    const annual = periodRateToAnnualPct(R, rateMode, period);
    const r = type === 'simple' ? simpleInterest(P, annual, years) : compoundInterest(P, annual, years, 1);
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
    const out = { interest: round2(r.interest), total: round2(r.total), years, type, principal: P, rate: R, rateMode, period };
    setRes(out);
    if (me) {
      try {
        await insertInterest({ user_id: me.id, user_name: me.name, type, principal: P, rate: R, time_years: round2(years), frequency: type === 'compound' ? 1 : null, interest: out.interest, total_amount: out.total });
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

  const onClear = () => { setPrincipal(''); setRate(''); setFrom(null); setTo(Date.now()); setDurY(''); setDurM(''); setDurD(''); setRes(null); };

  const onShare = async () => {
    if (!res) return;
    const html = pdfDocument('Interest Calculation', kvTable([
      { k: 'Interest type', v: res.type === 'simple' ? 'Simple' : 'Compound' },
      { k: 'Principal', v: formatINR(res.principal) },
      { k: 'Rate', v: `${res.rate}${res.rateMode === 'rupees' ? '₹ per ₹100' : '%'} ${res.period}` },
      { k: 'Duration', v: `${res.years.toFixed(2)} years` },
      { k: 'Interest', v: formatINR(res.interest) },
      { k: 'Total payable', v: formatINR(res.total), tot: true },
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
          <View style={s.radioRow}>
            <Radio label="Simple" active={type === 'simple'} onPress={() => setType('simple')} />
            <Radio label="Compound" active={type === 'compound'} onPress={() => setType('compound')} />
          </View>

          <Label>Principal Amount</Label>
          <Field label="Principal amount" value={principal} onChangeText={setPrincipal} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Rate Type</Label>
          <Segment<'percent' | 'rupees'> options={[{ k: 'percent', label: '% (percentage)' }, { k: 'rupees', label: '₹ per ₹100' }]} value={rateMode} onChange={setRateMode} />

          <Label>{rateMode === 'rupees' ? 'Interest Rate (₹ per ₹100)' : 'Interest Rate (%)'}</Label>
          <Field label={rateMode === 'rupees' ? 'Interest rate, rupees per 100' : 'Interest rate, percent'} value={rate} onChangeText={setRate} placeholder="Enter rate" keyboardType="numeric" />

          <Label>Interest Period</Label>
          <Segment<LedgerPeriod> options={[{ k: 'daily', label: 'Daily' }, { k: 'weekly', label: 'Weekly' }, { k: 'monthly', label: 'Monthly' }, { k: 'yearly', label: 'Yearly' }]} value={period} onChange={setPeriod} small />

          <View style={[s.radioRow, { marginTop: 16 }]}>
            <Radio label="Dates" active={timeMode === 'dates'} onPress={() => setTimeMode('dates')} />
            <Radio label="Duration" active={timeMode === 'duration'} onPress={() => setTimeMode('duration')} />
          </View>

          {timeMode === 'dates' ? (
            <>
              <Label>From Date</Label>
              <DateField value={from ? fmtDate(from) : ''} onPress={() => pick('from')} />
              <Label>To Date</Label>
              <DateField value={fmtDate(to)} onPress={() => pick('to')} />
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
                <RowLine k="Monthly interest" v={formatINR(monthly)} />
                <RowLine k="Daily interest" v={formatINR(daily)} />
                <RowLine k="Duration" v={`${res.years.toFixed(2)} years`} />
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

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  radioRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 28, rowGap: 8, marginTop: 4 },
  durRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  durationField: { flexGrow: 1, flexBasis: 100, minWidth: 0 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 20 },
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 6, ...TABULAR },
});
