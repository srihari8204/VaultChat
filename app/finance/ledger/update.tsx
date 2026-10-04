// app/finance/ledger/update.tsx — Manual amount update (no gateway).
// User enters what they received; remaining auto-computes but stays editable.

import React, { useCallback, useEffect, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { KeyboardSafe } from '../../../components/ui';
import { View, Text, ScrollView, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader, Label, Field, Btn, Card, RowLine, LoadingState, ErrorState } from '../../../components/finance/ui';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { formatINR, fmtDateTime, num } from '../../../utils/financeFormat';
import { getLedger, addLedgerUpdate, type LedgerEntry } from '../../../db/ledger';
import { round2 } from '../../../utils/interest';

export default function UpdateAmount() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [e, setE] = useState<LedgerEntry | null>(null);
  const [received, setReceived] = useState('');
  const [remaining, setRemaining] = useState('');
  const [note, setNote] = useState('');
  const [touchedRemaining, setTouchedRemaining] = useState(false);

  const { status, begin, done, fail } = useLoadStatus();
  const load = useCallback(() => {
    if (!id) { fail(); return; }
    begin();
    getLedger(id).then((row) => { setE(row); done(); }).catch(fail);
  }, [id, begin, done, fail]);
  useEffect(load, [load]);

  // auto-fill remaining = current remaining − received (until the user edits it)
  useEffect(() => {
    if (!e || touchedRemaining) return;
    const r = num(received);
    const next = Number.isFinite(r) ? Math.max(0, round2(e.remaining - r)) : e.remaining;
    setRemaining(String(next));
  }, [received, e, touchedRemaining]);

  if (!e) {
    return (
      <View style={s.screen}>
        <FinHeader title="Update Amount" />
        {status === 'loading' && <LoadingState label="Loading ledger" />}
        {status === 'error' && <ErrorState title="Could not load this ledger" sub="Nothing has been changed." onRetry={load} />}
        {status === 'ready' && <ErrorState title="Ledger not found" sub="It may have been deleted." />}
      </View>
    );
  }

  const onSave = async () => {
    const rec = num(received), rem = num(remaining);
    if (!(rec > 0)) return Alert.alert('Received', 'Enter the amount received (greater than 0).');
    if (!(rem >= 0)) return Alert.alert('Remaining', 'Enter a valid remaining amount.');
    // Both are legitimate (an overpayment; interest added to the balance) but
    // both are also what a slipped digit looks like, so they are confirmed.
    const odd = rec > e.remaining
      ? `${formatINR(rec)} received is more than the ${formatINR(e.remaining)} still owed.`
      : rem > e.remaining
        ? `The new remaining, ${formatINR(rem)}, is more than the current ${formatINR(e.remaining)}.`
        : null;
    // Settling is final for the ledger (it moves to Completed), so it is said
    // out loud rather than inferred from a 0 in the box.
    const settles = !odd && rem === 0 && e.remaining > 0;
    if (odd) {
      const go = await new Promise<boolean>((resolve) => Alert.alert('Check the amounts', `${odd} Save anyway?`, [
        { text: 'Go back', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Save', onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) }));
      if (!go) return;
    }
    if (settles) {
      const go = await new Promise<boolean>((resolve) => Alert.alert('Settle this ledger?',
        `Nothing will remain on ${e.name}'s ledger, so it is marked Completed.`, [
          { text: 'Go back', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Settle', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) }));
      if (!go) return;
    }
    try {
      await addLedgerUpdate(e.id, rec, rem, note.trim() || null);
      router.back();
    } catch (err: any) { Alert.alert('Could not save', err?.message ?? 'Try again'); }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Update Amount" />
      <KeyboardSafe style={{ flex: 1 }} >
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Card>
            <Text numberOfLines={1} style={s.who} accessibilityRole="header">{e.name}</Text>
            <RowLine k="Principal" v={formatINR(e.principal)} />
            <RowLine k="Current remaining" v={formatINR(e.remaining)} bold tone={e.remaining > 0 ? 'warn' : 'good'} />
            <RowLine k="Last updated" v={fmtDateTime(e.last_updated)} />
          </Card>

          <Label>Amount Received Now</Label>
          <Field label="Amount received now" value={received} onChangeText={setReceived} placeholder="₹ 0" keyboardType="numeric" />

          <Label hint="(auto — edit if needed)">New Remaining Amount</Label>
          <Field label="New remaining amount" value={remaining} onChangeText={(t) => { setTouchedRemaining(true); setRemaining(t); }} placeholder="₹ 0" keyboardType="numeric" />

          <Label hint="(optional)">Notes</Label>
          <Field label="Notes, optional" value={note} onChangeText={setNote} placeholder="e.g. paid via UPI" multiline />

          <Text style={s.hint}>This update is timestamped and added to the ledger timeline automatically.</Text>

          <View style={{ marginTop: 18 }}>
            <Btn label="Save Update" icon="checkmark" onPress={onSave} wide />
          </View>
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  who: { color: FIN.text, fontSize: 16, fontWeight: '800', marginBottom: 6 },
  hint: { color: FIN.faint, fontSize: 12, marginTop: 12, lineHeight: 17 },
});
