// app/finance/_layout.tsx — Vault Finance hub navigation stack.
// Each screen draws its own FinHeader, so the native header stays hidden.

import { Stack } from 'expo-router';
import React from 'react';
import { FIN } from '../../constants/financeTheme';

export default function FinanceLayout() {
  return (
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
  );
}
