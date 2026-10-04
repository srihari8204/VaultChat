// app/lock-settings.tsx — the Location Lock settings hub (v2): General (units,
// monitoring mode + custom sensitivity), Sound & Vibration (every alert channel
// independently togglable, volume, tone, pattern, grace, repeat, Test Alarm),
// Battery (kill-safe background toggle + optimization exemption), and About.
// Edits persist via lockSettings and apply live to an armed lock.

import React from 'react';
import { View, TouchableOpacity, ScrollView, StyleSheet, Switch, Platform, Alert, Vibration } from 'react-native';
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
  applyAlertSettings, testAlarm, useLockView, enableKillSafe, disableKillSafe, KILL_SAFE_REFUSED,
} from '../lib/lock/lockService';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { currentVersionName } from '../lib/appVersion';
import type { Palette } from '../constants/theme';

const VOLUMES = [0.2, 0.4, 0.6, 0.8, 1];
const GRACES = [0, 5, 10, 30, 60];
const REPEAT_GAPS = [5, 10, 30, 60];
const MODES: { key: LockMode; label: string }[] = [
  { key: 'walking', label: 'Walking' }, { key: 'cycling', label: 'Cycling' },
  { key: 'driving', label: 'Driving' }, { key: 'custom', label: 'Custom' },
];
const BANDS = [3, 5, 10, 15, 25];
const HYSTS = [2, 3, 5, 10];

/** The on/off channels: the only LockAlertSettings keys a Switch row may own. */
type ChannelKey = { [K in keyof LockAlertSettings]: LockAlertSettings[K] extends boolean ? K : never }[keyof LockAlertSettings];

/** Persist, then hand the change to an armed lock, and SAY when either fails.
 *  Both used to end in .catch(() => {}): an alarm setting that silently did
 *  not stick, or did not reach the running lock, is a safety gap. */
/** One alert, even when both steps fail (it used to show two back to back). */
async function save(write: Promise<void>): Promise<void> {
  const saved = await write.then(() => true, () => false);
  const applied = await applyAlertSettings().then(() => true, () => false);
  if (!saved && !applied) {
    Alert.alert('Setting not saved or applied', 'This change could not be saved (it will reset when the app restarts), and the running lock could not pick it up. Try again, or unlock and lock again.');
  } else if (!saved) {
    Alert.alert('Setting not saved', 'This change applies now, but it could not be saved and will reset when the app restarts. Try again.');
  } else if (!applied) {
    Alert.alert('Not applied to the active lock', 'The running lock could not pick up this change. Unlock and lock again to apply it.');
  }
}

/** A failed test of an alarm channel must say so: silence here reads as "works". */
const testFailed = (channel: string) =>
  Alert.alert(`${channel} test failed`, `This device could not play the ${channel.toLowerCase()} test, so that alarm channel may not work. Check the system sound and vibration settings.`);

// Hoisted out of the screen: defined inside it, each was a new component type
// on every render, so React remounted every row and chip on each change.
function Row({ icon, label, keyName, on, onChange, colors }: {
  icon: keyof typeof Ionicons.glyphMap; label: string; keyName: ChannelKey;
  on: boolean; onChange: (patch: Partial<LockAlertSettings>) => void; colors: Palette;
}) {
  return (
    <View style={[st.row, { borderColor: colors.glassStroke }]}>
      <Ionicons name={icon} size={19} color={colors.primary} />
      <Text style={[st.rowTxt, { color: colors.text }]}>{label}</Text>
      <Switch
        value={on}
        accessibilityLabel={label}
        onValueChange={(v) => { const patch: Partial<LockAlertSettings> = {}; patch[keyName] = v; onChange(patch); }}
        trackColor={{ true: colors.primary + '88', false: colors.border }}
        // Off: the platform's own thumb, which is visible on both themes.
        thumbColor={on ? colors.primary : undefined}
      />
    </View>
  );
}

/** A radio (inside a radiogroup) when `on` is given; a plain action (no
 *  checked state) when it is not — "Test voice" is a button, not an option. */
