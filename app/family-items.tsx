// app/family-items.tsx — Item finder (BLE tags), the open alternative to Tile.
//
// Three jobs, in the order a person needs them:
//   1. PAIR   — list what is advertising nearby and let them name it.
//   2. FIND   — a live hot/cold meter for one item, driven by smoothed RSSI.
//   3. RECALL — where and when the phone last heard it, named by saved Place.
//
// Vendor-neutral: anything that advertises over BLE works. The reasoning lives
// in lib/items/proximity + leftBehind (pure, self-checked); this file is
// permission, scan lifecycle and layout.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { SPACE_SHADOW } from '../constants/spaceTheme';
import {
  smoothRssi, bandOf, rssiToMetres, trend, BAND_LABEL, type ProximityBand,
} from '../lib/items/proximity';
import { listItems, addItem, removeItem, patchItem, type TrackedItem } from '../lib/items/store';
import {
  startScan, ensureBlePermissions, isBluetoothOn, isBleAvailable, destroyScanner, bleLastError, type Seen,
} from '../lib/items/scanner';
import { getPlaces } from '../lib/family/store';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  fetchSharedItems, registerSharedItem, reportSighting, forgetSharedItem, type SharedItem,
} from '../lib/items/api';
import { type Geofence } from '../lib/family/geofence';
import { haversine } from '../lib/nav/geo';

/** Which saved Place contains this position, if any. Local to this screen:
 *  geofence.ts owns crossing DETECTION (with hysteresis); this is the simpler
 *  "am I inside right now" question a sighting needs to name a place. */
function placeAt(places: Geofence[], pos: { lat: number; lng: number }): Geofence | null {
  for (const f of places) {
    if (f.enabled === false) continue;
    if (haversine(f.center, pos) <= f.radiusM) return f;
  }
  return null;
}

const ICONS = ['key', 'wallet', 'briefcase', 'bag-handle', 'bicycle', 'car', 'headset', 'laptop'];

const BAND_COLOR = (b: ProximityBand, c: any) =>
  b === 'immediate' ? c.success : b === 'near' ? c.primary : b === 'far' ? c.warning ?? c.primary : c.textDim;

