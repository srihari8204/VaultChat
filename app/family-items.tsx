// app/family-items.tsx — Item finder (BLE tags), the open alternative to Tile.
//
// Three jobs, in the order a person needs them:
//   1. PAIR   — list what is advertising nearby and let them name it.
//   2. FIND   — a live hot/cold meter for one item, driven by smoothed RSSI.
//   3. RECALL — where and when the phone last heard it, named by saved Place.
//
// Vendor-neutral: anything that advertises over BLE works. The reasoning lives
// in lib/items/proximity + leftBehind + crowd (pure, self-checked); this file
// is permission, scan lifecycle and layout.
//
// CROWD-FIND. While searching, this phone also reports the OTHER members' tags
// it hears (the space registry lists them; any member may report a sighting),
// and lists them under "Family's things". Only the place NAME travels.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, TextInput, Modal, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { SPACE_SHADOW } from '../constants/spaceTheme';
import { KeyboardSafe } from '../components/ui';
import { familyTags, dueSightings } from '../lib/items/crowd';
import {
  smoothRssi, bandOf, rssiToMetres, trend, BAND_LABEL, type ProximityBand,
} from '../lib/items/proximity';
import { listItems, addItem, removeItem, patchItem, type TrackedItem } from '../lib/items/store';
import {
  startScan, ensureBlePermissions, bleNeverAskAgain, isBluetoothOn, isBleAvailable, destroyScanner, bleLastError,
  type Seen,
} from '../lib/items/scanner';
import { permissionDenied } from '../lib/permissionDenied';
import { getPlaces } from '../lib/family/store';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  fetchSharedItems, registerSharedItem, reportSighting, forgetSharedItem, type SharedItem,
} from '../lib/items/api';
import { type Geofence } from '../lib/family/geofence';
import { haversine } from '../lib/nav/geo';
import { ago } from '../lib/family/memberFormat';
import { sheetSt } from '../components/family/sheetStyles';

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

type IconName = keyof typeof Ionicons.glyphMap;
const ICONS: IconName[] = ['key', 'wallet', 'briefcase', 'bag-handle', 'bicycle', 'car', 'headset', 'laptop'];

/** A list that could not be read: says so, with Retry — never an empty list. */
function LoadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    <View style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]} accessibilityLiveRegion="polite">
      <Ionicons name="cloud-offline-outline" size={18} color={colors.textDim} />
      <Text style={{ flex: 1, color: colors.textDim, fontSize: 13 }}>{text}</Text>
      <TouchableOpacity onPress={onRetry} accessibilityRole="button" accessibilityLabel={`Retry. ${text}`}
        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
        <Text style={{ color: G.accentText, fontWeight: '800', fontSize: 13 }}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

const BAND_COLOR = (b: ProximityBand, c: { success: string; primary: string; warning?: string; textDim: string }) =>
  b === 'immediate' ? c.success : b === 'near' ? c.primary : b === 'far' ? c.warning ?? c.primary : c.textDim;

