// app/finance/emi.tsx — EMI calculator with loan types, amortization schedule
// and PDF export. Uses the existing emi()/amortization() math in utils/finance.

import React, { useMemo, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../components/ui';
import { View, Text, ScrollView, StyleSheet, Alert, Pressable } from 'react-native';
import { TABULAR, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, Label, Field, Segment, Btn, HeroCard, Card, RowLine } from '../../components/finance/ui';
import { num } from '../../utils/financeFormat';
import { formatINR } from '../../utils/interest';
import { emi, amortization } from '../../utils/finance';
import { sharePdf, pdfDocument, kvTable, htmlTable } from '../../utils/financeIO';

const LOAN_TYPES = ['Home', 'Car', 'Bike', 'Personal', 'Education', 'Business'];

export default function EmiCalc() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const [loanType, setLoanType] = useState('Home');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [tenure, setTenure] = useState('');
  const [unit, setUnit] = useState<'yr' | 'mo'>('yr');
  // The result holds the P and R it was CALCULATED from. Everything below used
  // to re-read the live `amount`/`rate` strings, so editing a field after
  // pressing Calculate silently rewrote the card, the schedule and the shared
  // PDF to match input that had not been calculated yet — "₹NaN" the moment a
  // field was half-typed. A result is a snapshot, not a view of the form
  // (2026-09-17).
  const [res, setRes] = useState<{ emi: number; totalInterest: number; totalPayment: number; months: number; P: number; R: number } | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);

  const months = () => { const n = num(tenure) || 0; return unit === 'yr' ? Math.round(n * 12) : Math.round(n); };

  const onCalc = () => {
    const P = num(amount), R = num(rate), n = months();
    // 0% IS A REAL LOAN (2026-09-17). No-cost EMI on a phone or a fridge is
    // one of the commonest Indian consumer-finance products, and a no-interest
    // loan to family is the other. utils/finance.ts supports it on purpose
    // (r === 0 divides the principal evenly) and its selftest pins it - this
    // screen was the only thing refusing to pass 0 through. A rate must be a
    // real number and not negative; it does NOT have to be positive.
    if (!(P > 0) || !Number.isFinite(R) || R < 0 || !(n > 0)) return Alert.alert('EMI', 'Enter a valid amount, rate and tenure.');
    const r = emi(P, R, n);
    setRes({ ...r, months: n, P, R });
    setShowSchedule(false);
  };

  const schedule = useMemo(
    () => (res ? amortization(res.P, res.R, res.months) : []),
    [res],
  );

  const onShare = async () => {
    if (!res) return;
    const body = kvTable([
      { k: 'Loan type', v: `${loanType} Loan` },
      { k: 'Loan amount', v: formatINR(res.P) },
      { k: 'Interest rate', v: `${res.R}% p.a.` },
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
      <KeyboardSafe style={{ flex: 1 }} >
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
            <View style={{ flexGrow: 1, flexBasis: 140, minWidth: 0 }}>
              <Field value={tenure} onChangeText={setTenure} placeholder="Enter tenure" keyboardType="numeric" />
            </View>
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
                <RowLine k="Loan amount" v={formatINR(res.P)} />
                <RowLine k="Total interest" v={formatINR(res.totalInterest)} />
                <RowLine k="Total payment" v={formatINR(res.totalPayment)} bold />
                <RowLine k="Tenure" v={`${res.months} months`} />
              </Card>

              <View style={s.btnRow}>
                <Btn label={showSchedule ? 'Hide Schedule' : 'View Amortization'} kind="ghost" icon="list" onPress={() => setShowSchedule(v => !v)} style={{ flexGrow: 1, flexBasis: 200 }} />
                <Btn label="PDF" kind="ghost" icon="share-outline" onPress={onShare} style={{ flexGrow: 1, flexBasis: 80 }} />
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
                      <Text style={s.schCell} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{Math.round(r.principal).toLocaleString('en-IN')}</Text>
                      <Text style={s.schCell} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{Math.round(r.interest).toLocaleString('en-IN')}</Text>
                      <Text style={s.schCell} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{Math.round(r.balance).toLocaleString('en-IN')}</Text>
                    </View>
                  ))}
                  {schedule.length > 24 && <Text style={s.schMore}>Showing first 24 of {schedule.length} months · full schedule in the PDF</Text>}
                </Card>
              )}
            </>
          )}
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={[s.chip, active && { backgroundColor: FIN.brandDeep, borderColor: FIN.brandDeep }]}
    >
      <Text style={[s.chipText, active && { color: FIN.onBrand }]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: FIN.border, backgroundColor: FIN.card, justifyContent: 'center' },
  chipText: { color: FIN.sub, fontSize: 13, fontWeight: '700' },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 14 },
  heroLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroVal: { color: '#fff', fontSize: 30, fontWeight: '800', marginTop: 6, ...TABULAR },

  schRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: FIN.line },
  schHead: { backgroundColor: FIN.card2 },
  schHeadTxt: { color: FIN.sub, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  // At 320dp each money column gets 71dp; at OS font scale 1.5 a 7-digit
  // rupee amount needs ~107dp, and Android breaks an unspaced digit-and-comma
  // string MID-NUMBER - a balance renders as '12,34,' / '567' with no
  // thousands context. Shrink to fit instead of wrapping (2026-09-17).
  schCell: { flex: 1, fontSize: 12, color: FIN.text, textAlign: 'right', fontVariant: ['tabular-nums'] },
  schMore: { color: FIN.faint, fontSize: 11, textAlign: 'center', padding: 10 },
});
