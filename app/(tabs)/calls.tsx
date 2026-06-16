// app/(tabs)/calls.tsx — Phase 3a placeholder.
// Original call history came from Firestore. Calls will return when
// the call signalling layer is wired through the new Socket.IO server
// and history is stored in Postgres.

import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function CallsScreen() {
  const { colors } = useTheme();
  const S = useS();
  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.title}>Calls</Text>
      </View>
      <View style={S.body}>
        <Text style={S.icon}>📞</Text>
        <Text style={S.heading}>Call history coming back soon</Text>
        <Text style={S.sub}>
          Voice + video calls and the call log are being ported to the new backend.
          WebRTC signalling already runs through our Socket.IO server, so the wire is ready —
          just need the UI rewire.
        </Text>
      </View>
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  header:  { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 12 },
  title:   { color: c.text, fontSize: 28, fontWeight: '800' },
  body:    { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  icon:    { fontSize: 56, marginBottom: 8 },
  heading: { color: c.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  sub:     { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
