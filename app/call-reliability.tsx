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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  requestIgnoreBatteryOptimizations, readBatteryExemption, openAutoStartSettings, oemInstructions,
  type OemStep,
} from '../lib/batteryOptimization';
import { getLowDataMode, setLowDataMode } from '../lib/callPrefs';
import { canUseFullScreenIntent, openFullScreenIntentSettings } from '../lib/CallService';
import { AuroraBackground } from '../components/ui';

// The OEM auto-start page cannot be read back, so "I've done this" is the
// user's word for it — kept across visits so they are not asked every time.
const DONE_KEY = 'vc_call_reliability_done';

export default function CallReliabilityScreen() {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const [oem, setOem] = useState<OemStep | null>(null);
  // null = could not be read back; never shown as done.
  const [battOk, setBattOk] = useState<boolean | null>(false);
  const [autoOk, setAutoOk] = useState(false);
  const [lowData, setLowData] = useState(false);
  const [lowDataFailed, setLowDataFailed] = useState(false);
  const [oemFailed, setOemFailed] = useState(false);
  useEffect(() => { getLowDataMode().then(setLowData).catch(() => {}); }, []);

  useEffect(() => {
    oemInstructions().then(setOem).catch(() => setOemFailed(true));
    AsyncStorage.getItem(DONE_KEY).then(v => setAutoOk(v === '1')).catch(() => {});
  }, []);
  // A failed write is put back and said, or the tick would vanish next visit.
  const [doneSaveFailed, setDoneSaveFailed] = useState(false);
  const markAutoStart = (done: boolean) => {
    setAutoOk(done);
    setDoneSaveFailed(false);
    AsyncStorage.setItem(DONE_KEY, done ? '1' : '0').catch(() => { setAutoOk(!done); setDoneSaveFailed(true); });
  };
  // Which "Open settings" button could not open its page, if any. Each opener
  // resolves false instead of throwing; without this a tap did nothing visible.
  const [openFailed, setOpenFailed] = useState<null | 'fsi' | 'battery' | 'autostart'>(null);
  const noteOpened = (which: 'fsi' | 'battery' | 'autostart', ok: boolean) => setOpenFailed(ok ? null : which);
  const openFailedTxt = 'Couldn’t open this setting. Open your phone’s Settings, then Apps, then crazzychat, and change it there.';

  // Android 14 turned USE_FULL_SCREEN_INTENT into a user-granted permission for
  // anything that is not the default dialer. Declaring it in the manifest is no
  // longer enough — measured on device as FSI_REQUESTED_BUT_DENIED on the ring
  // notification, which is why an incoming call showed a heads-up banner instead
  // of taking over the lock screen like a phone call.
  //
  // Re-checked on focus, not just on mount: granting it happens in Settings, so
  // the user comes BACK to this screen having changed it, and a mount-only check
  // would keep telling them to do something they had already done.
  //
  // The battery exemption is READ BACK the same way. This used to flip to "done"
  // the moment the system dialog returned, whether or not the user allowed it.
  // When it cannot be read (readBatteryExemption → null) the card says so and
  // still offers the settings, rather than claiming it is done.
  const [fsiOk, setFsiOk] = useState(true);
  const refresh = () => {
    canUseFullScreenIntent().then(setFsiOk).catch(() => {});
    if (Platform.OS === 'android') readBatteryExemption().then(setBattOk).catch(() => setBattOk(null));
  };
  useFocusEffect(useCallback(() => { refresh(); }, []));

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} hitSlop={8} style={S.hBtn}><Ionicons name="arrow-back" size={24} color={colors.text} /></TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Call reliability</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={S.intro}>
          {Platform.OS === 'android'
            ? 'To make sure calls ring even when crazzychat is closed, allow it to run in the background. This is required on most Android phones.'
            : 'iPhone rings for calls through the system, so there is nothing to set up here. Low data mode below still applies.'}
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
            <TouchableOpacity style={S.btn} onPress={() => { void openFullScreenIntentSettings().then(ok => noteOpened('fsi', ok)); }} accessibilityRole="button" accessibilityLabel="Open full-screen call setting">
              <Text style={S.btnTxt}>Open setting</Text>
            </TouchableOpacity>
            {openFailed === 'fsi' && <Text style={S.errTxt} accessibilityLiveRegion="polite">{openFailedTxt}</Text>}
          </View>
        )}

        {/* Step 1 — battery optimization. Android only: the request is a no-op
            on iOS (lib/batteryOptimization.ts). */}
        {Platform.OS === 'android' && (
        <View style={S.card}>
          <View style={S.cardHead}>
            <Ionicons
              name={battOk === true ? 'checkmark-circle' : battOk === null ? 'help-circle-outline' : 'battery-charging-outline'}
              size={22} color={battOk === true ? colors.online : colors.text}
            />
            <Text style={S.cardTitle}>1. Ignore battery optimization</Text>
          </View>
          <Text style={S.cardBody}>
            {battOk === true ? 'Done — crazzychat can receive a call while closed or with the screen off.'
              : battOk === null ? 'Couldn’t check this on your phone. Open battery settings and make sure crazzychat is not optimized (set to “Unrestricted” or “Don’t optimize”).'
              : 'Lets crazzychat receive a call while the app is closed or the screen is off.'}
          </Text>
          <TouchableOpacity
            style={S.btn}
            onPress={async () => { noteOpened('battery', await requestIgnoreBatteryOptimizations()); refresh(); }}
            accessibilityRole="button"
            accessibilityLabel={battOk === null ? 'Open battery settings' : 'Allow crazzychat to ignore battery optimization'}
          >
            <Text style={S.btnTxt}>{battOk === true ? 'Open again' : battOk === null ? 'Open battery settings' : 'Allow'}</Text>
          </TouchableOpacity>
          {openFailed === 'battery' && <Text style={S.errTxt} accessibilityLiveRegion="polite">{openFailedTxt}</Text>}
        </View>
        )}

        {Platform.OS === 'android' && oemFailed && (
          <Text style={S.cardBody}>Could not work out this phone&apos;s maker, so the auto-start steps are not shown. Look for &quot;Auto-start&quot; or &quot;Background activity&quot; in your phone&apos;s app settings.</Text>
        )}

        {/* Step 2 — OEM auto-start */}
        {Platform.OS === 'android' && oem && (
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
            <TouchableOpacity style={S.btn} onPress={async () => { noteOpened('autostart', await openAutoStartSettings()); }} accessibilityRole="button" accessibilityLabel="Open auto-start settings">
              <Text style={S.btnTxt}>Open settings</Text>
            </TouchableOpacity>
            {openFailed === 'autostart' && <Text style={S.errTxt} accessibilityLiveRegion="polite">{openFailedTxt}</Text>}
            <TouchableOpacity
              style={[S.btn, S.btnGhost]} onPress={() => markAutoStart(!autoOk)}
              accessibilityRole="checkbox" accessibilityState={{ checked: autoOk }}
              accessibilityLabel="I've turned on auto-start"
            >
              <Text style={[S.btnTxt, { color: colors.primary }]}>{autoOk ? 'Done ✓ (tap to undo)' : 'I’ve done this'}</Text>
            </TouchableOpacity>
            {doneSaveFailed && <Text style={S.errTxt} accessibilityLiveRegion="polite">Could not save this on your phone. Try again.</Text>}
          </View>
        )}

        {Platform.OS === 'android' && battOk === true && autoOk && (
          <View style={S.okBar}>
            <Ionicons name="shield-checkmark" size={18} color={colors.online} />
            <Text style={S.okTxt}>You’re set — calls should ring even when crazzychat is closed.</Text>
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
              accessibilityLabel="Low data mode"
              onValueChange={async (v) => {
                setLowData(v);
                try { await setLowDataMode(v); setLowDataFailed(false); }
                catch { setLowData(!v); setLowDataFailed(true); }
              }}
              trackColor={{ true: colors.primary }}
            />
          </View>
          {lowDataFailed && <Text style={S.errTxt} accessibilityLiveRegion="polite">Could not save this setting. Try again.</Text>}
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
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '700' },
  intro: { color: c.textDim, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  cardTitle: { color: c.text, fontSize: 16, fontWeight: '700', flex: 1 },
  cardBody: { color: c.textDim, fontSize: 13, lineHeight: 18, marginBottom: 10 },
  stepRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  stepNum: { color: c.primary, fontSize: 13, fontWeight: '800', width: 16 },
  stepTxt: { color: c.text, fontSize: 13, lineHeight: 18, flex: 1 },
  btn: { marginTop: 6, backgroundColor: c.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnGhost: { backgroundColor: 'transparent' },
  btnTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '800' }, // on the primary fill
  errTxt: { color: c.danger, fontSize: 13, lineHeight: 18, marginTop: 8 },
  okBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.online },
  okTxt: { color: c.text, fontSize: 13, flex: 1 },
});
