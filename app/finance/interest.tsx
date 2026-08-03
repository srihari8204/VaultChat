// app/finance/interest.tsx — Interest Calculator (simple/compound, %/₹, by
// dates or duration). Saves to on-device history; result exports to PDF.

import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { FIN } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Radio, Btn, DateField, HeroCard, Card, RowLine } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { fmtDate, num } from '../../utils/financeFormat';
import { simpleInterest, compoundInterest, round2, formatINR, type InterestType } from '../../utils/interest';
import { periodRateToAnnualPct, type LedgerPeriod } from '../../utils/finance';
import { insertInterest } from '../../db/interestHistory';
import { sharePdf, pdfDocument, kvTable } from '../../utils/financeIO';

export default function InterestCalc() {
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
  const [res, setRes] = useState<{ interest: number; total: number; years: number } | null>(null);

  const pick = (which: 'from' | 'to') => {
    const cur = which === 'from' ? (from ?? Date.now()) : to;
    DateTimePickerAndroid.open({ value: new Date(cur), mode: 'date', onChange: (_e, d) => { if (d) which === 'from' ? setFrom(d.getTime()) : setTo(d.getTime()); } });
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
      years = (num(durY) || 0) + (num(durM) || 0) / 12 + (num(durD) || 0) / 365;
      if (!(years > 0)) return Alert.alert('Duration', 'Enter a duration greater than 0.');
    }
    const annual = periodRateToAnnualPct(R, rateMode, period);
    const r = type === 'simple' ? simpleInterest(P, annual, years) : compoundInterest(P, annual, years, 1);
    const out = { interest: round2(r.interest), total: round2(r.total), years };
    setRes(out);
    if (me) {
      try {
        await insertInterest({ user_id: me.id, user_name: me.name, type, principal: P, rate: R, time_years: round2(years), frequency: type === 'compound' ? 1 : null, interest: out.interest, total_amount: out.total });
      } catch {}
    }
  };

  const onClear = () => { setPrincipal(''); setRate(''); setFrom(null); setTo(Date.now()); setDurY(''); setDurM(''); setDurD(''); setRes(null); };

  const onShare = async () => {
    if (!res) return;
    const html = pdfDocument('Interest Calculation', kvTable([
      { k: 'Interest type', v: type === 'simple' ? 'Simple' : 'Compound' },
      { k: 'Principal', v: formatINR(num(principal)) },
      { k: 'Rate', v: `${rate}${rateMode === 'rupees' ? '₹ per ₹100' : '%'} ${period}` },
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
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Label>Interest Type</Label>
          <View style={s.radioRow}>
            <Radio label="Simple" active={type === 'simple'} onPress={() => setType('simple')} />
            <Radio label="Compound" active={type === 'compound'} onPress={() => setType('compound')} />
          </View>

          <Label>Principal Amount</Label>
          <Field value={principal} onChangeText={setPrincipal} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Rate Type</Label>
          <Segment<'percent' | 'rupees'> options={[{ k: 'percent', label: '% (percentage)' }, { k: 'rupees', label: '₹ per ₹100' }]} value={rateMode} onChange={setRateMode} />

          <Label>{rateMode === 'rupees' ? 'Interest Rate (₹ per ₹100)' : 'Interest Rate (%)'}</Label>
          <Field value={rate} onChangeText={setRate} placeholder="Enter rate" keyboardType="numeric" />

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
                <Field style={{ flex: 1 }} value={durY} onChangeText={setDurY} placeholder="Years" keyboardType="numeric" />
                <Field style={{ flex: 1 }} value={durM} onChangeText={setDurM} placeholder="Months" keyboardType="numeric" />
                <Field style={{ flex: 1 }} value={durD} onChangeText={setDurD} placeholder="Days" keyboardType="numeric" />
              </View>
            </>
          )}

          <View style={s.btnRow}>
            <Btn label="Clear" kind="ghost" onPress={onClear} wide />
            <Btn label="Calculate" icon="calculator" onPress={onCalc} wide />
          </View>

          {res && (
            <>
              <HeroCard colors={[FIN.good, '#0f7a38']}>
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
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40 },
  radioRow: { flexDirection: 'row', gap: 28, marginTop: 4 },
  durRow: { flexDirection: 'row', gap: 8 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 20 },
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: 6 },
});
