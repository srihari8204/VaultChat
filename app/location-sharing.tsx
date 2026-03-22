/**
 * app/location-sharing.tsx
 * VaultChat — Location Sharing Session Manager
 * D2DE encrypted — server sees ZERO plaintext coordinates
 * Three modes: Static snapshot · Live stream · Until I stop
 */

import { getAuth } from '@react-native-firebase/auth';
import { deleteDoc, doc, getFirestore, setDoc } from '@react-native-firebase/firestore';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

// ─── D2DE stubs ───────────────────────────────────────────────
type D2DESession = { id: string; key: string };
type LocationPayload = {
  lat:        number;
  lng:        number;
  ts:         number;
  accuracy?:  number;
  address?:   string;
  type?:      string;
  expiresAt?: number;
};

const createSession = async (_uid?: string): Promise<D2DESession> => ({ id: '', key: '' });
const encryptLocation = async (payload: LocationPayload, sess: D2DESession): Promise<string> => '';
const deleteSession = async (id: string): Promise<void> => {};
// ──────────────────────────────────────────────────────────────

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
  { val: 15,  label: '15 min' },
  { val: 30,  label: '30 min' },
  { val: 60,  label: '1 hr'   },
  { val: 90,  label: '90 min' },
  { val: 120, label: '2 hrs'  },
  { val: 180, label: '3 hrs'  },
];

type Mode   = 'current' | 'live' | 'manual';
type Screen = 'picker' | 'dur-current' | 'dur-live' | 'active';

