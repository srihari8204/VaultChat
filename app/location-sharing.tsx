import { Ionicons } from '@expo/vector-icons';
// app/location-sharing.tsx — Location Sharing (Postgres + socket, no Firebase).
//
// Opened from a chat. Three modes:
//   • Current  — one-time snapshot (a location message in the chat)
//   • Live     — a snapshot message + live position relayed over realtime for
//                a chosen duration; peers' open chat shows a live banner
//   • Until I stop — live with no time limit
// Real GPS via expo-location. Removed the fake "D2DE" stubs + false crypto
// claims (the flag is off; coordinates are sent like any other message).

import { brandAlpha, type Palette } from '../constants/theme';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import {
  ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
// SafeAreaView from 'react-native' is iOS-ONLY — on Android it renders a plain
// View and applies no inset at all, so this screen drew under the status bar on
// every Android handset (and logged the deprecation warning at runtime). The
// safe-area-context one is the cross-platform implementation.
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme';
import { getSocket } from '../lib/socket';
import { sendMessage } from '../lib/chatService';
import { newLiveKey, encryptPosition } from '../lib/liveLocationCrypto';
import { AuroraBackground } from '../components/ui';
import LocationMap, { type MapPoint } from '../components/LocationMap';
import { permissionDenied } from '../lib/permissionDenied';

const DURATIONS = [
  { val: 15, label: '15 min' }, { val: 30, label: '30 min' }, { val: 60, label: '1 hr' },
  { val: 90, label: '90 min' }, { val: 120, label: '2 hrs' }, { val: 180, label: '3 hrs' },
];

type Mode = 'current' | 'live' | 'manual';
type Screen = 'picker' | 'dur-current' | 'dur-live' | 'active';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function LocationSharingScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId?: string }>();

  // Brand-only accents. Live status uses the WhatsApp live-location red purely
  // as a status indicator; all chrome/CTAs use the lavender brand color.
  const C = { current: colors.primary, live: colors.danger, manual: colors.primary, link: colors.primary };

  const [screen, setScreen] = useState<Screen>('picker');
  const [mode, setMode] = useState<Mode>('current');
  const [selDur, setSelDur] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [loading, setLoading] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [address, setAddress] = useState('Getting your location…');
  // Render-only. `denied` lets the map say WHY it is blank instead of showing
  // an endless spinner; `trail` is the path drawn while live sharing runs,
  // built from the fixes the watcher already delivers — nothing extra is
  // collected, stored or sent.
  const [denied, setDenied] = useState(false);
  const [trail, setTrail] = useState<MapPoint[]>([]);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const socketRef = useRef<any>(null);
  const untilRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (mounted) setDenied(true);
        permissionDenied('Location needed', 'Allow location access to share where you are.', canAskAgain);
        return;
      }
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
        setTrail([coords]);
        socketRef.current = await getSocket();
        await Location.requestBackgroundPermissionsAsync().catch(() => {});
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 8000, distanceInterval: 8 },
          (loc) => {
            setCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude });
            setTrail((t) => [...t, { lat: loc.coords.latitude, lng: loc.coords.longitude }]);
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
      <AuroraBackground />
      <ActivityIndicator color={C.current} size="large" />
      <Text style={[s.sub, { marginTop: 12 }]}>Starting…</Text>
    </SafeAreaView>
  );

  if (screen === 'active') {
    const col = C[mode];
    return (
      <SafeAreaView style={s.root}>
        <View style={[s.center, { flex: 1, padding: 20 }]}>
          {/* The decorative pulse rings said "sharing" without ever saying
              WHERE. This is the actual position, and in live mode the path
              travelled since sharing started. */}
          <LocationMap
            coord={coords}
            trail={mode === 'current' ? null : trail}
            status={denied ? 'denied' : undefined}
            height={240}
            style={{ width: '100%', marginBottom: 18 }}
          />
          <View style={[s.badge, { backgroundColor: `${col}15`, borderColor: `${col}33`, marginBottom: 10 }]}>
            <View style={[s.dot, { backgroundColor: col }]} />
            <Text style={[s.badgeText, { color: col }]}>{mode === 'current' ? 'SNAPSHOT SHARED' : 'LIVE'}</Text>
          </View>
          <Text style={[s.heading, { textAlign: 'center', marginBottom: 4 }]}>{address}</Text>
          <Text style={[s.sub, { marginBottom: 20, textAlign: 'center' }]}>
            {mode === 'current' ? 'Snapshot sent to the chat.' : mode === 'manual' ? 'Sharing until you stop.' : `Live · ${fmt(timeLeft)} remaining`}
          </Text>
          <TouchableOpacity style={[s.btn, { backgroundColor: `${col}15`, borderColor: `${col}33`, borderWidth: 1, width: '100%' }]} onPress={stop}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Ionicons name="stop" size={16} color={col} />
              <Text style={[s.btnTxt, { color: col }]}>Stop sharing</Text>
            </View>
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
          <TouchableOpacity onPress={() => { setScreen('picker'); setSelDur(null); }} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <Ionicons name="chevron-back" size={18} color={C.link} />
            <Text style={{ color: C.link, fontSize: 15 }}>Back</Text>
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Ionicons name={live ? 'navigate' : 'location'} size={20} color={col} />
            <Text style={[s.heading, { color: col, marginBottom: 0 }]}>{live ? 'Live Location' : 'Current Location'}</Text>
          </View>
          <Text style={[s.sub, { marginBottom: 20 }]}>How long to share for?</Text>
          <View style={s.durGrid}>
            {DURATIONS.map(d => (
              <TouchableOpacity key={d.val} style={[s.durCard, selDur === d.val && { backgroundColor: `${col}18`, borderColor: `${col}55` }]} onPress={() => setSelDur(d.val)}>
                <Text style={[s.durLabel, { color: selDur === d.val ? col : colors.textDim }]}>{d.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {live && (
            <TouchableOpacity style={[s.durCard, { width: '100%', marginBottom: 16 }, selDur === -1 && { backgroundColor: `${col}18`, borderColor: `${col}55` }]} onPress={() => setSelDur(-1)}>
              <Text style={[s.durLabel, { color: selDur === -1 ? col : colors.textDim }]}>Until I stop</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.btn, { backgroundColor: selDur !== null ? col : colors.surface }]}
            disabled={selDur === null}
            onPress={() => { if (selDur !== null) startSharing(live ? 'live' : 'current', selDur === -1 ? null : selDur); }}
          >
            <Text style={[s.btnTxt, { color: selDur !== null ? '#fff' : colors.textDim }]}>{live ? 'Start live location' : 'Share location'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Mode picker
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TouchableOpacity onPress={() => router.back()} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
          <Ionicons name="chevron-back" size={18} color={C.link} />
          <Text style={{ color: C.link, fontSize: 15 }}>Back</Text>
        </TouchableOpacity>
        <Text style={s.lbl}>LOCATION SHARING</Text>
        <Text style={s.heading}>Share Location</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 16 }}>
          <Ionicons name="location-outline" size={13} color={colors.textDim} />
          <Text style={s.sub}>{address}</Text>
        </View>
        {/* Preview: what the other side will see a pin on, before you pick a mode. */}
        <LocationMap
          coord={coords}
          status={denied ? 'denied' : undefined}
          height={170}
          style={{ marginBottom: 16 }}
        />
        {!chatId && <Text style={[s.sub, { color: C.live, marginBottom: 12 }]}>Open this from a chat to share.</Text>}

        {([
          { mode: 'current' as Mode, icon: 'location' as const, title: 'Current Location', desc: 'One-time snapshot, not tracking', onPress: () => setScreen('dur-current') },
          { mode: 'live' as Mode, icon: 'navigate' as const, title: 'Live Location', desc: 'Updates as you move · time-limited', onPress: () => setScreen('dur-live') },
          { mode: 'manual' as Mode, icon: 'infinite' as const, title: 'Until I Stop', desc: 'Live with no time limit', onPress: () => startSharing('manual', null) },
        ]).map(opt => (
          <TouchableOpacity key={opt.mode} style={s.modeCard} onPress={opt.onPress} disabled={!chatId}>
            <View style={s.modeIcon}><Ionicons name={opt.icon} size={24} color={colors.text} /></View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={s.optTitle}>{opt.title}</Text>
              <Text style={s.sub}>{opt.desc}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  center: { justifyContent: 'center', alignItems: 'center' },
  heading: { fontSize: 22, fontWeight: '900', color: c.text, marginBottom: 6 },
  sub: { fontSize: 12, color: c.textDim, lineHeight: 18 },
  lbl: { fontSize: 9, fontWeight: '700', color: c.textFaint, letterSpacing: 2, marginBottom: 8 },
  modeCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke, marginBottom: 12 },
  modeIcon: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: c.glassSoft },
  optTitle: { fontSize: 15, fontWeight: '800', color: c.text },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  badgeText: { fontSize: 9, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  durGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  durCard: { width: '31%', padding: 12, borderRadius: 14, alignItems: 'center', backgroundColor: c.glassSoft, borderWidth: 1.5, borderColor: c.glassStroke },
  durLabel: { fontSize: 12, fontWeight: '800' },
  btn: { borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 10 },
  btnTxt: { fontSize: 14, fontWeight: '800', color: '#fff' },
});
