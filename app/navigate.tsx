// app/navigate.tsx — the navigation screen. Pick a destination + a Direction-Lock
// profile, hit Start; the haptic engine guides you via vibration + the mini
// banner, and once active the live map (NavMap) becomes the hero with the route,
// destination, and a moving "you" dot. Real flow against self-hosted Valhalla.

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator, Platform } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { geocodeSearch, type GeoHit } from '../lib/nav/geocode';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useTheme } from '../lib/theme';
import { tint } from '../lib/tintColor';
import { LOCATION_LOCK } from '../constants/flags';
import { useLockView } from '../lib/lock/lockService';
import { useNavSettings, setNavSettings, loadNavSettings } from '../lib/nav/navSettings';
import { startNavigation, stopNavigation, forceReroute, useNavBanner, type NavGeo } from '../lib/nav/navigationService';
import { fetchRoutes, type Route } from '../lib/nav/routing';
import NavBanner from '../components/nav/NavBanner';
import NavMap from '../components/nav/NavMap';
import { type NavProfile } from '../lib/nav/hapticLanguage';
import { type DisplayMode } from '../lib/nav/hapticPlayer';
import { type LatLng } from '../lib/nav/geo';
import { typedCoords, inLatLngRange } from '../lib/nav/urlCoords';
import { navErrorText } from '../lib/nav/navErrorText';

const PROFILES: { key: NavProfile; label: string }[] = [
  { key: 'standard', label: 'Standard' }, { key: 'strong', label: 'Strong' },
  { key: 'minimal', label: 'Minimal' }, { key: 'rider', label: 'Rider' },
  // 'custom' is not offered: there is no editor for it anywhere, and with the
  // default empty map it vibrates for nothing. Add it back with an editor.
];
// Voice guidance ships with v2 (expo-speech via lib/nav/voiceGuide).
const MODES: { key: DisplayMode; label: string }[] = [
  { key: 'vibrationOnly', label: 'Vibration only' },
  { key: 'everything', label: 'Voice + banner + vibration' },
  { key: 'voiceVibration', label: 'Voice + vibration' },
  { key: 'voiceBanner', label: 'Voice + banner' },
  { key: 'bannerOnly', label: 'Banner only' },
];