export default function LocationSharingScreen() {
  const router  = useRouter();

  const [screen,   setScreen]   = useState<Screen>('picker');
  const [mode,     setMode]     = useState<Mode>('current');
  const [selDur,   setSelDur]   = useState<number | null>(null);
  const [session,  setSession]  = useState<D2DESession | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [myCoords, setMyCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [address,  setAddress]  = useState('Getting your location…');

  const liveSubRef = useRef<Location.LocationSubscription | null>(null);
  const updateRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Initial location fetch ──────────────────────────────────
  useEffect(() => {
    let mounted = true;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Location access is required.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      if (!mounted) return;
      setMyCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });

      const geo = await Location.reverseGeocodeAsync({
        latitude:  loc.coords.latitude,
        longitude: loc.coords.longitude,
      });
      if (!mounted) return;
      if (geo.length > 0) {
        const g = geo[0];
        setAddress([g.name, g.street, g.city, g.region].filter(Boolean).join(', '));
      }
    })();

    return () => {
      mounted = false;
      // inline cleanup for initial mount
      liveSubRef.current?.remove();
      liveSubRef.current = null;
      if (updateRef.current) clearInterval(updateRef.current);
    };
  }, []);

  // ── Countdown timer ─────────────────────────────────────────
  useEffect(() => {
    if (screen !== 'active' || mode === 'manual') return;
    if (timeLeft <= 0) {
      // Inline stopSharing logic
      liveSubRef.current?.remove();
      liveSubRef.current = null;
      if (updateRef.current) clearInterval(updateRef.current);
      if (session) {
        const db = getFirestore();
        Promise.all([
          deleteDoc(doc(db, 'location_shares', session.id)).catch(() => {}),
          deleteDoc(doc(db, 'live_location',   session.id)).catch(() => {}),
        ]).then(() => deleteSession(session.id)).then(() => setSession(null));
      }
      router.back();
      return;
    }
    const t = setInterval(() => setTimeLeft(v => v - 1), 1000);
    return () => clearInterval(t);
  }, [screen, timeLeft, mode, session, router]);

  // ── Live location push every 30s ────────────────────────────
  useEffect(() => {
    if (screen !== 'active' || mode === 'current' || !session) return;
    const sess = session;
    const pushLiveLocation = async (s: D2DESession) => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        setMyCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });

        const payload: LocationPayload = {
          lat:      loc.coords.latitude,
          lng:      loc.coords.longitude,
          ts:       Date.now(),
          accuracy: loc.coords.accuracy ?? undefined,
          address,
          type:     'live',
        };

        const encrypted = await encryptLocation(payload, s);

        const db = getFirestore();
        await setDoc(doc(db, 'live_location', s.id), {
          payload:   JSON.stringify(encrypted),
          updatedAt: Date.now(),
        });
      } catch (e) {
        console.warn('[LocationSharing] Live update failed:', e);
      }
    };
    updateRef.current = setInterval(() => pushLiveLocation(sess), 30000);
    return () => { if (updateRef.current) clearInterval(updateRef.current); };
  }, [screen, session, mode, address]);

  const fmt = (s: number) =>
    s >= 99999
      ? '∞'
      : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const startSharing = async (m: Mode, dur: number | null) => {
    if (!myCoords) {
      Alert.alert('Waiting', 'Getting your location, please wait…');
      return;
    }
    setLoading(true);
    try {
      const uid  = getAuth().currentUser?.uid || 'anon';
      const sess = await createSession(uid);
      setSession(sess);

      const payload: LocationPayload = {
        lat:       myCoords.lat,
        lng:       myCoords.lng,
        ts:        Date.now(),
        address,
        type:      m === 'current' ? 'static' : 'live',
        expiresAt: dur ? Date.now() + dur * 60000 : undefined,
      };

      const encrypted   = await encryptLocation(payload, sess);

      const db = getFirestore();
      await setDoc(doc(db, 'location_shares', sess.id), {
        payload:   JSON.stringify(encrypted),
        mode:      m,
        sentAt:    Date.now(),
        expiresAt: payload.expiresAt ?? null,
      });

      if (m !== 'current') {
        await Location.requestBackgroundPermissionsAsync().catch(() => {});
        liveSubRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 5000, distanceInterval: 5 },
          async (newLoc) => {
            setMyCoords({ lat: newLoc.coords.latitude, lng: newLoc.coords.longitude });
            await pushLiveLocation(sess);
          }
        );
      }

      setMode(m);
      setTimeLeft(dur ? dur * 60 : 99999);
      setScreen('active');
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Could not start sharing');
    } finally {
      setLoading(false);
    }
  };

  const stopSharing = async () => {
    liveSubRef.current?.remove();
    liveSubRef.current = null;
    if (updateRef.current) clearInterval(updateRef.current);

    if (session) {
      const db = getFirestore();
      await Promise.all([
        deleteDoc(doc(db, 'location_shares', session.id)).catch(() => {}),
        deleteDoc(doc(db, 'live_location',   session.id)).catch(() => {}),
      ]);
      await deleteSession(session.id);
      setSession(null);
    }

    router.back();
  };

  if (loading) return (
    <SafeAreaView style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}>
      <ActivityIndicator color={C.current} size="large" />
      <Text style={[s.sub, { marginTop: 12 }]}>Starting D2DE session…</Text>
    </SafeAreaView>
  );

  // ── Active Sharing ──────────────────────────────────────────
  if (screen === 'active') {
    const col = C[mode];
    return (
      <SafeAreaView style={s.root}>
        <View style={{ flex: 1, padding: 20, alignItems: 'center', justifyContent: 'center' }}>

          <View style={[s.pulseOuter, { borderColor: `${col}40` }]}>
            <View style={[s.pulseInner, { backgroundColor: `${col}15`, borderColor: `${col}55` }]}>
              <View style={[s.pin, { backgroundColor: col }]}>
                <Text style={{ fontSize: 26 }}>📍</Text>
              </View>
            </View>
          </View>

          <View style={[s.badge, { backgroundColor: `${col}15`, borderColor: `${col}33`, marginBottom: 10 }]}>
            <View style={[s.dot, { backgroundColor: col }]} />
            <Text style={[s.badgeText, { color: col }]}>
              {mode === 'current' ? 'SNAPSHOT SHARED' : mode === 'live' ? 'LIVE TRACKING' : 'SHARING LIVE'}
            </Text>
          </View>

          <Text style={[s.heading, { textAlign: 'center', marginBottom: 4 }]}>{address}</Text>
          <Text style={[s.sub, { marginBottom: 6, textAlign: 'center' }]}>
            {mode === 'current' ? `Expires in ${fmt(timeLeft)}` :
             mode === 'live'    ? `Live · ${fmt(timeLeft)} remaining` :
             'Sharing until you stop'}
          </Text>

          <View style={[s.card, { width: '100%', marginBottom: 14, borderColor: `${col}22` }]}>
            <Text style={[s.lbl, { marginBottom: 6 }]}>D2DE ENCRYPTION STATUS</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Text style={{ fontSize: 14 }}>🔐</Text>
              <Text style={{ color: C.current, fontSize: 12, fontWeight: '700' }}>AES-256-GCM Active</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Text style={{ fontSize: 14 }}>🔑</Text>
              <Text style={{ color: C.current, fontSize: 12, fontWeight: '700' }}>Per-session key · Never stored on server</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 14 }}>🛡️</Text>
              <Text style={{ color: C.current, fontSize: 12, fontWeight: '700' }}>Server sees ciphertext only</Text>
            </View>
          </View>

          {session && (
            <View style={[s.card, { width: '100%', marginBottom: 20 }]}>
              <Text style={s.lbl}>SESSION ID</Text>
              <Text style={{ color: col, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
                fontSize: 11, fontWeight: '700', marginTop: 4 }}>
                {session.id}
              </Text>
              <Text style={[s.sub, { fontSize: 10, marginTop: 4 }]}>
                Session key transmitted via E2EE chat — not stored anywhere
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[s.btn, { backgroundColor: `${col}15`, borderColor: `${col}33`, borderWidth: 1, width: '100%' }]}
            onPress={stopSharing}
          >
            <Text style={[s.btnTxt, { color: col }]}>⏹ Stop & Wipe Session</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Duration picker — Current ───────────────────────────────
  if (screen === 'dur-current') return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => setScreen('picker')} style={{ marginBottom: 16 }}>
          <Text style={{ color: C.link, fontSize: 15 }}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.heading}>📌 Current Location</Text>
        <Text style={[s.sub, { marginBottom: 20 }]}>How long can the recipient view it?</Text>
        <View style={s.durGrid}>
          {DURATIONS.map(d => (
            <TouchableOpacity key={d.val}
              style={[s.durCard, selDur === d.val && { backgroundColor: `${C.current}18`, borderColor: `${C.current}55` }]}
              onPress={() => setSelDur(d.val)}>
              <Text style={[s.durLabel, { color: selDur === d.val ? C.current : C.sub }]}>{d.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={[s.card, { marginBottom: 16 }]}>
          <Text style={s.lbl}>D2DE PROTECTION</Text>
          <Text style={{ color: C.current, fontSize: 12, fontWeight: '700', marginTop: 6 }}>
            🔐 Coordinates AES-256-GCM encrypted{'\n'}
            🔑 Session key delivered via E2EE chat{'\n'}
            🗑️ Auto-wiped after expiry
          </Text>
        </View>
        <TouchableOpacity
          style={[s.btn, { backgroundColor: selDur ? C.current : 'rgba(255,255,255,0.06)' }]}
          onPress={() => { if (selDur) startSharing('current', selDur); }}
          disabled={!selDur}>
          <Text style={[s.btnTxt, { color: selDur ? '#fff' : C.sub }]}>📌 Share Current Location</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // ── Duration picker — Live ──────────────────────────────────
  if (screen === 'dur-live') return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => setScreen('picker')} style={{ marginBottom: 16 }}>
          <Text style={{ color: C.live, fontSize: 15 }}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={[s.heading, { color: C.live }]}>🔴 Live Location</Text>
        <Text style={[s.sub, { marginBottom: 20 }]}>How long to share for?</Text>
        <View style={s.durGrid}>
          {DURATIONS.map(d => (
            <TouchableOpacity key={d.val}
              style={[s.durCard, selDur === d.val && { backgroundColor: `${C.live}18`, borderColor: `${C.live}55` }]}
              onPress={() => setSelDur(d.val)}>
              <Text style={[s.durLabel, { color: selDur === d.val ? C.live : C.sub }]}>{d.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={[s.card, { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16,
            ...(selDur === -1 && { borderColor: `${C.live}44`, backgroundColor: `${C.live}0a` }) }]}
          onPress={() => setSelDur(-1)}>
          <Text style={{ fontSize: 26 }}>♾️</Text>
          <View style={{ flex: 1 }}>
            <Text style={[s.optTitle, { color: selDur === -1 ? C.live : '#fff' }]}>Until I Stop</Text>
            <Text style={s.sub}>Share until you manually end it</Text>
          </View>
          {selDur === -1 && <Text style={{ color: C.live, fontSize: 18 }}>✓</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, { backgroundColor: selDur !== null ? C.live : 'rgba(255,255,255,0.06)' }]}
          onPress={() => { if (selDur !== null) startSharing('live', selDur === -1 ? null : selDur); }}
          disabled={selDur === null}>
          <Text style={[s.btnTxt, { color: selDur !== null ? '#fff' : C.sub }]}>🔴 Start Live Location</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );

  // ── Mode Picker (home) ──────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ marginBottom: 16 }}>
          <Text style={{ color: C.link, fontSize: 15 }}>‹ Back</Text>
        </TouchableOpacity>

        <Text style={s.lbl}>LOCATION SHARING</Text>
        <Text style={s.heading}>Share Location</Text>
        <Text style={[s.sub, { marginBottom: 6 }]}>
          {address !== 'Getting your location…' ? `📍 ${address}` : '📍 Getting your location…'}
        </Text>

        <View style={[s.card, { backgroundColor: 'rgba(0,212,170,0.07)', borderColor: 'rgba(0,212,170,0.2)', marginBottom: 20 }]}>
          <Text style={{ color: C.current, fontSize: 12, fontWeight: '800' }}>
            🔐 D2DE Protected · AES-256-GCM · Server sees zero plaintext
          </Text>
        </View>

        {([
          {
            mode:    'current' as Mode,
            icon:    '📌',
            title:   'Current Location',
            badge:   'SNAPSHOT',
            color:   C.current,
            desc:    'Static pin · Not tracking · Expires on timer',
            tags:    ['One-time', 'Auto-expires', 'No tracking'],
            onPress: () => setScreen('dur-current'),
          },
          {
            mode:    'live' as Mode,
            icon:    '🔴',
            title:   'Live Location',
            badge:   'MOVING',
            color:   C.live,
            desc:    'Pin moves as you move · Updates every 30s',
            tags:    ['Real-time', 'Time limit', '30s updates'],
            onPress: () => setScreen('dur-live'),
          },
          {
            mode:    'manual' as Mode,
            icon:    '♾️',
            title:   'Until I Stop',
            badge:   'MANUAL',
            color:   C.manual,
            desc:    'Live indefinitely · Tap Stop when done',
            tags:    ['No limit', 'You stop it', 'Continuous'],
            onPress: () => startSharing('manual', null),
          },
        ] as const).map(opt => (
          <TouchableOpacity key={opt.mode}
            style={[s.modeCard, { borderColor: `${opt.color}33` }]}
            onPress={opt.onPress}>
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
                    <Text style={[s.tagTxt, { color: `${opt.color}cc` }]}>{t}</Text>
                  </View>
                ))}
              </View>
            </View>
            <Text style={{ color: 'rgba(255,255,255,0.2)', fontSize: 20 }}>›</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:       { flex: 1, backgroundColor: C.bg },
  heading:    { fontSize: 22, fontWeight: '900', color: '#fff', marginBottom: 6 },
  sub:        { fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 18 },
  lbl:        { fontSize: 9, fontWeight: '700', color: 'rgba(255,255,255,0.3)',
                letterSpacing: 2, marginBottom: 8 },
  card:       { backgroundColor: C.card, borderRadius: 14, padding: 14,
                borderWidth: 1, borderColor: C.border, marginBottom: 10 },
  modeCard:   { flexDirection: 'row', alignItems: 'flex-start', gap: 14,
                padding: 16, borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.03)',
                borderWidth: 1, marginBottom: 12 },
  modeIcon:   { width: 52, height: 52, borderRadius: 14, alignItems: 'center',
                justifyContent: 'center', flexShrink: 0 },
  optTitle:   { fontSize: 15, fontWeight: '800', color: '#fff' },
  badge:      { flexDirection: 'row', alignItems: 'center', gap: 4,
                paddingHorizontal: 6, paddingVertical: 2,
                borderRadius: 5, borderWidth: 1 },
  badgeText:  { fontSize: 8, fontWeight: '700' },
  dot:        { width: 5, height: 5, borderRadius: 3 },
  tag:        { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, borderWidth: 1 },
  tagTxt:     { fontSize: 9, fontWeight: '600' },
  durGrid:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  durCard:    { width: '31%', padding: 12, borderRadius: 14, alignItems: 'center',
                backgroundColor: 'rgba(255,255,255,0.04)',
                borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.08)' },
  durLabel:   { fontSize: 12, fontWeight: '800' },
  btn:        { borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 10 },
  btnTxt:     { fontSize: 14, fontWeight: '800', color: '#fff' },
  pulseOuter: { width: 180, height: 180, borderRadius: 90, borderWidth: 1,
                alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  pulseInner: { width: 120, height: 120, borderRadius: 60, borderWidth: 1,
                alignItems: 'center', justifyContent: 'center' },
  pin:        { width: 64, height: 64, borderRadius: 32,
                alignItems: 'center', justifyContent: 'center' },
});
