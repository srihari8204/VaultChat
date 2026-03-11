import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Alert, ActivityIndicator, SafeAreaView, Platform
} from 'react-native';
import * as Location from 'expo-location';
import { useRouter, useLocalSearchParams } from 'expo-router';

// REPLACE with your actual backend IP
const API = 'http://YOUR_BACKEND_IP:3001/api/location';

// FIX: added 'link' key so C.link does not crash
const C = {
  current: '#00D4AA',
  live:    '#FF6B35',
  manual:  '#A78BFA',
  link:    '#4A9FFF',
  bg:      '#030912',
  card:    '#0D1B2E',
  border:  'rgba(255,255,255,0.09)',
  text:    '#fff',
  sub:     'rgba(255,255,255,0.4)',
};

const DURATIONS = [
  { val: 15,  label: '15 min', icon: '?' },
  { val: 30,  label: '30 min', icon: '??' },
  { val: 60,  label: '1 hr',   icon: '??' },
  { val: 90,  label: '90 min', icon: '??' },
  { val: 120, label: '2 hrs',  icon: '??' },
  { val: 180, label: '3 hrs',  icon: '??' },
];

type Mode   = 'current' | 'live' | 'manual';
type Screen = 'picker' | 'dur-current' | 'dur-live' | 'active';

