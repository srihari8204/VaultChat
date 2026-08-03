// app/finance/io.tsx — Import / Export finance data (CSV & Excel), fully local.
// Export writes a share-sheet file; import reads a CSV and bulk-inserts ledgers.

import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { FIN } from '../../constants/financeTheme';
import { FinHeader, Segment, Btn, Card } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { fmtDate } from '../../utils/financeFormat';
import { listLedger, insertLedger } from '../../db/ledger';
import { listGroups } from '../../db/chitti';
import { exportCsv, exportExcel } from '../../utils/financeIO';
import type { LedgerPeriod } from '../../utils/finance';

type Dataset = 'ledger' | 'chitti';
type Format = 'excel' | 'csv';

const LEDGER_HEADERS = ['Name', 'Mobile', 'Direction', 'InterestType', 'Principal', 'Rate', 'RateMode', 'Period', 'Remaining', 'Status', 'Notes', 'Created'];

export default function FinanceIO() {
  const me = useMe();
  const [dataset, setDataset] = useState<Dataset>('ledger');
  const [format, setFormat] = useState<Format>('excel');

  const onExport = async () => {
    if (!me) return;
    try {
      if (dataset === 'ledger') {
        const rows = await listLedger(me.id);
        if (rows.length === 0) return Alert.alert('Nothing to export', 'No ledgers yet.');
        const data = rows.map(l => [l.name, l.mobile ?? '', l.direction, l.interest_type, l.principal, l.rate, l.rate_mode, l.period, l.remaining, l.status, l.notes ?? '', fmtDate(l.created_at)]);
        format === 'excel' ? await exportExcel('vault-ledger', LEDGER_HEADERS, data) : await exportCsv('vault-ledger', LEDGER_HEADERS, data);
      } else {
        const groups = await listGroups(me.id);
        if (groups.length === 0) return Alert.alert('Nothing to export', 'No chitti groups yet.');
        const headers = ['Name', 'ChitValue', 'Installment', 'Members', 'Duration', 'Foreman', 'Status', 'Start'];
        const data = groups.map(g => [g.name, g.chit_value, g.installment, g.members, g.duration, g.foreman ?? '', g.status, fmtDate(g.start_date)]);
        format === 'excel' ? await exportExcel('vault-chitti', headers, data) : await exportCsv('vault-chitti', headers, data);
      }
    } catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Try again'); }
  };

  const onImport = async () => {
    if (!me) return;
    if (dataset !== 'ledger') return Alert.alert('Ledger only', 'CSV import currently supports the Ledger Book.');
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', '*/*'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(res.assets[0].uri);
      const count = await importLedgerCsv(me.id, content);
      Alert.alert('Import complete', `${count} ledger${count === 1 ? '' : 's'} imported.`);
    } catch (e: any) { Alert.alert('Import failed', e?.message ?? 'Could not read the file.'); }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Import / Export" />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <Text style={s.label}>Data</Text>
        <Segment<Dataset> options={[{ k: 'ledger', label: 'Ledger Book' }, { k: 'chitti', label: 'Chitti Paata' }]} value={dataset} onChange={setDataset} />

        <Text style={s.label}>Format</Text>
        <Segment<Format> options={[{ k: 'excel', label: 'Excel (.xls)' }, { k: 'csv', label: 'CSV' }]} value={format} onChange={setFormat} />

        <Card style={{ marginTop: 20 }}>
          <View style={s.infoRow}><Ionicons name="cloud-upload-outline" size={18} color={FIN.brandDeep} /><Text style={s.infoTxt}>Export creates a file you can share or back up. Everything stays on your device.</Text></View>
        </Card>

        <View style={{ marginTop: 16 }}>
          <Btn label={`Export ${dataset === 'ledger' ? 'Ledger' : 'Chitti'}`} icon="download-outline" onPress={onExport} wide />
        </View>
        <View style={{ marginTop: 12 }}>
          <Btn label="Import Ledger from CSV" kind="ghost" icon="cloud-upload-outline" onPress={onImport} wide />
        </View>

        <Text style={s.hint}>
          CSV import expects the same columns as the export:{'\n'}{LEDGER_HEADERS.join(', ')}
        </Text>
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

/** Parse an exported ledger CSV and insert rows. Returns the count imported. */
async function importLedgerCsv(userId: string, content: string): Promise<number> {
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return 0;
  const parseRow = (line: string): string[] => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  };
  const num = (v: string) => { const n = Number((v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = parseRow(lines[i]);
    const name = (c[0] ?? '').trim();
    if (!name) continue;
    const principal = num(c[4]);
    if (!(principal > 0)) continue;
    await insertLedger({
      user_id: userId, direction: c[2] === 'borrow' ? 'borrow' : 'lend', name, mobile: (c[1] || '').trim() || null,
      interest_type: c[3] === 'compound' ? 'compound' : 'simple', principal, rate: num(c[5]),
      rate_mode: c[6] === 'rupees' ? 'rupees' : 'percent', period: (['daily', 'weekly', 'monthly', 'yearly'].includes(c[7]) ? c[7] : 'monthly') as LedgerPeriod,
      start_date: Date.now(), end_date: null, notes: (c[10] || '').trim() || null,
      remaining: num(c[8]) || principal, status: (['running', 'overdue', 'completed'].includes(c[9]) ? c[9] : 'running') as any,
    });
    count++;
  }
  return count;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16 },
  label: { color: FIN.text, fontSize: 14, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  infoRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  infoTxt: { flex: 1, color: FIN.sub, fontSize: 13, lineHeight: 19 },
  hint: { color: FIN.faint, fontSize: 11.5, marginTop: 16, lineHeight: 17 },
});
