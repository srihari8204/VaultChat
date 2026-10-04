// app/finance/_layout.tsx — Vault Finance hub navigation stack.
// Each screen draws its own FinHeader, so the native header stays hidden.
//
// The ice ground lives HERE, once, behind the whole stack. Every screen's root
// is `backgroundColor: FIN.bg` which is transparent, and the stack's own
// contentStyle is transparent too, so this single gradient is the ground for
// all 18 finance screens — and it does not repaint on navigation the way a
// per-screen gradient would.

import { Stack } from 'expo-router';
import React from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { type FinancePalette } from '../../constants/financeTheme';
import { ErrorBoundary } from '../../components/ErrorBoundary';

export default function FinanceLayout() {
  const FIN = useFinanceTheme();
  const styles = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[FIN.bgTop, FIN.bgMid, FIN.bgBottom]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* A render throw in any finance screen stops here, with a Try again,
          instead of unwinding to the app-wide boundary. The data is on disk
          and untouched by a render failure, which the message says. */}
      <ErrorBoundary screen="finance" fallbackTitle="Vault Finance hit a problem"
        fallbackMessage="Your ledgers and Lucky Draw groups are safe on this phone. Tap Try again; if it keeps happening, go back and reopen Vault Finance.">
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: FIN.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="ledger/index" />
        <Stack.Screen name="ledger/new" />
        <Stack.Screen name="ledger/[id]" />
        <Stack.Screen name="ledger/edit" />
        <Stack.Screen name="ledger/update" />
        <Stack.Screen name="chitti/index" />
        <Stack.Screen name="chitti/new" />
        <Stack.Screen name="chitti/[id]" />
        <Stack.Screen name="interest" />
        <Stack.Screen name="emi" />
        <Stack.Screen name="reminders" />
        <Stack.Screen name="calendar" />
        <Stack.Screen name="reports" />
        <Stack.Screen name="saved" />
        <Stack.Screen name="io" />
        <Stack.Screen name="customer" />
        <Stack.Screen name="search" />
      </Stack>
      </ErrorBoundary>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  // bgMid under the gradient: if the gradient ever fails to draw for a frame
  // during a transition, the fallback is the mid ice tone, not black.
  root: { flex: 1, backgroundColor: FIN.bgMid },
});
