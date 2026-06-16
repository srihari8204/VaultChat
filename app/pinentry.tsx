// app/pinentry.tsx — legacy redirect.
//
// The old Firestore-based PIN/duress screen is superseded by the canonical
// MPIN gate (/enter-mpin) and the Postgres-backed duress handling in
// services/security. Its Firestore reads no longer resolve, so this module
// now forwards to /enter-mpin to avoid a dead, non-functional screen.

import React, { useEffect , useMemo} from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function PinEntryRedirect() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  useEffect(() => { router.replace('/enter-mpin' as any); }, []);
  return (
    <View style={s.center}>
      <Stack.Screen options={{ headerShown: false }} />
      <ActivityIndicator color={colors.primary} size="large" />
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  center: { flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
});
