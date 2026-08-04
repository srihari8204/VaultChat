// app/lock-settings.tsx — Alarm & Alert Settings for Location Lock. Every
// channel independently togglable (spec: lock-alarm), volume, tone, vibration
// pattern, grace time, repeat-until-return, and Test Alarm. Edits persist via
// lockSettings and apply live to an armed lock (applyAlertSettings).

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Switch, Platform } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import {
  useLockSettings, setLockAlerts, type LockAlertSettings,
} from '../lib/lock/lockSettings';
import { applyAlertSettings, testAlarm } from '../lib/lock/lockService';

const VOLUMES = [0.2, 0.4, 0.6, 0.8, 1];
const GRACES = [0, 5, 10, 30, 60];
const REPEAT_GAPS = [5, 10, 30, 60];

export default function LockSettingsScreen() {
  const { colors } = useTheme();
  const s = useLockSettings();
  const a = s.alerts;

  const set = (patch: Partial<LockAlertSettings>) => {
    setLockAlerts(patch).then(() => applyAlertSettings()).catch(() => {});
  };

  const Row = ({ icon, label, keyName }: { icon: any; label: string; keyName: keyof LockAlertSettings }) => (
    <View style={[st.row, { borderColor: colors.border }]}>
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
      <Stack.Screen options={{ title: 'Alarm & Alert Settings', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={st.body}>
        <Text style={[st.h, { color: colors.text }]}>Channels</Text>
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

        <View style={[st.row, { borderColor: colors.border, marginTop: 24 }]}>
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

        <TouchableOpacity onPress={() => testAlarm()} style={[st.testBtn, { backgroundColor: colors.primary }]}>
          <Ionicons name="play" size={17} color="#fff" />
          <Text style={st.testTxt}>Test Alarm</Text>
        </TouchableOpacity>
        <Text style={{ color: colors.text + '77', fontSize: 12, textAlign: 'center', marginTop: 8 }}>
          Plays the enabled channels for a few seconds. Nothing is written to history.
        </Text>
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
});
