// app/lock-settings.tsx — the Location Lock settings hub (v2): General (units,
// monitoring mode + custom sensitivity), Sound & Vibration (every alert channel
// independently togglable, volume, tone, pattern, grace, repeat, Test Alarm),
// Battery (kill-safe background toggle + optimization exemption), and About.
// Edits persist via lockSettings and apply live to an armed lock.

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Switch, Platform, Alert, Vibration } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import notifee from '@notifee/react-native';
import * as Speech from 'expo-speech';
import { useTheme } from '../lib/theme';
import { VIBE_PATTERN } from '../lib/lock/alarmChannels';
import { VOICE } from '../lib/lock/alarmController';
import {
  useLockSettings, setLockAlerts, setLockSettings, type LockAlertSettings,
} from '../lib/lock/lockSettings';
import { type LockMode } from '../lib/lock/zoneMachine';
import {
  applyAlertSettings, testAlarm, useLockView, enableKillSafe, disableKillSafe,
} from '../lib/lock/lockService';

const VOLUMES = [0.2, 0.4, 0.6, 0.8, 1];
const GRACES = [0, 5, 10, 30, 60];
const REPEAT_GAPS = [5, 10, 30, 60];
const MODES: { key: LockMode; label: string }[] = [
  { key: 'walking', label: 'Walking' }, { key: 'cycling', label: 'Cycling' },
  { key: 'driving', label: 'Driving' }, { key: 'custom', label: 'Custom' },
];
const BANDS = [3, 5, 10, 15, 25];
const HYSTS = [2, 3, 5, 10];

