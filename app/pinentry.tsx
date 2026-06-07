// app/pinentry.tsx — legacy redirect.
//
// The old Firestore-based PIN/duress screen is superseded by the canonical
// MPIN gate (/enter-mpin) and the Postgres-backed duress handling in
// services/security. Its Firestore reads no longer resolve, so this module
// now forwards to /enter-mpin to avoid a dead, non-functional screen.

import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Aurora } from '../constants/theme';

export default function PinEntryRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/enter-mpin' as any); }, []);
  return (
    <View style={s.center}>
      <Stack.Screen options={{ headerShown: false }} />
      <ActivityIndicator color={Aurora.primary} size="large" />
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, backgroundColor: Aurora.bg, justifyContent: 'center', alignItems: 'center' },
});
