// app/finance/ledger/new.tsx — Add a Lend / Borrow ledger entry.
// The fields and checks are components/finance/LedgerForm, shared with edit.

import React from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader } from '../../../components/finance/ui';
import { LedgerForm, type LedgerFormValues } from '../../../components/finance/LedgerForm';
import { useMe } from '../../../components/finance/useMe';
import { insertLedger } from '../../../db/ledger';

export default function NewLedger() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const router = useRouter();
  const me = useMe();

  const onSave = async (v: LedgerFormValues) => {
    if (!me) return;
    await insertLedger({ user_id: me.id, ...v });
    router.back();
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Add Ledger" />
      <LedgerForm directionEditable saveLabel="Save Ledger" onSave={onSave} />
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
});
