// app/(tabs)/alerts.tsx — Phase 3a placeholder.
// Original security alerts feed pulled from Firestore. Will return
// once we have a security_events table + push notification pipeline
// on the new backend.

import { StyleSheet, Text, View } from 'react-native';

export default function AlertsScreen() {
  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.title}>Alerts</Text>
      </View>
      <View style={S.body}>
        <Text style={S.icon}>🔔</Text>
        <Text style={S.heading}>Security alerts coming back soon</Text>
        <Text style={S.sub}>
          Screenshot detection, login alerts, and breach warnings are being moved to a
          Postgres-backed activity feed with push notifications. Stay tuned.
        </Text>
      </View>
    </View>
  );
}

const DARK_BG = '#0D0F14';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';

const S = StyleSheet.create({
  screen:  { flex: 1, backgroundColor: DARK_BG },
  header:  { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 12 },
  title:   { color: TEXT, fontSize: 28, fontWeight: '800' },
  body:    { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  icon:    { fontSize: 56, marginBottom: 8 },
  heading: { color: TEXT, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  sub:     { color: SUBTLE, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
