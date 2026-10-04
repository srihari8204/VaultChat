// app/finance/io.tsx — Import / Export finance data (CSV & Excel), fully local.
// Export writes a share-sheet file; import reads a CSV and bulk-inserts ledgers.

import React, { useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { type FinancePalette } from '../../constants/financeTheme';
import { KeyboardSafe } from '../../components/ui';
import { FinHeader, Segment, Btn, Card, Field, Label } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { listLedger, insertLedgers } from '../../db/ledger';
import { listGroups, listMembers, listCollections, listAuctions } from '../../db/chitti';
import { exportExcel, shareTextFile } from '../../utils/financeIO';
import { buildBackup, restoreBackup, isRestorable } from '../../db/financeBackup';
import { LEDGER_HEADERS, ledgerCsvRow, planLedgerImport, toCsv } from '../../components/finance/ledgerCsv';
import { sealFinanceBackup, isSealedFinanceBackup, openFinanceBackup, passwordProblem } from '../../utils/financeBackupSeal';

type Dataset = 'ledger' | 'chitti' | 'backup';
type Format = 'excel' | 'csv';

const LD_HEADERS = ['Group', 'MemberNo', 'Name', 'Mobile', 'Address', 'Paid', 'Pending', 'Overdue', 'Won'];

/** Larger than any real finance book; refuses a wrong pick before reading it. */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** What the picker offers. Providers label CSV inconsistently, so the usual
 *  aliases are listed; the content is still parsed and checked after picking. */
const PICK_TYPES: Record<'csv' | 'json', string[]> = {
  csv: ['text/csv', 'text/comma-separated-values', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  json: ['application/json', 'text/json', 'text/plain', 'application/octet-stream'],
};

/** Exports carry names, phones and addresses in plain text. Once the share
 *  sheet has handed the file on, the copy in the app cache is deleted. */
async function dropExport(uri: string | null) {
  if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

const ask = (title: string, message: string, action: string) => new Promise<boolean>((resolve) =>
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
    { text: action, onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function FinanceIO() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const me = useMe();
  const [dataset, setDataset] = useState<Dataset>('ledger');
  const [format, setFormat] = useState<Format>('excel');
  // The Full Backup password. Never stored: it exists only while typed here.
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');

  const onExport = async () => {
    if (!me) return;
    try {
      if (dataset === 'ledger') {
        const rows = await listLedger(me.id);
        if (rows.length === 0) return Alert.alert('Nothing to export', 'No ledgers yet.');
        const data = rows.map(ledgerCsvRow);
        await dropExport(format === 'excel'
          ? await exportExcel('vault-ledger', LEDGER_HEADERS, data)
          : await shareTextFile('vault-ledger.csv', toCsv(LEDGER_HEADERS, data), 'text/csv'));
      } else if (dataset === 'backup') {
        // Full round-trippable backup — the only export that can be restored.
        // It holds every name, phone and amount, so it leaves the phone sealed
        // under a password (utils/financeBackupSeal), never as plain JSON.
        const weak = passwordProblem(pw);
        if (weak) return Alert.alert('Backup password', `${weak} This password is the only way to open the backup.`);
        if (pw !== pw2) return Alert.alert('Backup password', 'The two passwords do not match.');
        const snap = await buildBackup(me.id);
        if (snap.ledgers.length === 0 && snap.groups.length === 0) {
          return Alert.alert('Nothing to back up', 'Add a ledger or a Lucky Draw group first.');
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const n = snap.groups.length + snap.ledgers.length;
        const sealed = sealFinanceBackup(JSON.stringify(snap), pw);
        await dropExport(await shareTextFile(`vault-finance-backup-${stamp}.json`, sealed, 'application/json'));
        setPw2('');
        // Explicit confirmation: this file is the only restore path, and the
        // share sheet is easy to dismiss by accident. Without this the user
        // cannot tell "backed up" from "nothing happened".
        Alert.alert('Backup created',
          `${n} record${n === 1 ? '' : 's'} saved to vault-finance-backup-${stamp}.json, protected by your password.\n\n` +
          'Only the copy you saved or sent exists — none is kept on this device. Save it to Drive or Files, ' +
          'and keep the password: without it the backup cannot be opened by anyone, including you.');
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
        await dropExport(format === 'excel'
          ? await exportExcel('vault-lucky-draw', LD_HEADERS, data)
          : await shareTextFile('vault-lucky-draw.csv', toCsv(LD_HEADERS, data), 'text/csv'));
      }
    } catch (e: any) { Alert.alert('Export failed', e?.message ?? 'Try again'); }
  };

  const onImport = async () => {
    if (!me) return;
    if (dataset === 'chitti') {
      return Alert.alert('Use Full Backup', 'The Lucky Draw sheet is for reading in Excel. To restore Lucky Draw data, choose Full Backup and import the .json file.');
    }
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: PICK_TYPES[dataset === 'backup' ? 'json' : 'csv'], copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      const tooBig = () => Alert.alert('File too large', 'That file is bigger than any finance export. Pick the file this screen exported.');
      if ((asset.size ?? 0) > MAX_IMPORT_BYTES) {
        await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {});
        return tooBig();
      }
      const content = await FileSystem.readAsStringAsync(asset.uri);
      await FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {});
      // Some providers report no size; the length read is checked instead.
      if (content.length > MAX_IMPORT_BYTES) return tooBig();

      if (dataset === 'backup') {
        // Sealed backups need the password; backups made before sealing
        // existed are plain JSON and restore exactly as they always did.
        let text = content;
        if (isSealedFinanceBackup(content)) {
          if (!pw) return Alert.alert('Password needed', 'This backup is password-protected. Type its password in Backup password above, then restore again.');
          try { text = openFinanceBackup(content, pw); } catch {
            return Alert.alert('Wrong password', 'That password does not open this backup. Nothing was changed.');
          }
        }
        let parsed: any;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        if (!isRestorable(parsed)) {
          return Alert.alert('Not a backup file', 'This is not a Vault Finance backup, or it was made by a newer version of the app. Nothing was changed.');
        }
        const n = (a: unknown) => (Array.isArray(a) ? a.length : 0);
        const go = await ask('Restore this backup?',
          `It holds ${plural(n(parsed.ledgers), 'ledger')}, ${plural(n(parsed.groups), 'Lucky Draw group')} and ` +
          `${plural(n(parsed.reminders), 'reminder')}` +
          (parsed.exportedAt ? `, saved ${new Date(parsed.exportedAt).toLocaleString()}` : '') + '.\n\n' +
          'Any record you already have that is also in the backup will be REPLACED by the backup copy, ' +
          'including changes you made after the backup was taken. Nothing else is deleted.',
          'Restore');
        if (!go) return;
        const c = await restoreBackup(me.id, parsed);
        return Alert.alert('Restore complete',
          `${c.groups} Lucky Draw group${c.groups === 1 ? '' : 's'}, ${c.members} member${c.members === 1 ? '' : 's'}, ` +
          `${c.collections} due${c.collections === 1 ? '' : 's'}, ${c.auctions} auction${c.auctions === 1 ? '' : 's'} and ` +
          `${c.ledgers} ledger${c.ledgers === 1 ? '' : 's'} restored.`);
      }

      const plan = planLedgerImport(content, await listLedger(me.id), Date.now());
      const notes = [
        plan.duplicates ? `${plural(plan.duplicates, 'row')} already in your ledger book — skipped.` : '',
        plan.badPrincipal ? `${plural(plan.badPrincipal, 'row')} without a readable Principal — skipped.` : '',
        // guessing a Remaining it cannot read would resurrect a settled debt
        plan.badRemaining ? `${plural(plan.badRemaining, 'row')} whose Remaining is not a plain number — skipped.` : '',
        plan.badDate ? `${plural(plan.badDate, 'row')} with an unreadable start or end date — skipped.` : '',
        plan.badMobile ? `${plural(plan.badMobile, 'row')} with a mobile that is not a valid 10-digit number — imported without it.` : '',
      ].filter(Boolean).join('\n');
      if (plan.rows.length === 0) {
        return Alert.alert('Nothing to import', notes || 'The file has no ledger rows.');
      }
      if (!await ask('Import ledgers?', `${plural(plan.rows.length, 'new ledger')} will be added.${notes ? `\n\n${notes}` : ''}`, 'Import')) return;
      // All or nothing: a failure part-way rolls the whole import back, so
      // "Import failed" never hides a half-imported file.
      const count = await insertLedgers(plan.rows.map(row => ({ ...row, user_id: me.id })));
      Alert.alert('Import complete', `${plural(count, 'ledger')} imported.${notes ? `\n\n${notes}` : ''}`);
    } catch (e: any) {
      Alert.alert('Import failed', e?.message ?? 'Could not read the file.');
    }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Import / Export" />
      <KeyboardSafe>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
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
                ? 'A complete, password-protected copy of your ledgers and Lucky Draw groups — members, dues, auctions and history. This is the only export you can restore from. Keep it somewhere safe.'
                : 'Export creates a spreadsheet you can share or print. Everything stays on your device.'}
            </Text>
          </View>
        </Card>

        {dataset === 'backup' && (
          <>
            <Label hint="(8+ characters, a letter and a number)">Backup password</Label>
            <Field label="Backup password" value={pw} onChangeText={setPw} placeholder="Password"
              secureTextEntry autoCapitalize="none" autoCorrect={false} />
            <Label hint="(for export)">Confirm password</Label>
            <Field label="Confirm backup password" value={pw2} onChangeText={setPw2} placeholder="Type it again"
              secureTextEntry autoCapitalize="none" autoCorrect={false} />
            <Text style={s.warn}>
              The backup is locked with this password. If you forget it, the backup cannot be opened — not by you, and not by us.
            </Text>
          </>
        )}

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
            ? 'Restoring merges the file into your data: records that are also in the backup are replaced by the backup copy, and nothing else is deleted. You see what the file holds and confirm before anything changes. Older backups made without a password restore without one.'
            : dataset === 'chitti'
              ? `Spreadsheet columns:\n${LD_HEADERS.join(', ')}\n\nTo restore Lucky Draw data, use Full Backup.`
              : `CSV import expects the same columns as the export:\n${LEDGER_HEADERS.join(', ')}`}
        </Text>
        <View style={{ height: 30 }} />
      </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  label: { color: FIN.text, fontSize: 14, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  infoRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  infoTxt: { flex: 1, color: FIN.sub, fontSize: 13, lineHeight: 19 },
  hint: { color: FIN.faint, fontSize: 11.5, marginTop: 16, lineHeight: 17 },
  warn: { color: FIN.warn, fontSize: 12, marginTop: 8, lineHeight: 17 },
});
