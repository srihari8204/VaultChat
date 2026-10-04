// components/lock/LockActiveFace.tsx — Location Lock's ACTIVE face, split out
// of app/location-lock.tsx: live status card (zone state, distance, accuracy,
// time locked), the map with the zone-coloured radius + compass, Stop Alarm /
// Navigate back / Unlock, and the kill-safe upgrade banner.

import React, { useEffect, useMemo, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import type { Palette } from '../../constants/theme';
import { ALARM } from '../../lib/lock/alarmPalette';
import { type LatLng } from '../../lib/nav/geo';
import { type Costing } from '../../lib/nav/routing';
import NavMap from '../nav/NavMap';
import { zoneColor } from '../../lib/lock/zoneMachine';
import { useLockSettings } from '../../lib/lock/lockSettings';
import { fmtDistance, fmtSpeed, fmtHeading, fmtAgo, gpsConfidence, QUALITY_LABEL, QUALITY_COLOR } from '../../lib/lock/format';
import {
  useLockView, unlockLock, stopLockAlarm, navigateBackToLock, enableKillSafe, KILL_SAFE_REFUSED,
} from '../../lib/lock/lockService';
import { AppText as Text, AuroraBackground } from '../ui';
import { Chip } from './LockChip';

const fmtDur = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};

const STATE_LABEL: Record<string, string> = {
  safe: 'SAFE', warning: 'NEAR BOUNDARY', atLimit: 'AT LIMIT', outside: 'OUTSIDE',
};

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

/** Ask for background protection and say so when it is refused (same copy as
 *  the settings switch); a refusal used to leave the user with no feedback.
 *  Also used by the setup face's arm alert. */
export function askKillSafe() {
  enableKillSafe()
    .then((r) => { if (r !== 'on') Alert.alert(KILL_SAFE_REFUSED[r].title, KILL_SAFE_REFUSED[r].body); })
    .catch((e: unknown) => Alert.alert('Background tracking', errText(e, 'Could not turn on background tracking. Try again.')));
}

/** Re-renders itself every second; the screen around it does not. The 1 s
 *  ticker used to live in the screen and re-render the map, card and every
 *  chip just to move "Locked" and "GPS updated" on. */
function Ticking({ render }: { render: () => React.ReactNode }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);
  return <>{render()}</>;
}

