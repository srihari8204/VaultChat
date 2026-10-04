// app/d2de-status.tsx
// Encryption status — which encryption layers THIS BUILD uses. It is a readout
// of compile-time flags (services/d2deService.getD2DEStatus → E2EE_ENABLED), not
// a live per-conversation check, and the copy says so.

import { AppText as Text, AuroraBackground } from '../components/ui';
import React, { useMemo } from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { Stack } from 'expo-router';
import { getD2DEStatus } from '../services/d2deService';

// Keyed by the layer names services/d2deService.ts returns — a key that does
// not match leaves the card's explanation blank ('Android Keystore' vs
// 'Secure Keystore' did exactly that). Worded as what the build is MADE to do:
// this screen reads flags, it cannot observe the live connection or keystore.
const LAYER_INFO: Record<string, string> = {
  'TLS 1.3':           'This build is made to encrypt traffic between your device and crazzychat servers in transit.',
  'AES-256-GCM':       'Direct-chat messages are encrypted on your device before they are sent, so the server stores ciphertext it cannot read.',
  'Double Ratchet':    'A fresh key for every message gives forward secrecy: one exposed key does not unlock earlier messages.',
  'X3DH':              'Two devices agree on a shared secret from published prekeys without ever sending a private key.',
  'Secure Keystore':   'This build is made to keep your end-to-end keys in the operating system’s secure storage on this device.',
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
          <Text style={s.scoreNum} accessibilityRole="header"
            accessibilityLabel={`${active} of ${layers.length} encryption layers in this build`}>{active}/{layers.length}</Text>
          <Text style={s.scoreLabel} importantForAccessibility="no" accessibilityElementsHidden>Encryption layers in this build</Text>
          {/* Decorative: the number above already says it. */}
          <View style={s.scoreBar} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {layers.map((l) => (
              <View key={l.layer} style={[s.scoreSeg, { backgroundColor: l.active ? colors.success : colors.border }]} />
            ))}
          </View>
          <Text style={s.scoreNote}>
            {active === layers.length
              ? 'All layers are switched on in this build.'
              : `${layers.length - active} layer${layers.length - active > 1 ? 's are' : ' is'} not switched on in this build.`
            }
          </Text>
        </View>

        {/* Layer cards */}
        {layers.map((layer) => (
          <View key={layer.layer} style={[s.layerCard, { borderLeftColor: layer.active ? colors.success : colors.border }]}
            accessible accessibilityLabel={`${layer.layer}, ${layer.active ? 'on' : 'off'}. ${layer.label}. ${LAYER_INFO[layer.layer] ?? ''}`}>
            <View style={s.layerHeader}>
              <View style={[s.layerDot, { backgroundColor: layer.active ? colors.success : colors.border }]} />
              <Text style={[s.layerName, { color: layer.active ? colors.text : colors.textDim }]}>{layer.layer}</Text>
              <View style={[s.layerBadge, { backgroundColor: colors.glassSoft }]}>
                <Text style={[s.layerBadgeTxt, { color: layer.active ? colors.accentOn : colors.textDim }]}>
                  {layer.active ? 'ON' : 'OFF'}
                </Text>
              </View>
            </View>
            <Text style={s.layerLabel}>{layer.label}</Text>
            <Text style={s.layerInfo}>{LAYER_INFO[layer.layer] ?? ''}</Text>
          </View>
        ))}

        <View style={s.uniqueBox}>
          <Text style={s.uniqueBody}>
            This lists what this version of the app is built to use. To check that a particular conversation is end-to-end
            encrypted with the right person, open the chat, tap their name, then tap the End-to-End Encrypted card, and
            compare the safety number with the one on their phone.
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
  uniqueBox:    { backgroundColor: c.glass, margin: 16, borderRadius: 12, padding: 18, borderWidth: 1, borderColor: c.glassStroke },
  uniqueBody:   { color: c.textDim, fontSize: 13, lineHeight: 20 },
});
