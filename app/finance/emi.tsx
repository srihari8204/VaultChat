// app/finance/emi.tsx — EMI calculator with loan types, amortization schedule
// and PDF export. Uses the existing emi()/amortization() math in utils/finance.

import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { FIN, TABULAR } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Btn, HeroCard, Card, RowLine } from '../../components/finance/ui';
import { num } from '../../utils/financeFormat';
import { formatINR } from '../../utils/interest';
import { emi, amortization } from '../../utils/finance';
import { sharePdf, pdfDocument, kvTable, htmlTable } from '../../utils/financeIO';

const LOAN_TYPES = ['Home', 'Car', 'Bike', 'Personal', 'Education', 'Business'];

export default function EmiCalc() {
  const [loanType, setLoanType] = useState('Home');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [tenure, setTenure] = useState('');
  const [unit, setUnit] = useState<'yr' | 'mo'>('yr');
  const [res, setRes] = useState<{ emi: number; totalInterest: number; totalPayment: number; months: number } | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);

  const months = () => { const n = num(tenure) || 0; return unit === 'yr' ? Math.round(n * 12) : Math.round(n); };

  const onCalc = () => {
    const P = num(amount), R = num(rate), n = months();
    if (!(P > 0) || !(R > 0) || !(n > 0)) return Alert.alert('EMI', 'Enter a valid amount, rate and tenure.');
    const r = emi(P, R, n);
    setRes({ ...r, months: n });
    setShowSchedule(false);
  };

  const schedule = useMemo(
    () => (res ? amortization(num(amount), num(rate), res.months) : []),
    [res, amount, rate],
  );

  const onShare = async () => {
    if (!res) return;
    const P = num(amount);
    const body = kvTable([
      { k: 'Loan type', v: `${loanType} Loan` },
      { k: 'Loan amount', v: formatINR(P) },
      { k: 'Interest rate', v: `${rate}% p.a.` },
      { k: 'Tenure', v: `${res.months} months` },
      { k: 'Monthly EMI', v: formatINR(res.emi), tot: true },
      { k: 'Total interest', v: formatINR(res.totalInterest) },
      { k: 'Total payment', v: formatINR(res.totalPayment) },
    ]) + '<h3 style="margin-top:20px;font-size:14px;color:#6D3FA8">Amortization (first 12 months)</h3>' +
    htmlTable(['Month', 'EMI', 'Principal', 'Interest', 'Balance'],
      schedule.slice(0, 12).map(r => [r.month, formatINR(r.emi), formatINR(r.principal), formatINR(r.interest), formatINR(r.balance)]));
    try { await sharePdf(pdfDocument('EMI Report', body), 'emi'); } catch (e: any) { Alert.alert('Share failed', e?.message ?? 'Try again'); }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="EMI Calculator" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Label>Loan Type</Label>
          <View style={s.chipRow}>
            {LOAN_TYPES.map(t => (
              <Chip key={t} label={t} active={loanType === t} onPress={() => setLoanType(t)} />
            ))}
          </View>

          <Label>Loan Amount</Label>
          <Field value={amount} onChangeText={setAmount} placeholder="₹ 0" keyboardType="numeric" />

          <Label>Interest Rate (% p.a.)</Label>
          <Field value={rate} onChangeText={setRate} placeholder="e.g. 8.5" keyboardType="numeric" />

          <Label>Tenure</Label>
          {/* Wraps rather than crushing: on a narrow phone the unit selector
              drops to its own line instead of squeezing the tenure field. */}
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Field style={{ flexGrow: 1, flexBasis: 140 }} value={tenure} onChangeText={setTenure} placeholder="Enter tenure" keyboardType="numeric" />
            <View style={{ flexGrow: 1, flexBasis: 132 }}>
              <Segment<'yr' | 'mo'> options={[{ k: 'yr', label: 'Years' }, { k: 'mo', label: 'Months' }]} value={unit} onChange={setUnit} small />
            </View>
          </View>

          <View style={{ marginTop: 20 }}>
            <Btn label="Calculate EMI" icon="calculator" onPress={onCalc} wide />
          </View>

          {res && (
            <>
              <HeroCard>
                <Text style={s.heroLabel}>MONTHLY EMI</Text>
                <Text style={s.heroVal}>{formatINR(res.emi)}</Text>
              </HeroCard>
              <Card style={{ marginTop: 12 }}>
                <RowLine k="Loan amount" v={formatINR(num(amount))} />
                <RowLine k="Total interest" v={formatINR(res.totalInterest)} />
                <RowLine k="Total payment" v={formatINR(res.totalPayment)} bold />
                <RowLine k="Tenure" v={`${res.months} months`} />
              </Card>

              <View style={s.btnRow}>
                <Btn label={showSchedule ? 'Hide Schedule' : 'View Amortization'} kind="ghost" icon="list" onPress={() => setShowSchedule(v => !v)} wide />
                <Btn label="PDF" kind="ghost" icon="share-outline" onPress={onShare} wide />
              </View>

              {showSchedule && (
                <Card style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
                  <View style={[s.schRow, s.schHead]}>
                    <Text style={[s.schCell, s.schHeadTxt, { flex: 0.7 }]}>Mo</Text>
                    <Text style={[s.schCell, s.schHeadTxt]}>Principal</Text>
                    <Text style={[s.schCell, s.schHeadTxt]}>Interest</Text>
                    <Text style={[s.schCell, s.schHeadTxt]}>Balance</Text>
                  </View>
                  {schedule.slice(0, 24).map(r => (
                    <View key={r.month} style={s.schRow}>
                      <Text style={[s.schCell, { flex: 0.7, color: FIN.sub }]}>{r.month}</Text>
                      <Text style={s.schCell}>{Math.round(r.principal).toLocaleString('en-IN')}</Text>
                      <Text style={s.schCell}>{Math.round(r.interest).toLocaleString('en-IN')}</Text>
                      <Text style={s.schCell}>{Math.round(r.balance).toLocaleString('en-IN')}</Text>
                    </View>
                  ))}
                  {schedule.length > 24 && <Text style={s.schMore}>Showing first 24 of {schedule.length} months · full schedule in the PDF</Text>}
                </Card>
              )}
            </>
          )}
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Text
      onPress={onPress}
      style={[s.chip, active && { backgroundColor: FIN.brand, color: '#fff', borderColor: FIN.brand }]}
    >{label}</Text>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card, color: FIN.sub, fontSize: 13, fontWeight: '700', overflow: 'hidden' },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 14 },
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 30, fontWeight: '800', marginTop: 6, ...TABULAR },

  schRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: FIN.line },
  schHead: { backgroundColor: FIN.card2 },
  schHeadTxt: { color: FIN.sub, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  schCell: { flex: 1, fontSize: 12, color: FIN.text, textAlign: 'right', fontVariant: ['tabular-nums'] },
  schMore: { color: FIN.faint, fontSize: 11, textAlign: 'center', padding: 10 },
});
