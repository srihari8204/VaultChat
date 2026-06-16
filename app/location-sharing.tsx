// app/location-sharing.tsx — Location Sharing (Postgres + socket, no Firebase).
//
// Opened from a chat. Three modes:
//   • Current  — one-time snapshot (a location message in the chat)
//   • Live     — a snapshot message + live position relayed over Socket.IO for
//                a chosen duration; peers' open chat shows a live banner
//   • Until I stop — live with no time limit
// Real GPS via expo-location. Removed the fake "D2DE" stubs + false crypto
// claims (the flag is off; coordinates are sent like any other message).

import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Aurora } from '../constants/theme';
import { getSocket } from '../lib/socket';
import { sendMessage } from '../lib/chatService';
import { newLiveKey, encryptPosition } from '../lib/liveLocationCrypto';

const C = { current: Aurora.primary, live: '#FF6B35', manual: Aurora.purple, link: Aurora.accent };
const DURATIONS = [
  { val: 15, label: '15 min' }, { val: 30, label: '30 min' }, { val: 60, label: '1 hr' },
  { val: 90, label: '90 min' }, { val: 120, label: '2 hrs' }, { val: 180, label: '3 hrs' },
];

type Mode = 'current' | 'live' | 'manual';
type Screen = 'picker' | 'dur-current' | 'dur-live' | 'active';

