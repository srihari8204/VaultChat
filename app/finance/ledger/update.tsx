// app/finance/ledger/update.tsx — Manual amount update (no gateway).
// User enters what they received; remaining auto-computes but stays editable.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FIN } from '../../../constants/financeTheme';
import { FinHeader, Label, Field, Btn, Card, RowLine } from '../../../components/finance/ui';
import { formatINR, fmtDateTime, num } from '../../../utils/financeFormat';
import { getLedger, addLedgerUpdate, type LedgerEntry } from '../../../db/ledger';
import { round2 } from '../../../utils/interest';

export default function UpdateAmount() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [e, setE] = useState<LedgerEntry | null>(null);
  const [received, setReceived] = useState('');
  const [remaining, setRemaining] = useState('');
  const [note, setNote] = useState('');
  const [touchedRemaining, setTouchedRemaining] = useState(false);

  const load = useCallback(() => { if (id) getLedger(id).then(setE); }, [id]);
  useEffect(load, [load]);

  // auto-fill remaining = current remaining − received (until the user edits it)
  useEffect(() => {
    if (!e || touchedRemaining) return;
    const r = num(received);
    const next = Number.isFinite(r) ? Math.max(0, round2(e.remaining - r)) : e.remaining;
    setRemaining(String(next));
  }, [received, e, touchedRemaining]);

  if (!e) return <View style={s.screen}><FinHeader title="Update Amount" /></View>;

  const onSave = async () => {
    const rec = num(received), rem = num(remaining);
    if (!(rec > 0)) return Alert.alert('Received', 'Enter the amount received (greater than 0).');
    if (!(rem >= 0)) return Alert.alert('Remaining', 'Enter a valid remaining amount.');
    try {
      await addLedgerUpdate(e.id, rec, rem, note.trim() || null);
      router.back();
    } catch (err: any) { Alert.alert('Could not save', err?.message ?? 'Try again'); }
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Update Amount" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Card>
            <Text style={s.who}>{e.name}</Text>
            <RowLine k="Principal" v={formatINR(e.principal)} />
            <RowLine k="Current remaining" v={formatINR(e.remaining)} bold tone={e.remaining > 0 ? 'warn' : 'good'} />
            <RowLine k="Last updated" v={fmtDateTime(e.last_updated)} />
          </Card>

          <Label>Amount Received Now</Label>
          <Field value={received} onChangeText={setReceived} placeholder="₹ 0" keyboardType="numeric" />

          <Label hint="(auto — edit if needed)">New Remaining Amount</Label>
          <Field value={remaining} onChangeText={(t) => { setTouchedRemaining(true); setRemaining(t); }} placeholder="₹ 0" keyboardType="numeric" />

          <Label hint="(optional)">Notes</Label>
          <Field value={note} onChangeText={setNote} placeholder="e.g. paid via UPI" multiline />

          <Text style={s.hint}>This update is timestamped and added to the ledger timeline automatically.</Text>

          <View style={{ marginTop: 18 }}>
            <Btn label="Save Update" icon="checkmark" onPress={onSave} wide />
          </View>
          <View style={{ height: 30 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingBottom: 40, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  who: { color: FIN.text, fontSize: 16, fontWeight: '800', marginBottom: 6 },
  hint: { color: FIN.faint, fontSize: 12, marginTop: 12, lineHeight: 17 },
});
