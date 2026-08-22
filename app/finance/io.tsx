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
import { listGroups, listMembers, listCollections, listAuctions } from '../../db/chitti';
import { exportCsv, exportExcel, shareTextFile } from '../../utils/financeIO';
import { buildBackup, restoreBackup } from '../../db/financeBackup';
import type { LedgerPeriod } from '../../utils/finance';

type Dataset = 'ledger' | 'chitti' | 'backup';
type Format = 'excel' | 'csv';

const LD_HEADERS = ['Group', 'MemberNo', 'Name', 'Mobile', 'Address', 'Paid', 'Pending', 'Overdue', 'Won'];

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
      } else if (dataset === 'backup') {
        // Full round-trippable backup — the only export that can be restored.
        const snap = await buildBackup(me.id);
        if (snap.ledgers.length === 0 && snap.groups.length === 0) {
          return Alert.alert('Nothing to back up', 'Add a ledger or a Lucky Draw group first.');
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const n = snap.groups.length + snap.ledgers.length;
        await shareTextFile(`vault-finance-backup-${stamp}.json`, JSON.stringify(snap), 'application/json');
        // Explicit confirmation: this file is the only restore path, and the
        // share sheet is easy to dismiss by accident. Without this the user
        // cannot tell "backed up" from "nothing happened".
        Alert.alert('Backup created',
          `${n} record${n === 1 ? '' : 's'} saved to vault-finance-backup-${stamp}.json.\n\n` +
          'Save it to Drive or Files — it stays only on this device otherwise.');
      } else {
        // Member-level sheet: one row per member with their dues tally. Far more
        // useful to an organizer than the old group-only sheet, which omitted
        // every member, collection and auction.
        const groups = await listGroups(me.id);
        if (groups.length === 0) return Alert.alert('Nothing to export', 'No Lucky Draw groups yet.');
        const data: (string | number)[][] = [];
        for (const g of groups) {
          const [members, cols, aucs] = await Promise.all([
            listMembers(g.id), listCollections(g.id), listAuctions(g.id),
          ]);
          for (const m of members) {
            const mine = cols.filter(c => c.member_id === m.id);
            const won = aucs.filter(a => a.winner_id === m.id).map(a => `M${a.month}`).join(' ');
            data.push([
              g.name, m.number, m.name, m.phone ?? '', m.address ?? '',
              mine.filter(c => c.status === 'paid').length,
              mine.filter(c => c.status === 'pending').length,
              mine.filter(c => c.status === 'overdue').length,
              won,
            ]);
          }
        }
        if (data.length === 0) return Alert.alert('Nothing to export', 'Your Lucky Draw groups have no members yet.');
        format === 'excel' ? await exportExcel('vault-lucky-draw', LD_HEADERS, data) : await exportCsv('vault-lucky-draw', LD_HEADERS, data);
      }
    } catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Try again'); }
  };

  const onImport = async () => {
    if (!me) return;
    if (dataset === 'chitti') {
      return Alert.alert('Use Full Backup', 'The Lucky Draw sheet is for reading in Excel. To restore Lucky Draw data, choose Full Backup and import the .json file.');
    }
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: ['*/*'], copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const content = await FileSystem.readAsStringAsync(res.assets[0].uri);

      if (dataset === 'backup') {
        const parsed = JSON.parse(content);
        const c = await restoreBackup(me.id, parsed);
        return Alert.alert('Restore complete',
          `${c.groups} Lucky Draw group${c.groups === 1 ? '' : 's'}, ${c.members} member${c.members === 1 ? '' : 's'}, ` +
          `${c.collections} due${c.collections === 1 ? '' : 's'}, ${c.auctions} auction${c.auctions === 1 ? '' : 's'} and ` +
          `${c.ledgers} ledger${c.ledgers === 1 ? '' : 's'} restored.`);
      }

      const count = await importLedgerCsv(me.id, content);
      Alert.alert('Import complete', `${count} ledger${count === 1 ? '' : 's'} imported.`);
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? 'Could not read the file.');
    }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Import / Export" />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <Text style={s.label}>Data</Text>
        <Segment<Dataset>
          options={[{ k: 'ledger', label: 'Ledger' }, { k: 'chitti', label: 'Lucky Draw' }, { k: 'backup', label: 'Full Backup' }]}
          value={dataset} onChange={setDataset}
        />

        {dataset !== 'backup' && (
          <>
            <Text style={s.label}>Format</Text>
            <Segment<Format> options={[{ k: 'excel', label: 'Excel (.xls)' }, { k: 'csv', label: 'CSV' }]} value={format} onChange={setFormat} />
          </>
        )}

        <Card style={{ marginTop: 20 }}>
          <View style={s.infoRow}>
            <Ionicons name={dataset === 'backup' ? 'shield-checkmark-outline' : 'cloud-upload-outline'} size={18} color={FIN.brandDeep} />
            <Text style={s.infoTxt}>
              {dataset === 'backup'
                ? 'A complete .json copy of your ledgers and Lucky Draw groups — members, dues, auctions and history. This is the only export you can restore from. Keep it somewhere safe.'
                : 'Export creates a spreadsheet you can share or print. Everything stays on your device.'}
            </Text>
          </View>
        </Card>

        <View style={{ marginTop: 16 }}>
          <Btn
            label={dataset === 'backup' ? 'Export Full Backup' : `Export ${dataset === 'ledger' ? 'Ledger' : 'Lucky Draw'}`}
            icon="download-outline" onPress={onExport} wide
          />
        </View>
        <View style={{ marginTop: 12 }}>
          <Btn
            label={dataset === 'backup' ? 'Restore from Backup' : 'Import Ledger from CSV'}
            kind="ghost" icon="cloud-upload-outline" onPress={onImport} wide
          />
        </View>

        <Text style={s.hint}>
          {dataset === 'backup'
            ? 'Restoring merges the file into your data — rows you already have are updated, nothing is deleted. Importing the same file twice is safe.'
            : dataset === 'chitti'
              ? `Spreadsheet columns:\n${LD_HEADERS.join(', ')}\n\nTo restore Lucky Draw data, use Full Backup.`
              : `CSV import expects the same columns as the export:\n${LEDGER_HEADERS.join(', ')}`}
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
