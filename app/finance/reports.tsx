// app/finance/reports.tsx — period reports with totals, breakdown and export.

import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FIN } from '../../constants/financeTheme';
import { FinHeader, Segment, StatTile, Card, RowLine, Btn } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { inrShort, fmtDate } from '../../utils/financeFormat';
import { formatINR, round2, simpleInterest } from '../../utils/interest';
import { periodRateToAnnualPct } from '../../utils/finance';
import { listLedger, type LedgerEntry } from '../../db/ledger';
import { listGroups } from '../../db/chitti';
import { sharePdf, pdfDocument, kvTable, exportExcel } from '../../utils/financeIO';

type Period = 'month' | 'year' | 'all';

interface Report {
  lent: number; borrowed: number; earned: number; pending: number;
  collections: number; active: number; overdue: number; completed: number; chitti: number;
  ledgers: LedgerEntry[];
}
const ZERO: Report = { lent: 0, borrowed: 0, earned: 0, pending: 0, collections: 0, active: 0, overdue: 0, completed: 0, chitti: 0, ledgers: [] };

function periodStart(p: Period): number {
  const d = new Date();
  if (p === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (p === 'year') return new Date(d.getFullYear(), 0, 1).getTime();
  return 0;
}

export default function Reports() {
  const me = useMe();
  const [period, setPeriod] = useState<Period>('month');
  const [r, setR] = useState<Report>(ZERO);

  const reload = useCallback(() => {
    if (!me) return;
    (async () => {
      const from = periodStart(period);
      const [all, groups] = await Promise.all([listLedger(me.id), listGroups(me.id)]);
      const ledgers = all.filter(l => l.created_at >= from);
      const acc: Report = { ...ZERO, ledgers };
      for (const l of ledgers) {
        const annual = periodRateToAnnualPct(l.rate, l.rate_mode, l.period);
        const years = l.end_date ? Math.max(0, (l.end_date - l.start_date) / 31536000000) : 1;
        const interest = round2(simpleInterest(l.principal, annual, years).interest);
        if (l.direction === 'lend') {
          acc.lent += l.principal;
          if (l.status === 'completed') acc.earned += interest; else acc.pending += interest;
          acc.collections += l.principal - l.remaining;
        } else acc.borrowed += l.principal;
        if (l.status === 'running') acc.active += 1;
        if (l.status === 'overdue') acc.overdue += 1;
        if (l.status === 'completed') acc.completed += 1;
      }
      acc.chitti = groups.filter(g => g.status === 'active').length;
      setR(acc);
    })();
  }, [me, period]);
  useFocusEffect(reload);

  const label = period === 'month' ? 'This Month' : period === 'year' ? 'This Year' : 'All Time';

  const rows = () => [
    { k: 'Total lent', v: formatINR(r.lent) },
    { k: 'Total borrowed', v: formatINR(r.borrowed) },
    { k: 'Interest earned', v: formatINR(r.earned) },
    { k: 'Interest pending', v: formatINR(r.pending) },
    { k: 'Collections received', v: formatINR(r.collections) },
    { k: 'Outstanding', v: formatINR(r.lent - r.collections), tot: true },
    { k: 'Active loans', v: String(r.active) },
    { k: 'Overdue loans', v: String(r.overdue) },
    { k: 'Completed loans', v: String(r.completed) },
    { k: 'Active chitti groups', v: String(r.chitti) },
  ];

  const onPdf = async () => {
    try { await sharePdf(pdfDocument(`Finance Report — ${label}`, kvTable(rows())), 'report'); }
    catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Try again'); }
  };
  const onExcel = async () => {
    const headers = ['Name', 'Direction', 'Principal', 'Remaining', 'Status', 'Rate', 'Period', 'Created'];
    const data = r.ledgers.map(l => [l.name, l.direction, l.principal, l.remaining, l.status, l.rate, l.period, fmtDate(l.created_at)]);
    try { await exportExcel(`vault-finance-${period}`, headers, data); }
    catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Try again'); }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Reports" />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <Segment<Period> options={[{ k: 'month', label: 'Month' }, { k: 'year', label: 'Year' }, { k: 'all', label: 'All Time' }]} value={period} onChange={setPeriod} />

        <Text style={s.heading}>{label}</Text>
        <View style={s.tileRow}>
          <StatTile value={inrShort(r.lent)} label="Total lent" tone="good" />
          <StatTile value={inrShort(r.borrowed)} label="Total borrowed" tone="bad" />
        </View>
        <View style={[s.tileRow, { marginTop: 8 }]}>
          <StatTile value={inrShort(r.earned)} label="Interest earned" tone="good" />
          <StatTile value={inrShort(r.pending)} label="Interest pending" tone="warn" />
        </View>

        <Card style={{ marginTop: 16 }}>
          <RowLine k="Collections received" v={formatINR(r.collections)} />
          <RowLine k="Outstanding" v={formatINR(r.lent - r.collections)} bold tone="warn" />
          <RowLine k="Active loans" v={String(r.active)} />
          <RowLine k="Overdue loans" v={String(r.overdue)} tone="bad" />
          <RowLine k="Completed loans" v={String(r.completed)} />
          <RowLine k="Active chitti groups" v={String(r.chitti)} />
        </Card>

        <View style={s.btnRow}>
          <Btn label="Export PDF" kind="ghost" icon="document-text-outline" onPress={onPdf} wide />
          <Btn label="Export Excel" kind="ghost" icon="grid-outline" onPress={onExcel} wide />
        </View>
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16 },
  heading: { color: FIN.text, fontSize: 16, fontWeight: '800', marginTop: 18, marginBottom: 12 },
  tileRow: { flexDirection: 'row', gap: 8 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 18 },
});
