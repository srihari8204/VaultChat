// app/d2de-status.tsx
// Live D2DE encryption status screen — unique to crazzychat

import { AppText as Text, AuroraBackground } from '../components/ui';
import React, { useMemo } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { Stack } from 'expo-router';
import { getD2DEStatus } from '../services/d2deService';

const LAYER_INFO: Record<string, string> = {
  'TLS 1.3':           'All traffic between your device and crazzychat servers is encrypted with TLS 1.3. This protects data in transit.',
  'AES-256-GCM':       'Every message is encrypted on your device before being stored in Firestore. The server never sees plaintext.',
  'Double Ratchet':    'Per-message ephemeral keys provide Perfect Forward Secrecy. Compromising one key cannot decrypt past messages.',
  'X3DH':              'Extended Triple Diffie-Hellman key exchange establishes shared secrets without ever transmitting private keys.',
  'Android Keystore':  'Private keys stored in hardware-backed secure enclave. Non-exportable even with root access.',
};

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function D2DEStatusScreen() {
  const { colors } = useTheme();
  const s = useS();
  const layers = getD2DEStatus();
  const active = layers.filter(l => l.active).length;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Encryption status', headerStyle: { backgroundColor: colors.glassSoft }, headerTintColor: colors.text }} />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AuroraBackground />
      <ScrollView style={s.screen}>

        {/* Score card */}
        <View style={s.scoreCard}>
          <Text style={s.scoreNum}>{active}/{layers.length}</Text>
          <Text style={s.scoreLabel}>Encryption Layers Active</Text>
          <View style={s.scoreBar}>
            {layers.map((l, i) => (
              <View key={i} style={[s.scoreSeg, { backgroundColor: l.active ? '#00FF88' : '#F3F4F6' }]} />
            ))}
          </View>
          <Text style={s.scoreNote}>
            {active === layers.length
              ? '🏆 Maximum security — all layers active'
              : `${layers.length - active} layer${layers.length - active > 1 ? 's' : ''} pending — see roadmap below`
            }
          </Text>
        </View>

        {/* Layer cards */}
        {layers.map((layer, i) => (
          <View key={i} style={[s.layerCard, { borderLeftColor: layer.active ? '#00FF88' : '#D1D5DB' }]}>
            <View style={s.layerHeader}>
              <View style={[s.layerDot, { backgroundColor: layer.active ? '#00FF88' : '#D1D5DB' }]} />
              <Text style={[s.layerName, { color: layer.active ? colors.text : colors.textDim }]}>{layer.layer}</Text>
              <View style={[s.layerBadge, { backgroundColor: colors.glassSoft }]}>
                <Text style={[s.layerBadgeTxt, { color: layer.active ? colors.accentOn : colors.textDim }]}>
                  {layer.active ? 'ACTIVE' : 'PENDING'}
                </Text>
              </View>
            </View>
            <Text style={s.layerLabel}>{layer.label}</Text>
            <Text style={s.layerInfo}>{LAYER_INFO[layer.layer] ?? ''}</Text>
          </View>
        ))}

        {/* Unique callout */}
        <View style={s.uniqueBox}>
          <Text style={s.uniqueTitle}>🏆 Unique to crazzychat</Text>
          <Text style={s.uniqueBody}>
            No other messaging app — not Signal, not WhatsApp, not Telegram — shows you a live encryption status screen.
            crazzychat is the only app where you can see exactly what protection is active on your conversation right now.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
      </View>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.glassSoft },
  scoreCard:    { backgroundColor: c.glass, margin: 16, borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: c.glassStroke },
  scoreNum:     { fontSize: 56, fontWeight: 'bold', color: c.accentOn },
  scoreLabel:   { color: c.textDim, fontSize: 14, marginBottom: 16 },
  scoreBar:     { flexDirection: 'row', gap: 6, marginBottom: 12 },
  scoreSeg:     { flex: 1, height: 6, borderRadius: 3 },
  scoreNote:    { color: c.textDim, fontSize: 12, textAlign: 'center' },
  layerCard:    { backgroundColor: c.glassSoft, marginHorizontal: 16, marginBottom: 10, borderRadius: 12, padding: 16, borderLeftWidth: 3 },
  layerHeader:  { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 6 },
  layerDot:     { width: 10, height: 10, borderRadius: 5 },
  layerName:    { fontSize: 16, fontWeight: '700', flex: 1, minWidth: 120 },
  layerBadge:   { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  layerBadgeTxt:{ fontSize: 12, fontWeight: 'bold', letterSpacing: 0.5 },
  layerLabel:   { color: c.accentOn, fontSize: 12, marginBottom: 6 },
  layerInfo:    { color: c.textDim, fontSize: 12, lineHeight: 18 },
  uniqueBox:    { backgroundColor: c.glass, margin: 16, borderRadius: 12, padding: 18, borderWidth: 1, borderColor: '#FFD16633' },
  uniqueTitle:  { color: c.accentOn, fontSize: 15, fontWeight: 'bold', marginBottom: 8 },
  uniqueBody:   { color: c.textDim, fontSize: 13, lineHeight: 20 },
});
