// app/finance/ledger/edit.tsx — edit an existing ledger's terms (not balance).
// The fields and checks are components/finance/LedgerForm, shared with new.

import React, { useCallback, useEffect, useState } from 'react';
import { useFinanceTheme } from '../../../components/finance/useFinanceTheme';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLoadStatus } from '../../../components/finance/useLoad';
import { type FinancePalette } from '../../../constants/financeTheme';
import { FinHeader, LoadingState, ErrorState } from '../../../components/finance/ui';
import { LedgerForm, type LedgerFormValues } from '../../../components/finance/LedgerForm';
import { getLedger, updateLedgerDetails, type LedgerEntry } from '../../../db/ledger';

export default function EditLedger() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [e, setE] = useState<LedgerEntry | null>(null);

  const { status, begin, done, fail } = useLoadStatus();
  const load = useCallback(() => {
    if (!id) { fail(); return; }
    begin();
    getLedger(id).then((row) => { setE(row); done(); }).catch(fail);
  }, [id, begin, done, fail]);
  useEffect(load, [load]);

  if (!e) {
    return (
      <View style={s.screen}>
        <FinHeader title="Edit Ledger" />
        {status === 'loading' && <LoadingState label="Loading ledger" />}
        {status === 'error' && <ErrorState title="Could not load this ledger" sub="Nothing has been changed." onRetry={load} />}
        {status === 'ready' && <ErrorState title="Ledger not found" sub="It may have been deleted." />}
      </View>
    );
  }

  // The direction is fixed once a ledger exists; everything else is editable.
  const onSave = async ({ direction: _direction, ...v }: LedgerFormValues) => {
    await updateLedgerDetails(e.id, v);
    router.back();
  };

  return (
    <View style={s.screen}>
      <FinHeader title="Edit Ledger" />
      {/* Keyed by id: the form's fields start from this ledger's stored terms. */}
      <LedgerForm key={e.id} initial={e} directionEditable={false} saveLabel="Save Changes" onSave={onSave} />
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
});
