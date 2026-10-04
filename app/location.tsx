import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
// app/location.tsx — Location sharing (real, full-stack).
//
// Replaces the old screen that claimed "🔐 D2DE · AES-256-GCM · zero plaintext
// coordinates" while sending and encrypting nothing. Real behaviour now:
//   • Send current location → a real 'location' message through the normal
//     message pipeline (content = {lat,lng,address}); in direct chats it is
//     end-to-end encrypted exactly like a text message.
//   • Share live location → emits `live_location_update` over the socket, which
//     the server RELAYS to the chat with NO storage (server.js), and the peer's
//     open chat shows a live banner. Stops automatically after the chosen time.
// Honest copy only — no fabricated guarantees.

import { brandAlpha, type Palette } from '../constants/theme';
import { navigateTo } from '../lib/nav/openNavigation';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import {
  ActivityIndicator, Alert, AppState, Linking, ScrollView,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { useTheme } from '../lib/theme';
import { sendMessage } from '../lib/chatService';
import { emit } from '../lib/socket';
import { newLiveKey, encryptPosition } from '../lib/liveLocationCrypto';
import { AuroraBackground } from '../components/ui';
import LocationMap, { type MapPoint } from '../components/LocationMap';
import { readCache, writeCache } from '../lib/localCache';

// Last fix we actually got, so a re-open paints the right part of the world
// while the GPS warms up instead of a map of the whole subcontinent.
const LAST_FIX = 'location:lastFix';

const DURATIONS = [
  { label: '15 minutes', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '8 hours', seconds: 28800 },
];

function fmtClock(s: number): string {
  const m = Math.floor(s / 60), sec = s % 60;
  if (m >= 60) { const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function LocationScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const params = useLocalSearchParams();
  const chatId = (params.chatId as string) || '';
  const chatName = (params.name as string) || 'this chat';

  const [loc, setLoc] = useState<Location.LocationObject | null>(null);
  const [address, setAddress] = useState('Getting your location…');
  const [loading, setLoading] = useState(true);
  const [permDenied, setPermDenied] = useState(false);
  /** The last fix attempt failed (GPS off, timeout). Offers a retry instead of
   *  leaving "Getting your location…" up forever. */
  const [gpsError, setGpsError] = useState(false);
  const [sending, setSending] = useState(false);

  const [selDuration, setSelDuration] = useState(0);
  const [live, setLive] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  // Render-only: the path drawn on the map while live sharing is running. It is
  // built from the fixes the watcher already delivers — nothing extra is
  // collected, stored or sent.
  const [trail, setTrail] = useState<MapPoint[]>([]);
  // Shown ONLY until the real fix lands, and only on the map — the address card
  // keeps saying "Getting your location…", so nothing stale is presented as now.
  const [lastFix, setLastFix] = useState<MapPoint | null>(null);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Double-tap guard: the button stayed enabled while sendMessage was in
  // flight, so a second tap sent a second live message and its watcher
  // overwrote watchRef — leaking the first one, which kept streaming.
  const startingRef = useRef(false);
  const [startingLive, setStartingLive] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const reverseGeocode = useCallback(async (latitude: number, longitude: number) => {
    try {
      const g = await Location.reverseGeocodeAsync({ latitude, longitude });
      const a = g[0];
      setAddress(a ? [a.name, a.street, a.city, a.region].filter(Boolean).join(', ') || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
    } catch {
      setAddress(`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
    }
  }, []);

  // One fix attempt: the mount, "Try again" after a GPS failure, and the return
  // from Settings all run this. `ask` is false on that return so coming back
  // re-checks the grant without throwing a prompt at the user.
  const locate = useCallback(async (ask: boolean) => {
    setLoading(true);
    setGpsError(false);
    try {
      const { status } = ask
        ? await Location.requestForegroundPermissionsAsync()
        : await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') { setPermDenied(true); return; }
      setPermDenied(false);
      setAddress('Getting your location…');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!mountedRef.current) return;
      setLoc(pos);
      writeCache(LAST_FIX, { lat: pos.coords.latitude, lng: pos.coords.longitude });
      reverseGeocode(pos.coords.latitude, pos.coords.longitude);
    } catch {
      if (mountedRef.current) setGpsError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [reverseGeocode]);

  useEffect(() => {
    readCache<MapPoint>(LAST_FIX).then((c) => { if (c) setLastFix(c); });
    locate(true);
  }, [locate]);

  // Denied face: the only way forward is Settings, so re-check the grant when
  // the app comes back to the foreground instead of keeping a stale "denied".
  useEffect(() => {
    if (!permDenied) return;
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') locate(false); });
    return () => sub.remove();
  }, [permDenied, locate]);

  const sendCurrent = useCallback(async () => {
    if (!loc) { Alert.alert('Please wait', 'Still getting your location…'); return; }
    if (!chatId) { Alert.alert('No chat', 'Open this from a chat to share your location.'); return; }
    setSending(true);
    try {
      const payload = JSON.stringify({
        lat: loc.coords.latitude, lng: loc.coords.longitude, address, live: false,
      });
      await sendMessage(chatId, payload, 'location');
      router.back();
    } catch (e: unknown) {
      Alert.alert('Could not send', errText(e, 'Try again'));
    } finally {
      setSending(false);
    }
  }, [loc, chatId, address, router]);

  const stopLive = useCallback(() => {
    if (watchRef.current) { watchRef.current.remove(); watchRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (chatId) emit('live_location_stop', { chatId }).catch(() => {});
    setLive(false);
    setTimeLeft(0);
    setTrail([]);
  }, [chatId]);

  // Leaving the screen ends the live session (the copy says so).
  useEffect(() => stopLive, [stopLive]);

  const startLive = useCallback(async () => {
    if (startingRef.current || watchRef.current) return;
    if (!loc) { Alert.alert('Please wait', 'Still getting your location…'); return; }
    if (!chatId) { Alert.alert('No chat', 'Open this from a chat to share live location.'); return; }
    startingRef.current = true;
    setStartingLive(true);
    try {
      const dur = DURATIONS[selDuration];
      const until = Date.now() + dur.seconds * 1000;

      // Per-session key. Delivered to the peer ONCE inside the initial E2E
      // 'location' message (content.lk), then used to encrypt every relayed update
      // so the server only ever sees opaque blobs.
      const liveKey = newLiveKey();
      try {
        await sendMessage(chatId, JSON.stringify({
          lat: loc.coords.latitude, lng: loc.coords.longitude, address, live: true, lk: liveKey, until,
        }), 'location');
      } catch (e: unknown) {
        Alert.alert('Could not start', errText(e, 'Try again'));
        return;
      }

      setLive(true);
      setTimeLeft(dur.seconds);
      setTrail([{ lat: loc.coords.latitude, lng: loc.coords.longitude }]);

      // Encrypt each position with the session key and relay the opaque blob.
      // Only the FIRST update carries the address — it was looked up for that
      // position. Re-sending it with every later fix labelled a moving person
      // with where they started; the peer's banner shows coordinates instead.
      const pushUpdate = (latitude: number, longitude: number, addr?: string) => {
        const blob = encryptPosition(liveKey, { lat: latitude, lng: longitude, ...(addr ? { address: addr } : {}) });
        if (blob) emit('live_location_update', { chatId, blob, until }).catch(() => {});
      };
      pushUpdate(loc.coords.latitude, loc.coords.longitude, address);

      try {
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 },
          (newPos) => {
            setLoc(newPos);
            setTrail((t) => [...t, { lat: newPos.coords.latitude, lng: newPos.coords.longitude }]);
            pushUpdate(newPos.coords.latitude, newPos.coords.longitude);
          },
        );
        // Left the screen while the watcher was starting: the unmount cleanup
        // already ran, so this one would stream with nothing to stop it.
        if (!mountedRef.current) { sub.remove(); emit('live_location_stop', { chatId }).catch(() => {}); return; }
        watchRef.current = sub;
      } catch (e: unknown) {
        Alert.alert('Could not start', errText(e, 'Try again'));
        stopLive();
        return;
      }

      timerRef.current = setInterval(() => {
        setTimeLeft((t) => {
          if (t <= 1) { stopLive(); return 0; }
          return t - 1;
        });
      }, 1000);
    } finally { startingRef.current = false; if (mountedRef.current) setStartingLive(false); }
  }, [loc, chatId, selDuration, address, stopLive]);

  if (permDenied) {
    return (
      <View style={[S.container, S.center]}>
      <AuroraBackground />
        <Text style={S.permTitle}>Location permission needed</Text>
        <Text style={S.permSub}>Allow location access to share your position.</Text>
        <TouchableOpacity style={S.primaryBtn} onPress={() => { Linking.openSettings().catch(() => {}); }}
          accessibilityRole="button" accessibilityHint="Opens this app's settings to allow location access">
          <Text style={S.primaryBtnText}>Open settings</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" hitSlop={12} style={{ marginTop: 14 }}>
          <Text style={S.link}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const lat = loc?.coords.latitude;
  const lng = loc?.coords.longitude;

  return (
    <View style={S.container}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Share location</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* The real map. While live sharing runs it also draws the path
            travelled so far, from the fixes the watcher already delivers. */}
        <LocationMap
          coord={lat != null && lng != null ? { lat, lng } : lastFix}
          status={lat != null && lng != null ? 'ok' : gpsError ? 'nofix' : 'locating'}
          trail={live ? trail : null}
          height={220}
          style={{ marginBottom: 12 }}
        />

        {/* Address / coordinates */}
        <View style={S.mapCard}>
          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} accessibilityLabel="Getting your location" />
          ) : gpsError && !loc ? (
            <>
              <Text style={S.address}>Couldn’t get your location</Text>
              <Text style={[S.coords, { textAlign: 'center' }]}>Check that location services (GPS) are on, then try again.</Text>
              <TouchableOpacity style={S.mapsBtn} onPress={() => locate(true)} accessibilityRole="button" accessibilityLabel="Try getting your location again">
                <Ionicons name="refresh" size={15} color={colors.primary} />
                <Text style={S.mapsBtnText}>Try again</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={S.address} numberOfLines={2}>{address}</Text>
              {lat != null && lng != null && (
                <Text style={S.coords}>{lat.toFixed(5)}, {lng.toFixed(5)}</Text>
              )}
              {lat != null && lng != null && (
                <TouchableOpacity style={S.mapsBtn} onPress={() => navigateTo(lat, lng, address || 'Location')} accessibilityRole="button">
                  <Ionicons name="navigate" size={15} color={colors.primary} />
                  <Text style={S.mapsBtnText}>Navigate here</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        {live ? (
          <View style={S.liveCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <View style={S.liveDot} />
              <Text style={S.liveTitle}>Sharing live with {chatName}</Text>
            </View>
            <Text style={S.liveSub}>{fmtClock(timeLeft)} remaining · updates as you move · stops if you leave this screen</Text>
            <TouchableOpacity style={[S.primaryBtn, { backgroundColor: colors.danger, marginTop: 12 }]} onPress={stopLive} accessibilityRole="button">
              <Text style={S.primaryBtnText}>Stop sharing</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Send current location */}
            <TouchableOpacity style={[S.primaryBtn, sending && { opacity: 0.5 }]} onPress={sendCurrent} disabled={sending || loading}
              accessibilityRole="button" accessibilityState={{ disabled: sending || loading, busy: sending }}>
              {sending ? <ActivityIndicator size="small" color="#fff" /> : <Text style={S.primaryBtnText}>Send current location</Text>}
            </TouchableOpacity>
            <Text style={S.note}>
              Sends a pin to {chatName}. In direct chats it’s end-to-end encrypted, just like your messages.
            </Text>

            {/* Live location */}
            <Text style={S.sectionTitle}>SHARE LIVE FOR</Text>
            <View style={S.durRow}>
              {DURATIONS.map((d, i) => (
                <TouchableOpacity
                  key={d.label}
                  style={[S.durBtn, selDuration === i && S.durBtnActive]}
                  onPress={() => setSelDuration(i)}
                  disabled={startingLive}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selDuration === i, selected: selDuration === i, disabled: startingLive }}
                >
                  <Text style={[S.durText, selDuration === i && S.durTextActive]}>{d.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={[S.primaryBtn, { backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.glassStroke }, startingLive && { opacity: 0.5 }]}
              onPress={startLive} disabled={loading || startingLive}
              accessibilityRole="button" accessibilityState={{ disabled: loading || startingLive, busy: startingLive }}
            >
              {startingLive
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Text style={[S.primaryBtnText, { color: colors.primary }]}>Start live location</Text>}
            </TouchableOpacity>
            {/* Matches the behaviour: the watcher lives in this screen, and
                leaving it ends the session (the unmount calls stopLive). */}
            <Text style={S.note}>
              Streams your position in real time while this screen stays open. It’s relayed through
              the server and never stored, and stops after the time you pick or when you leave this screen.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  center: { justifyContent: 'center', alignItems: 'center', padding: 32 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: c.glassStroke },
  title: { color: c.text, fontSize: 17, fontWeight: '800' },

  mapCard: { backgroundColor: c.glassSoft, borderRadius: 18, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center', padding: 22, gap: 6 },
  address: { color: c.text, fontSize: 15, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  coords: { color: c.textDim, fontSize: 12.5 },
  mapsBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, backgroundColor: brandAlpha(0.12) },
  mapsBtnText: { color: c.primary, fontSize: 13, fontWeight: '700' },

  primaryBtn: { marginTop: 16, backgroundColor: c.primary, paddingVertical: 15, borderRadius: 14, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  note: { color: c.textDim, fontSize: 12.5, lineHeight: 18, marginTop: 8, paddingHorizontal: 4 },

  sectionTitle: { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 26, marginBottom: 10, marginLeft: 4 },
  durRow: { flexDirection: 'row', gap: 8 },
  durBtn: { flex: 1, paddingVertical: 11, borderRadius: 12, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center' },
  durBtnActive: { backgroundColor: brandAlpha(0.15), borderColor: c.primary },
  durText: { color: c.textDim, fontSize: 13, fontWeight: '600' },
  durTextActive: { color: c.primary, fontWeight: '800' },

  liveCard: { marginTop: 16, backgroundColor: c.danger + '12', borderRadius: 16, borderWidth: 1, borderColor: c.danger + '4D', padding: 16 },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: c.danger },
  liveTitle: { color: c.text, fontSize: 15, fontWeight: '800' },
  liveSub: { color: c.textDim, fontSize: 12.5, marginTop: 4 },

  permTitle: { color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  permSub: { color: c.textDim, fontSize: 14, textAlign: 'center', marginTop: 8, marginBottom: 18 },
  link: { color: c.primary, fontSize: 14, fontWeight: '700' },
});
