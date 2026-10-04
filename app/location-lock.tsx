// app/location-lock.tsx — Location Lock (Navigate mini-app utility).
//
// Two faces of one screen, driven by the lock service's external store:
//  * SETUP  — pick the point (current fix / search / draggable pin), pick the
//             radius (presets 10 m – 1 km + custom, live preview circle, GPS-
//             accuracy warning), review alerts, arm.
//  * ACTIVE — live status card (zone state, distance, accuracy, time locked),
//             the map with the zone-colored radius + compass, Stop Alarm /
//             Navigate back / Unlock, and the kill-safe upgrade banner
//             (components/lock/LockActiveFace.tsx).

import { geocodeSearch } from '../lib/nav/geocode';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, Platform, AppState, Linking,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import notifee from '@notifee/react-native';
import { useTheme } from '../lib/theme';
import { userErrorText } from '../lib/userErrorText';
import { permissionDenied } from '../lib/permissionDenied';
import { ALARM } from '../lib/lock/alarmPalette';
import { typedCoords } from '../lib/nav/urlCoords';
import { type LatLng } from '../lib/nav/geo';
import NavMap from '../components/nav/NavMap';
import { clampRadius, zoneColor, type LockMode } from '../lib/lock/zoneMachine';
import { useLockSettings, setLockSettings } from '../lib/lock/lockSettings';
import { useLockView, armLock, restoreLock, testAlarm, applyAlertSettings } from '../lib/lock/lockService';
import { listCircles, getPlaces } from '../lib/family/store';
import { AppText as Text, AuroraBackground } from '../components/ui';
import LockActiveFace, { askKillSafe } from '../components/lock/LockActiveFace';
import { Chip, chipSt } from '../components/lock/LockChip';

const RADII = [10, 20, 30, 50, 100, 200, 500, 1000];
const MODES: { key: LockMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'walking', label: 'Walking', icon: 'walk' },
  { key: 'cycling', label: 'Cycling', icon: 'bicycle' },
  { key: 'driving', label: 'Driving', icon: 'car' },
  { key: 'custom', label: 'Custom', icon: 'options' },
];