export default function LocationSharingScreen() {
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId?: string }>();

  const [screen, setScreen] = useState<Screen>('picker');
  const [mode, setMode] = useState<Mode>('current');
  const [selDur, setSelDur] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [address, setAddress] = useState('Getting your location…');

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const socketRef = useRef<any>(null);
  const untilRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission needed', 'Location access is required.'); return; }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (!mounted) return;
      setCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        if (mounted && geo[0]) {
          const g = geo[0];
          setAddress([g.name, g.street, g.city, g.region].filter(Boolean).join(', ') || 'Located');
        }
      } catch { if (mounted) setAddress(`${loc.coords.latitude.toFixed(5)}, ${loc.coords.longitude.toFixed(5)}`); }
    })();
    return () => { mounted = false; watchRef.current?.remove(); };
  }, []);

  const cleanup = useCallback(() => {
    watchRef.current?.remove();
    watchRef.current = null;
    if (socketRef.current && chatId) socketRef.current.emit('live_location_stop', { chatId });
  }, [chatId]);

  // Countdown
  useEffect(() => {
    if (screen !== 'active' || mode === 'manual' || timeLeft <= 0) return;
    const t = setInterval(() => setTimeLeft(v => {
      if (v <= 1) { cleanup(); router.back(); return 0; }
      return v - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [screen, timeLeft, mode, cleanup, router]);

  const fmt = (s: number) => s >= 99999 ? '∞' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const startSharing = async (m: Mode, durMin: number | null) => {
    if (!chatId) { Alert.alert('No chat', 'Open from a chat to share location.'); return; }
    if (!coords) { Alert.alert('Waiting', 'Getting your location, please wait…'); return; }
    setLoading(true);
    try {
      const isLive = m !== 'current';
      // Per-session key for live mode, delivered to the peer E2E inside this
      // message's content (so the server never sees it or the coordinates).
      const liveKey = isLive ? newLiveKey() : null;
      untilRef.current = isLive && durMin ? Date.now() + durMin * 60000 : undefined;

      // Coordinates ride in the message CONTENT (end-to-end encrypted in direct
      // chats), NOT in plaintext meta. The render bubble parses content JSON.
      await sendMessage(chatId, JSON.stringify({
        lat: coords.lat, lng: coords.lng, address, live: isLive,
        ...(liveKey ? { lk: liveKey, until: untilRef.current } : {}),
      }), 'location');

      if (isLive) {
        socketRef.current = await getSocket();
        await Location.requestBackgroundPermissionsAsync().catch(() => {});
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 8000, distanceInterval: 8 },
          (loc) => {
            setCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });
            // Encrypt each position with the session key → relay opaque blob.
            const blob = liveKey && encryptPosition(liveKey, { lat: loc.coords.latitude, lng: loc.coords.longitude, address });
            if (blob) socketRef.current?.emit('live_location_update', { chatId, blob, until: untilRef.current });
          },
        );
      }

      setMode(m);
      setTimeLeft(durMin ? durMin * 60 : 99999);
      setScreen('active');
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not start sharing');
    } finally {
      setLoading(false);
    }
  };

  const stop = () => { cleanup(); router.back(); };

  if (loading) return (
    <SafeAreaView style={[s.root, s.center]}>
      <ActivityIndicator color={C.current} size="large" />
      <Text style={[s.sub, { marginTop: 12 }]}>Starting…</Text>
    </SafeAreaView>
  );

  if (screen === 'active') {
    const col = C[mode];
    return (
      <SafeAreaView style={s.root}>
        <View style={[s.center, { flex: 1, padding: 20 }]}>
          <View style={[s.pulseOuter, { borderColor: `${col}40` }]}>
            <View style={[s.pulseInner, { backgroundColor: `${col}15`, borderColor: `${col}55` }]}>
              <View style={[s.pin, { backgroundColor: col }]}><Text style={{ fontSize: 26 }}>📍</Text></View>
            </View>
          </View>
          <View style={[s.badge, { backgroundColor: `${col}15`, borderColor: `${col}33`, marginBottom: 10 }]}>
            <View style={[s.dot, { backgroundColor: col }]} />
            <Text style={[s.badgeText, { color: col }]}>{mode === 'current' ? 'SNAPSHOT SHARED' : 'LIVE'}</Text>
          </View>
          <Text style={[s.heading, { textAlign: 'center', marginBottom: 4 }]}>{address}</Text>
          <Text style={[s.sub, { marginBottom: 20, textAlign: 'center' }]}>
            {mode === 'current' ? 'Snapshot sent to the chat.' : mode === 'manual' ? 'Sharing until you stop.' : `Live · ${fmt(timeLeft)} remaining`}
          </Text>
          <TouchableOpacity style={[s.btn, { backgroundColor: `${col}15`, borderColor: `${col}33`, borderWidth: 1, width: '100%' }]} onPress={stop}>
            <Text style={[s.btnTxt, { color: col }]}>⏹ Stop sharing</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'dur-current' || screen === 'dur-live') {
    const live = screen === 'dur-live';
    const col = live ? C.live : C.current;
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <TouchableOpacity onPress={() => { setScreen('picker'); setSelDur(null); }} style={{ marginBottom: 16 }}>
            <Text style={{ color: C.link, fontSize: 15 }}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={[s.heading, { color: col }]}>{live ? '🔴 Live Location' : '📌 Current Location'}</Text>
          <Text style={[s.sub, { marginBottom: 20 }]}>How long to share for?</Text>
          <View style={s.durGrid}>
            {DURATIONS.map(d => (
              <TouchableOpacity key={d.val} style={[s.durCard, selDur === d.val && { backgroundColor: `${col}18`, borderColor: `${col}55` }]} onPress={() => setSelDur(d.val)}>
                <Text style={[s.durLabel, { color: selDur === d.val ? col : Aurora.textDim }]}>{d.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {live && (
            <TouchableOpacity style={[s.durCard, { width: '100%', marginBottom: 16 }, selDur === -1 && { backgroundColor: `${col}18`, borderColor: `${col}55` }]} onPress={() => setSelDur(-1)}>
              <Text style={[s.durLabel, { color: selDur === -1 ? col : Aurora.textDim }]}>♾️ Until I stop</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.btn, { backgroundColor: selDur !== null ? col : Aurora.surface }]}
            disabled={selDur === null}
            onPress={() => { if (selDur !== null) startSharing(live ? 'live' : 'current', selDur === -1 ? null : selDur); }}
          >
            <Text style={[s.btnTxt, { color: selDur !== null ? '#fff' : Aurora.textDim }]}>{live ? '🔴 Start live' : '📌 Share location'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Mode picker
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 16 }}>
          <Text style={{ color: C.link, fontSize: 15 }}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.lbl}>LOCATION SHARING</Text>
        <Text style={s.heading}>Share Location</Text>
        <Text style={[s.sub, { marginBottom: 16 }]}>📍 {address}</Text>
        {!chatId && <Text style={[s.sub, { color: C.live, marginBottom: 12 }]}>Open this from a chat to share.</Text>}

        {([
          { mode: 'current' as Mode, icon: '📌', title: 'Current Location', desc: 'One-time snapshot, not tracking', color: C.current, onPress: () => setScreen('dur-current') },
          { mode: 'live' as Mode, icon: '🔴', title: 'Live Location', desc: 'Updates as you move · time-limited', color: C.live, onPress: () => setScreen('dur-live') },
          { mode: 'manual' as Mode, icon: '♾️', title: 'Until I Stop', desc: 'Live with no time limit', color: C.manual, onPress: () => startSharing('manual', null) },
        ]).map(opt => (
          <TouchableOpacity key={opt.mode} style={[s.modeCard, { borderColor: `${opt.color}33` }]} onPress={opt.onPress} disabled={!chatId}>
            <View style={[s.modeIcon, { backgroundColor: `${opt.color}18` }]}><Text style={{ fontSize: 26 }}>{opt.icon}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.optTitle}>{opt.title}</Text>
              <Text style={s.sub}>{opt.desc}</Text>
            </View>
            <Text style={{ color: Aurora.textFaint, fontSize: 20 }}>›</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: Aurora.bg },
  center: { justifyContent: 'center', alignItems: 'center' },
  heading: { fontSize: 22, fontWeight: '900', color: Aurora.text, marginBottom: 6 },
  sub: { fontSize: 12, color: Aurora.textDim, lineHeight: 18 },
  lbl: { fontSize: 9, fontWeight: '700', color: Aurora.textFaint, letterSpacing: 2, marginBottom: 8 },
  modeCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18, backgroundColor: Aurora.card, borderWidth: 1, marginBottom: 12 },
  modeIcon: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  optTitle: { fontSize: 15, fontWeight: '800', color: Aurora.text },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  badgeText: { fontSize: 9, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  durGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  durCard: { width: '31%', padding: 12, borderRadius: 14, alignItems: 'center', backgroundColor: Aurora.surface, borderWidth: 1.5, borderColor: Aurora.border },
  durLabel: { fontSize: 12, fontWeight: '800' },
  btn: { borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 10 },
  btnTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
  pulseOuter: { width: 180, height: 180, borderRadius: 90, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  pulseInner: { width: 120, height: 120, borderRadius: 60, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  pin: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
});
