// app/finance/ledger/new.tsx — Add a Lend / Borrow ledger entry.
// The fields and checks are components/finance/LedgerForm, shared with edit.
// The interest calculator's "Save as ledger" opens this with its terms as
// params (components/finance/ledgerPrefill), so the ledger compounds the same.

import React from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { View, StyleSheet, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader } from '../../../components/finance/ui';
import { LedgerForm, type LedgerFormValues } from '../../../components/finance/LedgerForm';
import { useMe } from '../../../components/finance/useMe';
import { insertLedger } from '../../../db/ledger';
import { parseLedgerPrefill } from '../../../components/finance/ledgerPrefill';

export default function NewLedger() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const router = useRouter();
  const me = useMe();
  const params = useLocalSearchParams();
  // Read once: the form owns its fields after the first render.
  const [prefill] = React.useState(() => parseLedgerPrefill(params));

  const fromCalculator = Object.keys(prefill).length > 0;

  const onSave = async (v: LedgerFormValues) => {
    if (!me) return;
    const saved = await insertLedger({ user_id: me.id, ...v });
    if (!fromCalculator) { router.back(); return; }
    // From the calculator, Back alone returned to the calculation with nothing
    // saying a ledger was made or where it went.
    Alert.alert('Saved to Ledger Book', `${saved.name} is in your Ledger Book.`, [
      { text: 'Back to calculator', style: 'cancel', onPress: () => router.back() },
      { text: 'Open ledger', onPress: () => router.replace({ pathname: '/finance/ledger/[id]', params: { id: saved.id } }) },
    ], { cancelable: true, onDismiss: () => router.back() });
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Add Ledger" />
      <LedgerForm directionEditable prefill={prefill} saveLabel="Save Ledger" onSave={onSave} />
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
});