export default function FamilyItemsScreen() {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const params = useLocalSearchParams<{ circleId?: string }>();
  const circleId = String(params.circleId || '');

  const [items, setItems] = useState<TrackedItem[]>([]);
  /** This phone's saved items could not be read — not the same as "none". */
  const [itemsFailed, setItemsFailed] = useState(false);
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
  /** The space's list could not be fetched (offline, 5xx) — a 404 server is not a failure. */
  const [sharedFailed, setSharedFailed] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Seen | null>(null);
  const [pairName, setPairName] = useState('');
  const [pairIcon, setPairIcon] = useState<IconName>(ICONS[0]);
  /** A pairing save is in flight — Save ignores repeat taps until it lands. */
  const [saving, setSaving] = useState(false);
  const stopRef = useRef<null | (() => void)>(null);

  const loadLists = useCallback(() => {
    setItemsFailed(false);
    listItems().then(setItems).catch(() => setItemsFailed(true));
    if (circleId) {
      setSharedFailed(false);
      fetchSharedItems(circleId).then(setShared).catch(() => setSharedFailed(true));
    }
  }, [circleId]);

  useEffect(() => {
    loadLists();
    getCurrentUserAsync().then((u) => setMe(u ? String(u.id) : null)).catch(() => {});
    if (circleId) getPlaces(circleId).then(setPlaces).catch(() => {});
  }, [circleId, loadLists]);

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
        // After "don't ask again" the OS stays silent: offer Settings.
        permissionDenied('Permission needed', 'Allow “Nearby devices” so the app can hear your tags.', !bleNeverAskAgain());
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

  /** Where this phone is, from the OS cache (never a fresh GPS fix, no
   *  permission prompt), and the saved Place that contains it, if any. */
  const whereNow = useCallback(async () => {
    const loc = await Location.getLastKnownPositionAsync().catch(() => null);
    const pos = loc ? { lat: loc.coords.latitude, lng: loc.coords.longitude } : null;
    return { pos, place: pos ? (placeAt(places, pos)?.name ?? null) : null };
  }, [places]);

  /** My own tags whose latest sighting the space did not take: the stamp
   *  here is real, but other members cannot see it yet. */
  const [unreported, setUnreported] = useState<ReadonlySet<string>>(new Set());
  const markReported = useCallback((id: string, failed: boolean) => setUnreported((cur) => {
    if (cur.has(id) === failed) return cur;
    const next = new Set(cur);
    if (failed) next.add(id); else next.delete(id);
    return next;
  }), []);

  /**
   * Record a sighting: WHERE the phone was when it heard the tag. This is the
   * answer to "where did I leave it", and it costs no extra permission — the
   * OS cache is read, never a fresh GPS fix.
   */
  const rememberSighting = useCallback(async (item: TrackedItem) => {
    try {
      const { pos, place } = await whereNow();
      const next = await patchItem(item.id, {
        lastSeenAt: Date.now(),
        ...(pos ? { lastSeenLat: pos.lat, lastSeenLng: pos.lng } : {}),
        lastSeenPlace: place,
      });
      setItems(next);
      // Tell the space. This is what lets another member's phone answer
      // "where are my keys" — and it is why hearing someone ELSE's tag is
      // worth reporting at all.
      // Only the place NAME is shared — never this phone's coordinates.
      // A failed report is said on the row and retried on the next due minute.
      if (circleId) {
        reportSighting(circleId, item.id, place)
          .then(() => markReported(item.id, false), () => markReported(item.id, true));
      }
    } catch { /* a sighting we could not stamp is still a sighting */ }
  }, [whereNow, circleId, markReported]);

  /** Another member's tag heard by this phone: tell the space where (place
   *  name only), and show it here as heard by you — only once the space has
   *  actually taken the report, so "by you" never claims a sighting the
   *  owner cannot see. A failed report is retried on the next due minute. */
  const reportFamilySighting = useCallback(async (bleId: string) => {
    if (!circleId) return;
    const { place } = await whereNow();
    const at = Date.now();
    try { await reportSighting(circleId, bleId, place, at); } catch { return; }
    setShared((list) => list.map((x) => (x.bleId === bleId
      ? { ...x, lastSeenAt: at, lastSeenBy: me, placeName: place } : x)));
  }, [circleId, whereNow, me]);

  const pairedIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  /** Other members' tags: this phone can only help find them. */
  const family = useMemo(() => familyTags(shared, pairedIds, me), [shared, pairedIds, me]);

  // Stamp a sighting at most once a minute per tag while scanning — my own
  // paired tags AND the family's.
  const lastStamp = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!scanning) return;
    const now = Date.now();
    const due = dueSightings(
      [...items.map((it) => it.id), ...family.map((f) => f.bleId)],
      (id) => nearby.has(id), lastStamp.current, now,
    );
    for (const id of due) {
      lastStamp.current.set(id, now);
      const it = items.find((x) => x.id === id);
      if (it) rememberSighting(it); else reportFamilySighting(id);
    }
  // `tick` (every 0.8 s while scanning) re-checks what is due; a re-run on new
  // callbacks stamps nothing early, because dueSightings keeps each tag to
  // once a minute.
  }, [tick, scanning, items, family, nearby, rememberSighting, reportFamilySighting]);

  const familyIds = useMemo(() => new Set(family.map((f) => f.bleId)), [family]);
  const discoverable = useMemo(
    () => [...nearby.values()]
      // Another member's tag is not offered for pairing: pairing it here would
      // rename THEIR shared entry (the server upserts by tag id).
      .filter((s) => !pairedIds.has(s.id) && !familyIds.has(s.id))
      .sort((a, b) => (rssiRef.current.get(b.id) ?? -999) - (rssiRef.current.get(a.id) ?? -999))
      .slice(0, 12),
    // `tick` (not read) re-sorts by the live RSSI in rssiRef every 0.8 s; a
    // ref is not a dependency the lint rule can see, hence the disable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nearby, pairedIds, familyIds, tick],
  );

  const doPair = async () => {
    if (!pairing || saving) return;
    const name = pairName.trim() || pairing.name || 'Item';
    let next: TrackedItem[];
    setSaving(true);
    try {
      next = await addItem({ id: pairing.id, name, icon: pairIcon, addedAt: Date.now() });
    } catch {
      Alert.alert('Could not save', `"${name}" was not saved. Try again.`);
      return;
    } finally { setSaving(false); }
    setItems(next);
    if (circleId) {
      // Crowd-find is the whole point of sharing a tag: without this call no
      // other member's phone can answer "have you seen it". Swallowing the
      // failure left the item looking shared when only this phone knew of it.
      registerSharedItem(circleId, pairing.id, name, pairIcon)
        .then((ok) => {
          if (!ok) throw new Error('rejected');
          // Shared; a failed re-read is only a stale list, not a failed share.
          fetchSharedItems(circleId).then(setShared).catch(() => setSharedFailed(true));
        })
        .catch(() => Alert.alert(
          'Saved, but not shared',
          `"${name}" is on this phone. It could not be shared with your space, so other members cannot help find it yet.`,
        ));
    }
    setPairing(null);
    setPairName('');
  };

  /** The shared "5m ago" wording (lib/family/memberFormat), or "never". */
  const seenAgo = (ms?: number | null) => (ms ? ago(ms) : 'never');

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
          accessibilityRole="button" accessibilityState={{ busy: scanning }}
          style={[st.scanBtn, { backgroundColor: scanning ? G.paneStrong : brandAlpha(0.1), borderColor: scanning ? colors.danger : colors.primary }]}
        >
          {scanning ? <ActivityIndicator size="small" color={colors.danger} /> : <Ionicons name="bluetooth" size={18} color={colors.primary} />}
          <Text style={{ color: scanning ? G.dangerText : G.accentText, fontWeight: '800', fontSize: 14 }}>
            {scanning ? 'Stop searching' : 'Search for my things'}
          </Text>
        </TouchableOpacity>

        {/* ── PAIRED ITEMS: the finder ── */}
        {items.length > 0 && <Text accessibilityRole="header" style={[st.h, { color: colors.textDim }]}>MY THINGS</Text>}
        {items.map((it) => {
          const seen = nearby.get(it.id);
          const r = rssiRef.current.get(it.id) ?? null;
          const band = bandOf(scanning ? r : null, seen?.at, Date.now());
          const metres = band === 'lost' ? null : rssiToMetres(r ?? -999);
          const dir = trend(prevRssiRef.current.get(it.id), r);
          return (
            <View key={it.id} style={[st.card, { backgroundColor: G.pane, borderColor: band === 'immediate' ? colors.success : G.edge }]}>
              <View style={[st.icon, { backgroundColor: G.paneFaint }]}>
                <Ionicons name={it.icon as IconName} size={20} color={BAND_COLOR(band, colors)} />
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
                    <Text style={{ color: colors.textDim, fontSize: 12.5 }} numberOfLines={2}>
                      Last seen {seenAgo(at)}
                      {place ? ` · ${place}` : ''}
                      {byOther ? '  · by family' : ''}
                      {!byOther && unreported.has(it.id) ? '  · not shared with your space yet' : ''}
                    </Text>
                  );
                })()}
              </View>
              <TouchableOpacity
                onPress={() => Alert.alert(it.name, 'Remove this item?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: async () => {
                    try { setItems(await removeItem(it.id)); }
                    catch {
                      Alert.alert('Not removed', `"${it.name}" could not be removed from this phone. Try again.`);
                      return;
                    }
                    // A removal that only happened locally is the worst
                    // outcome: the owner believes the tag is forgotten while
                    // the space still lists it and members still report
                    // sightings of it. Say so rather than swallow it.
                    if (circleId) {
                      forgetSharedItem(circleId, it.id)
                        .then(() => { fetchSharedItems(circleId).then(setShared).catch(() => setSharedFailed(true)); })
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

        {itemsFailed && (
          <LoadFailed text="Couldn't read the things saved on this phone." onRetry={loadLists} />
        )}
        {items.length === 0 && !scanning && !itemsFailed && (
          <Text style={{ color: colors.textDim, fontSize: 13.5, lineHeight: 19, paddingVertical: 10 }}>
            Attach any Bluetooth tag to your keys, wallet or bag — any brand works. Search
            to pair it, and this phone will remember where it last heard it.
          </Text>
        )}

        {/* ── FAMILY'S THINGS: other members' tags this phone helps find ── */}
        {family.length > 0 && (
          <Text accessibilityRole="header" style={[st.h, { color: colors.textDim, marginTop: 18 }]}>FAMILY&apos;S THINGS</Text>
        )}
        {sharedFailed && (
          <LoadFailed text="Couldn't load your space's shared things, so other members' tags are not listed." onRetry={loadLists} />
        )}
        {family.map((f) => {
          const heardNow = scanning && nearby.has(f.bleId);
          const by = !f.lastSeenBy ? '' : f.lastSeenBy === me ? ' · by you' : ' · by family';
          return (
            <View key={f.bleId} style={[st.card, { backgroundColor: G.pane, borderColor: heardNow ? colors.success : G.edge }]}>
              <View style={[st.icon, { backgroundColor: G.paneFaint }]}>
                <Ionicons name={(ICONS as string[]).includes(f.icon) ? (f.icon as IconName) : 'pricetag'} size={20}
                  color={heardNow ? colors.success : colors.textDim} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>{f.name}</Text>
                <Text style={{ color: heardNow ? G.goodText : colors.textDim, fontSize: 12.5 }} numberOfLines={1}>
                  {heardNow
                    ? 'Heard by this phone now'
                    : `Last heard ${seenAgo(f.lastSeenAt)}${f.placeName ? ` · ${f.placeName}` : ''}${by}`}
                </Text>
              </View>
            </View>
          );
        })}

        {/* ── DISCOVERY ── */}
        {scanning && (
          <>
            <Text accessibilityRole="header" style={[st.h, { color: colors.textDim, marginTop: 18 }]}>NEARBY DEVICES</Text>
            {discoverable.length === 0 && (
              <Text style={{ color: colors.textDim, fontSize: 13 }}>Looking… hold the tag near the phone and press its button if it has one.</Text>
            )}
            {discoverable.map((s) => {
              const r = rssiRef.current.get(s.id) ?? s.rssi;
              return (
                <TouchableOpacity
                  key={s.id}
                  onPress={() => { setPairing(s); setPairName(s.name ?? ''); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Pair ${s.name || 'unnamed device'}, ${BAND_LABEL[bandOf(r)]}`}
                  style={[st.card, { backgroundColor: G.pane, borderColor: G.edge }]}
                >
                  <View style={[st.icon, { backgroundColor: brandAlpha(0.1) }]}>
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

        {/* The "Left-behind alerts" switch is gone on purpose: nothing ever
            consumed it. lib/items/leftBehind.ts (pure, self-checked) needs a
            BACKGROUND scan tied to geofence exits, and scanning only runs
            while this screen is open — so the switch promised an alert that
            could never fire. Bring it back with that background wiring. */}

        <Text style={{ color: colors.textDim, fontSize: 11.5, lineHeight: 16, marginTop: 16 }}>
          Works with any Bluetooth tag — no brand lock-in, no subscription. Tags you pair are listed
          in this space with the place they were last heard (a saved place&apos;s name, never
          coordinates). While you search here, this phone also reports the other members&apos; tags it
          hears, so they can help find them: everyone in this space then sees that you heard it, and
          the name of the saved place you were in (such as &ldquo;Home&rdquo;), if any. Their phones do
          the same for your tags. The tag&apos;s maker is never involved.
        </Text>
      </ScrollView>

      {/* ── PAIRING SHEET ── a real modal, so the keyboard lifts it instead of
          covering it at the bottom of a long list. */}
      <Modal visible={!!pairing} transparent animationType="slide" onRequestClose={() => setPairing(null)}>
        <KeyboardSafe keyboardOnly style={sheetSt.modalWrap}>
          <Pressable style={{ flex: 1 }} onPress={() => setPairing(null)}
            accessibilityRole="button" accessibilityLabel="Cancel pairing" />
          <View style={[st.pair, { backgroundColor: G.sheet, borderColor: G.edge }]}>
            <Text accessibilityRole="header" style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>Name this item</Text>
            <TextInput
              value={pairName}
              onChangeText={setPairName}
              placeholder="Keys, wallet, bag…"
              accessibilityLabel="Item name"
              maxLength={80}
              placeholderTextColor={colors.textFaint}
              style={[st.input, { color: colors.text, borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}
            />
            <View style={st.iconRow} accessibilityRole="radiogroup" accessibilityLabel="Item icon">
              {ICONS.map((ic) => (
                <TouchableOpacity
                  key={ic}
                  onPress={() => setPairIcon(ic)}
                  accessibilityRole="radio" accessibilityState={{ checked: pairIcon === ic, selected: pairIcon === ic }} accessibilityLabel={`${ic} icon`}
                  style={[st.iconPick, { borderColor: pairIcon === ic ? colors.primary : G.chipEdge, backgroundColor: pairIcon === ic ? brandAlpha(0.14) : G.paneFaint }]}
                >
                  <Ionicons name={ic} size={18} color={pairIcon === ic ? colors.primary : colors.textDim} />
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: 9 }}>
              <TouchableOpacity onPress={() => setPairing(null)} accessibilityRole="button" style={[st.btn, { borderColor: G.chipEdge, flex: 1 }]}>
                <Text style={{ color: colors.textDim, fontWeight: '700' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={doPair} disabled={saving}
                accessibilityRole="button" accessibilityLabel="Save item" accessibilityState={{ busy: saving, disabled: saving }}
                style={[st.btn, { borderColor: colors.primary, backgroundColor: brandAlpha(0.14), flex: 1 }]}>
                {saving ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Text style={{ color: G.accentText, fontWeight: '800' }}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardSafe>
      </Modal>
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
  pair: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, padding: 16, paddingBottom: 28, gap: 11 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 46, fontSize: 15 },
  iconRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconPick: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 46, borderRadius: 12, borderWidth: 1 },
});
