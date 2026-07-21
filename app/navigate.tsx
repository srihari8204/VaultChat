// app/navigate.tsx — the navigation screen. Screen-free by design: pick a
// destination + a Direction-Lock profile, hit Start, and the haptic engine
// guides you via vibration + the mini banner. No full map (that's a later,
// optional layer) — this is the complete real flow against self-hosted Valhalla.

import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, ActivityIndicator, Platform } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useTheme } from '../lib/theme';
import { useNavSettings, setNavSettings, loadNavSettings } from '../lib/nav/navSettings';
import { startNavigation, stopNavigation, useNavBanner } from '../lib/nav/navigationService';
import NavBanner from '../components/nav/NavBanner';
import { type NavProfile } from '../lib/nav/hapticLanguage';
import { type DisplayMode } from '../lib/nav/hapticPlayer';
import { type LatLng } from '../lib/nav/geo';

const PROFILES: { key: NavProfile; label: string }[] = [
  { key: 'standard', label: 'Standard' }, { key: 'strong', label: 'Strong' },
  { key: 'minimal', label: 'Minimal' }, { key: 'rider', label: 'Rider' }, { key: 'custom', label: 'Custom' },
];
// Voice modes are omitted until a TTS engine ships — these three are real today.
const MODES: { key: DisplayMode; label: string }[] = [
  { key: 'vibrationOnly', label: 'Vibration only' },
  { key: 'everything', label: 'Banner + vibration' },
  { key: 'bannerOnly', label: 'Banner only' },
];

export default function NavigateScreen() {
  const { colors } = useTheme();
  const s = useNavSettings();
  const banner = useNavBanner();
  const params = useLocalSearchParams<{ lat?: string; lng?: string; name?: string }>();

  const [query, setQuery] = useState('');
  const [dest, setDest] = useState<{ name: string; coords: LatLng } | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => { loadNavSettings(); }, []);
  useEffect(() => {
    if (params.lat && params.lng) {
      const c = { lat: Number(params.lat), lng: Number(params.lng) };
      if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) setDest({ name: params.name || 'Destination', coords: c });
    }
  }, [params.lat, params.lng]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    // "lat, lng" works everywhere (no geocoder needed) — try it first.
    const m = q.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m) { setDest({ name: q, coords: { lat: +m[1], lng: +m[2] } }); return; }
    setSearching(true);
    try {
      const res = await Location.geocodeAsync(q);
      if (res[0]) setDest({ name: q, coords: { lat: res[0].latitude, lng: res[0].longitude } });
      else Alert.alert('Not found', 'No match. On no-GMS devices the address geocoder may be unavailable — enter coordinates as "lat, lng".');
    } catch {
      Alert.alert('Search failed', 'Enter coordinates as "lat, lng" (a self-hosted geocoder is the follow-up for address search).');
    } finally { setSearching(false); }
  };

  const start = async () => {
    if (!dest) return;
    setStarting(true);
    try {
      await startNavigation({ to: dest.coords, profile: s.profile, mode: s.mode, timing: s.timing, costing: s.costing, custom: s.custom });
    } catch (e: any) {
      Alert.alert('Could not start', e?.message ?? 'Check location permission and that the routing engine is up.');
    } finally { setStarting(false); }
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
        <View style={st.activeWrap}>
          <View style={[st.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[st.bigInstr, { color: colors.text }]}>{banner.rerouting ? 'Rerouting…' : (banner.instruction || 'Continue')}</Text>
            {!!banner.roadName && <Text style={{ color: colors.text + '99', marginTop: 4 }}>{banner.roadName}</Text>}
            <Text style={[st.bigDist, { color: colors.primary }]}>{banner.distanceToManeuver} m</Text>
          </View>
          <TouchableOpacity onPress={() => stopNavigation()} style={[st.stopBtn, { backgroundColor: colors.danger }]}>
            <Ionicons name="stop" size={18} color="#fff" />
            <Text style={st.stopTxt}>End navigation</Text>
          </TouchableOpacity>
          <Text style={{ color: colors.text + '77', textAlign: 'center', marginTop: 14, fontSize: 12.5 }}>
            Profile: {s.profile} · {MODES.find((m) => m.key === s.mode)?.label}. Keep your eyes on the road — the vibration guides you.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={st.setup} keyboardShouldPersistTaps="handled">
          {/* destination */}
          <Text style={[st.h, { color: colors.text }]}>Destination</Text>
          <View style={[st.searchRow, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name="search" size={18} color={colors.text + '99'} />
            <TextInput
              value={query} onChangeText={setQuery} onSubmitEditing={search} returnKeyType="search"
              placeholder='Address or "lat, lng"' placeholderTextColor={colors.text + '66'}
              style={[st.input, { color: colors.text }]}
            />
            {searching ? <ActivityIndicator size="small" color={colors.primary} />
              : <TouchableOpacity onPress={search}><Text style={{ color: colors.primary, fontWeight: '700' }}>Find</Text></TouchableOpacity>}
          </View>
          {dest && (
            <View style={[st.destPill, { backgroundColor: colors.primary + '14' }]}>
              <Ionicons name="flag" size={16} color={colors.primary} />
              <Text numberOfLines={1} style={{ color: colors.text, flex: 1 }}>{dest.name}</Text>
              <Text style={{ color: colors.text + '77', fontSize: 12 }}>{dest.coords.lat.toFixed(4)}, {dest.coords.lng.toFixed(4)}</Text>
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
  h: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 10, opacity: 0.9 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 48 },
  input: { flex: 1, fontSize: 15 },
  destPill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 14, marginTop: 30 },
  startTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },
  activeWrap: { flex: 1, padding: 16, justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 16, padding: 22, alignItems: 'center' },
  bigInstr: { fontSize: 22, fontWeight: '800', textAlign: 'center' },
  bigDist: { fontSize: 44, fontWeight: '900', marginTop: 12 },
  stopBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 14, marginTop: 24 },
  stopTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