/** Test Alarm, saying so when the alarm sound could not play. */
function testAlarmAndSay() {
  const fail = () => Alert.alert('Alarm sound test failed', 'This device could not play the alarm sound, so the siren may not work. Check the system sound settings.');
  testAlarm().then((ok) => { if (!ok) fail(); }, fail);
}

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
  /** Saved places could not be read. Shown as a line, not as "no places". */
  const [savedFailed, setSavedFailed] = useState(false);
  /** Location permission is refused: the screen says so and offers Settings
   *  instead of showing a map with no "you" and no explanation. */
  const [locDenied, setLocDenied] = useState(false);
  const [locating, setLocating] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // First fix for the setup map. `ask` is false when re-checking on return
  // from Settings, so coming back never throws a prompt at the user.
  const firstFix = useCallback(async (ask: boolean) => {
    try {
      const p = ask ? await Location.requestForegroundPermissionsAsync() : await Location.getForegroundPermissionsAsync();
      if (!mounted.current) return;
      if (p.status !== 'granted') { setLocDenied(true); return; }
      setLocDenied(false);
      const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (!mounted.current) return;
      setMyPos({ lat: cur.coords.latitude, lng: cur.coords.longitude });
      setAccuracy(cur.coords.accuracy ?? null);
    } catch { /* no fix yet: "Current location" retries and says why */ }
  }, []);

  // Resume an armed lock after relaunch + take a first fix for the setup map,
  // and load Family Space places — a saved place is a one-tap lock (point AND
  // radius come from the place).
  useEffect(() => {
    restoreLock().catch((e: unknown) => {
      // Silence here meant a lock that might not be monitoring while the
      // screen looked normal. Say so; the background service may still run.
      Alert.alert('Location Lock', `Couldn’t resume monitoring. ${userErrorText(e, 'Check location permission and GPS.')}`);
    });
    (async () => {
      try {
        const circles = await listCircles();
        const all: { name: string; coords: LatLng; radiusM: number }[] = [];
        for (const c of circles) {
          for (const p of await getPlaces(c.id)) {
            all.push({ name: p.name, coords: p.center, radiusM: p.radiusM });
          }
        }
        if (mounted.current) setSaved(all.slice(0, 12));
      } catch { if (mounted.current) setSavedFailed(true); }
    })();
    firstFix(true);
  }, [firstFix]);

  // Denied: the only way forward is Settings, so re-check on return.
  useEffect(() => {
    if (!locDenied) return;
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') firstFix(false); });
    return () => sub.remove();
  }, [locDenied, firstFix]);

  const pickCurrent = async () => {
    if (locating) return;
    setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!mounted.current) return;
      if (perm.status !== 'granted') {
        setLocDenied(true);
        permissionDenied('Location permission needed', 'Location Lock needs your position to lock the spot you are standing on.', perm.canAskAgain);
        return;
      }
      setLocDenied(false);
      const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (!mounted.current) return;
      const c = { lat: cur.coords.latitude, lng: cur.coords.longitude };
      setMyPos(c);
      setAccuracy(cur.coords.accuracy ?? null);
      setPoint({ name: 'Current location', coords: c });
      setPinMode(false);
    } catch {
      if (mounted.current) Alert.alert('No fix', 'Could not read your position. Check that GPS is on and try again.');
    } finally { if (mounted.current) setLocating(false); }
  };

  const setMode = (mode: LockMode) => {
    setLockSettings({ mode }).then(() => applyAlertSettings()).catch((e: unknown) => {
      Alert.alert('Mode not saved', `${userErrorText(e, 'Could not save the lock mode.')} The new mode applies now but will not survive an app restart.`);
    });
  };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    const typed = typedCoords(q);
    if (typed === 'out-of-range') {
      Alert.alert('Not a valid position', 'Latitude must be between -90 and 90, longitude between -180 and 180.');
      return;
    }
    if (typed) { setPoint({ name: q, coords: typed }); setPinMode(false); return; }
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
      // Only pre-fills the radius next time; the lock itself is armed.
      setLockSettings({ lastRadius: clampRadius(radius) }).catch(() => {});
      if (!r.killSafe) {
        Alert.alert(
          'Background protection off',
          'The lock works while the app is open. Allow location "all the time" to keep protecting after the app is closed.',
          [{ text: 'Not now' }, { text: 'Allow', onPress: askKillSafe }],
        );
      } else if (Platform.OS === 'android') {
        // OEM battery killers are the #1 cause of silently dropped geofences
        // (design.md risk) — offer the exemption once monitoring is kill-safe.
        try {
          if (await notifee.isBatteryOptimizationEnabled()) {
            Alert.alert(
              'Keep the lock reliable',
              'Battery optimization can pause background monitoring. Exempt crazzychat so the alarm always fires.',
              [{ text: 'Later' }, { text: 'Open settings', onPress: () => { notifee.openBatteryOptimizationSettings().catch(() => {}); } }],
            );
          }
        } catch {}
      }
    } catch (e: unknown) {
      // armLock can reject (e.g. no GPS fix in time) — that used to vanish,
      // leaving the user believing the spot was locked.
      Alert.alert('Could not lock', userErrorText(e, 'Could not read your position. Check GPS and try again.'));
    } finally { setArming(false); }
  };

  const accWarn = accuracy != null && radius < 2 * accuracy;
  const previewLock = useMemo(
    () => (point ? { center: point.coords, radius: clampRadius(radius), color: zoneColor('safe') } : null),
    [point, radius],
  );
  const setupMapData = useMemo(() => ({ shape: [], pos: myPos, dest: null, heading: 0 }), [myPos]);

  // ═══ ACTIVE ═══ (components/lock/LockActiveFace.tsx)
  if (lock.active && lock.center) return <LockActiveFace myPos={myPos} />;

  // ═══ SETUP ═══
  return (
    <View style={st.screen}>
      <AuroraBackground />
      {/* headerShown explicitly, as on the active face: the root stack hides
          headers app-wide, so without it this face had no back control and
          sat under the status bar. */}
      <Stack.Screen options={{ headerShown: true, title: 'Location Lock', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={st.setup} keyboardShouldPersistTaps="handled">
        <Text style={[st.h, { color: colors.text }]} accessibilityRole="header">Lock point</Text>
        {locDenied && (
          <View style={[st.warn, { backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassStroke, marginTop: 0, marginBottom: 10 }]}>
            <Ionicons name="location-outline" size={16} color={colors.danger} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>Location permission needed</Text>
              <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 2 }}>
                Location Lock can’t monitor a spot without your position. You can still pick one by search or pin.
              </Text>
            </View>
            <TouchableOpacity onPress={() => { Linking.openSettings().catch(() => {}); }} accessibilityRole="button"
              accessibilityLabel="Open settings to allow location" hitSlop={12}>
              <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 13 }}>Settings</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={[st.row, { gap: 8 }]}>
          <TouchableOpacity onPress={pickCurrent} disabled={locating} accessibilityRole="button"
            accessibilityState={{ busy: locating, disabled: locating }} style={[st.srcBtn, { borderColor: colors.glassStroke }]}>
            {locating ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="locate" size={16} color={colors.primary} />}
            <Text style={{ color: colors.text, fontSize: 13 }}>Current location</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setPinMode((v) => !v)} accessibilityRole="switch" accessibilityState={{ checked: pinMode }}
            accessibilityLabel="Drop pin on map" accessibilityHint="When on, tap the map to place the lock point"
            style={[st.srcBtn, { borderColor: pinMode ? colors.primary : colors.border, backgroundColor: pinMode ? colors.primary + '14' : 'transparent' }]}>
            <Ionicons name="pin" size={16} color={pinMode ? colors.primary : colors.text} />
            <Text style={{ color: pinMode ? colors.primary : colors.text, fontSize: 13 }}>
              {pinMode ? 'Tap map to drop pin' : 'Drop pin on map'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={[st.searchRow, { borderColor: colors.glassStroke, backgroundColor: colors.glass, marginTop: 10 }]}>
          <Ionicons name="search" size={18} color={colors.textDim} />
          <TextInput
            value={query} onChangeText={setQuery} onSubmitEditing={search} returnKeyType="search"
            placeholder='Address or "lat, lng"' placeholderTextColor={colors.textFaint}
            accessibilityLabel="Search for a lock point by address or lat, lng"
            style={[st.input, { color: colors.text }]}
          />
          {searching ? <ActivityIndicator size="small" color={colors.primary} />
            : <TouchableOpacity onPress={search} accessibilityRole="button" accessibilityLabel="Find lock point" hitSlop={12}><Text style={{ color: colors.primary, fontWeight: '700' }}>Find</Text></TouchableOpacity>}
        </View>

        {/* Saved places (lock type: saved location) — one tap sets both point
            and radius. Sourced read-only from the user's saved place list. */}
        {savedFailed && (
          <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 10 }} accessibilityLiveRegion="polite">
            Couldn’t load your saved places. Search, use your location or drop a pin instead.
          </Text>
        )}
        {saved.length > 0 && (
          <View style={{ marginTop: 12 }}>
            <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '700', marginBottom: 6 }} accessibilityRole="header">SAVED PLACES</Text>
            <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Saved places">
              {saved.map((p) => {
                // Name AND position: two saved places may share a name.
                const on = point?.name === p.name && point.coords.lat === p.coords.lat && point.coords.lng === p.coords.lng;
                return (
                <TouchableOpacity key={`${p.name}@${p.coords.lat},${p.coords.lng}`}
                  onPress={() => { setPoint({ name: p.name, coords: p.coords }); setRadius(clampRadius(p.radiusM)); setCustomR(''); setPinMode(false); }}
                  accessibilityRole="radio" accessibilityState={{ checked: on }}
                  style={[chipSt.chip, { borderColor: on ? colors.primary : colors.border, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
                  <Ionicons name="bookmark" size={12} color={colors.primary} />
                  <Text numberOfLines={1} style={{ color: colors.text, fontSize: 12.5 }}>{p.name}</Text>
                </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {point && (
          <View style={[st.destPill, { backgroundColor: colors.primary + '14' }]}>
            <Ionicons name="location" size={16} color={colors.primary} />
            <Text numberOfLines={1} style={{ color: colors.text, flex: 1 }}>{point.name}</Text>
            <Text style={{ color: colors.textDim, fontSize: 12 }}>
              {point.coords.lat.toFixed(5)}, {point.coords.lng.toFixed(5)}
            </Text>
          </View>
        )}

        <NavMap
          data={setupMapData}
          follow={false}
          lock={previewLock}
          accuracyM={accuracy ?? 0}
          pin={point?.coords ?? null}
          pinMode={pinMode}
          onPinDrop={(p) => setPoint({ name: 'Dropped pin', coords: p })}
          zoomControls
          imperialScale={settings.units === 'imperial'}
          style={[st.previewMap, { borderColor: colors.glassStroke }]}
        />

        <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Mode</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Mode">
          {MODES.map((m) => (
            <TouchableOpacity key={m.key}
              onPress={() => setMode(m.key)}
              accessibilityRole="radio" accessibilityState={{ checked: settings.mode === m.key }}
              style={[chipSt.chip, {
                flexDirection: 'row', alignItems: 'center', gap: 5,
                borderColor: settings.mode === m.key ? colors.primary : colors.border,
                backgroundColor: settings.mode === m.key ? colors.primary + '1a' : 'transparent',
              }]}>
              <Ionicons name={m.icon} size={13} color={settings.mode === m.key ? colors.primary : colors.text} />
              <Text style={{ color: settings.mode === m.key ? colors.primary : colors.text, fontSize: 13, fontWeight: settings.mode === m.key ? '700' : '500' }}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Radius</Text>
        <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Radius">
          {RADII.map((r) => (
            <Chip key={r} radio active={radius === r} label={r >= 1000 ? '1 km' : `${r} m`}
              onPress={() => { setRadius(r); setCustomR(''); }} colors={colors} />
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
            placeholderTextColor={colors.textFaint}
            accessibilityLabel="Custom radius in metres, 10 to 1000"
            style={[st.customInput, { color: colors.text, borderColor: colors.glassStroke, backgroundColor: colors.glass }]}
          />
          <Text style={{ color: colors.textDim, fontSize: 13 }}>→ {clampRadius(radius)} m</Text>
        </View>
        {accWarn && (
          <View style={[st.warn, { backgroundColor: ALARM.grace + '22' }]}>
            <Ionicons name="warning" size={15} color={ALARM.grace} />
            <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>
              GPS accuracy is ±{Math.round(accuracy!)} m — a {clampRadius(radius)} m radius may false-alarm.
              Consider {clampRadius(Math.ceil((accuracy! * 2) / 10) * 10)} m or more.
            </Text>
          </View>
        )}

        <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Alerts</Text>
        <View style={[st.row, { gap: 8 }]}>
          <TouchableOpacity onPress={() => router.push('/lock-settings')} accessibilityRole="button" accessibilityHint="Opens alarm and alert settings" style={[st.srcBtn, { borderColor: colors.glassStroke, flex: 1 }]}>
            <Ionicons name="options" size={16} color={colors.primary} />
            {/* Shrinks and wraps: with every alert on, the summary is wider than a phone row. */}
            <Text style={{ color: colors.text, fontSize: 13, flexShrink: 1 }}>
              {[settings.alerts.siren && 'Siren', settings.alerts.continuousBeep && 'Beep', settings.alerts.vibration && 'Vibration',
                settings.alerts.voice && 'Voice', settings.alerts.flash && 'Flash']
                .filter(Boolean).join(' · ') || 'All off'} · {settings.alerts.graceS}s grace
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={testAlarmAndSay} accessibilityRole="button" accessibilityLabel="Test the alarm" style={[st.srcBtn, { borderColor: colors.glassStroke }]}>
            <Ionicons name="play" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 13 }}>Test</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity disabled={!point || arming} onPress={arm}
          accessibilityRole="button" accessibilityLabel="Lock this location and start monitoring"
          accessibilityState={{ disabled: !point || arming, busy: arming }}
          accessibilityHint={point ? undefined : 'Pick a lock point first'}
          style={[st.lockBtn, { backgroundColor: point ? colors.primary : colors.border }]}>
          {arming ? <ActivityIndicator color={colors.onPrimary} />
            : <><Ionicons name="lock-closed" size={18} color={colors.onPrimary} /><Text style={[st.lockTxt, { color: colors.onPrimary }]}>Lock Location</Text></>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/lock-history')} accessibilityRole="button" hitSlop={12} style={{ alignSelf: 'center', marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13.5 }}>History & statistics</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  setup: { padding: 16, paddingBottom: 48 },
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  row: { flexDirection: 'row', alignItems: 'center' },
  // 2026-09-17: srcBtn pinned a height around its label. At font scale 1.5 the
  // line box outgrew the box and the descenders went. minHeight grows with the
  // text and keeps it at or above the 44dp tap floor.
  srcBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 44, paddingVertical: 6 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, paddingVertical: 8 },
  input: { flex: 1, fontSize: 15 },
  destPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 10 },
  previewMap: { height: 230, borderRadius: 14, borderWidth: 1, marginTop: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  customInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 42, paddingVertical: 6, fontSize: 14 },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, marginTop: 10 },
  lockBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, paddingVertical: 10, borderRadius: 14, marginTop: 28 },
  lockTxt: { fontSize: 16, fontWeight: '800' },
});
