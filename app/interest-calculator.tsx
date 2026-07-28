// app/interest-calculator.tsx — Financial calculator mini-app.
//
// Four tabs (Home / Book / EMI / Gold) modelled on a rupee lending-calculator:
//   Home  — Simple/Compound interest, rate in ₹ (per ₹100/mo) or %, by date-range
//           or duration; results saved to on-device history.
//   Book  — Lend/Borrow ledger (name, mobile, terms, notes) persisted locally.
//   EMI   — EMI calculator, home-loan part-payment impact, and EMI comparison.
//   Gold  — gold-loan eligibility (weight × rate × purity × LTV).
// Everything is on-device (SQLite) — no backend, tagged with the current user.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, StatusBar, Platform, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { getCurrentUserAsync } from './(constants)/authService';
import { simpleInterest, compoundInterest, round2, formatINR, type InterestType } from '../utils/interest';
import {
  emi, partPayment, compareLoans, goldLoan, GOLD_PURITY,
  rupeeRateToAnnualPct, yearsBetween,
} from '../utils/finance';
import { insertInterest, listInterest, deleteInterest, type InterestRow } from '../db/interestHistory';
import { insertBook, listBook, deleteBook, type BookEntry } from '../db/financeBook';

// ── Blue financial palette (matches the reference app) ──────────────
const C = {
  navy: '#1E3A8A', blue: '#1D4ED8', blueSoft: '#DBEAFE', accent: '#2563EB',
  bg: '#F3F4F6', card: '#FFFFFF', border: '#E5E7EB', line: '#EEF0F3',
  text: '#111827', sub: '#6B7280', green: '#059669', danger: '#DC2626',
};

type Tab = 'home' | 'book' | 'emi' | 'gold';
const TABS: { id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'book', label: 'Book', icon: 'book' },
  { id: 'emi',  label: 'EMI',  icon: 'calculator' },
  { id: 'gold', label: 'Gold', icon: 'star' },
];

const fmtDate = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};
const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : NaN; };