function Chip({ on, label, onPress, colors }: {
  on?: boolean; label: string; onPress: () => void; colors: Palette;
}) {
  const lit = !!on;
  return (
    <TouchableOpacity onPress={onPress}
      accessibilityRole={on === undefined ? 'button' : 'radio'}
      accessibilityState={on === undefined ? undefined : { checked: on }}
      style={[st.chip, { borderColor: lit ? colors.primary : colors.glassStroke, backgroundColor: lit ? colors.glass : colors.glassSoft }]}>
      <Text style={{ color: lit ? colors.primary : colors.text, fontWeight: lit ? '700' : '500', fontSize: 13 }}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function LockSettingsScreen() {
  const { colors } = useTheme();
  const s = useLockSettings();
  const lock = useLockView();
  const a = s.alerts;

  const set = (patch: Partial<LockAlertSettings>) => { void save(setLockAlerts(patch)); };
  const setGeneral = (patch: Parameters<typeof setLockSettings>[0]) => { void save(setLockSettings(patch)); };
  const [killBusy, setKillBusy] = React.useState(false);

  const toggleKillSafe = async (v: boolean) => {
    if (killBusy) return;
    setKillBusy(true);
    try {
      if (v) {
        // false = the "Allow all the time" grant was refused or the background
        // service would not start; the switch stays off, and now says why.
        if (!await enableKillSafe()) Alert.alert(KILL_SAFE_REFUSED.title, KILL_SAFE_REFUSED.body);
      } else {
        await disableKillSafe();
      }
    } catch (e: unknown) {
      Alert.alert('Background tracking', (e instanceof Error && e.message) || 'Could not change background tracking. Try again.');
    } finally { setKillBusy(false); }
  };

  const openBattery = async () => {
    try {
      if (await notifee.isBatteryOptimizationEnabled()) await notifee.openBatteryOptimizationSettings();
      else Alert.alert('All good', 'crazzychat is already exempt from battery optimization.');
    } catch {
      Alert.alert('Battery settings', 'Could not open battery optimization settings. Open the system Settings app and exempt crazzychat there.');
    }
  };

  return (
    <View style={st.screen}>
      <AuroraBackground />
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Alarm & Alert Settings', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={st.body}>
        {/* ── General ── */}
        <Text style={[st.h, { color: colors.text }]} accessibilityRole="header">General · Units</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Units">
          <Chip on={s.units === 'metric'} label="Metric (m, km)" colors={colors} onPress={() => setGeneral({ units: 'metric' })} />
          <Chip on={s.units === 'imperial'} label="Imperial (ft, mi)" colors={colors} onPress={() => setGeneral({ units: 'imperial' })} />
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 20 }]} accessibilityRole="header">General · Monitoring mode</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Monitoring mode">
          {MODES.map((m) => <Chip key={m.key} on={s.mode === m.key} label={m.label} colors={colors} onPress={() => setGeneral({ mode: m.key })} />)}
        </View>
        {s.mode === 'custom' && (
          <View style={{ marginTop: 10 }}>
            <Text style={{ color: colors.textDim, fontSize: 12.5, marginBottom: 6 }}>Warning band (m inside the boundary)</Text>
            <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Warning band">
              {BANDS.map((b) => <Chip key={b} on={s.customSensitivity.warningBand === b} label={`${b} m`}
                colors={colors} onPress={() => setGeneral({ customSensitivity: { ...s.customSensitivity, warningBand: b } })} />)}
            </View>
            <Text style={{ color: colors.textDim, fontSize: 12.5, marginVertical: 6 }}>Hysteresis (m past the boundary before alarm)</Text>
            <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Hysteresis">
              {HYSTS.map((h) => <Chip key={h} on={s.customSensitivity.hysteresis === h} label={`${h} m`}
                colors={colors} onPress={() => setGeneral({ customSensitivity: { ...s.customSensitivity, hysteresis: h } })} />)}
            </View>
          </View>
        )}
        <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 6 }}>
          Faster modes use a wider envelope so highway-speed GPS scatter can’t false-alarm.
        </Text>

        {/* ── Battery ── */}
        <View style={[st.row, { borderColor: colors.glassStroke, marginTop: 24 }]}>
          <Ionicons name="shield-half" size={19} color={colors.primary} />
          <Text style={[st.rowTxt, { color: colors.text }]}>
            Background tracking{lock.active ? '' : ' (asked for when you lock)'}
          </Text>
          <Switch
            // Off until a lock is armed: arming can end without background
            // protection (killSafe false), so a pre-checked "on" was a promise.
            value={lock.active ? lock.killSafe : false}
            accessibilityLabel="Background tracking"
            accessibilityHint={lock.active ? undefined : 'Available while a lock is active'}
            accessibilityState={{ busy: killBusy, disabled: !lock.active || killBusy }}
            disabled={!lock.active || killBusy}
            onValueChange={toggleKillSafe}
            trackColor={{ true: colors.primary + '88', false: colors.border }}
            thumbColor={lock.active && lock.killSafe ? colors.primary : undefined}
          />
        </View>
        {Platform.OS === 'android' && (
          <TouchableOpacity
            onPress={openBattery}
            accessibilityRole="button" accessibilityLabel="Battery optimization exemption"
            accessibilityHint="Opens the system setting that keeps the lock running in the background"
            style={[st.row, { borderColor: colors.glassStroke }]}>
            <Ionicons name="battery-charging" size={19} color={colors.primary} />
            <Text style={[st.rowTxt, { color: colors.text }]}>Battery optimization exemption</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
          </TouchableOpacity>
        )}
        <Text style={[st.h, { color: colors.text, marginTop: 20 }]} accessibilityRole="header">Tracking frequency</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Tracking frequency">
          <Chip on={s.cadence === 'auto'} label="Adaptive (recommended)" colors={colors} onPress={() => setGeneral({ cadence: 'auto' })} />
          <Chip on={s.cadence === 'saver'} label="Battery saver" colors={colors} onPress={() => setGeneral({ cadence: 'saver' })} />
          <Chip on={s.cadence === 'high'} label="High precision" colors={colors} onPress={() => setGeneral({ cadence: 'high' })} />
        </View>
        <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 6 }}>
          Adaptive speeds up GPS only near the boundary or while moving; saver stays slow while safe; high precision always runs at navigation cadence.
        </Text>

        {/* ── Sound & Vibration ── */}
        <Text style={[st.h, { color: colors.text, marginTop: 24 }]} accessibilityRole="header">Channels</Text>
        <Row icon="volume-high" label="Loud siren" keyName="siren" on={a.siren} onChange={set} colors={colors} />
        <Row icon="pulse" label="Continuous beep" keyName="continuousBeep" on={a.continuousBeep} onChange={set} colors={colors} />
        <Row icon="phone-portrait" label="Vibration" keyName="vibration" on={a.vibration} onChange={set} colors={colors} />
        <Row icon="chatbubble-ellipses" label='Voice warning ("You are leaving the locked area")' keyName="voice" on={a.voice} onChange={set} colors={colors} />
        <Row icon="flashlight" label="Flash screen + full-screen alert" keyName="flash" on={a.flash} onChange={set} colors={colors} />

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]} accessibilityRole="header">Alarm volume</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Alarm volume">
          {VOLUMES.map((v) => <Chip key={v} on={Math.abs(a.volume - v) < 0.01} label={`${Math.round(v * 100)}%`} colors={colors} onPress={() => set({ volume: v })} />)}
        </View>
        {Platform.OS === 'ios' && (
          <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 8 }}>
            iOS: the alarm plays at app volume even in silent mode, but cannot exceed the system media volume.
          </Text>
        )}

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]} accessibilityRole="header">Tone</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Tone">
          <Chip on={a.tone === 'siren'} label="Siren" colors={colors} onPress={() => set({ tone: 'siren' })} />
          <Chip on={a.tone === 'beep'} label="Beep" colors={colors} onPress={() => set({ tone: 'beep' })} />
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]} accessibilityRole="header">Vibration pattern</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Vibration pattern">
          <Chip on={a.vibePattern === 'strong'} label="Strong" colors={colors} onPress={() => set({ vibePattern: 'strong' })} />
          <Chip on={a.vibePattern === 'medium'} label="Medium" colors={colors} onPress={() => set({ vibePattern: 'medium' })} />
          <Chip on={a.vibePattern === 'pulse'} label="Pulse" colors={colors} onPress={() => set({ vibePattern: 'pulse' })} />
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 24 }]} accessibilityRole="header">Start alarm after</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Start alarm after">
          {GRACES.map((g) => <Chip key={g} on={a.graceS === g} label={g === 0 ? 'Instantly' : `${g} s`} colors={colors} onPress={() => set({ graceS: g })} />)}
        </View>
        <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 6 }}>
          Returning inside the radius within this window cancels the alarm silently.
        </Text>

        <View style={[st.row, { borderColor: colors.glassStroke, marginTop: 24 }]}>
          <Ionicons name="repeat" size={19} color={colors.primary} />
          <Text style={[st.rowTxt, { color: colors.text }]}>Repeat alarm until back inside</Text>
          <Switch
            value={a.repeat}
            accessibilityLabel="Repeat alarm until back inside"
            onValueChange={(v) => set({ repeat: v })}
            trackColor={{ true: colors.primary + '88', false: colors.border }}
            thumbColor={a.repeat ? colors.primary : undefined}
          />
        </View>
        {a.repeat && (
          <View style={[st.chips, { marginTop: 10 }]} accessibilityRole="radiogroup" accessibilityLabel="Repeat interval">
            {REPEAT_GAPS.map((g) => <Chip key={g} on={a.repeatIntervalS === g} label={`every ${g} s`} colors={colors} onPress={() => set({ repeatIntervalS: g })} />)}
          </View>
        )}

        <TouchableOpacity onPress={() => testAlarm()} accessibilityRole="button" accessibilityLabel="Test the full alarm"
          style={[st.testBtn, { backgroundColor: colors.primary }]}>
          <Ionicons name="play" size={17} color={colors.onPrimary} />
          <Text style={[st.testTxt, { color: colors.onPrimary }]}>Test Alarm</Text>
        </TouchableOpacity>
        <View style={[st.chips, { marginTop: 8, justifyContent: 'center' }]}>
          <Chip label="Test voice" colors={colors} onPress={() => {
            try { Speech.stop(); Speech.speak(VOICE.outside, { rate: 1.0, onError: () => testFailed('Voice') }); } catch { testFailed('Voice'); }
          }} />
          <Chip label="Test vibration" colors={colors} onPress={() => {
            try { Vibration.vibrate(VIBE_PATTERN[a.vibePattern], false); } catch { testFailed('Vibration'); }
          }} />
        </View>
        <Text style={{ color: colors.textDim, fontSize: 12, textAlign: 'center', marginTop: 8 }}>
          Plays the enabled channels for a few seconds. Nothing is written to history.
        </Text>

        {/* ── About ── */}
        <Text style={[st.h, { color: colors.text, marginTop: 28 }]} accessibilityRole="header">About Location Lock</Text>
        <View style={[st.about, { borderColor: colors.glassStroke, backgroundColor: colors.glass }]}>
          <Text style={{ color: colors.text, fontSize: 13.5, fontWeight: '700' }}>
            Location Lock · Navigate mini-app{currentVersionName() ? ` · v${currentVersionName()}` : ''}
          </Text>
          <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 6, lineHeight: 18 }}>
            Geofencing runs entirely on this device, and your lock history never leaves
            it. Network use is limited to: crazzychat’s own routing engine when you
            navigate back; crazzychat’s own search proxy when you search for a place;
            and map tiles from tiles.openfreemap.org, which sees the area of the map
            you are viewing (not your exact position).
          </Text>
          <Text style={{ color: colors.textFaint, fontSize: 11.5, marginTop: 8, lineHeight: 16 }}>
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
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 16, paddingBottom: 48 },
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
  rowTxt: { flex: 1, fontSize: 14.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  // 2026-09-18: minHeight, not height — 'Test Alarm' at font scale 1.5 overran a
  // pinned 48 and the label lost its bottom. 48 is the tap floor, and 19 of line
  // box + 2×14 padding leaves it looking exactly as it did at scale 1.0.
  testBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48, paddingVertical: 14, borderRadius: 12, marginTop: 30 },
  testTxt: { fontSize: 15, fontWeight: '800' },
  about: { borderWidth: 1, borderRadius: 12, padding: 14 },
});
