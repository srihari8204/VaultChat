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
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, Platform, AppState, Linking,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import notifee from '@notifee/react-native';
import { useTheme } from '../lib/theme';
import type { Palette } from '../constants/theme';
import { permissionDenied } from '../lib/permissionDenied';
import { ALARM } from '../lib/lock/alarmPalette';
import { typedCoords } from '../lib/nav/urlCoords';
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
import { AppText as Text, AuroraBackground } from '../components/ui';

const RADII = [10, 20, 30, 50, 100, 200, 500, 1000];
const MODES: { key: LockMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
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

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

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

/** Radius / navigate-back chip. `busy` is for an action in flight: a chip that
 *  is PLANNING is not "selected", and announcing it so was wrong. */
function Chip({ active: on, busy = false, disabled = false, label, onPress, colors }: {
  active: boolean; busy?: boolean; disabled?: boolean; label: string; onPress: () => void; colors: Palette;
}) {
  const lit = on || busy;
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled}
      accessibilityRole="button" accessibilityState={{ selected: on, busy, disabled }}
      style={[st.chip, { borderColor: lit ? colors.primary : colors.border, backgroundColor: lit ? colors.primary + '1a' : 'transparent', opacity: disabled && !busy ? 0.5 : 1 }]}>
      <Text style={{ color: lit ? colors.primary : colors.text, fontWeight: lit ? '700' : '500', fontSize: 13.5 }}>{label}</Text>
    </TouchableOpacity>
  );
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
  /** The mode whose route back is being planned; Navigate opens only once it exists. */
  const [planning, setPlanning] = useState<Costing | null>(null);
  const [saved, setSaved] = useState<{ name: string; coords: LatLng; radiusM: number }[]>([]);
  /** Saved places could not be read. Shown as a line, not as "no places". */
  const [savedFailed, setSavedFailed] = useState(false);
  /** Location permission is refused: the screen says so and offers Settings
   *  instead of showing a map with no "you" and no explanation. */
  const [locDenied, setLocDenied] = useState(false);
  const [locating, setLocating] = useState(false);

  // First fix for the setup map. `ask` is false when re-checking on return
  // from Settings, so coming back never throws a prompt at the user.
  const firstFix = useCallback(async (ask: boolean) => {
    try {
      const p = ask ? await Location.requestForegroundPermissionsAsync() : await Location.getForegroundPermissionsAsync();
      if (p.status !== 'granted') { setLocDenied(true); return; }
      setLocDenied(false);
      const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
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
      Alert.alert('Location Lock', `Couldn’t resume monitoring: ${errText(e, 'unknown error')}. Check location permission and GPS.`);
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
        setSaved(all.slice(0, 12));
      } catch { setSavedFailed(true); }
    })();
    firstFix(true);
  }, [firstFix]);

  // Denied: the only way forward is Settings, so re-check on return.
  useEffect(() => {
    if (!locDenied) return;
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') firstFix(false); });
    return () => sub.remove();
  }, [locDenied, firstFix]);

  const useCurrent = async () => {
    if (locating) return;
    setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setLocDenied(true);
        permissionDenied('Location permission needed', 'Location Lock needs your position to lock the spot you are standing on.', perm.canAskAgain);
        return;
      }
      setLocDenied(false);
      const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const c = { lat: cur.coords.latitude, lng: cur.coords.longitude };
      setMyPos(c);
      setAccuracy(cur.coords.accuracy ?? null);
      setPoint({ name: 'Current location', coords: c });
      setPinMode(false);
    } catch {
      Alert.alert('No fix', 'Could not read your position. Check that GPS is on and try again.');
    } finally { setLocating(false); }
  };

  const setMode = (mode: LockMode) => {
    setLockSettings({ mode }).then(() => applyAlertSettings()).catch((e: unknown) => {
      Alert.alert('Mode not saved', `${errText(e, 'Could not save the lock mode')}. The new mode applies now but will not survive an app restart.`);
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
          [{ text: 'Not now' }, { text: 'Allow', onPress: () => { enableKillSafe(); } }],
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
      Alert.alert('Could not lock', errText(e, 'Could not read your position. Check GPS and try again.'));
    } finally { setArming(false); }
  };

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

  const accWarn = accuracy != null && radius < 2 * accuracy;
  // The live "you" marker comes from the engine's accepted fixes (lock.pos);
  // myPos — the one-off setup fix — is only the fallback until the first one.
  // Memoised so the 1 s ticker does not hand NavMap a new object every second.
  const activeMapData = useMemo(
    () => ({ shape: [], pos: lock.pos ?? myPos, dest: null, heading: lock.heading }),
    [lock.pos, myPos, lock.heading],
  );
  const previewLock = useMemo(
    () => (point ? { center: point.coords, radius: clampRadius(radius), color: zoneColor('safe') } : null),
    [point, radius],
  );
  const setupMapData = useMemo(() => ({ shape: [], pos: myPos, dest: null, heading: 0 }), [myPos]);

  // ═══ ACTIVE ═══
  if (lock.active && lock.center) {
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

        <View style={[st.card, { backgroundColor: colors.glass, borderColor: zc }]}>
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
            <Stat label="GPS ±" value={fmtDistance(lock.accuracy, settings.units)} colors={colors} />
            <Ticking render={() => <Stat label="Locked" value={fmtDur(Date.now() - lock.armedAt)} colors={colors} />} />
            <Stat label="Speed" value={fmtSpeed(lock.speedKmh, settings.units)} colors={colors} />
            <Stat label="Heading" value={fmtHeading(lock.heading)} colors={colors} />
            <Stat label="Battery" value={lock.battery != null ? `${lock.battery}%${lock.charging ? ' ⚡' : ''}` : '—'} colors={colors} />
            <Stat label="Confidence" value={`${QUALITY_LABEL[lock.quality]} · ${gpsConfidence(lock.accuracy)}%`} colors={colors} valueColor={QUALITY_COLOR[lock.quality]} />
          </View>
          <Ticking render={() => (
            <Text style={{ color: colors.textFaint, fontSize: 11 }}>
              GPS updated {lock.lastFixAt ? fmtAgo(Date.now() - lock.lastFixAt) : '—'}
            </Text>
          )} />

          {!lock.killSafe && (
            <TouchableOpacity onPress={() => enableKillSafe()} accessibilityRole="button"
              accessibilityHint="Asks for location access all the time so the lock keeps working after the app is closed"
              style={[st.bgBanner, { borderColor: colors.glassStroke }]}>
              <Ionicons name="shield-half" size={15} color={colors.primary} />
              <Text style={{ color: colors.text, fontSize: 12.5, flex: 1 }}>
                Enable background protection (location “all the time”)
              </Text>
            </TouchableOpacity>
          )}

          {lock.state === 'outside' && !lock.navBack && (
            <View style={[st.row, { marginTop: 12, gap: 8 }]}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>Navigate back:</Text>
              <Chip active={false} busy={planning === 'pedestrian'} disabled={planning !== null} label="Walk" onPress={() => navBack('pedestrian')} colors={colors} />
              <Chip active={false} busy={planning === 'bicycle'} disabled={planning !== null} label="Cycle" onPress={() => navBack('bicycle')} colors={colors} />
              <Chip active={false} busy={planning === 'auto'} disabled={planning !== null} label="Drive" onPress={() => navBack('auto')} colors={colors} />
              {planning && <ActivityIndicator size="small" color={colors.primary} accessibilityLabel="Planning route back" />}
            </View>
          )}

          <View style={[st.row, { marginTop: 14, gap: 10 }]}>
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
          <TouchableOpacity onPress={useCurrent} disabled={locating} accessibilityRole="button"
            accessibilityState={{ busy: locating, disabled: locating }} style={[st.srcBtn, { borderColor: colors.glassStroke }]}>
            {locating ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="locate" size={16} color={colors.primary} />}
            <Text style={{ color: colors.text, fontSize: 13 }}>Current location</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setPinMode((v) => !v)} accessibilityRole="button" accessibilityState={{ selected: pinMode }}
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
            <Text style={{ color: colors.textDim, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>SAVED PLACES</Text>
            <View style={st.chips}>
              {saved.map((p) => (
                <TouchableOpacity key={`${p.name}@${p.coords.lat},${p.coords.lng}`}
                  onPress={() => { setPoint({ name: p.name, coords: p.coords }); setRadius(clampRadius(p.radiusM)); setCustomR(''); setPinMode(false); }}
                  accessibilityRole="button" accessibilityState={{ selected: point?.name === p.name }}
                  style={[st.chip, { borderColor: point?.name === p.name ? colors.primary : colors.border, flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
                  <Ionicons name="bookmark" size={12} color={colors.primary} />
                  <Text numberOfLines={1} style={{ color: colors.text, fontSize: 12.5 }}>{p.name}</Text>
                </TouchableOpacity>
              ))}
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
        <View style={st.chips}>
          {MODES.map((m) => (
            <TouchableOpacity key={m.key}
              onPress={() => setMode(m.key)}
              accessibilityRole="button" accessibilityState={{ selected: settings.mode === m.key }}
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

        <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Radius</Text>
        <View style={st.chips}>
          {RADII.map((r) => (
            <Chip key={r} active={radius === r} label={r >= 1000 ? '1 km' : `${r} m`}
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
          <TouchableOpacity onPress={() => router.push('/lock-settings')} accessibilityRole="button" accessibilityHint="Opens alarm and alert settings" style={[st.srcBtn, { borderColor: colors.glassStroke }]}>
            <Ionicons name="options" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 13 }}>
              {[settings.alerts.siren && 'Siren', settings.alerts.vibration && 'Vibration',
                settings.alerts.voice && 'Voice', settings.alerts.flash && 'Flash']
                .filter(Boolean).join(' · ') || 'All off'} · {settings.alerts.graceS}s grace
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => testAlarm()} accessibilityRole="button" accessibilityLabel="Test the alarm" style={[st.srcBtn, { borderColor: colors.glassStroke }]}>
            <Ionicons name="play" size={16} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 13 }}>Test</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity disabled={!point || arming} onPress={arm}
          accessibilityRole="button" accessibilityLabel="Lock this location and start monitoring"
          accessibilityState={{ disabled: !point || arming, busy: arming }}
          accessibilityHint={point ? undefined : 'Pick a lock point first'}
          style={[st.lockBtn, { backgroundColor: point ? colors.primary : colors.border }]}>
          {arming ? <ActivityIndicator color="#fff" />
            : <><Ionicons name="lock-closed" size={18} color="#fff" /><Text style={st.lockTxt}>Lock Location</Text></>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/lock-history')} accessibilityRole="button" hitSlop={12} style={{ alignSelf: 'center', marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13.5 }}>History & statistics</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, colors, valueColor }: { label: string; value: string; colors: Palette; valueColor?: string }) {
  return (
    <View>
      <Text style={{ color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase' }}>{label}</Text>
      <Text style={{ color: valueColor ?? colors.text, fontSize: 15.5, fontWeight: '800', marginTop: 1 }}>{value}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  setup: { padding: 16, paddingBottom: 48 },
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  row: { flexDirection: 'row', alignItems: 'center' },
  // 2026-09-17: these four all pinned a height around a 15/16sp label. At font
  // scale 1.5 the line box outgrew the box and the descenders went. minHeight
  // keeps every one of them the same size at scale 1.0 and above the 44dp floor.
  srcBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 40, paddingVertical: 6 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, paddingVertical: 8 },
  input: { flex: 1, fontSize: 15 },
  destPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 10 },
  previewMap: { height: 230, borderRadius: 14, borderWidth: 1, marginTop: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  customInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 42, paddingVertical: 6, fontSize: 14 },
  warn: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, marginTop: 10 },
  lockBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, paddingVertical: 10, borderRadius: 14, marginTop: 28 },
  lockTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  alarmBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  alarmBarTxt: { color: ALARM.ink, fontWeight: '800', fontSize: 13.5, flex: 1 },
  card: { borderTopWidth: 3, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 22 },
  stateDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  stateTxt: { fontWeight: '900', fontSize: 15, letterSpacing: 0.4 },
  bgBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, padding: 9, marginTop: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 12, minHeight: 40 },
  btnTxt: { fontWeight: '700', fontSize: 13.5 },
});