/** `myPos` is the setup face's one-off fix: the "you" marker until the lock's first accepted fix. */
export default function LockActiveFace({ myPos }: { myPos: LatLng | null }) {
  const { colors } = useTheme();
  const router = useRouter();
  const lock = useLockView();
  const settings = useLockSettings();
  // The screen has a native header, so the root layout adds no bottom inset:
  // the card's own padding has to clear the home indicator.
  const insets = useSafeAreaInsets();
  /** The mode whose route back is being planned; Navigate opens only once it exists. */
  const [planning, setPlanning] = useState<Costing | null>(null);

  const unlock = () => {
    Alert.alert('Unlock location?', 'Monitoring stops and this session is saved to history.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlock', style: 'destructive', onPress: () => {
        unlockLock().catch((e: unknown) => Alert.alert('Could not unlock', `${errText(e, 'Unknown error')}. Monitoring is still on; try again.`));
      } },
    ]);
  };

  // Navigate opens only once the route exists: opening it first left the user
  // on an empty Navigate screen whenever planning failed.
  const navBack = async (costing: Costing) => {
    if (planning) return;
    setPlanning(costing);
    try {
      await navigateBackToLock(costing);
      router.push('/navigate');
    } catch (e: unknown) {
      Alert.alert('Navigate back', errText(e, 'Could not plan a route back to the locked spot.'));
    } finally { setPlanning(null); }
  };

  // The live "you" marker comes from the engine's accepted fixes (lock.pos);
  // myPos — the one-off setup fix — is only the fallback until the first one.
  // Memoised so the 1 s ticker does not hand NavMap a new object every second.
  const activeMapData = useMemo(
    () => ({ shape: [], pos: lock.pos ?? myPos, dest: null, heading: lock.heading }),
    [lock.pos, myPos, lock.heading],
  );
  if (!lock.center) return null;
  const zc = zoneColor(lock.state ?? 'safe');
  const alarming = lock.alarmPhase === 'alarming';
  return (
    <View style={st.screen}>
      <AuroraBackground />
      <Stack.Screen options={{
      headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Location Locked', headerTitleAlign: 'center' }} />

      {alarming && (
        <TouchableOpacity
          accessibilityRole="button" accessibilityLabel="Stop alarm"
          onPress={() => stopLockAlarm()}
          style={[st.alarmBar, { backgroundColor: ALARM.sounding }]}>
          <Ionicons name="alert-circle" size={18} color={ALARM.ink} />
          <Text style={st.alarmBarTxt}>ALARM — you left the locked area. Tap to stop.</Text>
        </TouchableOpacity>
      )}
      {/* Grace: a status, not a control — there is nothing to stop yet. It
          used to be announced as a "Stop alarm" button that did nothing. */}
      {lock.alarmPhase === 'grace' && (
        <View accessibilityLiveRegion="assertive" style={[st.alarmBar, { backgroundColor: ALARM.grace }]}>
          <Ionicons name="time" size={18} color={ALARM.ink} />
          <Text style={st.alarmBarTxt}>Outside the radius — alarm imminent. Head back now.</Text>
        </View>
      )}
      {/* boundary prediction (v2.1): how much room is left before the edge */}
      {lock.alarmPhase === 'idle' && (lock.state === 'warning' || lock.state === 'atLimit') && (
        <View accessibilityLiveRegion="polite" style={[st.alarmBar, { backgroundColor: lock.state === 'warning' ? ALARM.nearEdge : ALARM.atLimit }]}>
          <Ionicons name="warning" size={16} color={ALARM.ink} />
          <Text style={st.alarmBarTxt}>
            {fmtDistance(Math.max(0, lock.radius - lock.distance), settings.units)} remaining to the boundary
          </Text>
        </View>
      )}
      {lock.gpsDegraded && (
        <View style={[st.alarmBar, { backgroundColor: colors.surfaceSolid }]}>
          <Ionicons name="cellular" size={15} color={ALARM.grace} />
          {/* Theme text: this bar sits on surfaceSolid, where the alarm
              bars' white text vanished in light mode. */}
          <Text style={[st.alarmBarTxt, { fontWeight: '600', color: colors.text }]}>
            Weak GPS — possibly indoors. Monitoring continues with drift protection.
          </Text>
        </View>
      )}

      <NavMap
        data={activeMapData}
        follow={false}
        lock={{ center: lock.center, radius: lock.radius, color: zc }}
        accuracyM={lock.accuracy}
        headingDeg={lock.heading}
        showCompass
        zoomControls
        imperialScale={settings.units === 'imperial'}
        style={{ flex: 1 }}
      />

      <View style={[st.card, { backgroundColor: colors.glass, borderColor: zc, paddingBottom: 22 + insets.bottom }]}>
        <View style={st.row}>
          <View style={[st.stateDot, { backgroundColor: zc }]} />
          <Text style={[st.stateTxt, { color: zc }]}>{STATE_LABEL[lock.state ?? 'safe']}</Text>
          <Text style={{ color: colors.textDim, fontSize: 12.5, marginLeft: 'auto' }}>
            {lock.killSafe ? 'Protected in background' : 'Foreground only'}
          </Text>
        </View>
        <View style={[st.row, { marginTop: 10, columnGap: 18, rowGap: 10, flexWrap: 'wrap' }]}>
          <Stat label="Distance" value={fmtDistance(lock.distance, settings.units)} colors={colors} />
          <Stat label="Radius" value={fmtDistance(lock.radius, settings.units)} colors={colors} />
          <Stat label="GPS ±" spokenLabel="GPS accuracy" value={fmtDistance(lock.accuracy, settings.units)} colors={colors} />
          <Ticking render={() => <Stat label="Locked" value={fmtDur(Date.now() - lock.armedAt)} colors={colors} />} />
          <Stat label="Speed" value={fmtSpeed(lock.speedKmh, settings.units)} colors={colors} />
          <Stat label="Heading" value={fmtHeading(lock.heading)} colors={colors} />
          <Stat label="Battery" value={lock.battery != null ? `${lock.battery}%${lock.charging ? ' ⚡' : ''}` : '—'}
            spokenValue={lock.battery != null ? `${lock.battery}%${lock.charging ? ', charging' : ''}` : 'unknown'} colors={colors} />
          <Stat label="Confidence" value={`${QUALITY_LABEL[lock.quality]} · ${gpsConfidence(lock.accuracy)}%`} colors={colors} valueColor={QUALITY_COLOR[lock.quality]} />
        </View>
        <Ticking render={() => (
          <Text style={{ color: colors.textFaint, fontSize: 11 }}>
            GPS updated {lock.lastFixAt ? fmtAgo(Date.now() - lock.lastFixAt) : '—'}
          </Text>
        )} />

        {!lock.killSafe && (
          <TouchableOpacity onPress={askKillSafe} accessibilityRole="button"
            accessibilityHint="Asks for location access all the time so the lock keeps working after the app is closed"
            style={[st.bgBanner, { borderColor: colors.glassStroke }]}>
            <Ionicons name="shield-half" size={15} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>
              Enable background protection (location “all the time”)
            </Text>
          </TouchableOpacity>
        )}

        {lock.state === 'outside' && !lock.navBack && (
          <View style={[st.row, st.wrap, { marginTop: 12, gap: 8 }]}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>Navigate back:</Text>
            <Chip active={false} busy={planning === 'pedestrian'} disabled={planning !== null} label="Walk" onPress={() => navBack('pedestrian')} colors={colors} />
            <Chip active={false} busy={planning === 'bicycle'} disabled={planning !== null} label="Cycle" onPress={() => navBack('bicycle')} colors={colors} />
            <Chip active={false} busy={planning === 'auto'} disabled={planning !== null} label="Drive" onPress={() => navBack('auto')} colors={colors} />
            {planning && <ActivityIndicator size="small" color={colors.primary} accessibilityLabel="Planning route back" />}
          </View>
        )}

        {/* Wraps: with Stop alarm showing, four buttons do not fit one row on a phone. */}
        <View style={[st.row, st.wrap, { marginTop: 14, gap: 10 }]}>
          <TouchableOpacity onPress={unlock} accessibilityRole="button" accessibilityLabel="Unlock and stop monitoring"
            style={[st.btn, { borderColor: colors.danger, borderWidth: 1.5 }]}>
            <Ionicons name="lock-open" size={16} color={colors.danger} />
            <Text style={[st.btnTxt, { color: colors.danger }]}>Unlock</Text>
          </TouchableOpacity>
          {alarming && (
            <TouchableOpacity onPress={() => stopLockAlarm()} accessibilityRole="button" style={[st.btn, { backgroundColor: ALARM.sounding }]}>
              <Ionicons name="volume-mute" size={16} color={ALARM.ink} />
              <Text style={[st.btnTxt, { color: ALARM.ink }]}>Stop alarm</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => router.push('/lock-settings')} accessibilityRole="button" accessibilityLabel="Alert settings" style={[st.btn, { borderColor: colors.glassStroke, borderWidth: 1 }]}>
            <Ionicons name="options" size={16} color={colors.text} />
            <Text style={[st.btnTxt, { color: colors.text }]}>Alerts</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/lock-history')} accessibilityRole="button" accessibilityLabel="Lock history" style={[st.btn, { borderColor: colors.glassStroke, borderWidth: 1 }]}>
            <Ionicons name="time" size={16} color={colors.text} />
            <Text style={[st.btnTxt, { color: colors.text }]}>History</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

/** One accessible element per stat ("Distance: 12 m"), not two fragments. */
function Stat({ label, value, colors, valueColor, spokenLabel, spokenValue }: {
  label: string; value: string; colors: Palette; valueColor?: string; spokenLabel?: string; spokenValue?: string;
}) {
  return (
    <View accessible accessibilityLabel={`${spokenLabel ?? label}: ${spokenValue ?? value}`}>
      <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase' }}>{label}</Text>
      <Text style={{ color: valueColor ?? colors.text, fontSize: 15.5, fontWeight: '800', marginTop: 1 }}>{value}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  alarmBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44 },
  alarmBarTxt: { color: ALARM.ink, fontWeight: '800', fontSize: 13.5, flex: 1 },
  card: { borderTopWidth: 3, paddingHorizontal: 16, paddingTop: 12 },
  stateDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  stateTxt: { fontWeight: '900', fontSize: 15, letterSpacing: 0.4 },
  bgBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 9, minHeight: 44, marginTop: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 12, minHeight: 44 },
  btnTxt: { fontWeight: '700', fontSize: 13.5 },
});
