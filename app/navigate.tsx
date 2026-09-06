// app/navigate.tsx — the navigation screen. Pick a destination + a Direction-Lock
// profile, hit Start; the haptic engine guides you via vibration + the mini
// banner, and once active the live map (NavMap) becomes the hero with the route,
// destination, and a moving "you" dot. Real flow against self-hosted Valhalla.

import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator, Platform } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { geocodeSearch, type GeoHit } from '../lib/nav/geocode';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useTheme } from '../lib/theme';
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

const PROFILES: { key: NavProfile; label: string }[] = [
  { key: 'standard', label: 'Standard' }, { key: 'strong', label: 'Strong' },
  { key: 'minimal', label: 'Minimal' }, { key: 'rider', label: 'Rider' }, { key: 'custom', label: 'Custom' },
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
  const s = useNavSettings();
  const banner = useNavBanner();
  const lock = useLockView();
  const params = useLocalSearchParams<{ lat?: string; lng?: string; name?: string }>();

  const [query, setQuery] = useState('');
  const [dest, setDest] = useState<{ name: string; coords: LatLng } | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState<NavGeo | null>(null);
  // Primary route + any genuine Valhalla alternatives (never invented — the
  // chips render only when the engine actually returned more than one).
  const [routes, setRoutes] = useState<Route[]>([]);
  const [routeSel, setRouteSel] = useState(0);

  useEffect(() => { loadNavSettings(); }, []);

  // Setup preview: as soon as a destination is chosen, show it on the map with
  // your current position and a preview of the route (best-effort; the pin shows
  // instantly even before location/route resolve).
  useEffect(() => {
    if (!dest) { setPreview(null); return; }
    let cancel = false;
    (async () => {
      let pos: LatLng | null = null;
      try {
        const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        pos = { lat: cur.coords.latitude, lng: cur.coords.longitude };
      } catch { /* no permission/fix yet — still show the destination pin */ }
      let rts: Route[] = [];
      if (pos) { try { rts = await fetchRoutes(pos, dest.coords, s.costing, s.routeOpts); } catch { /* route preview optional */ } }
      if (!cancel) {
        setRoutes(rts);
        setRouteSel(0);
        setPreview({ shape: rts[0]?.shape ?? [], pos, dest: dest.coords, heading: 0 });
      }
    })();
    return () => { cancel = true; };
  }, [dest, s.costing]);
  useEffect(() => {
    if (params.lat && params.lng) {
      const c = { lat: Number(params.lat), lng: Number(params.lng) };
      if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) setDest({ name: params.name || 'Destination', coords: c });
    }
  }, [params.lat, params.lng]);

  // Type-ahead: debounced /nav/geocode suggestions (server-proxied Photon/OSM —
  // works on no-GMS where Location.geocodeAsync is dead). Coordinates still parse
  // instantly without any geocoder.
  const [sugs, setSugs] = useState<GeoHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || /(-?\d+(\.\d+)?)\s*,/.test(q)) { setSugs([]); return; }
    const t = setTimeout(async () => {
      try {
        const near = await Location.getLastKnownPositionAsync().catch(() => null);
        const hits = await geocodeSearch(q, near ? { lat: near.coords.latitude, lng: near.coords.longitude } : null);
        setSugs(hits);
      } catch { setSugs([]); }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);
  const pickSug = (h: GeoHit) => { setSugs([]); setQuery(h.label); setDest({ name: h.name || h.label, coords: { lat: h.lat, lng: h.lng } }); };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    // "lat, lng" works everywhere (no geocoder needed) — try it first.
    const m = q.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m) { setDest({ name: q, coords: { lat: +m[1], lng: +m[2] } }); return; }
    setSearching(true);
    try {
      const hits = await geocodeSearch(q).catch(() => [] as GeoHit[]);
      if (hits[0]) { pickSug(hits[0]); return; }
      const res = await Location.geocodeAsync(q);   // platform fallback (GMS devices)
      if (res[0]) setDest({ name: q, coords: { lat: res[0].latitude, lng: res[0].longitude } });
      else Alert.alert('Not found', 'No match — try a nearby landmark, or enter coordinates as "lat, lng".');
    } catch {
      Alert.alert('Search failed', 'Check your connection, or enter coordinates as "lat, lng".');
    } finally { setSearching(false); }
  };

  const start = async () => {
    if (!dest) return;
    setStarting(true);
    try {
      await startNavigation({ to: dest.coords, profile: s.profile, mode: s.mode, timing: s.timing, costing: s.costing, custom: s.custom, routeOpts: s.routeOpts });
    } catch (e: any) {
      Alert.alert('Could not start', e?.message ?? 'Check location permission and that the routing engine is up.');
    } finally { setStarting(false); }
  };

  const setRouteOpt = (patch: Partial<typeof s.routeOpts>) => {
    const routeOpts = { ...s.routeOpts, ...patch };
    setNavSettings({ routeOpts });
    if (banner.active) forceReroute(routeOpts);   // live change → recalc now
  };

  const Chip = ({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) => (
    <TouchableOpacity onPress={onPress}
      style={[st.chip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + '1a' : 'transparent' }]}>
      <Text style={{ color: active ? colors.primary : colors.text, fontWeight: active ? '700' : '500', fontSize: 13.5 }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[st.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ title: 'Navigate', headerTitleAlign: 'center' }} />

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
          <View style={[st.sheet, { backgroundColor: colors.glassSoft, borderTopColor: colors.glassStroke }]}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[st.sheetInstr, { color: colors.text }]}>
                {banner.rerouting ? 'Rerouting…' : (banner.instruction || 'Continue')}
              </Text>
              <Text numberOfLines={1} style={{ color: colors.text + '88', fontSize: 12.5, marginTop: 2 }}>
                {banner.roadName ? banner.roadName + ' · ' : ''}
                {banner.remainingM >= 1000 ? `${(banner.remainingM / 1000).toFixed(1)} km` : `${Math.round(banner.remainingM)} m`} to go
                {banner.etaEpochMs > 0 ? ` · ETA ${new Date(banner.etaEpochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={() => forceReroute()} disabled={banner.rerouting}
              style={[st.rerouteBtn, { borderColor: colors.primary, opacity: banner.rerouting ? 0.5 : 1 }]}>
              <Ionicons name="git-branch" size={16} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => stopNavigation()} style={[st.endBtn, { backgroundColor: colors.danger }]}>
              <Ionicons name="stop" size={16} color="#fff" />
              <Text style={st.endTxt}>End</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={st.setup} keyboardShouldPersistTaps="handled">
          {/* Location Lock — geofence utility (openspec: location-lock) */}
          {LOCATION_LOCK && (
            <TouchableOpacity onPress={() => router.push('/location-lock')}
              style={[st.lockEntry, { borderColor: lock.active ? '#22C55E' : colors.border, backgroundColor: colors.glassSoft }]}>
              <View style={[st.lockEntryIcon, { backgroundColor: (lock.active ? '#22C55E' : colors.primary) + '1a' }]}>
                <Ionicons name={lock.active ? 'lock-closed' : 'radio-button-on'} size={20}
                  color={lock.active ? '#22C55E' : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '800', fontSize: 14.5 }}>
                  {lock.active ? 'Location Locked' : 'Location Lock'}
                </Text>
                <Text style={{ color: colors.text + '88', fontSize: 12.5, marginTop: 1 }}>
                  {lock.active
                    ? `${Math.round(lock.distance)} m of ${Math.round(lock.radius)} m · ${(lock.state ?? 'safe').toUpperCase()}`
                    : 'Lock a spot, get alarmed if you leave it'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.text + '66'} />
            </TouchableOpacity>
          )}

          {/* destination */}
          <Text style={[st.h, { color: colors.text }]}>Destination</Text>
          <View style={[st.searchRow, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
            <Ionicons name="search" size={18} color={colors.text + '99'} />
            <TextInput
              value={query} onChangeText={setQuery} onSubmitEditing={search} returnKeyType="search"
              placeholder='Address or "lat, lng"' placeholderTextColor={colors.text + '66'}
              style={[st.input, { color: colors.text }]}
            />
            {searching ? <ActivityIndicator size="small" color={colors.primary} />
              : <TouchableOpacity onPress={search}><Text style={{ color: colors.primary, fontWeight: '700' }}>Find</Text></TouchableOpacity>}
          </View>
          {sugs.length > 0 && (
            <View style={[st.sugBox, { borderColor: colors.glassStroke, backgroundColor: colors.glassSoft }]}>
              {sugs.map((h, i) => (
                <TouchableOpacity key={i} onPress={() => pickSug(h)}
                  style={[st.sugRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.glassStroke }]}>
                  <Ionicons name="location-outline" size={16} color={colors.primary} />
                  <Text numberOfLines={1} style={{ color: colors.text, flex: 1, fontSize: 14 }}>{h.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {dest && (
            <View style={[st.destPill, { backgroundColor: colors.primary + '14' }]}>
              <Ionicons name="flag" size={16} color={colors.primary} />
              <Text numberOfLines={1} style={{ color: colors.text, flex: 1 }}>{dest.name}</Text>
              <Text style={{ color: colors.text + '77', fontSize: 12 }}>{dest.coords.lat.toFixed(4)}, {dest.coords.lng.toFixed(4)}</Text>
            </View>
          )}
          {dest && (
            <NavMap
              data={preview ?? { shape: [], pos: null, dest: dest.coords, heading: 0 }}
              follow={false}
              style={[st.previewMap, { borderColor: colors.glassStroke }]}
            />
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
                <View style={[st.chips, { marginTop: 8 }]}>
                  {routes.map((r, i) => (
                    <Chip
                      key={i}
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
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Direction Lock (vibration profile)</Text>
          <View style={st.chips}>
            {PROFILES.map((p) => <Chip key={p.key} active={s.profile === p.key} label={p.label} onPress={() => setNavSettings({ profile: p.key })} />)}
          </View>

          {/* guidance mode */}
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Guidance</Text>
          <View style={st.chips}>
            {MODES.map((m) => <Chip key={m.key} active={s.mode === m.key} label={m.label} onPress={() => setNavSettings({ mode: m.key })} />)}
          </View>

          {/* timing + travel mode */}
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Alert timing</Text>
          <View style={st.chips}>
            {(['early', 'normal', 'late'] as const).map((t) => <Chip key={t} active={s.timing === t} label={t[0].toUpperCase() + t.slice(1)} onPress={() => setNavSettings({ timing: t })} />)}
          </View>
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Travel mode</Text>
          <View style={st.chips}>
            {(['auto', 'motorcycle', 'bicycle', 'pedestrian', 'truck'] as const).map((c) => <Chip key={c} active={s.costing === c} label={c === 'auto' ? 'Car' : c[0].toUpperCase() + c.slice(1)} onPress={() => setNavSettings({ costing: c })} />)}
          </View>

          {/* route preferences (v2) — forwarded to Valhalla costing_options */}
          <Text style={[st.h, { color: colors.text, marginTop: 22 }]}>Route options</Text>
          <View style={st.chips}>
            <Chip active={!s.routeOpts.shortest} label="Fastest" onPress={() => setRouteOpt({ shortest: false })} />
            <Chip active={!!s.routeOpts.shortest} label="Shortest" onPress={() => setRouteOpt({ shortest: true })} />
            <Chip active={!!s.routeOpts.avoidTolls} label="Avoid tolls" onPress={() => setRouteOpt({ avoidTolls: !s.routeOpts.avoidTolls })} />
            <Chip active={!!s.routeOpts.avoidHighways} label="Avoid highways" onPress={() => setRouteOpt({ avoidHighways: !s.routeOpts.avoidHighways })} />
          </View>

          <TouchableOpacity disabled={!dest || starting} onPress={start}
            style={[st.startBtn, { backgroundColor: dest ? colors.primary : colors.border }]}>
            {starting ? <ActivityIndicator color="#fff" />
              : <><Ionicons name="navigate" size={18} color="#fff" /><Text style={st.startTxt}>Start navigation</Text></>}
          </TouchableOpacity>
          {Platform.OS === 'ios' && <Text style={{ color: colors.text + '77', fontSize: 12, textAlign: 'center', marginTop: 10 }}>iOS plays intensity accents; Android plays the full vibration patterns.</Text>}
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1 },
  setup: { padding: 16, paddingBottom: 48 },
  lockEntry: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderRadius: 14, padding: 12, marginBottom: 20 },
  lockEntryIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 48 },
  sugBox: { borderWidth: 1, borderRadius: 12, marginTop: 6, overflow: 'hidden' },
  sugRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 11 },
  input: { flex: 1, fontSize: 15 },
  destPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 10 },
  previewMap: { height: 210, borderRadius: 14, borderWidth: 1, marginTop: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 14, marginTop: 30 },
  startTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  sheet: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, paddingBottom: 22, borderTopWidth: StyleSheet.hairlineWidth },
  sheetInstr: { fontSize: 17, fontWeight: '800' },
  endBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 44, paddingHorizontal: 18, borderRadius: 12 },
  rerouteBtn: { alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 12, borderWidth: 1.5 },
  endTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },
});