export default function LocationSharingScreen() {
  const router  = useRouter();
  const params  = useLocalSearchParams();

  const [screen,    setScreen]    = useState<Screen>('picker');
  const [mode,      setMode]      = useState<Mode>('current');
  const [selDur,    setSelDur]    = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [timeLeft,  setTimeLeft]  = useState(0);
  const [loading,   setLoading]   = useState(false);
  const [myCoords,  setMyCoords]  = useState<{ lat: number; lng: number } | null>(null);
  const [address,   setAddress]   = useState('Getting your location…');
  const updateRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Get location on mount
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Location access is required.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setMyCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      const geo = await Location.reverseGeocodeAsync({
        latitude:  loc.coords.latitude,
        longitude: loc.coords.longitude,
      });
      if (geo.length > 0) {
        const g = geo[0];
        setAddress([g.name, g.street, g.city, g.region].filter(Boolean).join(', '));
      }
    })();
  }, []);

  // Countdown timer
  useEffect(() => {
    if (screen !== 'active' || mode === 'manual') return;
    if (timeLeft <= 0) { stopSharing(); return; }
    const t = setInterval(() => setTimeLeft(v => v - 1), 1000);
    return () => clearInterval(t);
  }, [screen, timeLeft]);

  // Live location push every 30s
  useEffect(() => {
    if (screen !== 'active' || mode === 'current' || !sessionId) return;
    updateRef.current = setInterval(pushLocation, 30000);
    return () => { if (updateRef.current) clearInterval(updateRef.current); };
  }, [screen, sessionId]);

  const fmt = (s: number) =>
    s >= 99999
      ? '8'
      : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const startSharing = async (m: Mode, dur: number | null) => {
    if (!myCoords) { Alert.alert('Waiting', 'Getting your location, please wait…'); return; }
    setLoading(true);
    try {
      const resp = await fetch(`${API}/share`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid:             'user123', // replace with Firebase auth UID
          mode:            m,
          durationMinutes: dur,
          lat:             myCoords.lat,
          lng:             myCoords.lng,
          address,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setSessionId(data.id);
        setMode(m);
        setTimeLeft(dur ? dur * 60 : 99999);
        setScreen('active');
      } else {
        throw new Error(data.error);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not start sharing');
    } finally {
      setLoading(false);
    }
  };

  const pushLocation = async () => {
    if (!sessionId) return;
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      await fetch(`${API}/update/${sessionId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: loc.coords.latitude, lng: loc.coords.longitude }),
      });
      setMyCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });
    } catch (e) {
      console.warn('Location update failed:', e);
    }
  };

  const stopSharing = async () => {
    if (updateRef.current) clearInterval(updateRef.current);
    if (sessionId) {
      try { await fetch(`${API}/${sessionId}`, { method: 'DELETE' }); } catch {}
    }
    router.back();
  };

  if (loading) {
    return (
      <SafeAreaView style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={C.current} size="large" />
        <Text style={[s.sub, { marginTop: 12 }]}>Starting location share…</Text>
      </SafeAreaView>
    );
  }

  // Active sharing screen
  if (screen === 'active') {
    const col = C[mode];
    return (
      <SafeAreaView style={s.root}>
        <View style={{ flex: 1, padding: 20, alignItems: 'center', justifyContent: 'center' }}>
          <View style={[s.pulseOuter, { borderColor: `${col}40` }]}>
            <View style={[s.pulseInner, { backgroundColor: `${col}20`, borderColor: `${col}66` }]}>
              <View style={[s.pin, { backgroundColor: col }]}>
                <Text style={{ fontSize: 22 }}>??</Text>
              </View>
            </View>
          </View>

          <View style={[s.badge, { backgroundColor: `${col}18`, borderColor: `${col}33`, marginBottom: 8 }]}>
            <View style={[s.dot, { backgroundColor: col }]} />
            <Text style={[s.badgeText, { color: col }]}>
              {mode === 'current' ? 'SNAPSHOT SHARED' : mode === 'live' ? 'LIVE TRACKING' : 'SHARING LOCATION'}
            </Text>
          </View>

          <Text style={[s.heading, { textAlign: 'center' }]}>{address}</Text>
          <Text style={[s.sub, { marginBottom: 24 }]}>
            {mode === 'current' ? `Expires in ${fmt(timeLeft)}` :
             mode === 'live'    ? `Live · ${selDur === -1 ? '8' : fmt(timeLeft)} remaining` :
             'Sharing until you stop'}
          </Text>

          <View style={[s.card, { width: '100%', marginBottom: 20 }]}>
            <Text style={s.label}>SESSION ID (share in chat)</Text>
            <Text style={{ color: col, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', fontSize: 13, fontWeight: '700' }}>
              {sessionId}
            </Text>
          </View>

          <TouchableOpacity
            style={[s.btn, { backgroundColor: `${col}18`, borderColor: `${col}33`, borderWidth: 1, width: '100%' }]}
            onPress={stopSharing}
          >
            <Text style={[s.btnTxt, { color: col }]}>?  Stop Sharing</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Duration picker — Current Location
  if (screen === 'dur-current') {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          {/* FIX: was C.link — now uses C.link which exists */}
          <TouchableOpacity onPress={() => setScreen('picker')} style={{ marginBottom: 16 }}>
            <Text style={{ color: C.link, fontSize: 15 }}>? Back</Text>
          </TouchableOpacity>
          <Text style={s.heading}>?? Current Location</Text>
          <Text style={[s.sub, { marginBottom: 20 }]}>How long can recipient view it?</Text>

          <View style={s.durGrid}>
            {DURATIONS.map(d => (
              <TouchableOpacity
                key={d.val}
                style={[s.durCard, selDur === d.val && { backgroundColor: `${C.current}18`, borderColor: `${C.current}55` }]}
                onPress={() => setSelDur(d.val)}
              >
                <Text style={{ fontSize: 22, marginBottom: 4 }}>{d.icon}</Text>
                <Text style={[s.durLabel, { color: selDur === d.val ? C.current : C.sub }]}>{d.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={[s.card, { flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 16 }]}>
            <Text style={{ fontSize: 16 }}>??</Text>
            <View>
              <Text style={s.label}>AUTO-CODE GENERATED ON SHARE</Text>
              <Text style={{ color: C.current, fontSize: 11, fontWeight: '700' }}>
                6-digit code will appear in chat card
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={[s.btn, { backgroundColor: selDur ? C.current : 'rgba(255,255,255,0.06)' }]}
            onPress={() => { if (selDur) startSharing('current', selDur); }}
            disabled={!selDur}
          >
            <Text style={[s.btnTxt, { color: selDur ? '#fff' : C.sub }]}>?? Share Current Location</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Duration picker — Live Location
  if (screen === 'dur-live') {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <TouchableOpacity onPress={() => setScreen('picker')} style={{ marginBottom: 16 }}>
            <Text style={{ color: C.live, fontSize: 15 }}>? Back</Text>
          </TouchableOpacity>
          <Text style={[s.heading, { color: C.live }]}>?? Live Location</Text>
          <Text style={[s.sub, { marginBottom: 20 }]}>How long to share for?</Text>

          <View style={s.durGrid}>
            {DURATIONS.map(d => (
              <TouchableOpacity
                key={d.val}
                style={[s.durCard, selDur === d.val && { backgroundColor: `${C.live}18`, borderColor: `${C.live}55` }]}
                onPress={() => setSelDur(d.val)}
              >
                <Text style={{ fontSize: 22, marginBottom: 4 }}>{d.icon}</Text>
                <Text style={[s.durLabel, { color: selDur === d.val ? C.live : C.sub }]}>{d.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[s.card, { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16,
              ...(selDur === -1 && { borderColor: `${C.live}44`, backgroundColor: `${C.live}0a` }) }]}
            onPress={() => setSelDur(-1)}
          >
            <Text style={{ fontSize: 26 }}>??</Text>
            <View style={{ flex: 1 }}>
              <Text style={[s.optTitle, { color: selDur === -1 ? C.live : '#fff' }]}>Until I Stop</Text>
              <Text style={s.sub}>Share until you manually end it</Text>
            </View>
            {selDur === -1 && <Text style={{ color: C.live }}>?</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.btn, { backgroundColor: selDur !== null ? C.live : 'rgba(255,255,255,0.06)' }]}
            onPress={() => { if (selDur !== null) startSharing('live', selDur === -1 ? null : selDur); }}
            disabled={selDur === null}
          >
            <Text style={[s.btnTxt, { color: selDur !== null ? '#fff' : C.sub }]}>?? Start Live Location</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Mode picker (home)
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 16 }}>
          <Text style={{ color: C.link, fontSize: 15 }}>? Back</Text>
        </TouchableOpacity>

        <Text style={s.label}>LOCATION SHARING</Text>
        <Text style={s.heading}>Share Location</Text>
        <Text style={[s.sub, { marginBottom: 24 }]}>
          {address !== 'Getting your location…' ? `?? ${address}` : '?? Getting your location…'}
        </Text>

        {[
          { mode: 'current' as Mode, icon: '??', title: 'Current Location', badge: 'SNAPSHOT', color: C.current,
            desc: 'Static pin · Not tracking · Expires on timer',
            tags: ['?? One-time', '?? Expires', '?? No tracking'],
            onPress: () => setScreen('dur-current') },
          { mode: 'live' as Mode, icon: '??', title: 'Live Location', badge: 'MOVING', color: C.live,
            desc: 'Pin moves as you move · Updates every 30s',
            tags: ['?? Real-time', '?? Time limit', '?? 30s updates'],
            onPress: () => setScreen('dur-live') },
          { mode: 'manual' as Mode, icon: '??', title: 'Until I Stop', badge: 'MANUAL', color: C.manual,
            desc: 'Live indefinitely · You tap Stop when done',
            tags: ['?? No limit', '?? You stop it', '?? Continuous'],
            onPress: () => startSharing('manual', null) },
        ].map(opt => (
          <TouchableOpacity key={opt.mode} style={[s.modeCard, { borderColor: `${opt.color}33` }]} onPress={opt.onPress}>
            <View style={[s.modeIcon, { backgroundColor: `${opt.color}18` }]}>
              <Text style={{ fontSize: 26 }}>{opt.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Text style={s.optTitle}>{opt.title}</Text>
                <View style={[s.badge, { backgroundColor: `${opt.color}18`, borderColor: `${opt.color}30` }]}>
                  <Text style={[s.badgeText, { color: opt.color }]}>{opt.badge}</Text>
                </View>
              </View>
              <Text style={s.sub}>{opt.desc}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                {opt.tags.map(t => (
                  <View key={t} style={[s.tag, { borderColor: `${opt.color}22`, backgroundColor: `${opt.color}0a` }]}>
                    <Text style={[s.tagTxt, { color: `${opt.color}bb` }]}>{t}</Text>
                  </View>
                ))}
              </View>
            </View>
            <Text style={{ color: 'rgba(255,255,255,0.2)', fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// FIX: removed unused C2 const that was here before
const s = StyleSheet.create({
  root:       { flex: 1, backgroundColor: '#030912' },
  heading:    { fontSize: 22, fontWeight: '900', color: '#fff', marginBottom: 6 },
  sub:        { fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 18 },
  label:      { fontSize: 9, fontWeight: '700', color: 'rgba(255,255,255,0.3)', letterSpacing: 2, marginBottom: 8 },
  card:       { backgroundColor: '#0D1B2E', borderRadius: 14, padding: 14, borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.09)', marginBottom: 10 },
  modeCard:   { flexDirection: 'row', alignItems: 'flex-start', gap: 14, padding: 16, borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, marginBottom: 12 },
  modeIcon:   { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  optTitle:   { fontSize: 15, fontWeight: '800', color: '#fff' },
  badge:      { flexDirection: 'row', alignItems: 'center', gap: 4,
                paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, borderWidth: 1 },
  badgeText:  { fontSize: 8, fontWeight: '700' },
  dot:        { width: 5, height: 5, borderRadius: 3 },
  tag:        { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, borderWidth: 1 },
  tagTxt:     { fontSize: 9, fontWeight: '600' },
  durGrid:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  durCard:    { width: '31%', padding: 12, borderRadius: 14, alignItems: 'center',
                backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1.5,
                borderColor: 'rgba(255,255,255,0.08)' },
  durLabel:   { fontSize: 11, fontWeight: '800' },
  btn:        { borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 10 },
  btnTxt:     { fontSize: 14, fontWeight: '800', color: '#fff' },
  pulseOuter: { width: 180, height: 180, borderRadius: 90, borderWidth: 1,
                alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  pulseInner: { width: 120, height: 120, borderRadius: 60, borderWidth: 1,
                alignItems: 'center', justifyContent: 'center' },
  pin:        { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
});
