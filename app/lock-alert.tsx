// app/lock-alert.tsx — the full-screen exit alarm. Launched by the alarm
// notification's full-screen intent (killed/backgrounded path) or pushed by
// the lock service the moment the alarm fires in-app. Flashing red screen
// (the "flash" alert channel), live distance outside the radius, Stop Alarm,
// and one-tap navigate-back. Auto-resolves to a green "safe" state on return.

import React, { useEffect, useRef, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Alert, ActivityIndicator } from 'react-native';
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

export default function LockAlertScreen() {
  const c = useColors();
  const st = useMemo(() => makeSt(c), [c]);
  const router = useRouter();
  const lock = useLockView();
  const settings = useLockSettings();
  const flash = useRef(new Animated.Value(0)).current;
  /** The mode whose route back is being planned. */
  const [planning, setPlanning] = useState<Costing | null>(null);

  // A full-screen-intent launch from a killed app lands here before anything
  // else ran — make sure the lock session is restored.
  useEffect(() => { restoreLock().catch(() => {}); }, []);

  // The flash channel: pulse the background while alarming (if enabled).
  const alarming = lock.alarmPhase === 'alarming' || lock.alarmPhase === 'grace';
  useEffect(() => {
    if (!alarming || !settings.alerts.flash) { flash.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(flash, { toValue: 1, duration: 350, useNativeDriver: false }),
      Animated.timing(flash, { toValue: 0, duration: 350, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [alarming, settings.alerts.flash, flash]);

  const back = lock.state !== 'outside';
  const over = Math.max(0, lock.distance - lock.radius);
  const bg = flash.interpolate({ inputRange: [0, 1], outputRange: ['#7F1D1D', '#DC2626'] });

  const navBack = async (costing: Costing) => {
    // Surfaced, not swallowed, and Navigate opens only once the route exists:
    // replacing first left the user on an empty Navigate screen, with this
    // alarm screen already gone, whenever planning failed.
    if (planning) return;
    setPlanning(costing);
    try {
      await navigateBackToLock(costing);
      router.replace('/navigate');
    } catch (e: any) {
      Alert.alert('Navigate back', e?.message ?? 'Could not plan a route back to the locked spot.');
    } finally { setPlanning(null); }
  };

  // Safe again (or lock gone) → green confirmation instead of red panic.
  if (!lock.active || back) {
    return (
      <View style={[st.screen, { backgroundColor: 'rgba(34,197,94,0.18)' }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Ionicons name="checkmark-circle" size={92} color="#4ADE80" />
        <Text style={st.bigSafe}>You are safe</Text>
        <Text style={st.sub}>
          {lock.active ? 'Back inside the locked area.' : 'No active lock.'}
        </Text>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/location-lock'))}
          accessibilityRole="button"
          style={[st.btn, { backgroundColor: '#22C55E', marginTop: 34 }]}>
          <Text style={st.btnTxt}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <Animated.View style={[st.screen, { backgroundColor: bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Ionicons name="warning" size={92} color="#fff" />
      <Text style={st.big}>ALERT!</Text>
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
        {lock.alarmPhase === 'alarming'
          ? 'Alarm sounding — head back now'
          : lock.alarmPhase === 'grace'
            ? 'Alarm starts in moments — head back now'
            : lock.alarmPhase === 'silenced'
              ? 'Alarm silenced — you are still outside the locked area'
              : 'You are outside the locked area — head back now'}
      </Text>
      {lock.alarmPhase === 'alarming' && (
        <TouchableOpacity onPress={() => stopLockAlarm()} accessibilityRole="button" style={[st.btn, { backgroundColor: c.glassSoft }]}>
          <Ionicons name="volume-mute" size={18} color="#DC2626" />
          <Text style={[st.btnTxt, { color: '#DC2626' }]}>Stop Alarm</Text>
        </TouchableOpacity>
      )}

      <Text style={[st.distLabel, { marginTop: 26 }]}>NAVIGATE BACK</Text>
      <View style={st.navRow}>
        <NavBtn icon="walk" label="Walk" busy={planning === 'pedestrian'} onPress={() => navBack('pedestrian')} />
        <NavBtn icon="bicycle" label="Cycle" busy={planning === 'bicycle'} onPress={() => navBack('bicycle')} />
        <NavBtn icon="car" label="Drive" busy={planning === 'auto'} onPress={() => navBack('auto')} />
      </View>

      <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/location-lock'))} accessibilityRole="button" hitSlop={12} style={{ marginTop: 26 }}>
        <Text style={{ color: '#FECACA', fontSize: 13.5, fontWeight: '600' }}>Back to lock screen</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function NavBtn({ icon, label, busy, onPress }: { icon: any; label: string; busy: boolean; onPress: () => void }) {
  const c = useColors();
  const st = useMemo(() => makeSt(c), [c]);
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={`Navigate back: ${label}`} accessibilityState={{ busy }} style={st.navBtn}>
      {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name={icon} size={22} color="#fff" />}
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12.5, marginTop: 3 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const makeSt = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  big: { color: '#fff', fontSize: 40, fontWeight: '900', letterSpacing: 2, marginTop: 8 },
  bigSafe: { color: '#fff', fontSize: 30, fontWeight: '900', marginTop: 12 },
  msg: { color: '#FEE2E2', fontSize: 16.5, fontWeight: '600', marginTop: 6, textAlign: 'center' },
  sub: { color: '#FECACA', fontSize: 13.5, marginTop: 8, textAlign: 'center' },
  distBox: { alignItems: 'center', marginTop: 26, marginBottom: 22 },
  distLabel: { color: '#FECACA', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.2 },
  dist: { color: '#fff', fontSize: 44, fontWeight: '900', marginTop: 2 },
  distSub: { color: '#FECACA', fontSize: 12.5, marginTop: 4 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, paddingHorizontal: 26, minHeight: 52, justifyContent: 'center' },
  btnTxt: { fontSize: 16.5, fontWeight: '800', color: '#fff' },
  // flexWrap: three 86dp buttons plus two 12dp gaps need 282dp, and a 320dp
  // screen leaves 272dp after padding - so 'Drive' clipped off the right edge.
  // This is the geofence ALARM screen, so the clipped control is a safety
  // action, and it is invisible on both reference handsets (2026-09-17).
  navRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 10 },
  navBtn: { alignItems: 'center', justifyContent: 'center', minWidth: 86, minHeight: 68, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 14, backgroundColor: 'rgba(255,255,255,.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,.35)' },
});
