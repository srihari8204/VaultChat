// app/call-reliability.tsx — "Calls may not ring?" survival guide.
//
// Prompts for battery-optimization exemption and deep-links to the OEM auto-start
// page, with a per-manufacturer step list + an "I've done this" confirmation.

import { HEADER_TOP } from '../constants/layout';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform, Switch } from 'react-native';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import {
  requestIgnoreBatteryOptimizations, openAutoStartSettings, oemInstructions, type OemStep,
} from '../lib/batteryOptimization';
import { getLowDataMode, setLowDataMode } from '../lib/callPrefs';
import { canUseFullScreenIntent, openFullScreenIntentSettings } from '../lib/CallService';

const DONE_KEY = 'vc_call_reliability_done';

export default function CallReliabilityScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const [oem, setOem] = useState<OemStep | null>(null);
  const [battOk, setBattOk] = useState(false);
  const [autoOk, setAutoOk] = useState(false);
  const [lowData, setLowData] = useState(false);
  useEffect(() => { getLowDataMode().then(setLowData).catch(() => {}); }, []);

  useEffect(() => { oemInstructions().then(setOem); }, []);

  // Android 14 turned USE_FULL_SCREEN_INTENT into a user-granted permission for
  // anything that is not the default dialer. Declaring it in the manifest is no
  // longer enough — measured on device as FSI_REQUESTED_BUT_DENIED on the ring
  // notification, which is why an incoming call showed a heads-up banner instead
  // of taking over the lock screen like a phone call.
  //
  // Re-checked on focus, not just on mount: granting it happens in Settings, so
  // the user comes BACK to this screen having changed it, and a mount-only check
  // would keep telling them to do something they had already done.
  const [fsiOk, setFsiOk] = useState(true);
  const refreshFsi = () => { canUseFullScreenIntent().then(setFsiOk).catch(() => {}); };
  useEffect(refreshFsi, []);
  useFocusEffect(useCallback(() => { refreshFsi(); }, []));

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

        {/* Step 0 — full-screen intent (Android 14+). Shown ONLY when it is
            actually missing: a permission card that is always there teaches
            people to ignore the list. */}
        {Platform.OS === 'android' && !fsiOk && (
          <View style={S.card}>
            <View style={S.cardHead}>
              <Ionicons name="alert-circle-outline" size={22} color={colors.danger} />
              <Text style={S.cardTitle}>Allow full-screen calls</Text>
            </View>
            <Text style={S.cardBody}>
              Without this, an incoming call shows a small banner instead of taking over the
              screen — easy to miss when the phone is locked.
            </Text>
            <TouchableOpacity style={S.btn} onPress={() => { openFullScreenIntentSettings(); }}>
              <Text style={S.btnTxt}>Open setting</Text>
            </TouchableOpacity>
          </View>
        )}

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
              <Text style={[S.btnTxt, { color: colors.primary }]}>I’ve done this</Text>
            </TouchableOpacity>
          </View>
        )}

        {Platform.OS === 'android' && battOk && autoOk && (
          <View style={S.okBar}>
            <Ionicons name="shield-checkmark" size={18} color={colors.online} />
            <Text style={S.okTxt}>You’re set — calls should ring even when VaultChat is closed.</Text>
          </View>
        )}

        {/* Low-data mode. Caps the encoder rather than switching anything off:
            video still works, it just stops chasing quality the connection
            cannot afford. Audio drops to the Opus floor (16 kbps), which is
            still transparent for speech. */}
        <View style={S.card}>
          <View style={S.cardHead}>
            <Ionicons name="cellular-outline" size={22} color={lowData ? colors.primary : colors.text} />
            <Text style={S.cardTitle}>Low data mode</Text>
            <Switch
              value={lowData}
              onValueChange={async (v) => { setLowData(v); await setLowDataMode(v); }}
              trackColor={{ true: colors.primary }}
            />
          </View>
          <Text style={S.cardBody}>
            Uses far less mobile data on calls, and less battery. Video stays on but at a lower
            quality ceiling; if the connection gets bad enough, video pauses so the audio keeps
            working. Takes effect on the next sample, including during a call.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
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
