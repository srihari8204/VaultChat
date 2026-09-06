// app/location-lock.tsx — Location Lock (Navigate mini-app utility).
//
// Two faces of one screen, driven by the lock service's external store:
//  * SETUP  — pick the point (current fix / search / draggable pin), pick the
//             radius (presets 10 m – 1 km + custom, live preview circle, GPS-
//             accuracy warning), review alerts, arm.
//  * ACTIVE — live status card (zone state, distance, accuracy, time locked),
//             the map with the zone-colored radius + compass, Stop Alarm /
//             Navigate back / Unlock, and the kill-safe upgrade banner.

import { geocodeSearch } from '../lib/nav/geocode';
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import notifee from '@notifee/react-native';
import { useTheme } from '../lib/theme';
import { type LatLng } from '../lib/nav/geo';
import { type Costing } from '../lib/nav/routing';
import NavMap from '../components/nav/NavMap';
import { clampRadius, zoneColor, type LockMode } from '../lib/lock/zoneMachine';
import { useLockSettings, setLockSettings } from '../lib/lock/lockSettings';
import { fmtDistance, fmtSpeed, fmtHeading, fmtAgo, gpsConfidence, QUALITY_LABEL, QUALITY_COLOR } from '../lib/lock/format';
import {
  useLockView, armLock, unlockLock, restoreLock, stopLockAlarm,
  navigateBackToLock, enableKillSafe, testAlarm, applyAlertSettings,
} from '../lib/lock/lockService';
import { listCircles, getPlaces } from '../lib/family/store';

const RADII = [10, 20, 30, 50, 100, 200, 500, 1000];
const MODES: { key: LockMode; label: string; icon: any }[] = [
  { key: 'walking', label: 'Walking', icon: 'walk' },
  { key: 'cycling', label: 'Cycling', icon: 'bicycle' },
  { key: 'driving', label: 'Driving', icon: 'car' },
  { key: 'custom', label: 'Custom', icon: 'options' },
];

const fmtDur = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};

const STATE_LABEL: Record<string, string> = {
  safe: 'SAFE', warning: 'NEAR BOUNDARY', atLimit: 'AT LIMIT', outside: 'OUTSIDE',
};