export default function FinanceCalculatorScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('home');
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => { (async () => {
    const u = await getCurrentUserAsync().catch(() => null);
    setMe({ id: u?.id ?? 'local', name: u?.name ?? u?.email ?? 'You' });
  })(); }, []);

  const title = tab === 'home' ? 'Interest Calculator' : tab === 'book' ? 'Ledger Book' : tab === 'emi' ? 'EMI Calculator' : 'Gold Loan';

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="dark-content" backgroundColor="#fff" />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={s.hBtn}><Ionicons name="arrow-back" size={22} color={C.text} /></TouchableOpacity>
        <Text style={s.headerTitle}>{title}</Text>
        <View style={{ width: 38 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {me && tab === 'home' && <HomeTab me={me} />}
        {me && tab === 'book' && <BookTab me={me} />}
        {tab === 'emi'  && <EmiTab />}
        {tab === 'gold' && <GoldTab />}
      </KeyboardAvoidingView>

      {/* Bottom tab bar */}
      <View style={s.tabBar}>
        {TABS.map(t => {
          const active = tab === t.id;
          return (
            <TouchableOpacity key={t.id} style={s.tabItem} onPress={() => setTab(t.id)} activeOpacity={0.8}>
              <Ionicons name={active ? t.icon : (`${t.icon}-outline` as any)} size={22} color={active ? C.blue : C.sub} />
              <Text style={[s.tabLabel, active && { color: C.blue, fontWeight: '700' }]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════
// HOME — Interest calculator
// ══════════════════════════════════════════════════════════════════
function HomeTab({ me }: { me: { id: string; name: string } }) {
  const [type, setType] = useState<InterestType>('simple');
  const [principal, setPrincipal] = useState('');
  const [rateMode, setRateMode] = useState<'rupees' | 'percent'>('rupees');
  const [rate, setRate] = useState('');
  const [timeMode, setTimeMode] = useState<'dates' | 'duration'>('dates');
  const [fromDate, setFromDate] = useState<number | null>(null);
  const [toDate, setToDate] = useState<number>(Date.now());
  const [durY, setDurY] = useState(''); const [durM, setDurM] = useState(''); const [durD, setDurD] = useState('');
  const [result, setResult] = useState<{ interest: number; total: number; years: number } | null>(null);
  const [history, setHistory] = useState<InterestRow[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  const reload = useCallback(() => { listInterest(me.id).then(setHistory).catch(() => {}); }, [me.id]);
  useEffect(() => { reload(); }, [reload]);

  const pickDate = (which: 'from' | 'to') => {
    const cur = which === 'from' ? (fromDate ?? Date.now()) : toDate;
    DateTimePickerAndroid.open({
      value: new Date(cur), mode: 'date',
      onChange: (_e, d) => { if (d) { which === 'from' ? setFromDate(d.getTime()) : setToDate(d.getTime()); } },
    });
  };

  const onClear = () => { setPrincipal(''); setRate(''); setFromDate(null); setToDate(Date.now()); setDurY(''); setDurM(''); setDurD(''); setResult(null); };

  const onCalculate = async () => {
    const P = num(principal), R = num(rate);
    if (!(P > 0)) return Alert.alert('Principal', 'Enter a principal amount greater than 0.');
    if (!(R > 0)) return Alert.alert('Interest rate', 'Enter an interest rate greater than 0.');
    let years: number;
    if (timeMode === 'dates') {
      if (!fromDate) return Alert.alert('From date', 'Pick a From date.');
      if (toDate <= fromDate) return Alert.alert('Dates', 'To date must be after From date.');
      years = yearsBetween(fromDate, toDate);
    } else {
      years = (num(durY) || 0) + (num(durM) || 0) / 12 + (num(durD) || 0) / 365;
      if (!(years > 0)) return Alert.alert('Duration', 'Enter a duration greater than 0.');
    }
    const annualPct = rateMode === 'rupees' ? rupeeRateToAnnualPct(R) : R;
    const res = type === 'simple' ? simpleInterest(P, annualPct, years) : compoundInterest(P, annualPct, years, 1);
    setResult({ interest: round2(res.interest), total: round2(res.total), years });
    try {
      await insertInterest({
        user_id: me.id, user_name: me.name, type, principal: P, rate: R, time_years: round2(years),
        frequency: type === 'compound' ? 1 : null, interest: round2(res.interest), total_amount: round2(res.total),
      });
      reload();
    } catch {}
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Label icon="🧮">Interest Type</Label>
      <View style={s.radioRow}>
        <Radio label="Simple Interest" active={type === 'simple'} onPress={() => setType('simple')} />
        <Radio label="Compound Interest" active={type === 'compound'} onPress={() => setType('compound')} />
      </View>

      <Label>Principal Amount</Label>
      <Field value={principal} onChangeText={setPrincipal} placeholder="Enter principal amount" keyboardType="numeric" />

      <Label>Rate Type</Label>
      <Segment
        options={[{ k: 'rupees', label: 'rupees' }, { k: 'percent', label: '% (percentage)' }]}
        value={rateMode} onChange={(k) => setRateMode(k as any)}
      />

      <Label>{rateMode === 'rupees' ? 'Interest Rate (₹ per ₹100 / month)' : 'Interest Rate (% per annum)'}</Label>
      <Field value={rate} onChangeText={setRate} placeholder="Enter interest rate" keyboardType="numeric" />

      <View style={s.radioRow}>
        <Radio label="Dates" active={timeMode === 'dates'} onPress={() => setTimeMode('dates')} />
        <Radio label="Duration" active={timeMode === 'duration'} onPress={() => setTimeMode('duration')} />
      </View>

      {timeMode === 'dates' ? (
        <>
          <Label>From Date <Text style={s.hint}>(dd/mm/yyyy)</Text></Label>
          <DateField value={fromDate ? fmtDate(fromDate) : ''} onPress={() => pickDate('from')} />
          <Label>To Date <Text style={s.hint}>(dd/mm/yyyy)</Text></Label>
          <DateField value={fmtDate(toDate)} onPress={() => pickDate('to')} />
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
        <Btn label="Clear" kind="ghost" onPress={onClear} />
        <Btn label="Calculate" kind="primary" onPress={onCalculate} />
        <TouchableOpacity style={s.savedBtn} onPress={() => setShowSaved(v => !v)}>
          <Ionicons name="bookmark" size={20} color={C.navy} />
          <Text style={s.savedTxt}>Saved</Text>
        </TouchableOpacity>
      </View>

      {result && (
        <View style={s.resultCard}>
          <Text style={s.resultTitle}>{type === 'simple' ? 'Simple' : 'Compound'} Interest</Text>
          <ResultLine k="Duration" v={`${result.years.toFixed(2)} yr`} />
          <ResultLine k="Interest" v={formatINR(result.interest)} />
          <ResultLine k="Total payable" v={formatINR(result.total)} bold />
        </View>
      )}

      {showSaved && (
        <View style={{ marginTop: 18 }}>
          <Text style={s.sectionTitle}>Saved Records</Text>
          {history.length === 0 && <Text style={s.emptyTxt}>No saved calculations yet.</Text>}
          {history.map(r => (
            <TouchableOpacity key={r.id} style={s.recRow} onLongPress={() => { deleteInterest(r.id).then(reload); }}>
              <View style={{ flex: 1 }}>
                <Text style={s.recTitle}>{r.type === 'simple' ? 'Simple' : 'Compound'} · ₹{r.principal.toLocaleString('en-IN')} · {r.rate} · {r.time_years} yr</Text>
                <Text style={s.recSub}>Interest {formatINR(r.interest)} · Total {formatINR(r.total_amount)}</Text>
              </View>
              <Ionicons name="trash-outline" size={16} color={C.sub} />
            </TouchableOpacity>
          ))}
          {history.length > 0 && <Text style={s.hintCenter}>Long-press a record to delete</Text>}
        </View>
      )}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════
// BOOK — Lend/Borrow ledger
// ══════════════════════════════════════════════════════════════════
function BookTab({ me }: { me: { id: string; name: string } }) {
  const [direction, setDirection] = useState<'lend' | 'borrow'>('lend');
  const [name, setName] = useState(''); const [mobile, setMobile] = useState('');
  const [itype, setItype] = useState<'simple' | 'compound'>('simple');
  const [principal, setPrincipal] = useState('');
  const [rateMode, setRateMode] = useState<'rupees' | 'percent'>('rupees');
  const [rate, setRate] = useState(''); const [fromDate, setFromDate] = useState<number>(Date.now());
  const [notes, setNotes] = useState('');
  const [entries, setEntries] = useState<BookEntry[]>([]);

  const reload = useCallback(() => { listBook(me.id).then(setEntries).catch(() => {}); }, [me.id]);
  useEffect(() => { reload(); }, [reload]);

  const onSave = async () => {
    if (!name.trim()) return Alert.alert('Name', 'Enter a name.');
    const P = num(principal), R = num(rate);
    if (!(P > 0)) return Alert.alert('Principal', 'Enter a principal greater than 0.');
    if (!(R > 0)) return Alert.alert('Rate', 'Enter a rate greater than 0.');
    try {
      await insertBook({
        user_id: me.id, direction, name: name.trim(), mobile: mobile.trim() || null,
        interest_type: itype, principal: P, rate: R, rate_mode: rateMode, from_date: fromDate,
        notes: notes.trim() || null,
      });
      setName(''); setMobile(''); setPrincipal(''); setRate(''); setNotes('');
      reload();
      Alert.alert('Saved', 'Entry added to your ledger.');
    } catch (e: any) { Alert.alert('Could not save', e?.message ?? 'Try again'); }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.radioRow}>
        <Radio label="Lend" active={direction === 'lend'} onPress={() => setDirection('lend')} />
        <Radio label="Borrow" active={direction === 'borrow'} onPress={() => setDirection('borrow')} />
      </View>

      <Label>{direction === 'lend' ? 'Borrower Name' : 'Lender Name'}</Label>
      <Field value={name} onChangeText={setName} placeholder="Enter Name" />
      <Label>Mobile Number <Text style={s.hint}>(Optional)</Text></Label>
      <Field value={mobile} onChangeText={setMobile} placeholder="Please enter mobile number" keyboardType="phone-pad" />
      <Label>Interest Type</Label>
      <Segment options={[{ k: 'simple', label: 'Simple Interest' }, { k: 'compound', label: 'Compound Interest' }]} value={itype} onChange={(k) => setItype(k as any)} />
      <Label>Principal Amount</Label>
      <Field value={principal} onChangeText={setPrincipal} placeholder="Enter principal amount" keyboardType="numeric" />
      <Label>Rate Type</Label>
      <Segment options={[{ k: 'rupees', label: 'rupees' }, { k: 'percent', label: '%' }]} value={rateMode} onChange={(k) => setRateMode(k as any)} />
      <Label>{rateMode === 'rupees' ? 'Interest Rate (in rupees)' : 'Interest Rate (%)'}</Label>
      <Field value={rate} onChangeText={setRate} placeholder="Enter interest rate" keyboardType="numeric" />
      <Label>From Date <Text style={s.hint}>(dd/mm/yyyy)</Text></Label>
      <DateField value={fmtDate(fromDate)} onPress={() => DateTimePickerAndroid.open({ value: new Date(fromDate), mode: 'date', onChange: (_e, d) => d && setFromDate(d.getTime()) })} />
      <Label>Notes <Text style={s.hint}>(Optional)</Text></Label>
      <TextInput style={[s.field, { height: 90, textAlignVertical: 'top' }]} value={notes} onChangeText={setNotes} placeholder="Notes" placeholderTextColor={C.sub} multiline />

      <View style={{ alignItems: 'center', marginTop: 14 }}>
        <Btn label="Save" kind="primary" onPress={onSave} wide />
      </View>

      {entries.length > 0 && (
        <View style={{ marginTop: 22 }}>
          <Text style={s.sectionTitle}>Ledger · {entries.length}</Text>
          {entries.map(e => (
            <TouchableOpacity key={e.id} style={s.recRow} onLongPress={() => Alert.alert('Delete entry?', e.name, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => deleteBook(e.id).then(reload) }])}>
              <View style={[s.tag, { backgroundColor: e.direction === 'lend' ? '#DCFCE7' : '#FEE2E2' }]}>
                <Text style={[s.tagTxt, { color: e.direction === 'lend' ? C.green : C.danger }]}>{e.direction === 'lend' ? 'LENT' : 'BORROWED'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.recTitle}>{e.name}{e.mobile ? ` · ${e.mobile}` : ''}</Text>
                <Text style={s.recSub}>₹{e.principal.toLocaleString('en-IN')} @ {e.rate}{e.rate_mode === 'rupees' ? '₹' : '%'} · {fmtDate(e.from_date)}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ══════════════════════════════════════════════════════════════════
// EMI — calculator / part-payment / comparison
// ══════════════════════════════════════════════════════════════════
function EmiTab() {
  const [sub, setSub] = useState<'emi' | 'part' | 'compare'>('emi');
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Segment
        options={[{ k: 'emi', label: 'EMI' }, { k: 'part', label: 'Part Pay' }, { k: 'compare', label: 'Compare' }]}
        value={sub} onChange={(k) => setSub(k as any)}
      />
      {sub === 'emi' && <EmiBasic />}
      {sub === 'part' && <PartPayment />}
      {sub === 'compare' && <EmiCompare />}
    </ScrollView>
  );
}

function tenureMonths(val: string, unit: 'yr' | 'mo') { const n = num(val) || 0; return unit === 'yr' ? Math.round(n * 12) : Math.round(n); }

function EmiBasic() {
  const [amt, setAmt] = useState(''); const [rate, setRate] = useState('');
  const [ten, setTen] = useState(''); const [unit, setUnit] = useState<'yr' | 'mo'>('yr');
  const [res, setRes] = useState<{ emi: number; totalPayment: number; totalInterest: number } | null>(null);
  const calc = () => {
    const P = num(amt), R = num(rate), n = tenureMonths(ten, unit);
    if (!(P > 0) || !(R > 0) || !(n > 0)) return Alert.alert('EMI', 'Enter valid amount, rate and tenure.');
    setRes(emi(P, R, n));
  };
  return (
    <View style={{ marginTop: 12 }}>
      <Label>Loan Amount</Label><Field value={amt} onChangeText={setAmt} placeholder="Please enter loan amount" keyboardType="numeric" />
      <Label>Interest Rate (%)</Label><Field value={rate} onChangeText={setRate} placeholder="Please enter interest rate" keyboardType="numeric" />
      <Label>Tenure</Label>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field style={{ flex: 1 }} value={ten} onChangeText={setTen} placeholder="Please enter tenure" keyboardType="numeric" />
        <Segment small options={[{ k: 'yr', label: 'Yr' }, { k: 'mo', label: 'Mo' }]} value={unit} onChange={(k) => setUnit(k as any)} />
      </View>
      <View style={{ alignItems: 'center', marginTop: 14 }}><Btn label="Calculate" kind="primary" onPress={calc} wide /></View>
      {res && (
        <View style={s.resultCard}>
          <ResultLine k="Monthly EMI" v={formatINR(res.emi)} bold />
          <ResultLine k="Total interest" v={formatINR(res.totalInterest)} />
          <ResultLine k="Total payment" v={formatINR(res.totalPayment)} />
        </View>
      )}
    </View>
  );
}

function PartPayment() {
  const [out, setOut] = useState(''); const [rate, setRate] = useState('');
  const [ten, setTen] = useState(''); const [unit, setUnit] = useState<'yr' | 'mo'>('yr');
  const [lump, setLump] = useState(''); const [mode, setMode] = useState<'emi' | 'tenure'>('emi');
  const [res, setRes] = useState<ReturnType<typeof partPayment> | null>(null);
  const calc = () => {
    const P = num(out), R = num(rate), n = tenureMonths(ten, unit), L = num(lump);
    if (!(P > 0) || !(R > 0) || !(n > 0) || !(L > 0)) return Alert.alert('Part payment', 'Enter valid values.');
    setRes(partPayment(P, R, n, L, mode));
  };
  return (
    <View style={{ marginTop: 12 }}>
      <Label>Outstanding Amount</Label><Field value={out} onChangeText={setOut} placeholder="Please enter loan amount" keyboardType="numeric" />
      <Label>Interest Rate (%)</Label><Field value={rate} onChangeText={setRate} placeholder="Please enter interest rate" keyboardType="numeric" />
      <Label>Remaining Tenure</Label>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field style={{ flex: 1 }} value={ten} onChangeText={setTen} placeholder="Please enter tenure" keyboardType="numeric" />
        <Segment small options={[{ k: 'yr', label: 'Yr' }, { k: 'mo', label: 'Mo' }]} value={unit} onChange={(k) => setUnit(k as any)} />
      </View>
      <Label>Part Payment Amount</Label><Field value={lump} onChangeText={setLump} placeholder="Part Payment Amount" keyboardType="numeric" />
      <Label>Reduction Type</Label>
      <Segment options={[{ k: 'emi', label: 'Reduce EMI' }, { k: 'tenure', label: 'Reduce Tenure' }]} value={mode} onChange={(k) => setMode(k as any)} />
      <View style={{ alignItems: 'center', marginTop: 14 }}><Btn label="Calculate Impact" kind="primary" onPress={calc} wide /></View>
      {res && (
        <View style={s.resultCard}>
          {mode === 'emi' ? (
            <>
              <ResultLine k="Old EMI" v={formatINR(res.oldEmi)} />
              <ResultLine k="New EMI" v={formatINR(res.newEmi)} bold />
              <ResultLine k="EMI reduced by" v={formatINR(res.emiReduced)} />
            </>
          ) : (
            <>
              <ResultLine k="Old tenure" v={`${res.oldMonths} mo`} />
              <ResultLine k="New tenure" v={`${res.newMonths} mo`} bold />
              <ResultLine k="Months saved" v={`${res.monthsReduced} mo`} />
            </>
          )}
          <ResultLine k="Interest saved" v={formatINR(res.interestSaved)} bold />
        </View>
      )}
    </View>
  );
}

function EmiCompare() {
  const [a, setA] = useState({ amt: '', rate: '', ten: '', unit: 'yr' as 'yr' | 'mo' });
  const [b, setB] = useState({ amt: '', rate: '', ten: '', unit: 'yr' as 'yr' | 'mo' });
  const [res, setRes] = useState<ReturnType<typeof compareLoans> | null>(null);
  const calc = () => {
    const la = { amount: num(a.amt), ratePct: num(a.rate), months: tenureMonths(a.ten, a.unit) };
    const lb = { amount: num(b.amt), ratePct: num(b.rate), months: tenureMonths(b.ten, b.unit) };
    if (!(la.amount > 0 && la.months > 0 && lb.amount > 0 && lb.months > 0)) return Alert.alert('Compare', 'Fill both loans.');
    setRes(compareLoans(la, lb));
  };
  const LoanCard = ({ title, v, set }: { title: string; v: typeof a; set: (x: any) => void }) => (
    <View style={s.loanCard}>
      <Text style={s.loanTitle}>{title}</Text>
      <Field small value={v.amt} onChangeText={(t) => set({ ...v, amt: t })} placeholder="Amount" keyboardType="numeric" />
      <Field small value={v.rate} onChangeText={(t) => set({ ...v, rate: t })} placeholder="Rate %" keyboardType="numeric" />
      <Segment small options={[{ k: 'yr', label: 'Yr' }, { k: 'mo', label: 'Mo' }]} value={v.unit} onChange={(k) => set({ ...v, unit: k })} />
      <Field small value={v.ten} onChangeText={(t) => set({ ...v, ten: t })} placeholder="Tenure" keyboardType="numeric" />
    </View>
  );
  return (
    <View style={{ marginTop: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <LoanCard title="Loan 1" v={a} set={setA} />
        <LoanCard title="Loan 2" v={b} set={setB} />
      </View>
      <View style={{ alignItems: 'center', marginTop: 14 }}><Btn label="Compare" kind="primary" onPress={calc} wide /></View>
      {res && (
        <View style={s.resultCard}>
          <ResultLine k="Loan 1 EMI" v={formatINR(res.a.emi)} />
          <ResultLine k="Loan 2 EMI" v={formatINR(res.b.emi)} />
          <ResultLine k="EMI difference" v={formatINR(res.emiDiff)} />
          <ResultLine k="Interest difference" v={formatINR(res.interestDiff)} />
          <ResultLine k="Cheaper overall" v={`Loan ${res.cheaper}`} bold />
        </View>
      )}
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════
// GOLD — loan eligibility
// ══════════════════════════════════════════════════════════════════
function GoldTab() {
  const [weight, setWeight] = useState(''); const [ratePerGram, setRatePerGram] = useState('');
  const [purity, setPurity] = useState(GOLD_PURITY[1]); // 22K default
  const [ltv, setLtv] = useState('75');
  const [res, setRes] = useState<{ goldValue: number; eligibleLoan: number } | null>(null);
  const calc = () => {
    const w = num(weight), r = num(ratePerGram), l = num(ltv);
    if (!(w > 0) || !(r > 0)) return Alert.alert('Gold', 'Enter weight and rate per gram.');
    setRes(goldLoan(w, r, purity.factor, l > 0 ? l : 75));
  };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Label>Gold Weight (grams)</Label><Field value={weight} onChangeText={setWeight} placeholder="Enter weight in grams" keyboardType="numeric" />
      <Label>Gold Rate (₹ per gram, 24K)</Label><Field value={ratePerGram} onChangeText={setRatePerGram} placeholder="Enter rate per gram" keyboardType="numeric" />
      <Label>Purity</Label>
      <View style={s.chipRow}>
        {GOLD_PURITY.map(p => (
          <TouchableOpacity key={p.label} style={[s.chip, purity.label === p.label && s.chipActive]} onPress={() => setPurity(p)}>
            <Text style={[s.chipTxt, purity.label === p.label && { color: '#fff' }]}>{p.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Label>Loan-to-Value (%)</Label><Field value={ltv} onChangeText={setLtv} placeholder="75" keyboardType="numeric" />
      <View style={{ alignItems: 'center', marginTop: 14 }}><Btn label="Calculate" kind="primary" onPress={calc} wide /></View>
      {res && (
        <View style={s.resultCard}>
          <ResultLine k="Gold value" v={formatINR(res.goldValue)} />
          <ResultLine k="Eligible loan" v={formatINR(res.eligibleLoan)} bold />
          <Text style={s.hintCenter}>RBI caps gold-loan LTV at 75%.</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ── Shared bits ─────────────────────────────────────────────────
function Label({ children, icon }: { children: React.ReactNode; icon?: string }) {
  return <Text style={s.label}>{icon ? `${icon} ` : ''}{children}</Text>;
}
function Field({ style, small, ...p }: any) {
  return <TextInput {...p} placeholderTextColor={C.sub} style={[s.field, small && s.fieldSmall, style]} />;
}
function DateField({ value, onPress }: { value: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.dateField} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.dateTxt, !value && { color: C.sub }]}>{value || 'dd/mm/yyyy'}</Text>
      <View style={s.dateBtn}><Ionicons name="calendar" size={18} color="#fff" /></View>
    </TouchableOpacity>
  );
}
function Radio({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.radio} onPress={onPress} activeOpacity={0.8}>
      <View style={[s.radioDot, active && { borderColor: C.blue }]}>{active && <View style={s.radioInner} />}</View>
      <Text style={[s.radioLabel, active && { color: C.blue, fontWeight: '700' }]}>{label}</Text>
    </TouchableOpacity>
  );
}
function Segment({ options, value, onChange, small }: { options: { k: string; label: string }[]; value: string; onChange: (k: string) => void; small?: boolean }) {
  return (
    <View style={[s.segment, small && { minWidth: 96 }]}>
      {options.map(o => {
        const active = value === o.k;
        return (
          <TouchableOpacity key={o.k} style={[s.segBtn, small && s.segBtnSmall, active && s.segBtnActive]} onPress={() => onChange(o.k)} activeOpacity={0.85}>
            <Text style={[s.segTxt, small && { fontSize: 12 }, active && { color: '#fff' }]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
function Btn({ label, kind, onPress, wide }: { label: string; kind: 'primary' | 'ghost'; onPress: () => void; wide?: boolean }) {
  return (
    <TouchableOpacity style={[s.btn, wide && { paddingHorizontal: 48 }, kind === 'primary' ? s.btnPrimary : s.btnGhost]} onPress={onPress} activeOpacity={0.85}>
      <Text style={[s.btnTxt, kind === 'ghost' && { color: C.blue }]}>{label}</Text>
    </TouchableOpacity>
  );
}
function ResultLine({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <View style={s.resLine}>
      <Text style={s.resKey}>{k}</Text>
      <Text style={[s.resVal, bold && { fontWeight: '800', color: C.navy }]}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, paddingTop: 48, paddingBottom: 12, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  hBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: C.text, fontSize: 20, fontWeight: '800' },
  body: { padding: 16, paddingBottom: 40 },

  label: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  hint: { color: C.sub, fontSize: 12, fontWeight: '400' },
  hintCenter: { color: C.sub, fontSize: 11, textAlign: 'center', marginTop: 8 },
  field: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, color: C.text },
  fieldSmall: { paddingVertical: 9, fontSize: 13, marginBottom: 8 },
  durRow: { flexDirection: 'row', gap: 8 },

  radioRow: { flexDirection: 'row', gap: 24, marginTop: 14 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  radioDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.sub, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.blue },
  radioLabel: { color: C.text, fontSize: 15 },

  segment: { flexDirection: 'row', backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  segBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  segBtnSmall: { flex: 0, paddingHorizontal: 12, paddingVertical: 9 },
  segBtnActive: { backgroundColor: C.blue },
  segTxt: { color: C.text, fontSize: 14, fontWeight: '700' },

  dateField: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, overflow: 'hidden' },
  dateTxt: { flex: 1, paddingHorizontal: 12, fontSize: 15, color: C.text },
  dateBtn: { backgroundColor: C.navy, paddingVertical: 14, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' },

  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 20 },
  btn: { borderRadius: 8, paddingVertical: 13, paddingHorizontal: 28, alignItems: 'center' },
  btnPrimary: { backgroundColor: C.navy },
  btnGhost: { backgroundColor: C.blueSoft },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  savedBtn: { alignItems: 'center' },
  savedTxt: { color: C.navy, fontSize: 11, fontWeight: '700', marginTop: 2 },

  resultCard: { backgroundColor: C.card, borderRadius: 12, padding: 16, marginTop: 20, borderWidth: 1, borderColor: C.border },
  resultTitle: { color: C.navy, fontSize: 16, fontWeight: '800', marginBottom: 10 },
  resLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  resKey: { color: C.sub, fontSize: 14 },
  resVal: { color: C.text, fontSize: 15, fontWeight: '600' },

  sectionTitle: { color: C.text, fontSize: 15, fontWeight: '800', marginBottom: 10 },
  emptyTxt: { color: C.sub, fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  recTitle: { color: C.text, fontSize: 14, fontWeight: '600' },
  recSub: { color: C.sub, fontSize: 12, marginTop: 2 },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  tagTxt: { fontSize: 10, fontWeight: '800' },

  loanCard: { flex: 1, backgroundColor: C.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: C.border },
  loanTitle: { color: C.blue, fontSize: 15, fontWeight: '800', marginBottom: 10 },

  chipRow: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, alignItems: 'center' },
  chipActive: { backgroundColor: C.blue, borderColor: C.blue },
  chipTxt: { color: C.text, fontSize: 14, fontWeight: '700' },

  tabBar: { flexDirection: 'row', backgroundColor: C.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingBottom: 6, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center', gap: 2 },
  tabLabel: { color: C.sub, fontSize: 11 },
});