export default function NavigateScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  // Native header: the root layout adds no bottom inset, so the active sheet
  // clears the home indicator itself.
  const insets = useSafeAreaInsets();
  const s = useNavSettings();
  const banner = useNavBanner();
  const lock = useLockView();
  const params = useLocalSearchParams<{ lat?: string; lng?: string; name?: string }>();

  const [query, setQuery] = useState('');
  const [dest, setDest] = useState<{ name: string; coords: LatLng } | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [preview, setPreview] = useState<NavGeo | null>(null);
  // Primary route + any genuine Valhalla alternatives (never invented — the
  // chips render only when the engine actually returned more than one).
  const [routes, setRoutes] = useState<Route[]>([]);
  const [routeSel, setRouteSel] = useState(0);
  /** Why there is no route preview, when there should be one. Null = fine. */
  const [previewNote, setPreviewNote] = useState<string | null>(null);

  useEffect(() => { loadNavSettings(); }, []);
  // A 'custom' profile saved by an earlier build has an empty pattern map, i.e.
  // silent guidance. Fall back to Standard rather than navigate without a buzz.
  useEffect(() => { if (s.profile === 'custom') setNavSettings({ profile: 'standard' }); }, [s.profile]);

  // Setup preview: as soon as a destination is chosen, show it on the map with
  // your current position and a preview of the route (best-effort; the pin shows
  // instantly even before location/route resolve).
  useEffect(() => {
    if (!dest) { setPreview(null); setPreviewNote(null); return; }
    let cancel = false;
    (async () => {
      let pos: LatLng | null = null;
      let note: string | null = null;
      try {
        const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        pos = { lat: cur.coords.latitude, lng: cur.coords.longitude };
      } catch {
        // No permission/fix yet — still show the destination pin, and say why
        // there is no route rather than leaving the map to look finished.
        note = 'Your position isn’t available yet, so there’s no route preview. Check location permission and GPS.';
      }
      let rts: Route[] = [];
      if (pos) {
        try {
          rts = await fetchRoutes(pos, dest.coords, s.costing, s.routeOpts);
          if (!rts.length) note = 'No route was found to this destination for this travel mode. Try another travel mode or a nearby point.';
        } catch { note = 'Couldn’t preview a route right now. You can still start; the route is fetched again then.'; }
      }
      if (!cancel) {
        setRoutes(rts);
        setRouteSel(0);
        setPreviewNote(note);
        setPreview({ shape: rts[0]?.shape ?? [], pos, dest: dest.coords, heading: 0 });
      }
    })();
    return () => { cancel = true; };
  // Keyed on the route options too: toggling Shortest / Avoid tolls during
  // setup must re-fetch the preview (setRouteOpt reroutes only while active).
  // The settings store keeps the routeOpts object until it is patched, and
  // setRouteOpt patches only on a real change, so the reference is the key.
  }, [dest, s.costing, s.routeOpts]);
  useEffect(() => {
    if (params.lat && params.lng) {
      const c = { lat: Number(params.lat), lng: Number(params.lng) };
      if (inLatLngRange(c.lat, c.lng)) setDest({ name: params.name || 'Destination', coords: c });
      else Alert.alert('Not a valid position', 'The link’s destination isn’t a valid position. Search for the place instead.');
    }
  }, [params.lat, params.lng, params.name]);

  // Type-ahead: debounced /nav/geocode suggestions (server-proxied Photon/OSM —
  // works on no-GMS where Location.geocodeAsync is dead). Coordinates still parse
  // instantly without any geocoder.
  const [sugs, setSugs] = useState<GeoHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || /^\s*-?\d+(\.\d+)?\s*,/.test(q)) { setSugs([]); return; }
    let stale = false;   // a slow answer to an older query must not overwrite a newer one
    const t = setTimeout(async () => {
      try {
        const near = await Location.getLastKnownPositionAsync().catch(() => null);
        const hits = await geocodeSearch(q, near ? { lat: near.coords.latitude, lng: near.coords.longitude } : null);
        if (!stale) setSugs(hits);
      } catch { if (!stale) setSugs([]); }
    }, 350);
    return () => { stale = true; clearTimeout(t); };
  }, [query]);
  const pickSug = (h: GeoHit) => { setSugs([]); setQuery(h.label); setDest({ name: h.name || h.label, coords: { lat: h.lat, lng: h.lng } }); };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    // "lat, lng" works everywhere (no geocoder needed) — try it first.
    const typed = typedCoords(q);
    if (typed === 'out-of-range') {
      Alert.alert('Not a valid position', 'Latitude must be between -90 and 90, longitude between -180 and 180.');
      return;
    }
    if (typed) { setDest({ name: q, coords: typed }); return; }
    setSearching(true);
    try {
      const hits = await geocodeSearch(q).catch(() => [] as GeoHit[]);
      if (!mounted.current) return;
      if (hits[0]) { pickSug(hits[0]); return; }
      const res = await Location.geocodeAsync(q);   // platform fallback (GMS devices)
      if (!mounted.current) return;
      if (res[0]) setDest({ name: q, coords: { lat: res[0].latitude, lng: res[0].longitude } });
      else Alert.alert('Not found', 'No match — try a nearby landmark, or enter coordinates as "lat, lng".');
    } catch {
      if (mounted.current) Alert.alert('Search failed', 'Check your connection, or enter coordinates as "lat, lng".');
    } finally { if (mounted.current) setSearching(false); }
  };

  const start = async () => {
    if (!dest) return;
    setStarting(true);
    try {
      // The alternative the user picked is the one driven. Only an alternative
      // is handed over: the primary keeps being fetched fresh from the current
      // fix, exactly as before.
      const chosen = routeSel > 0 ? routes[routeSel] : undefined;
      await startNavigation({ to: dest.coords, profile: s.profile, mode: s.mode, timing: s.timing, costing: s.costing, custom: s.custom, routeOpts: s.routeOpts, route: chosen });
    } catch (e: unknown) {
      Alert.alert('Could not start', navErrorText(e, 'Could not plan the route. Check your location is on and try again.'));
    } finally { if (mounted.current) setStarting(false); }
  };

  const setRouteOpt = (patch: Partial<typeof s.routeOpts>) => {
    // Re-tapping the checked radio is not a change: no refetch, no reroute.
    if ((Object.keys(patch) as (keyof typeof patch)[]).every((k) => !!s.routeOpts[k] === !!patch[k])) return;
    const routeOpts = { ...s.routeOpts, ...patch };
    setNavSettings({ routeOpts });
    if (banner.active) forceReroute(routeOpts);   // live change → recalc now
  };

  return (
    <View style={[st.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Navigate', headerTitleAlign: 'center' }} />

      {/* Live banner while navigating */}
      <NavBanner />

      {banner.active ? (
        <View style={{ flex: 1 }}>
          <NavMap style={{ flex: 1 }} />
          {/* overall route progress (v2.1) */}
          {banner.totalM > 0 && (
            <View style={{ height: 3, backgroundColor: colors.border }}>
              <View style={{
                height: 3, backgroundColor: colors.primary,
                width: `${Math.round(Math.max(0, Math.min(1, 1 - banner.remainingM / banner.totalM)) * 100)}%`,
              }} />
            </View>
          )}
          <View style={[st.sheet, { backgroundColor: colors.glassSoft, borderTopColor: colors.glassStroke, paddingBottom: 22 + insets.bottom }]}>
            <View style={{ flex: 1 }}>
              {/* The next instruction and road live in NavBanner (with its live
                  region); repeating them here made screen readers read each
                  turn twice. The sheet carries the trip summary. */}
              {/* The remaining distance and the ETA are shown once each: the
                  distance here, the ETA in NavBanner. */}
              <Text numberOfLines={1} style={[st.sheetInstr, { color: colors.text }]}>
                {banner.remainingM >= 1000 ? `${(banner.remainingM / 1000).toFixed(1)} km` : `${Math.round(banner.remainingM)} m`} to go
              </Text>
              <Text numberOfLines={1} style={{ color: colors.textDim, fontSize: 12.5, marginTop: 2 }}>
                {dest ? dest.name : 'Navigating'}
              </Text>
            </View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Find a new route" onPress={() => forceReroute()} disabled={banner.rerouting}
              style={[st.rerouteBtn, { borderColor: colors.primary, opacity: banner.rerouting ? 0.5 : 1 }]}>
              <Ionicons name="git-branch" size={16} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => stopNavigation()} accessibilityRole="button" accessibilityLabel="End navigation" style={[st.endBtn, { backgroundColor: colors.danger }]}>
              <Ionicons name="stop" size={16} color={colors.onDanger} />
              <Text style={[st.endTxt, { color: colors.onDanger }]}>End</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={st.setup} keyboardShouldPersistTaps="handled">
          {/* Location Lock — geofence utility (openspec: location-lock) */}
          {LOCATION_LOCK && (
            <TouchableOpacity onPress={() => router.push('/location-lock')}
              accessibilityRole="button"
              accessibilityLabel={lock.active
                ? `Location Locked, ${Math.round(lock.distance)} of ${Math.round(lock.radius)} metres, ${(lock.state ?? 'safe')}`
                : 'Location Lock'}
              accessibilityHint={lock.active ? 'Opens the active lock' : 'Lock a spot and get alarmed if you leave it'}
              style={[st.lockEntry, { borderColor: lock.active ? colors.success : colors.border, backgroundColor: colors.glassSoft }]}>
              <View style={[st.lockEntryIcon, { backgroundColor: tint(lock.active ? colors.success : colors.primary, 0.1) }]}>
                <Ionicons name={lock.active ? 'lock-closed' : 'radio-button-on'} size={20}
                  color={lock.active ? colors.success : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14.5 }}>
                  {lock.active ? 'Location Locked' : 'Location Lock'}
                </Text>
                <Text style={{ color: colors.textDim, fontSize: 12.5, marginTop: 1 }}>
                  {lock.active
                    ? `${Math.round(lock.distance)} m of ${Math.round(lock.radius)} m · ${(lock.state ?? 'safe').toUpperCase()}`
                    : 'Lock a spot, get alarmed if you leave it'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>
          )}

          {/* destination */}
          <Text style={[st.h, { color: colors.text }]} accessibilityRole="header">Destination</Text>
          <View style={[st.searchRow, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
            <Ionicons name="search" size={18} color={colors.textDim} />
            <TextInput
              value={query} onChangeText={setQuery} onSubmitEditing={search} returnKeyType="search"
              accessibilityLabel="Destination" accessibilityHint='Type an address or place, or "lat, lng"'
              placeholder='Address or "lat, lng"' placeholderTextColor={colors.textFaint}
              style={[st.input, { color: colors.text }]}
            />
            {searching ? <ActivityIndicator size="small" color={colors.primary} />
              : <TouchableOpacity onPress={search} accessibilityRole="button" accessibilityLabel="Find destination" hitSlop={12}><Text style={{ color: colors.primary, fontWeight: '700' }}>Find</Text></TouchableOpacity>}
          </View>
          {sugs.length > 0 && (
            <View style={[st.sugBox, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              {sugs.map((h, i) => (
                <TouchableOpacity key={`${h.lat},${h.lng},${h.label}`} onPress={() => pickSug(h)} accessibilityRole="button"
                  style={[st.sugRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.glassStroke }]}>
                  <Ionicons name="location-outline" size={16} color={colors.primary} />
                  <Text numberOfLines={1} style={{ color: colors.text, flex: 1, fontSize: 14 }}>{h.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {dest && (
            <View style={[st.destPill, { backgroundColor: tint(colors.primary, 0.08) }]}>
              <Ionicons name="flag" size={16} color={colors.primary} />
              <Text numberOfLines={1} style={{ color: colors.text, flex: 1 }}>{dest.name}</Text>
              <Text style={{ color: colors.textFaint, fontSize: 12 }}>{dest.coords.lat.toFixed(4)}, {dest.coords.lng.toFixed(4)}</Text>
            </View>
          )}
          {dest && (
            <NavMap
              data={preview ?? { shape: [], pos: null, dest: dest.coords, heading: 0 }}
              follow={false}
              style={[st.previewMap, { borderColor: colors.glassStroke }]}
            />
          )}
          {dest && previewNote && (
            <Text accessibilityLiveRegion="polite" style={{ color: colors.textDim, fontSize: 12.5, marginTop: 8 }}>{previewNote}</Text>
          )}

          {/* Route summary + alternatives (Google-style). Chips appear only
              when Valhalla genuinely returned more than one distinct route. */}
          {routes.length > 0 && (
            <View style={{ marginTop: 10 }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14.5 }}>
                {(routes[routeSel].lengthM / 1000).toFixed(1)} km · {Math.round(routes[routeSel].timeS / 60)} min
                {' · ETA '}{new Date(Date.now() + routes[routeSel].timeS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
              {routes.length > 1 && (
                <View style={[st.chips, { marginTop: 8 }]} accessibilityRole="radiogroup" accessibilityLabel="Route">
                  {routes.map((r, i) => (
                    <Chip
                      key={i}
                      role="radio"
                      active={routeSel === i}
                      label={`${i === 0 ? 'Fastest' : `Alt ${i}`} · ${Math.round(r.timeS / 60)} min`}
                      onPress={() => {
                        setRouteSel(i);
                        setPreview((p) => (p ? { ...p, shape: r.shape } : p));
                      }}
                    />
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Direction Lock — locked for the trip once you start */}
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Direction Lock (vibration profile)</Text>
          <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Vibration profile">
            {PROFILES.map((p) => <Chip key={p.key} role="radio" active={s.profile === p.key} label={p.label} onPress={() => setNavSettings({ profile: p.key })} />)}
          </View>

          {/* guidance mode */}
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Guidance</Text>
          <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Guidance">
            {MODES.map((m) => <Chip key={m.key} role="radio" active={s.mode === m.key} label={m.label} onPress={() => setNavSettings({ mode: m.key })} />)}
          </View>

          {/* timing + travel mode */}
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Alert timing</Text>
          <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Alert timing">
            {(['early', 'normal', 'late'] as const).map((t) => <Chip key={t} role="radio" active={s.timing === t} label={t[0].toUpperCase() + t.slice(1)} onPress={() => setNavSettings({ timing: t })} />)}
          </View>
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Travel mode</Text>
          <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Travel mode">
            {(['auto', 'motorcycle', 'bicycle', 'pedestrian', 'truck'] as const).map((c) => <Chip key={c} role="radio" active={s.costing === c} label={c === 'auto' ? 'Car' : c[0].toUpperCase() + c.slice(1)} onPress={() => setNavSettings({ costing: c })} />)}
          </View>

          {/* route preferences (v2) — forwarded to Valhalla costing_options */}
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]} accessibilityRole="header">Route options</Text>
          <View style={st.chips}>
            <View style={st.chips} accessibilityRole="radiogroup" accessibilityLabel="Route preference">
              <Chip role="radio" active={!s.routeOpts.shortest} label="Fastest" onPress={() => setRouteOpt({ shortest: false })} />
              <Chip role="radio" active={!!s.routeOpts.shortest} label="Shortest" onPress={() => setRouteOpt({ shortest: true })} />
            </View>
            <Chip role="checkbox" active={!!s.routeOpts.avoidTolls} label="Avoid tolls" onPress={() => setRouteOpt({ avoidTolls: !s.routeOpts.avoidTolls })} />
            <Chip role="checkbox" active={!!s.routeOpts.avoidHighways} label="Avoid highways" onPress={() => setRouteOpt({ avoidHighways: !s.routeOpts.avoidHighways })} />
          </View>

          <TouchableOpacity disabled={!dest || starting} onPress={start} accessibilityRole="button"
            accessibilityState={{ disabled: !dest || starting, busy: starting }}
            style={[st.startBtn, { backgroundColor: dest ? colors.primary : colors.border }]}>
            {starting ? <ActivityIndicator color={colors.onPrimary} />
              : <><Ionicons name="navigate" size={18} color={colors.onPrimary} /><Text style={[st.startTxt, { color: colors.onPrimary }]}>Start navigation</Text></>}
          </TouchableOpacity>
          {Platform.OS === 'ios' && <Text style={{ color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 10 }}>iOS plays intensity accents; Android plays the full vibration patterns.</Text>}
        </ScrollView>
      )}
    </View>
  );
}

// Hoisted: defined inside the screen it was a new component type every render,
// so React remounted every chip on each GPS/banner update.
// Single-choice groups use radios (inside a radiogroup), on/off options checkboxes.
function Chip({ active, label, onPress, role }: { active: boolean; label: string; onPress: () => void; role: 'radio' | 'checkbox' }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity onPress={onPress}
      accessibilityRole={role} accessibilityState={{ checked: active }}
      style={[st.chip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? tint(colors.primary, 0.1) : 'transparent' }]}>
      <Text style={{ color: active ? colors.primary : colors.text, fontWeight: active ? '700' : '500', fontSize: 13.5 }}>{label}</Text>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1 },
  setup: { padding: 16, paddingBottom: 48 },
  lockEntry: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderRadius: 14, padding: 12, marginBottom: 20 },
  lockEntryIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  // 2026-09-17: searchRow, startBtn and endBtn each pinned a height around a
  // 14-16sp label; at font scale 1.5 the line box outgrew the box and clipped.
  // minHeight is the same size at scale 1.0 and stays over the 44dp tap floor.
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 48, paddingVertical: 8 },
  sugBox: { borderWidth: 1, borderRadius: 12, marginTop: 6, overflow: 'hidden' },
  sugRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 11, minHeight: 44 },
  input: { flex: 1, fontSize: 15 },
  destPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 10 },
  previewMap: { height: 210, borderRadius: 14, borderWidth: 1, marginTop: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // minHeight: the 13.5sp label + 8pt padding made a ~36pt chip, under the 44pt tap floor.
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, minHeight: 44, justifyContent: 'center' },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 52, paddingVertical: 10, borderRadius: 14, marginTop: 30 },
  startTxt: { fontSize: 16, fontWeight: '800' },
  sheet: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
  sheetInstr: { fontSize: 17, fontWeight: '800' },
  endBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingVertical: 8, paddingHorizontal: 18, borderRadius: 12 },
  rerouteBtn: { alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 12, borderWidth: 1.5 },
  endTxt: { fontSize: 14, fontWeight: '800' },
});
