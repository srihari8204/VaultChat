// app/d2de-status.tsx
// Live D2DE encryption status screen — unique to VaultChat

import React, { useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { Stack } from 'expo-router';
import { getD2DEStatus } from '../services/d2deService';

const LAYER_INFO: Record<string, string> = {
  'TLS 1.3':           'All traffic between your device and VaultChat servers is encrypted with TLS 1.3. This protects data in transit.',
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
      <Stack.Screen options={{ title: '🔐 D2DE Status', headerStyle: { backgroundColor: colors.glassSoft }, headerTintColor: '#1F2937' }} />
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
              <Text style={[s.layerName, { color: layer.active ? '#fff' : '#6B7280' }]}>{layer.layer}</Text>
              <View style={[s.layerBadge, { backgroundColor: layer.active ? '#00FF8822' : '#F3F4F6' }]}>
                <Text style={[s.layerBadgeTxt, { color: layer.active ? '#00FF88' : '#6B7280' }]}>
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
          <Text style={s.uniqueTitle}>🏆 Unique to VaultChat</Text>
          <Text style={s.uniqueBody}>
            No other messaging app — not Signal, not WhatsApp, not Telegram — shows you a live encryption status screen.
            VaultChat is the only app where you can see exactly what protection is active on your conversation right now.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.glassSoft },
  scoreCard:    { backgroundColor: c.bg, margin: 16, borderRadius: 16, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: '#00FF8822' },
  scoreNum:     { fontSize: 56, fontWeight: 'bold', color: '#00FF88' },
  scoreLabel:   { color: c.textDim, fontSize: 14, marginBottom: 16 },
  scoreBar:     { flexDirection: 'row', gap: 6, marginBottom: 12 },
  scoreSeg:     { flex: 1, height: 6, borderRadius: 3 },
  scoreNote:    { color: c.textDim, fontSize: 12, textAlign: 'center' },
  layerCard:    { backgroundColor: c.glassSoft, marginHorizontal: 16, marginBottom: 10, borderRadius: 12, padding: 16, borderLeftWidth: 3 },
  layerHeader:  { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  layerDot:     { width: 10, height: 10, borderRadius: 5 },
  layerName:    { fontSize: 16, fontWeight: '700', flex: 1 },
  layerBadge:   { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  layerBadgeTxt:{ fontSize: 10, fontWeight: 'bold', letterSpacing: 0.5 },
  layerLabel:   { color: c.accent, fontSize: 12, marginBottom: 6 },
  layerInfo:    { color: c.textDim, fontSize: 12, lineHeight: 18 },
  uniqueBox:    { backgroundColor: c.bg, margin: 16, borderRadius: 12, padding: 18, borderWidth: 1, borderColor: '#FFD16633' },
  uniqueTitle:  { color: '#FFD166', fontSize: 15, fontWeight: 'bold', marginBottom: 8 },
  uniqueBody:   { color: c.textDim, fontSize: 13, lineHeight: 20 },
});
