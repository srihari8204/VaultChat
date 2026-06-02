// app/(tabs)/status.tsx — Phase 3a placeholder.
// Original Firestore-based status/stories feature paused; will return
// with signed media URLs in a later phase. This screen is just a
// non-crashing landing page so the tab is navigable.

import { StyleSheet, Text, View } from 'react-native';

export default function StatusScreen() {
  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.title}>Status</Text>
      </View>
      <View style={S.body}>
        <Text style={S.icon}>📸</Text>
        <Text style={S.heading}>Stories coming back soon</Text>
        <Text style={S.sub}>
          Status updates are being rebuilt on the new Postgres backend with signed media URLs.
          For now, head over to Chats.
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