export default function LockSettingsScreen() {
  const { colors } = useTheme();
  const s = useLockSettings();
  const lock = useLockView();
  const a = s.alerts;

  const set = (patch: Partial<LockAlertSettings>) => {
    setLockAlerts(patch).then(() => applyAlertSettings()).catch(() => {});
  };
  const setGeneral = (patch: Parameters<typeof setLockSettings>[0]) => {
    setLockSettings(patch).then(() => applyAlertSettings()).catch(() => {});
  };

  const Row = ({ icon, label, keyName }: { icon: any; label: string; keyName: keyof LockAlertSettings }) => (
    <View style={[st.row, { borderColor: colors.glassStroke }]}>
      <Ionicons name={icon} size={19} color={colors.primary} />
      <Text style={[st.rowTxt, { color: colors.text }]}>{label}</Text>
      <Switch
        value={!!a[keyName]}
        onValueChange={(v) => set({ [keyName]: v } as any)}
        trackColor={{ true: colors.primary + '88', false: colors.border }}
        thumbColor={a[keyName] ? colors.primary : '#999'}
      />
    </View>
  );

  const Chip = ({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) => (
    <TouchableOpacity onPress={onPress}
      style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary + '1a' : 'transparent' }]}>
      <Text style={{ color: on ? colors.primary : colors.text, fontWeight: on ? '700' : '500', fontSize: 13 }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[st.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Alarm & Alert Settings', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={st.body}>
        {/* ── General ── */}
        <Text style={[st.h, { color: colors.text }]}>General · Units</Text>
        <View style={st.chips}>
          <Chip on={s.units === 'metric'} label="Metric (m, km)" onPress={() => setGeneral({ units: 'metric' })} />
          <Chip on={s.units === 'imperial'} label="Imperial (ft, mi)" onPress={() => setGeneral({ units: 'imperial' })} />
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 20 }]}>General · Monitoring mode</Text>
        <View style={st.chips}>
          {MODES.map((m) => <Chip key={m.key} on={s.mode === m.key} label={m.label} onPress={() => setGeneral({ mode: m.key })} />)}
        </View>
        {s.mode === 'custom' && (
          <View style={{ marginTop: 10 }}>
            <Text style={{ color: colors.text + '88', fontSize: 12.5, marginBottom: 6 }}>Warning band (m inside the boundary)</Text>
            <View style={st.chips}>
              {BANDS.map((b) => <Chip key={b} on={s.customSensitivity.warningBand === b} label={`${b} m`}
                onPress={() => setGeneral({ customSensitivity: { ...s.customSensitivity, warningBand: b } })} />)}
            </View>
            <Text style={{ color: colors.text + '88', fontSize: 12.5, marginVertical: 6 }}>Hysteresis (m past the boundary before alarm)</Text>
            <View style={st.chips}>
              {HYSTS.map((h) => <Chip key={h} on={s.customSensitivity.hysteresis === h} label={`${h} m`}
                onPress={() => setGeneral({ customSensitivity: { ...s.customSensitivity, hysteresis: h } })} />)}
            </View>
          </View>
        )}
        <Text style={{ color: colors.text + '77', fontSize: 12, marginTop: 6 }}>
          Faster modes use a wider envelope so highway-speed GPS scatter can’t false-alarm.
        </Text>

        {/* ── Battery ── */}
        <View style={[st.row, { borderColor: colors.glassStroke, marginTop: 24 }]}>
          <Ionicons name="shield-half" size={19} color={colors.primary} />
          <Text style={[st.rowTxt, { color: colors.text }]}>
            Background tracking{lock.active ? '' : ' (arms with the next lock)'}
          </Text>
          <Switch
            value={lock.active ? lock.killSafe : true}
            disabled={!lock.active}
            onValueChange={(v) => { (v ? enableKillSafe() : disableKillSafe()).catch(() => {}); }}
            trackColor={{ true: colors.primary + '88', false: colors.border }}
            thumbColor={lock.killSafe ? colors.primary : '#999'}
          />
        </View>
        {Platform.OS === 'android' && (
          <TouchableOpacity
            onPress={async () => {
              try {
                if (await notifee.isBatteryOptimizationEnabled()) await notifee.openBatteryOptimizationSettings();
                else Alert.alert('All good', 'VaultChat is already exempt from battery optimization.');
              } catch {}
            }}
            style={[st.row, { borderColor: colors.glassStroke }]}>
            <Ionicons name="battery-charging" size={19} color={colors.primary} />
            <Text style={[st.rowTxt, { color: colors.text }]}>Battery optimization exemption</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.text + '66'} />
          </TouchableOpacity>
        )}
        <Text style={[st.h, { color: colors.text, marginTop: 20 }]}>Tracking frequency</Text>
        <View style={st.chips}>
          <Chip on={s.cadence === 'auto'} label="Adaptive (recommended)" onPress={() => setGeneral({ cadence: 'auto' })} />
          <Chip on={s.cadence === 'saver'} label="Battery saver" onPress={() => setGeneral({ cadence: 'saver' })} />
          <Chip on={s.cadence === 'high'} label="High precision" onPress={() => setGeneral({ cadence: 'high' })} />
        </View>
        <Text style={{ color: colors.text + '77', fontSize: 12, marginTop: 6 }}>
          Adaptive speeds up GPS only near the boundary or while moving; saver stays slow while safe; high precision always runs at navigation cadence.
        </Text>

        {/* ── Sound & Vibration ── */}
        <Text style={[st.h, { color: colors.text, marginTop: 24 }]}>Channels</Text>
        <Row icon="volume-high" label="Loud siren" keyName="siren" />
        <Row icon="pulse" label="Continuous beep" keyName="continuousBeep" />
        <Row icon="phone-portrait" label="Vibration" keyName="vibration" />
        <Row icon="chatbubble-ellipses" label='Voice warning ("You are leaving the locked area")' keyName="voice" />
        <Row icon="flashlight" label="Flash screen + full-screen alert" keyName="flash" />

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]}>Alarm volume</Text>
        <View style={st.chips}>
          {VOLUMES.map((v) => <Chip key={v} on={Math.abs(a.volume - v) < 0.01} label={`${Math.round(v * 100)}%`} onPress={() => set({ volume: v })} />)}
        </View>
        {Platform.OS === 'ios' && (
          <Text style={{ color: colors.text + '77', fontSize: 12, marginTop: 8 }}>
            iOS: the alarm plays at app volume even in silent mode, but cannot exceed the system media volume.
          </Text>
        )}

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]}>Tone</Text>
        <View style={st.chips}>
          <Chip on={a.tone === 'siren'} label="Siren" onPress={() => set({ tone: 'siren' })} />
          <Chip on={a.tone === 'beep'} label="Beep" onPress={() => set({ tone: 'beep' })} />
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]}>Vibration pattern</Text>
        <View style={st.chips}>
          <Chip on={a.vibePattern === 'strong'} label="Strong" onPress={() => set({ vibePattern: 'strong' })} />
          <Chip on={a.vibePattern === 'medium'} label="Medium" onPress={() => set({ vibePattern: 'medium' })} />
          <Chip on={a.vibePattern === 'pulse'} label="Pulse" onPress={() => set({ vibePattern: 'pulse' })} />
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]}>Start alarm after</Text>
        <View style={st.chips}>
          {GRACES.map((g) => <Chip key={g} on={a.graceS === g} label={g === 0 ? 'Instantly' : `${g} s`} onPress={() => set({ graceS: g })} />)}
        </View>
        <Text style={{ color: colors.text + '77', fontSize: 12, marginTop: 6 }}>
          Returning inside the radius within this window cancels the alarm silently.
        </Text>

        <View style={[st.row, { borderColor: colors.glassStroke, marginTop: 24 }]}>
          <Ionicons name="repeat" size={19} color={colors.primary} />
          <Text style={[st.rowTxt, { color: colors.text }]}>Repeat alarm until back inside</Text>
          <Switch
            value={a.repeat}
            onValueChange={(v) => set({ repeat: v })}
            trackColor={{ true: colors.primary + '88', false: colors.border }}
            thumbColor={a.repeat ? colors.primary : '#999'}
          />
        </View>
        {a.repeat && (
          <View style={[st.chips, { marginTop: 10 }]}>
            {REPEAT_GAPS.map((g) => <Chip key={g} on={a.repeatIntervalS === g} label={`every ${g} s`} onPress={() => set({ repeatIntervalS: g })} />)}
          </View>
        )}

        <TouchableOpacity onPress={() => testAlarm()} accessibilityRole="button" accessibilityLabel="Test the full alarm"
          style={[st.testBtn, { backgroundColor: colors.primary }]}>
          <Ionicons name="play" size={17} color="#fff" />
          <Text style={st.testTxt}>Test Alarm</Text>
        </TouchableOpacity>
        <View style={[st.chips, { marginTop: 8, justifyContent: 'center' }]}>
          <Chip on={false} label="🗣 Test voice" onPress={() => { try { Speech.stop(); Speech.speak(VOICE.outside, { rate: 1.0 }); } catch {} }} />
          <Chip on={false} label="〰 Test vibration" onPress={() => { try { Vibration.vibrate(VIBE_PATTERN[a.vibePattern], false); } catch {} }} />
        </View>
        <Text style={{ color: colors.text + '77', fontSize: 12, textAlign: 'center', marginTop: 8 }}>
          Plays the enabled channels for a few seconds. Nothing is written to history.
        </Text>

        {/* ── About ── */}
        <Text style={[st.h, { color: colors.text, marginTop: 28 }]}>About Location Lock</Text>
        <View style={[st.about, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
          <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '700' }}>Location Lock · Navigate mini-app</Text>
          <Text style={{ color: colors.text + '88', fontSize: 12.5, marginTop: 6, lineHeight: 18 }}>
            Geofencing runs entirely on this device. Your coordinates and history never
            leave it — the only network call is to VaultChat’s own routing engine when
            you navigate back.
          </Text>
          <Text style={{ color: colors.text + '66', fontSize: 11.5, marginTop: 8, lineHeight: 16 }}>
            Open-source components: OpenStreetMap data (ODbL) · MapLibre GL (BSD-3) ·
            Leaflet (BSD-2) · Valhalla routing (MIT) · OpenFreeMap vector basemap
            tiles (OpenMapTiles schema). Alarm sounds are generated, license-free.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1 },
  body: { padding: 16, paddingBottom: 48 },
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
  rowTxt: { flex: 1, fontSize: 14.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  testBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 12, marginTop: 30 },
  testTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  about: { borderWidth: 1, borderRadius: 12, padding: 14 },
});
