// app/lock-alert.tsx — the full-screen exit alarm. Launched by the alarm
// notification's full-screen intent (killed/backgrounded path) or pushed by
// the lock service the moment the alarm fires in-app. Flashing red screen
// (the "flash" alert channel), live distance outside the radius, Stop Alarm,
// and one-tap navigate-back. Auto-resolves to a green "safe" state on return.

import React, { useEffect, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
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

  const navBack = (costing: Costing) => {
    navigateBackToLock(costing).catch(() => {});
    router.replace('/navigate');
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

      {lock.alarmPhase === 'alarming' ? (
        <TouchableOpacity onPress={() => stopLockAlarm()} style={[st.btn, { backgroundColor: c.glassSoft }]}>
          <Ionicons name="volume-mute" size={18} color="#DC2626" />
          <Text style={[st.btnTxt, { color: '#DC2626' }]}>Stop Alarm</Text>
        </TouchableOpacity>
      ) : (
        <Text style={[st.sub, { marginTop: 8 }]}>Alarm starts in moments — head back now</Text>
      )}

      <Text style={[st.distLabel, { marginTop: 26 }]}>NAVIGATE BACK</Text>
      <View style={st.navRow}>
        <NavBtn icon="walk" label="Walk" onPress={() => navBack('pedestrian')} />
        <NavBtn icon="bicycle" label="Cycle" onPress={() => navBack('bicycle')} />
        <NavBtn icon="car" label="Drive" onPress={() => navBack('auto')} />
      </View>

      <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace('/location-lock'))} style={{ marginTop: 26 }}>
        <Text style={{ color: '#FECACA', fontSize: 13.5, fontWeight: '600' }}>Back to lock screen</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function NavBtn({ icon, label, onPress }: { icon: any; label: string; onPress: () => void }) {
  const c = useColors();
  const st = useMemo(() => makeSt(c), [c]);
  return (
    <TouchableOpacity onPress={onPress} style={st.navBtn}>
      <Ionicons name={icon} size={22} color="#fff" />
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
  navRow: { flexDirection: 'row', gap: 12, marginTop: 10 },
  navBtn: { alignItems: 'center', justifyContent: 'center', width: 86, height: 68, borderRadius: 14, backgroundColor: 'rgba(255,255,255,.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,.35)' },
});
