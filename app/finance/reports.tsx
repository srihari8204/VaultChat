// app/finance/reports.tsx — period reports with totals, breakdown and export.

import React, { useCallback, useRef, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, Segment, StatTile, Card, RowLine, Btn, EmptyState, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { inrShort, fmtDate } from '../../utils/financeFormat';
import { formatINR } from '../../utils/interest';
import { ledgerInterest } from '../../utils/financeRules';
import { ledgerInterestTypeLabel, ledgerCompoundingNote } from '../../lib/finance/compounding';
import { sumRupees } from '../../utils/money';
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
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const me = useMe();
  const [period, setPeriod] = useState<Period>('month');
  const [r, setR] = useState<Report>(ZERO);
  const { status, begin, done, fail } = useLoadStatus();
  // Switching Month → Year quickly starts two loads; only the newest may land,
  // or a slow Month read could overwrite the Year report under a Year heading.
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!me) return;
    const mine = ++seq.current;
    begin();
    (async () => {
      const from = periodStart(period);
      const [all, groups] = await Promise.all([listLedger(me.id), listGroups(me.id)]);
      const ledgers = all.filter(l => l.created_at >= from);
      const acc: Report = { ...ZERO, ledgers };
      for (const l of ledgers) {
        // The ledger detail's own calculator: compound loans compound here too.
        // Statuses (overdue) are brought up to date by listLedger itself.
        const { interest } = ledgerInterest(l);
        // Paise-exact accumulation — a report that disagrees with the ledger by
        // a few paise is worse than no report.
        if (l.direction === 'lend') {
          acc.lent = sumRupees([acc.lent, l.principal]);
          if (l.status === 'completed') acc.earned = sumRupees([acc.earned, interest]);
          else acc.pending = sumRupees([acc.pending, interest]);
          acc.collections = sumRupees([acc.collections, l.principal, -l.remaining]);
        } else acc.borrowed = sumRupees([acc.borrowed, l.principal]);
        if (l.status === 'running') acc.active += 1;
        if (l.status === 'overdue') acc.overdue += 1;
        if (l.status === 'completed') acc.completed += 1;
      }
      acc.chitti = groups.filter(g => g.status === 'active').length;
      if (mine !== seq.current) return;
      setR(acc);
      done();
    })().catch(() => { if (mine === seq.current) fail(); });
  }, [me, period, begin, done, fail]);
  useFocusEffect(reload);

  const label = period === 'month' ? 'This Month' : period === 'year' ? 'This Year' : 'All Time';

  const outstanding = sumRupees([r.lent, -r.collections]);
  // The same full-term figures and words as the dashboard: each lent
  // ledger's interest to its end date (a 1-year projection without one), not
  // interest actually received or accrued so far.
  const compoundNote = ledgerCompoundingNote(r.ledgers.filter(l => l.direction === 'lend'));
  const rows = () => [
    { k: 'Total lent', v: formatINR(r.lent) },
    { k: 'Total borrowed', v: formatINR(r.borrowed) },
    { k: 'Interest, settled loans (full term)', v: formatINR(r.earned) },
    { k: 'Interest, open loans (full term)', v: formatINR(r.pending) },
    ...(compoundNote ? [{ k: 'Compounding', v: compoundNote }] : []),
    { k: 'Collections received', v: formatINR(r.collections) },
    { k: 'Outstanding', v: formatINR(outstanding), tot: true },
    { k: 'Active loans', v: String(r.active) },
    { k: 'Overdue loans', v: String(r.overdue) },
    { k: 'Completed loans', v: String(r.completed) },
    { k: 'Active Lucky Draw groups', v: String(r.chitti) },
  ];

  const onPdf = async () => {
    try { await sharePdf(pdfDocument(`Finance Report — ${label}`, kvTable(rows())), 'report'); }
    catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Try again'); }
  };
  const onExcel = async () => {
    if (r.ledgers.length === 0) return Alert.alert('Nothing to export', `No ledgers were created ${label.toLowerCase()}.`);
    const headers = ['Name', 'Direction', 'Principal', 'Remaining', 'Status', 'Rate', 'Period', 'Interest type', 'Created'];
    const data = r.ledgers.map(l => [l.name, l.direction, l.principal, l.remaining, l.status, l.rate, l.period, ledgerInterestTypeLabel(l), fmtDate(l.created_at)]);
    try {
      const uri = await exportExcel(`vault-finance-${period}`, headers, data);
      // Names and amounts: once the share sheet has handed the file on, the
      // cache copy goes, as the PDF export and app/finance/io.tsx already do.
      if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    } catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Try again'); }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Reports" />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <Segment<Period> options={[{ k: 'month', label: 'Month' }, { k: 'year', label: 'Year' }, { k: 'all', label: 'All Time' }]} value={period} tabs onChange={setPeriod} />

        {status === 'loading' && <LoadingState label="Loading report" />}
        {status === 'error' && (
          <ErrorState title="Could not build the report" sub="Your ledgers could not be read. Nothing has been lost." onRetry={reload} />
        )}
        {status === 'ready' && r.ledgers.length === 0 && (
          <EmptyState icon="bar-chart-outline" title={`No ledgers ${label.toLowerCase()}`}
            sub={period === 'all' ? 'Add a ledger to see totals here.' : 'No ledger was created in this period. Try Year or All Time.'} />
        )}
        {status === 'ready' && r.ledgers.length > 0 && (<>
        <Text style={s.heading}>{label}</Text>
        <View style={s.tileRow}>
          <StatTile value={inrShort(r.lent)} label="Total lent" tone="good" />
          <StatTile value={inrShort(r.borrowed)} label="Total borrowed" tone="bad" />
        </View>
        <View style={[s.tileRow, { marginTop: 8 }]}>
          <StatTile value={inrShort(r.earned)} label="Interest, settled (full term)" tone="good" />
          <StatTile value={inrShort(r.pending)} label="Interest, open (full term)" tone="warn" />
        </View>
        {compoundNote && <Text style={s.note}>{compoundNote}</Text>}

        <Card style={{ marginTop: 16 }}>
          <RowLine k="Collections received" v={formatINR(r.collections)} />
          <RowLine k="Outstanding" v={formatINR(outstanding)} bold tone="warn" />
          <RowLine k="Active loans" v={String(r.active)} />
          <RowLine k="Overdue loans" v={String(r.overdue)} tone="bad" />
          <RowLine k="Completed loans" v={String(r.completed)} />
          <RowLine k="Active Lucky Draw groups" v={String(r.chitti)} />
        </Card>

        <View style={s.btnRow}>
          <Btn label="Export PDF" kind="ghost" icon="document-text-outline" onPress={onPdf} wide />
          <Btn label="Export Excel" kind="ghost" icon="grid-outline" onPress={onExcel} wide />
        </View>
        </>)}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  heading: { color: FIN.text, fontSize: 16, fontWeight: '800', marginTop: 18, marginBottom: 12 },
  tileRow: { flexDirection: 'row', gap: 8 },
  note: { color: FIN.sub, fontSize: 12, marginTop: 8 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 18 },
});
