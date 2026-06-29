// app/call-reliability.tsx — "Calls may not ring?" survival guide.
//
// Prompts for battery-optimization exemption and deep-links to the OEM auto-start
// page, with a per-manufacturer step list + an "I've done this" confirmation.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  requestIgnoreBatteryOptimizations, openAutoStartSettings, oemInstructions, type OemStep,
} from '../lib/batteryOptimization';

const DONE_KEY = 'vc_call_reliability_done';

export default function CallReliabilityScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const [oem, setOem] = useState<OemStep | null>(null);
  const [battOk, setBattOk] = useState(false);
  const [autoOk, setAutoOk] = useState(false);

  useEffect(() => { oemInstructions().then(setOem); }, []);

  return (
    <View style={S.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} style={S.hBtn}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
        <Text style={S.title}>Call reliability</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={S.intro}>
          To make sure calls ring even when VaultChat is closed, allow it to run in the background. This is required on most
          Android phones.
        </Text>

        {/* Step 1 — battery optimization */}
        <View style={S.card}>
          <View style={S.cardHead}>
            <Ionicons name={battOk ? 'checkmark-circle' : 'battery-charging-outline'} size={22} color={battOk ? colors.online : colors.text} />
            <Text style={S.cardTitle}>1. Ignore battery optimization</Text>
          </View>
          <Text style={S.cardBody}>Lets VaultChat receive a call while the app is closed or the screen is off.</Text>
          <TouchableOpacity style={S.btn} onPress={async () => { await requestIgnoreBatteryOptimizations(); setBattOk(true); }}>
            <Text style={S.btnTxt}>Allow</Text>
          </TouchableOpacity>
        </View>

        {/* Step 2 — OEM auto-start */}
        {oem && (
          <View style={S.card}>
            <View style={S.cardHead}>
              <Ionicons name={autoOk ? 'checkmark-circle' : 'rocket-outline'} size={22} color={autoOk ? colors.online : colors.text} />
              <Text style={S.cardTitle}>2. {oem.title}</Text>
            </View>
            {oem.steps.map((s, i) => (
              <View key={i} style={S.stepRow}>
                <Text style={S.stepNum}>{i + 1}</Text>
                <Text style={S.stepTxt}>{s}</Text>
              </View>
            ))}
            <TouchableOpacity style={S.btn} onPress={async () => { await openAutoStartSettings(); }}>
              <Text style={S.btnTxt}>Open settings</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[S.btn, S.btnGhost]} onPress={() => setAutoOk(true)}>
              <Text style={[S.btnTxt, { color: colors.primary }]}>I've done this</Text>
            </TouchableOpacity>
          </View>
        )}

        {Platform.OS === 'android' && battOk && autoOk && (
          <View style={S.okBar}>
            <Ionicons name="shield-checkmark" size={18} color={colors.online} />
            <Text style={S.okTxt}>You're set — calls should ring even when VaultChat is closed.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: 54, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '700' },
  intro: { color: c.textDim, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  cardTitle: { color: c.text, fontSize: 16, fontWeight: '700', flex: 1 },
  cardBody: { color: c.textDim, fontSize: 13, lineHeight: 18, marginBottom: 10 },
  stepRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  stepNum: { color: c.primary, fontSize: 13, fontWeight: '800', width: 16 },
  stepTxt: { color: c.text, fontSize: 13, lineHeight: 18, flex: 1 },
  btn: { marginTop: 6, backgroundColor: c.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnGhost: { backgroundColor: 'transparent' },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  okBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, backgroundColor: 'rgba(46,160,67,0.12)' },
  okTxt: { color: c.text, fontSize: 13, flex: 1 },
});
