// app/lock-alert.tsx — the full-screen exit alarm. Launched by the alarm
// notification's full-screen intent (killed/backgrounded path) or pushed by
// the lock service the moment the alarm fires in-app. Flashing red screen
// (the "flash" alert channel), live distance outside the radius, Stop Alarm,
// and one-tap navigate-back. Auto-resolves to a green "safe" state on return.

import React, { useEffect, useRef, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Alert, ActivityIndicator, AccessibilityInfo, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Costing } from '../lib/nav/routing';
import { useLockSettings } from '../lib/lock/lockSettings';
import { fmtDistance } from '../lib/lock/format';
import {
  useLockView, stopLockAlarm, navigateBackToLock, restoreLock,
} from '../lib/lock/lockService';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';
import { ALARM } from '../lib/lock/alarmPalette';
import { useReducedMotionSetting } from '../lib/useReducedMotion';

export default function LockAlertScreen() {
  const c = useColors();
  const st = useMemo(() => makeSt(c), [c]);
  const router = useRouter();
  const lock = useLockView();
  const settings = useLockSettings();
  const flash = useRef(new Animated.Value(0)).current;
  // Null until the Reduce Motion setting is read: on this full-screen red flash
  // the strobe waits for the answer instead of running one cycle first.
  const reduceMotion = useReducedMotionSetting();
  /** The mode whose route back is being planned. */
  const [planning, setPlanning] = useState<Costing | null>(null);

  // A full-screen-intent launch from a killed app lands here before anything
  // else ran — make sure the lock session is restored.
  // A failure is surfaced: silence left this alarm screen saying "No active
  // lock" when it simply could not read the lock.
  useEffect(() => {
    restoreLock().catch((e: unknown) => {
      Alert.alert('Location Lock', `Couldn’t read the active lock: ${(e instanceof Error && e.message) || 'unknown error'}. Open Location Lock to check it.`);
    });
  }, []);

  // The flash channel: pulse the background while alarming (if enabled). A
  // full-screen red strobe is a photosensitivity risk, so Reduce Motion holds
  // the screen on the steady dark red instead; siren, vibration and voice are
  // untouched.
  const alarming = lock.alarmPhase === 'alarming' || lock.alarmPhase === 'grace';
  useEffect(() => {
    if (!alarming || !settings.alerts.flash || reduceMotion !== false) { flash.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(flash, { toValue: 1, duration: 350, useNativeDriver: false }),
      Animated.timing(flash, { toValue: 0, duration: 350, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [alarming, settings.alerts.flash, reduceMotion, flash]);

  const back = lock.state !== 'outside';
  const alarmFace = lock.active && !back;

  const phaseLine = lock.alarmPhase === 'alarming'
    ? 'Alarm sounding — head back now'
    : lock.alarmPhase === 'grace'
      ? 'Alarm starts in moments — head back now'
      : lock.alarmPhase === 'silenced'
        ? 'Alarm silenced — you are still outside the locked area'
        : 'You are outside the locked area — head back now';

  // A spoken announcement when the alarm face first shows (on Android it
  // front-runs the assertive phase line below). iOS has no live regions, so
  // each later phase change (grace → alarming → silenced) is announced too.
  const announcedLine = useRef<string | null>(null);
  useEffect(() => {
    if (!alarmFace) return;
    if (announcedLine.current === null) {
      AccessibilityInfo.announceForAccessibility('Location Lock alarm. You have left the locked area. Head back now.');
    } else if (Platform.OS === 'ios' && announcedLine.current !== phaseLine) {
      AccessibilityInfo.announceForAccessibility(phaseLine);
    }
    announcedLine.current = phaseLine;
  }, [alarmFace, phaseLine]);
  const over = Math.max(0, lock.distance - lock.radius);
  const bg = flash.interpolate({ inputRange: [0, 1], outputRange: [ALARM.flashLow, ALARM.flashHigh] });

  const navBack = async (costing: Costing) => {
    // Surfaced, not swallowed, and Navigate opens only once the route exists:
    // replacing first left the user on an empty Navigate screen, with this
    // alarm screen already gone, whenever planning failed.
    if (planning) return;
    setPlanning(costing);
    try {
      await navigateBackToLock(costing);
      router.replace('/navigate');
    } catch (e: unknown) {
      Alert.alert('Navigate back', (e instanceof Error && e.message) || 'Could not plan a route back to the locked spot.');
    } finally { setPlanning(null); }
  };

  // Safe again (or lock gone) → green confirmation instead of red panic.
  if (!alarmFace) {
    return (
      // Theme ground + green wash: the old white/pink text on a translucent
      // wash was unreadable in light mode.
      <View style={[st.screen, { backgroundColor: c.bg }]}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: ALARM.safeWash }]} />
        <Stack.Screen options={{ headerShown: false }} />
        <Ionicons name="checkmark-circle" size={92} color={c.success} accessibilityElementsHidden importantForAccessibility="no" />
        <Text style={st.bigSafe} accessibilityRole="header">You are safe</Text>
        <Text style={st.safeSub}>
          {lock.active ? 'Back inside the locked area.' : 'No active lock.'}
        </Text>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/location-lock'))}
          accessibilityRole="button"
          style={[st.btn, { backgroundColor: ALARM.safeButton, marginTop: 34 }]}>
          <Text style={st.btnTxt}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <Animated.View style={[st.screen, { backgroundColor: bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Ionicons name="warning" size={92} color={ALARM.ink} accessibilityElementsHidden importantForAccessibility="no" />
      <Text style={st.big} accessibilityRole="header">ALERT!</Text>
      <Text style={st.msg}>You have left the locked area</Text>

      <View style={st.distBox}>
        <Text style={st.distLabel}>DISTANCE OUTSIDE</Text>
        <Text style={st.dist}>{fmtDistance(over, settings.units)}</Text>
        <Text style={st.distSub}>
          {fmtDistance(lock.distance, settings.units)} from center · radius {fmtDistance(lock.radius, settings.units)} · GPS ±{fmtDistance(lock.accuracy, settings.units)}
        </Text>
      </View>

      {/* One line per phase: after Stop Alarm the phase is 'silenced', and
          "Alarm starts in moments" was then simply false. Always mounted, so
          the assertive live region announces each phase CHANGE (a static
          "ALERT!" heading carried it before and never changed). */}
      <Text style={[st.sub, { marginTop: 0, marginBottom: 10 }]} accessibilityLiveRegion="assertive">
        {phaseLine}
      </Text>
      {lock.alarmPhase === 'alarming' && (
        // Solid white, not c.glassSoft: on the dark theme that glass is 7%
        // white, which left red text on a red ground.
        <TouchableOpacity onPress={() => stopLockAlarm()} accessibilityRole="button" style={[st.btn, { backgroundColor: ALARM.ink }]}>
          <Ionicons name="volume-mute" size={18} color={ALARM.sounding} />
          <Text style={[st.btnTxt, { color: ALARM.sounding }]}>Stop Alarm</Text>
        </TouchableOpacity>
      )}

      <Text style={[st.distLabel, { marginTop: 26 }]}>NAVIGATE BACK</Text>
      <View style={st.navRow}>
        <NavBtn icon="walk" label="Walk" planning={planning} mode="pedestrian" onPress={navBack} />
        <NavBtn icon="bicycle" label="Cycle" planning={planning} mode="bicycle" onPress={navBack} />
        <NavBtn icon="car" label="Drive" planning={planning} mode="auto" onPress={navBack} />
      </View>

      <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/location-lock'))} accessibilityRole="button" hitSlop={12} style={{ marginTop: 26 }}>
        <Text style={{ color: ALARM.ink, fontSize: 13.5, fontWeight: '600' }}>Back to lock screen</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function NavBtn({ icon, label, mode, planning, onPress }: {
  icon: keyof typeof Ionicons.glyphMap; label: string; mode: Costing;
  planning: Costing | null; onPress: (mode: Costing) => void;
}) {
  const c = useColors();
  const st = useMemo(() => makeSt(c), [c]);
  const busy = planning === mode;
  // One route back at a time: the siblings are disabled (and say so) while
  // any mode is planning, instead of silently ignoring the tap.
  const disabled = planning !== null;
  return (
    <TouchableOpacity onPress={() => onPress(mode)} disabled={disabled}
      accessibilityRole="button" accessibilityLabel={`Navigate back: ${label}`} accessibilityState={{ busy, disabled }}
      style={[st.navBtn, disabled && !busy && { opacity: 0.5 }]}>
      {busy ? <ActivityIndicator color={ALARM.ink} /> : <Ionicons name={icon} size={22} color={ALARM.ink} />}
      <Text style={{ color: ALARM.ink, fontWeight: '700', fontSize: 12.5, marginTop: 3 }}>{label}</Text>
    </TouchableOpacity>
  );
}

// The alarm face is ALARM-coloured in both themes (lib/lock/alarmPalette);
// only the safe face (bigSafe, safeSub) follows the theme.
const makeSt = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  big: { color: ALARM.ink, fontSize: 40, fontWeight: '900', letterSpacing: 2, marginTop: 8 },
  bigSafe: { color: c.text, fontSize: 30, fontWeight: '900', marginTop: 12 },
  safeSub: { color: c.textDim, fontSize: 13.5, marginTop: 8, textAlign: 'center' },
  msg: { color: ALARM.ink, fontSize: 16.5, fontWeight: '600', marginTop: 6, textAlign: 'center' },
  sub: { color: ALARM.ink, fontSize: 13.5, marginTop: 8, textAlign: 'center' },
  distBox: { alignItems: 'center', marginTop: 26, marginBottom: 22 },
  distLabel: { color: ALARM.ink, fontSize: 11.5, fontWeight: '800', letterSpacing: 1.2 },
  dist: { color: ALARM.ink, fontSize: 44, fontWeight: '900', marginTop: 2 },
  distSub: { color: ALARM.ink, fontSize: 12.5, marginTop: 4 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, paddingHorizontal: 26, minHeight: 52, justifyContent: 'center' },
  btnTxt: { fontSize: 16.5, fontWeight: '800', color: ALARM.ink },
  // flexWrap: three 86dp buttons plus two 12dp gaps need 282dp, and a 320dp
  // screen leaves 272dp after padding - so 'Drive' clipped off the right edge.
  // This is the geofence ALARM screen, so the clipped control is a safety
  // action, and it is invisible on both reference handsets (2026-09-17).
  navRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 },
  navBtn: { alignItems: 'center', justifyContent: 'center', minWidth: 86, minHeight: 68, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 14, backgroundColor: ALARM.controlFill, borderWidth: 1, borderColor: ALARM.controlStroke },
});