export default function FamilyItemsScreen() {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const params = useLocalSearchParams<{ circleId?: string }>();
  const circleId = String(params.circleId || '');

  const [items, setItems] = useState<TrackedItem[]>([]);
  const [places, setPlaces] = useState<Geofence[]>([]);
  const [scanning, setScanning] = useState(false);
  const [nearby, setNearby] = useState<Map<string, Seen>>(new Map());
  /** Smoothed RSSI per device id — the finder's real signal. */
  const rssiRef = useRef<Map<string, number>>(new Map());
  const prevRssiRef = useRef<Map<string, number>>(new Map());
  const [tick, setTick] = useState(0);
  /** What the SPACE knows — sightings by any member's phone. Empty when the
   *  server predates migration 114; the local finder is unaffected. */
  const [shared, setShared] = useState<SharedItem[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Seen | null>(null);
  const [pairName, setPairName] = useState('');
  const [pairIcon, setPairIcon] = useState(ICONS[0]);
  const stopRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    listItems().then(setItems).catch(() => {});
    getCurrentUserAsync().then((u) => setMe(u ? String(u.id) : null)).catch(() => {});
    if (circleId) {
      getPlaces(circleId).then(setPlaces).catch(() => {});
      fetchSharedItems(circleId).then(setShared).catch(() => {});
    }
  }, [circleId]);

  /** Advertisements seen since the last flush. Buffered in a ref, NEVER in
   *  state — see onSeen. */
  const pendingRef = useRef<Map<string, Seen>>(new Map());

  // Re-render on a slow pulse so bands/trends update without a render per
  // advertisement — a busy room produces dozens of callbacks a second.
  //
  // This pulse is also the ONLY writer of `nearby`. The pulse used to exist
  // while onSeen still called setNearby per advertisement, so the throttle
  // never applied to the thing that actually re-renders: with
  // allowDuplicates:true and seven tags in range, every advertisement copied
  // the whole Map and re-rendered the list. That storm starved the JS thread
  // and the app went "isn't responding" on device (2026-08-22) — which looks
  // exactly like a dead button, because nothing can respond to a tap.
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => {
      const batch = pendingRef.current;
      if (batch.size) {
        pendingRef.current = new Map();
        setNearby((m) => { const n = new Map(m); batch.forEach((v, k) => n.set(k, v)); return n; });
      }
      setTick((n) => n + 1);
    }, 800);
    return () => clearInterval(t);
  }, [scanning]);

  const onSeen = useCallback((s: Seen) => {
    const prev = rssiRef.current.get(s.id);
    if (prev != null) prevRssiRef.current.set(s.id, prev);
    rssiRef.current.set(s.id, smoothRssi(prev, s.rssi));
    // Buffer only. The 800 ms pulse above turns a burst of advertisements
    // into ONE state update.
    pendingRef.current.set(s.id, s);
  }, []);

  const start = useCallback(async () => {
    // EVERY failure path says something. A silent no-op button is worse than
    // an error: this one looked dead on device because a native construction
    // throw escaped as an unhandled rejection (2026-08-22).
    try {
      if (!isBleAvailable()) {
        Alert.alert('Bluetooth unavailable', bleLastError() ?? 'This build has no Bluetooth module.');
        return;
      }
      if (!(await ensureBlePermissions())) {
        Alert.alert('Permission needed', 'Allow “Nearby devices” so the app can hear your tags.');
        return;
      }
      if (!(await isBluetoothOn())) {
        Alert.alert('Bluetooth is off', bleLastError() ?? 'Turn Bluetooth on to search for your items.');
        return;
      }
      stopRef.current = await startScan(onSeen, (msg) => {
        // The radio can drop the scan long after it started. Without this the
        // screen kept spinning with an empty list and no way to know why.
        stopRef.current = null;
        setScanning(false);
        Alert.alert('Search stopped', msg);
      });
      if (!stopRef.current) { Alert.alert('Could not search', bleLastError() ?? 'The scan did not start.'); return; }
      setScanning(true);
    } catch (e: any) {
      Alert.alert('Could not search', String(e?.message ?? e));
    }
  }, [onSeen]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => () => { stopRef.current?.(); destroyScanner(); }, []);

  /**
   * Record a sighting: WHERE the phone was when it heard the tag. This is the
   * answer to "where did I leave it", and it costs no extra permission — the
   * OS cache is read, never a fresh GPS fix.
   */
  const rememberSighting = useCallback(async (item: TrackedItem) => {
    try {
      const loc = await Location.getLastKnownPositionAsync();
      const pos = loc ? { lat: loc.coords.latitude, lng: loc.coords.longitude } : null;
      const place = pos ? (placeAt(places, pos)?.name ?? null) : null;
      const next = await patchItem(item.id, {
        lastSeenAt: Date.now(),
        ...(pos ? { lastSeenLat: pos.lat, lastSeenLng: pos.lng } : {}),
        lastSeenPlace: place,
      });
      setItems(next);
      // Tell the space. This is what lets another member's phone answer
      // "where are my keys" — and it is why hearing someone ELSE's tag is
      // worth reporting at all.
      if (circleId) reportSighting(circleId, item.id, pos, place).catch(() => {});
    } catch { /* a sighting we could not stamp is still a sighting */ }
  }, [places]);

  // Stamp a sighting at most once a minute per item while scanning.
  const lastStamp = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!scanning) return;
    const now = Date.now();
    for (const it of items) {
      const seen = nearby.get(it.id);
      if (!seen) continue;
      if ((lastStamp.current.get(it.id) ?? 0) > now - 60_000) continue;
      lastStamp.current.set(it.id, now);
      rememberSighting(it);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, scanning, items, nearby]);

  const pairedIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const discoverable = useMemo(
    () => [...nearby.values()]
      .filter((s) => !pairedIds.has(s.id))
      .sort((a, b) => (rssiRef.current.get(b.id) ?? -999) - (rssiRef.current.get(a.id) ?? -999))
      .slice(0, 12),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nearby, pairedIds, tick],
  );

  const doPair = async () => {
    if (!pairing) return;
    const name = pairName.trim() || pairing.name || 'Item';
    const next = await addItem({
      id: pairing.id, name, icon: pairIcon, addedAt: Date.now(), leftBehindAlerts: true,
    });
    setItems(next);
    if (circleId) {
      // Crowd-find is the whole point of sharing a tag: without this call no
      // other member's phone can answer "have you seen it". Swallowing the
      // failure left the item looking shared when only this phone knew of it.
      registerSharedItem(circleId, pairing.id, name, pairIcon)
        .then((ok) => {
          if (!ok) throw new Error('rejected');
          return fetchSharedItems(circleId).then(setShared);
        })
        .catch(() => Alert.alert(
          'Saved, but not shared',
          `"${name}" is on this phone. It could not be shared with your space, so other members cannot help find it yet.`,
        ));
    }
    setPairing(null);
    setPairName('');
  };

  const ago = (ms?: number) => {
    if (!ms) return 'never';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  };

  return (
    <View style={{ flex: 1, backgroundColor: G.bgMid }}>
      <Stack.Screen options={{
        headerShown: true, title: 'Find my things', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <SpaceGround />

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
        <TouchableOpacity
          onPress={scanning ? stop : start}
          accessibilityRole="button"
          style={[st.scanBtn, { backgroundColor: scanning ? colors.danger + '18' : brandAlpha(0.1), borderColor: scanning ? colors.danger : colors.primary }]}
        >
          {scanning ? <ActivityIndicator size="small" color={colors.danger} /> : <Ionicons name="bluetooth" size={18} color={colors.primary} />}
          <Text style={{ color: scanning ? G.dangerText : G.accentText, fontWeight: '800', fontSize: 14 }}>
            {scanning ? 'Stop searching' : 'Search for my things'}
          </Text>
        </TouchableOpacity>

        {/* ── PAIRED ITEMS: the finder ── */}
        {items.length > 0 && <Text style={[st.h, { color: colors.textDim }]}>MY THINGS</Text>}
        {items.map((it) => {
          const seen = nearby.get(it.id);
          const r = rssiRef.current.get(it.id) ?? null;
          const band = bandOf(scanning ? r : null, seen?.at, Date.now());
          const metres = band === 'lost' ? null : rssiToMetres(r ?? -999);
          const dir = trend(prevRssiRef.current.get(it.id), r);
          return (
            <View key={it.id} style={[st.card, { backgroundColor: G.pane, borderColor: band === 'immediate' ? colors.success : G.edge }]}>
              <View style={[st.icon, { backgroundColor: G.paneFaint }]}>
                <Ionicons name={it.icon as any} size={20} color={BAND_COLOR(band, colors)} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>{it.name}</Text>
                {scanning ? (
                  // The band caption is small TEXT, so it takes the AA-deep
                  // tints; the icon keeps the brighter raw band colour.
                  <Text style={{ color: band === 'immediate' ? G.goodText : band === 'near' || band === 'far' ? G.accentText : colors.textDim, fontSize: 12.5, fontWeight: '600' }}>
                    {BAND_LABEL[band]}
                    {metres != null ? `  ·  ~${metres < 1 ? '<1' : metres} m` : ''}
                    {dir === 1 ? '  ↑ warmer' : dir === -1 ? '  ↓ colder' : ''}
                  </Text>
                ) : (() => {
                  // WHOEVER HEARD IT LAST WINS — this phone or another
                  // member's. That is the entire point of pooling sightings:
                  // the tag is usually not near its owner when it is lost.
                  const sh = shared.find((x) => x.bleId === it.id);
                  const mineAt = it.lastSeenAt ?? 0;
                  const theirsAt = sh?.lastSeenAt ?? 0;
                  const byOther = theirsAt > mineAt && sh?.lastSeenBy && sh.lastSeenBy !== me;
                  const at = byOther ? theirsAt : (it.lastSeenAt ?? undefined);
                  const place = byOther ? sh?.placeName : it.lastSeenPlace;
                  return (
                    <Text style={{ color: colors.textDim, fontSize: 12.5 }} numberOfLines={1}>
                      Last seen {ago(at)}
                      {place ? ` · ${place}` : ''}
                      {byOther ? '  · by family' : ''}
                    </Text>
                  );
                })()}
              </View>
              <TouchableOpacity
                onPress={() => Alert.alert(it.name, 'Remove this item?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: async () => {
                    setItems(await removeItem(it.id));
                    // A removal that only happened locally is the worst
                    // outcome: the owner believes the tag is forgotten while
                    // the space still lists it and members still report
                    // sightings of it. Say so rather than swallow it.
                    if (circleId) {
                      forgetSharedItem(circleId, it.id)
                        .then(() => fetchSharedItems(circleId).then(setShared))
                        .catch(() => Alert.alert(
                          'Removed here only',
                          `"${it.name}" is gone from this phone, but your space could not be updated. Others may still see it — try again when you are back online.`,
                        ));
                    }
                  } },
                ])}
                style={{ padding: 6 }}
                hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                accessibilityRole="button" accessibilityLabel={`Options for ${it.name}`}
              >
                <Ionicons name="ellipsis-vertical" size={17} color={colors.textDim} />
              </TouchableOpacity>
            </View>
          );
        })}

        {items.length === 0 && !scanning && (
          <Text style={{ color: colors.textDim, fontSize: 13.5, lineHeight: 19, paddingVertical: 10 }}>
            Attach any Bluetooth tag to your keys, wallet or bag — any brand works. Search
            to pair it, and this phone will remember where it last heard it.
          </Text>
        )}

        {/* ── DISCOVERY ── */}
        {scanning && (
          <>
            <Text style={[st.h, { color: colors.textDim, marginTop: 18 }]}>NEARBY DEVICES</Text>
            {discoverable.length === 0 && (
              <Text style={{ color: colors.textDim, fontSize: 13 }}>Looking… hold the tag near the phone and press its button if it has one.</Text>
            )}
            {discoverable.map((s) => {
              const r = rssiRef.current.get(s.id) ?? s.rssi;
              return (
                <TouchableOpacity
                  key={s.id}
                  onPress={() => { setPairing(s); setPairName(s.name ?? ''); }}
                  style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}
                >
                  <View style={[st.icon, { backgroundColor: colors.primary + '18' }]}>
                    <Ionicons name="radio-outline" size={19} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
                      {s.name || 'Unnamed device'}
                    </Text>
                    <Text style={{ color: colors.textDim, fontSize: 11.5 }} numberOfLines={1}>
                      {BAND_LABEL[bandOf(r)]} · {s.id.slice(0, 17)}
                    </Text>
                  </View>
                  <Text style={{ color: G.accentText, fontWeight: '800', fontSize: 12 }}>PAIR</Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* ── PAIRING SHEET ── */}
        {pairing && (
          <View style={[st.pair, { backgroundColor: G.paneStrong, borderColor: colors.primary }]}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>Name this item</Text>
            <TextInput
              value={pairName}
              onChangeText={setPairName}
              placeholder="Keys, wallet, bag…"
              placeholderTextColor={colors.textFaint}
              style={[st.input, { color: colors.text, borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}
            />
            <View style={st.iconRow}>
              {ICONS.map((ic) => (
                <TouchableOpacity
                  key={ic}
                  onPress={() => setPairIcon(ic)}
                  accessibilityRole="button" accessibilityState={{ selected: pairIcon === ic }} accessibilityLabel={`${ic} icon`}
                  style={[st.iconPick, { borderColor: pairIcon === ic ? colors.primary : G.chipEdge, backgroundColor: pairIcon === ic ? brandAlpha(0.14) : G.paneFaint }]}
                >
                  <Ionicons name={ic as any} size={18} color={pairIcon === ic ? colors.primary : colors.textDim} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 9 }}>
              <TouchableOpacity onPress={() => setPairing(null)} style={[st.btn, { borderColor: G.chipEdge, flex: 1 }]}>
                <Text style={{ color: colors.textDim, fontWeight: '700' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={doPair} style={[st.btn, { borderColor: colors.primary, backgroundColor: brandAlpha(0.14), flex: 1 }]}>
                <Text style={{ color: G.accentText, fontWeight: '800' }}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── LEFT-BEHIND TOGGLE ── */}
        {items.length > 0 && (
          <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge, marginTop: 18 }]}>
            <View style={[st.icon, { backgroundColor: colors.primary + '18' }]}>
              <Ionicons name="notifications-outline" size={19} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>Left-behind alerts</Text>
              <Text style={{ color: colors.textDim, fontSize: 11.5, lineHeight: 16 }}>
                Warn me if I leave a saved place without an item. Needs the app to be searching.
              </Text>
            </View>
            <Switch
              value={items.every((i) => i.leftBehindAlerts !== false)}
              onValueChange={async (v) => {
                // allSettled, and refresh WHATEVER happened. The sequential
                // await threw on the first network failure, so the remaining
                // items were never touched AND setItems never ran: the switch
                // kept showing the old value while half the items had flipped,
                // with nothing on screen admitting it.
                await Promise.allSettled(items.map((i) => patchItem(i.id, { leftBehindAlerts: v })));
                setItems(await listItems().catch(() => items));
              }}
              trackColor={{ true: colors.primary }}
            />
          </View>
        )}

        <Text style={{ color: colors.textDim, fontSize: 11.5, lineHeight: 16, marginTop: 16 }}>
          Works with any Bluetooth tag — no brand lock-in, no subscription. Tags you pair, and
          where they were last heard, are shared with this space so any member&apos;s phone can help
          find them. The tag&apos;s maker is never involved.
        </Text>
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  h: { fontSize: 12, fontWeight: '800', letterSpacing: 0.7, marginBottom: 8, marginTop: 6 },
  scanBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    minHeight: 50, borderRadius: 16, borderWidth: 1, marginBottom: 16,
  },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    borderWidth: 1, borderRadius: 18, padding: 12, marginBottom: 10, ...SPACE_SHADOW.rest,
  },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  pair: { borderWidth: 1, borderRadius: 20, padding: 14, gap: 11, marginTop: 12, ...SPACE_SHADOW.raised },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 46, fontSize: 15 },
  iconRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconPick: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 46, borderRadius: 12, borderWidth: 1 },
});