export default function LocationLockScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const lock = useLockView();
  const settings = useLockSettings();

  // ── setup state ──
  const [point, setPoint] = useState<{ name: string; coords: LatLng } | null>(null);
  const [radius, setRadius] = useState(settings.lastRadius || 30);
  const [customR, setCustomR] = useState('');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [pinMode, setPinMode] = useState(false);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [arming, setArming] = useState(false);
  const [saved, setSaved] = useState<{ name: string; coords: LatLng; radiusM: number }[]>([]);
  const [, tick] = useState(0);

  // Resume an armed lock after relaunch + take a first fix for the setup map,
  // and load Family Space places — a saved place is a one-tap lock (point AND
  // radius come from the place).
  useEffect(() => {
    restoreLock().catch(() => {});
    (async () => {
      try {
        const circles = await listCircles();
        const all: { name: string; coords: LatLng; radiusM: number }[] = [];
        for (const c of circles) {
          for (const p of await getPlaces(c.id)) {
            all.push({ name: p.name, coords: p.center, radiusM: p.radiusM });
          }
        }
        setSaved(all.slice(0, 12));
      } catch {}
    })();
    (async () => {
      try {
        const p = await Location.requestForegroundPermissionsAsync();
        if (p.status !== 'granted') return;
        const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        setMyPos({ lat: cur.coords.latitude, lng: cur.coords.longitude });
        setAccuracy(cur.coords.accuracy ?? null);
      } catch {}
    })();
  }, []);

  // Time-locked ticker while armed.
  useEffect(() => {
    if (!lock.active) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [lock.active]);

  const useCurrent = async () => {
    try {
      const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const c = { lat: cur.coords.latitude, lng: cur.coords.longitude };
      setMyPos(c);
      setAccuracy(cur.coords.accuracy ?? null);
      setPoint({ name: 'Current location', coords: c });
      setPinMode(false);
    } catch {
      Alert.alert('No fix', 'Could not read your position. Check location permission and GPS.');
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    const m = q.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m) { setPoint({ name: q, coords: { lat: +m[1], lng: +m[2] } }); setPinMode(false); return; }
    setSearching(true);
    try {
      // Server-proxied geocoder first (works on no-GMS), platform fallback second.
      const hits = await geocodeSearch(q).catch(() => []);
      if (hits[0]) { setPoint({ name: hits[0].name || hits[0].label, coords: { lat: hits[0].lat, lng: hits[0].lng } }); setPinMode(false); return; }
      const res = await Location.geocodeAsync(q);
      if (res[0]) { setPoint({ name: q, coords: { lat: res[0].latitude, lng: res[0].longitude } }); setPinMode(false); }
      else Alert.alert('Not found', 'No match — try a nearby landmark, enter "lat, lng", or drop a pin.');
    } catch {
      Alert.alert('Search failed', 'Enter coordinates as "lat, lng" or drop a pin on the map.');
    } finally { setSearching(false); }
  };

  const arm = async () => {
    if (!point) return;
    setArming(true);
    try {
      const r = await armLock(point.coords, clampRadius(radius));
      if (!r.ok) { Alert.alert('Could not lock', r.reason ?? 'Unknown error'); return; }
      setLockSettings({ lastRadius: clampRadius(radius) }).catch(() => {});
      if (!r.killSafe) {
        Alert.alert(
          'Background protection off',
          'The lock works while the app is open. Allow location "all the time" to keep protecting after the app is closed.',
          [{ text: 'Not now' }, { text: 'Allow', onPress: () => { enableKillSafe(); } }],
        );
      } else if (Platform.OS === 'android') {
        // OEM battery killers are the #1 cause of silently dropped geofences
        // (design.md risk) — offer the exemption once monitoring is kill-safe.
        try {
          if (await notifee.isBatteryOptimizationEnabled()) {
            Alert.alert(
              'Keep the lock reliable',
              'Battery optimization can pause background monitoring. Exempt VaultChat so the alarm always fires.',
              [{ text: 'Later' }, { text: 'Open settings', onPress: () => { notifee.openBatteryOptimizationSettings().catch(() => {}); } }],
            );
          }
        } catch {}
      }
    } finally { setArming(false); }
  };

  const unlock = () => {
    Alert.alert('Unlock location?', 'Monitoring stops and this session is saved to history.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlock', style: 'destructive', onPress: () => { unlockLock().catch(() => {}); } },
    ]);
  };

  const navBack = (costing: Costing) => { navigateBackToLock(costing).catch(() => {}); router.push('/navigate'); };

  const accWarn = accuracy != null && radius < 2 * accuracy;
  const previewLock = useMemo(
    () => (point ? { center: point.coords, radius: clampRadius(radius), color: '#22C55E' } : null),
    [point, radius],
  );

  const Chip = ({ active: on, label, onPress }: { active: boolean; label: string; onPress: () => void }) => (
    <TouchableOpacity onPress={onPress}
      style={[st.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary + '1a' : 'transparent' }]}>
      <Text style={{ color: on ? colors.primary : colors.text, fontWeight: on ? '700' : '500', fontSize: 13.5 }}>{label}</Text>
    </TouchableOpacity>
  );

  // ═══ ACTIVE ═══
  if (lock.active && lock.center) {
    const zc = zoneColor(lock.state ?? 'safe');
    const alarming = lock.alarmPhase === 'alarming';
    return (
      <View style={[st.screen, { backgroundColor: colors.bg }]}>
        <Stack.Screen options={{ title: 'Location Locked', headerTitleAlign: 'center' }} />

        {(alarming || lock.alarmPhase === 'grace') && (
          <TouchableOpacity
            accessibilityRole="button" accessibilityLabel="Stop alarm"
            onPress={() => (alarming ? stopLockAlarm() : undefined)}
            style={[st.alarmBar, { backgroundColor: alarming ? '#DC2626' : '#F97316' }]}>
            <Ionicons name={alarming ? 'alert-circle' : 'time'} size={18} color="#fff" />
            <Text style={st.alarmBarTxt}>
              {alarming ? 'ALARM — you left the locked area. Tap to stop.' : 'Outside the radius — alarm imminent…'}
            </Text>
          </TouchableOpacity>
        )}
        {/* boundary prediction (v2.1): how much room is left before the edge */}
        {lock.alarmPhase === 'idle' && (lock.state === 'warning' || lock.state === 'atLimit') && (
          <View style={[st.alarmBar, { backgroundColor: lock.state === 'warning' ? '#A16207' : '#C2410C' }]}>
            <Ionicons name="warning" size={16} color="#fff" />
            <Text style={st.alarmBarTxt}>
              {fmtDistance(Math.max(0, lock.radius - lock.distance), settings.units)} remaining to the boundary
            </Text>
          </View>
        )}
        {lock.gpsDegraded && (
          <View style={[st.alarmBar, { backgroundColor: colors.surfaceSolid }]}>
            <Ionicons name="cellular" size={15} color="#F97316" />
            <Text style={[st.alarmBarTxt, { fontWeight: '600' }]}>
              Weak GPS — possibly indoors. Monitoring continues with drift protection.
            </Text>
          </View>
        )}

        <NavMap
          data={{ shape: [], pos: myPos, dest: null, heading: lock.heading }}
          follow={false}
          lock={{ center: lock.center, radius: lock.radius, color: zc }}
          accuracyM={lock.accuracy}
          headingDeg={lock.heading}
          showCompass
          zoomControls
          imperialScale={settings.units === 'imperial'}
          style={{ flex: 1 }}
        />

        <View style={[st.card, { backgroundColor: colors.card, borderColor: zc }]}>
          <View style={st.row}>
            <View style={[st.stateDot, { backgroundColor: zc }]} />
            <Text style={[st.stateTxt, { color: zc }]}>{STATE_LABEL[lock.state ?? 'safe']}</Text>
            <Text style={{ color: colors.text + '88', fontSize: 12.5, marginLeft: 'auto' }}>
              {lock.killSafe ? 'Protected in background' : 'Foreground only'}
            </Text>
          </View>
          <View style={[st.row, { marginTop: 10, columnGap: 18, rowGap: 10, flexWrap: 'wrap' }]}>
            <Stat label="Distance" value={fmtDistance(lock.distance, settings.units)} colors={colors} />
            <Stat label="Radius" value={fmtDistance(lock.radius, settings.units)} colors={colors} />
            <Stat label="GPS ±" value={fmtDistance(lock.accuracy, settings.units)} colors={colors} />
            <Stat label="Locked" value={fmtDur(Date.now() - lock.armedAt)} colors={colors} />
            <Stat label="Speed" value={fmtSpeed(lock.speedKmh, settings.units)} colors={colors} />
            <Stat label="Heading" value={fmtHeading(lock.heading)} colors={colors} />
            <Stat label="Battery" value={lock.battery != null ? `${lock.battery}%${lock.charging ? ' ⚡' : ''}` : '—'} colors={colors} />
            <Stat label="Confidence" value={`${QUALITY_LABEL[lock.quality]} · ${gpsConfidence(lock.accuracy)}%`} colors={colors} valueColor={QUALITY_COLOR[lock.quality]} />
          </View>
          <Text style={{ color: colors.text + '66', fontSize: 11 }}>
            GPS updated {lock.lastFixAt ? fmtAgo(Date.now() - lock.lastFixAt) : '—'}
          </Text>

          {!lock.killSafe && (
            <TouchableOpacity onPress={() => enableKillSafe()} style={[st.bgBanner, { borderColor: colors.border }]}>
              <Ionicons name="shield-half" size={15} color={colors.primary} />
              <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>
                Enable background protection (location “all the time”)
              </Text>
            </TouchableOpacity>
          )}

          {lock.state === 'outside' && !lock.navBack && (
            <View style={[st.row, { marginTop: 12, gap: 8 }]}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>Navigate back:</Text>
              <Chip active={false} label="Walk" onPress={() => navBack('pedestrian')} />
              <Chip active={false} label="Cycle" onPress={() => navBack('bicycle')} />
              <Chip active={false} label="Drive" onPress={() => navBack('auto')} />
            </View>
          )}

          <View style={[st.row, { marginTop: 14, gap: 10 }]}>
            <TouchableOpacity onPress={unlock} accessibilityRole="button" accessibilityLabel="Unlock and stop monitoring"
              style={[st.btn, { borderColor: '#EF4444', borderWidth: 1.5 }]}>
              <Ionicons name="lock-open" size={16} color="#EF4444" />
              <Text style={[st.btnTxt, { color: '#EF4444' }]}>Unlock</Text>
            </TouchableOpacity>
            {alarming && (
              <TouchableOpacity onPress={() => stopLockAlarm()} style={[st.btn, { backgroundColor: '#DC2626' }]}>
                <Ionicons name="volume-mute" size={16} color="#fff" />
                <Text style={[st.btnTxt, { color: '#fff' }]}>Stop alarm</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => router.push('/lock-settings')} style={[st.btn, { borderColor: colors.border, borderWidth: 1 }]}>
              <Ionicons name="options" size={16} color={colors.text} />
              <Text style={[st.btnTxt, { color: colors.text }]}>Alerts</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/lock-history')} style={[st.btn, { borderColor: colors.border, borderWidth: 1 }]}>
              <Ionicons name="time" size={16} color={colors.text} />
              <Text style={[st.btnTxt, { color: colors.text }]}>History</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // ═══ SETUP ═══
  return (
    <View style={[st.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Location Lock', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={st.setup} keyboardShouldPersistTaps="handled">
        <Text style={[st.h, { color: colors.text }]}>Lock point</Text>
        <View style={[st.row, { gap: 8 }]}>
          <TouchableOpacity onPress={useCurrent} style={[st.srcBtn, { borderColor: colors.border }]}>
            <Ionicons name="locate" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 13 }}>Current location</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setPinMode((v) => !v)}
            style={[st.srcBtn, { borderColor: pinMode ? colors.primary : colors.border, backgroundColor: pinMode ? colors.primary + '14' : 'transparent' }]}>
            <Ionicons name="pin" size={16} color={pinMode ? colors.primary : colors.text} />
            <Text style={{ color: pinMode ? colors.primary : colors.text, fontSize: 13 }}>
              {pinMode ? 'Tap map to drop pin' : 'Drop pin on map'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={[st.searchRow, { borderColor: colors.border, backgroundColor: colors.surface, marginTop: 10 }]}>
          <Ionicons name="search" size={18} color={colors.text + '99'} />
          <TextInput
            value={query} onChangeText={setQuery} onSubmitEditing={search} returnKeyType="search"
            placeholder='Address or "lat, lng"' placeholderTextColor={colors.text + '66'}
            style={[st.input, { color: colors.text }]}
          />
          {searching ? <ActivityIndicator size="small" color={colors.primary} />
            : <TouchableOpacity onPress={search}><Text style={{ color: colors.primary, fontWeight: '700' }}>Find</Text></TouchableOpacity>}
        </View>

        {/* Saved places (lock type: saved location) — one tap sets both point
            and radius. Sourced read-only from the user's saved place list. */}
        {saved.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <Text style={{ color: colors.text + '88', fontSize: 12, fontWeight: '700', marginBottom: 6 }}>SAVED PLACES</Text>
            <View style={st.chips}>
              {saved.map((p, i) => (
                <TouchableOpacity key={`${p.name}-${i}`}
                  onPress={() => { setPoint({ name: p.name, coords: p.coords }); setRadius(clampRadius(p.radiusM)); setCustomR(''); setPinMode(false); }}
                  style={[st.chip, { borderColor: point?.name === p.name ? colors.primary : colors.border, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
                  <Ionicons name="bookmark" size={12} color={colors.primary} />
                  <Text style={{ color: colors.text, fontSize: 12.5 }}>{p.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {point && (
          <View style={[st.destPill, { backgroundColor: colors.primary + '14' }]}>
            <Ionicons name="location" size={16} color={colors.primary} />
            <Text numberOfLines={1} style={{ color: colors.text, flex: 1 }}>{point.name}</Text>
            <Text style={{ color: colors.text + '77', fontSize: 12 }}>
              {point.coords.lat.toFixed(5)}, {point.coords.lng.toFixed(5)}
            </Text>
          </View>
        )}

        <NavMap
          data={{ shape: [], pos: myPos, dest: null, heading: 0 }}
          follow={false}
          lock={previewLock}
          accuracyM={accuracy ?? 0}
          pin={point?.coords ?? null}
          pinMode={pinMode}
          onPinDrop={(p) => setPoint({ name: 'Dropped pin', coords: p })}
          zoomControls
          imperialScale={settings.units === 'imperial'}
          style={[st.previewMap, { borderColor: colors.border }]}
        />

        <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Mode</Text>
        <View style={st.chips}>
          {MODES.map((m) => (
            <TouchableOpacity key={m.key}
              onPress={() => { setLockSettings({ mode: m.key }).then(() => applyAlertSettings()).catch(() => {}); }}
              style={[st.chip, {
                flexDirection: 'row', alignItems: 'center', gap: 5,
                borderColor: settings.mode === m.key ? colors.primary : colors.border,
                backgroundColor: settings.mode === m.key ? colors.primary + '1a' : 'transparent',
              }]}>
              <Ionicons name={m.icon} size={13} color={settings.mode === m.key ? colors.primary : colors.text} />
              <Text style={{ color: settings.mode === m.key ? colors.primary : colors.text, fontSize: 13, fontWeight: settings.mode === m.key ? '700' : '500' }}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Radius</Text>
        <View style={st.chips}>
          {RADII.map((r) => (
            <Chip key={r} active={radius === r} label={r >= 1000 ? '1 km' : `${r} m`}
              onPress={() => { setRadius(r); setCustomR(''); }} />
          ))}
        </View>
        <View style={[st.row, { marginTop: 10, gap: 8 }]}>
          <TextInput
            value={customR}
            onChangeText={(t) => {
              setCustomR(t.replace(/[^0-9]/g, ''));
              const n = parseInt(t, 10);
              if (Number.isFinite(n) && n > 0) setRadius(clampRadius(n));
            }}
            keyboardType="number-pad" placeholder="Custom (10–1000 m)"
            placeholderTextColor={colors.text + '66'}
            style={[st.customInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
          />
          <Text style={{ color: colors.text + '88', fontSize: 13 }}>→ {clampRadius(radius)} m</Text>
        </View>
        {accWarn && (
          <View style={[st.warn, { backgroundColor: '#F9731622' }]}>
            <Ionicons name="warning" size={15} color="#F97316" />
            <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>
              GPS accuracy is ±{Math.round(accuracy!)} m — a {clampRadius(radius)} m radius may false-alarm.
              Consider {clampRadius(Math.ceil((accuracy! * 2) / 10) * 10)} m or more.
            </Text>
          </View>
        )}

        <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Alerts</Text>
        <View style={[st.row, { gap: 8 }]}>
          <TouchableOpacity onPress={() => router.push('/lock-settings')} style={[st.srcBtn, { borderColor: colors.border }]}>
            <Ionicons name="options" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 13 }}>
              {[settings.alerts.siren && 'Siren', settings.alerts.vibration && 'Vibration',
                settings.alerts.voice && 'Voice', settings.alerts.flash && 'Flash']
                .filter(Boolean).join(' · ') || 'All off'} · {settings.alerts.graceS}s grace
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => testAlarm()} style={[st.srcBtn, { borderColor: colors.border }]}>
            <Ionicons name="play" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 13 }}>Test</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity disabled={!point || arming} onPress={arm}
          accessibilityRole="button" accessibilityLabel="Lock this location and start monitoring"
          style={[st.lockBtn, { backgroundColor: point ? colors.primary : colors.border }]}>
          {arming ? <ActivityIndicator color="#fff" />
            : <><Ionicons name="lock-closed" size={18} color="#fff" /><Text style={st.lockTxt}>Lock Location</Text></>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/lock-history')} style={{ alignSelf: 'center', marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13.5 }}>History & statistics</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, colors, valueColor }: { label: string; value: string; colors: any; valueColor?: string }) {
  return (
    <View>
      <Text style={{ color: colors.text + '77', fontSize: 11, fontWeight: '600', textTransform: 'uppercase' }}>{label}</Text>
      <Text style={{ color: valueColor ?? colors.text, fontSize: 15.5, fontWeight: '800', marginTop: 1 }}>{value}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1 },
  setup: { padding: 16, paddingBottom: 48 },
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  row: { flexDirection: 'row', alignItems: 'center' },
  srcBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 40 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 48 },
  input: { flex: 1, fontSize: 15 },
  destPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 10 },
  previewMap: { height: 230, borderRadius: 14, borderWidth: 1, marginTop: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  customInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 42, fontSize: 14 },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, marginTop: 10 },
  lockBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 14, marginTop: 28 },
  lockTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  alarmBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  alarmBarTxt: { color: '#fff', fontWeight: '800', fontSize: 13.5, flex: 1 },
  card: { borderTopWidth: 3, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 22 },
  stateDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  stateTxt: { fontWeight: '900', fontSize: 15, letterSpacing: 0.4 },
  bgBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 9, marginTop: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 12, minHeight: 40 },
  btnTxt: { fontWeight: '700', fontSize: 13.5 },
});
