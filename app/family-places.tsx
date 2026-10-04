// app/family-places.tsx — Family Space Safe Zones (mockup screen 19).
//
// Definitions stay on-device; only the RESULT of a crossing ("arrived at / left
// <place>") becomes an E2EE system message plus a local alert. No coordinate for
// a place is ever published or stored off the phone. One caveat: a typed
// ADDRESS is looked up through the server geocoder (/nav/geocode) to find it.
//
// v2 closes the gaps that made v1 barely usable:
//   * per-place ON/OFF toggle — the mockup's switch list. Absent `enabled`
//     means ON, so places saved before this existed keep firing.
//   * add a place you are NOT standing in (address or "lat, lng") — previously
//     the only way to create "School" was to physically walk there.
//   * edit an existing place (rename / re-radius) instead of delete-and-redo.
//   * any radius, not just the three hardcoded presets.

import { AppText as Text } from '../components/ui/Text';
import React, { useEffect, useState } from 'react';
import { KeyboardSafe } from '../components/ui';
import {
  View, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator,
  ScrollView, Switch,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { geocodeSearch, type GeoHit } from '../lib/nav/geocode';
import { getPlaces, setPlaces, getDefaultRef, setDefaultRef } from '../lib/family/store';
import { reloadPlaces } from '../lib/family/presence';
import { isZoneActive, type Geofence } from '../lib/family/geofence';
// v3 — shared Location Lock engine (ONE engine app-wide; see lib/family/lockBridge)
import { armFamilyPlaceLock, isFamilyLockFor } from '../lib/family/lockBridge';
import { useLockView, unlockLock } from '../lib/lock/lockService';
import { zoneColor, clampRadius } from '../lib/lock/zoneMachine';
import { statsForPlace, type PlaceLockStats } from '../lib/lock/lockStore';
import { navigateTo } from '../lib/nav/openNavigation';
import { getCurrentUserAsync } from './(constants)/authService';
import { permissionDenied } from '../lib/permissionDenied';
import { RADII, COORD_RE, describeZone, iconFor } from '../lib/family/placeOptions';
import PlaceEditSheet, { ZoneChoice, st as formSt, type PlacePatch } from '../components/family/PlaceEditSheet';
import { tint } from '../lib/tintColor';

export default function FamilyPlacesScreen() {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  const { circleId, name: circleName } = useLocalSearchParams<{ circleId?: string; name?: string }>();
  const cid = String(circleId || '');

  const [places, setPlacesState] = useState<Geofence[]>([]);
  const [name, setName] = useState('');
  const [where, setWhere] = useState('');          // blank = "here"
  const [radius, setRadius] = useState(150);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Geofence | null>(null);
  /** An edit-sheet save is in flight — Save ignores repeat taps until it lands. */
  const [saving, setSaving] = useState(false);
  const [lockStats, setLockStats] = useState<Record<string, PlaceLockStats>>({});
  const router = useRouter();
  const lock = useLockView();   // shared engine's live state (chip on locked place)

  useEffect(() => { if (cid) getPlaces(cid).then(setPlacesState).catch(() => {}); }, [cid]);

  // Which place my circle sees me measured against ("1.2 km from Home").
  // Never inferred — the spec is explicit that it must not be guessed from
  // relationship, age or occupation. Absent until the member picks one.
  const [refName, setRefName] = useState<string | null>(null);
  useEffect(() => { if (cid) getDefaultRef(cid).then(setRefName).catch(() => {}); }, [cid]);

  /** Choose (or clear) my reference place, and push it into the live publisher. */
  const chooseRef = async (nameOrNull: string | null) => {
    const prev = refName;
    const next = refName === nameOrNull ? null : nameOrNull;   // tapping the chosen one clears it
    setRefName(next);
    try { await setDefaultRef(cid, next); }
    catch {
      setRefName(prev);
      Alert.alert('Not saved', 'Your choice could not be saved on this phone. Try again.');
      return;
    }
    await reloadPlaces(cid).catch(() => {});   // the broadcaster caches this; refresh it now
  };

  // Per-place lock stats from the SHARED history store (visits · time inside).
  useEffect(() => {
    (async () => {
      const out: Record<string, PlaceLockStats> = {};
      for (const p of places) { try { out[p.name] = await statsForPlace(p.name); } catch {} }
      setLockStats(out);
    })();
  }, [places]);

  /** Saves and re-arms. On a failed save the list reverts and the user is
   *  told — a switch or edit that looks saved but is not is worse than none.
   *  Resolves to whether it saved; never rejects. */
  const persist = async (next: Geofence[]): Promise<boolean> => {
    const prev = places;
    setPlacesState(next);
    try { await setPlaces(cid, next); }
    catch {
      setPlacesState(prev);
      Alert.alert('Not saved', 'Your safe zones could not be saved on this phone. Try again.');
      return false;
    }
    await reloadPlaces(cid).catch(() => {});   // push the new fence set into the live watcher
    return true;
  };

  /** Resolve the "where" box: blank → GPS, "lat,lng" → parsed, else geocoded. */
  const resolveCenter = async (): Promise<{ lat: number; lng: number } | null> => {
    const q = where.trim();
    if (!q) {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        permissionDenied('Location needed', 'Enable location to drop a place where you are, or type an address instead.', perm.canAskAgain);
        return null;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      return { lat: loc.coords.latitude, lng: loc.coords.longitude };
    }
    const m = q.match(COORD_RE);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        Alert.alert('Not a valid position', 'Latitude must be between -90 and 90, longitude between -180 and 180.');
        return null;
      }
      return { lat, lng };
    }
    // Server-proxied geocoder first, platform second — same order as
    // location-lock.tsx / navigate.tsx. Places search used to call
    // Location.geocodeAsync ALONE, which is dead on no-GMS devices, so on those
    // phones the only way to create a place was still to stand inside it.
    const hits = await geocodeSearch(q).catch(() => [] as GeoHit[]);
    if (hits[0]) return { lat: hits[0].lat, lng: hits[0].lng };
    const hit = await Location.geocodeAsync(q).catch(() => [] as Location.LocationGeocodedLocation[]);
    if (!hit[0]) { Alert.alert('Not found', `Could not find "${q}". Try an address, or "lat, lng".`); return null; }
    return { lat: hit[0].latitude, lng: hit[0].longitude };
  };

  const add = async () => {
    if (!name.trim() || busy || !cid) return;
    setBusy(true);
    try {
      const center = await resolveCenter();
      if (!center) return;
      const g: Geofence = {
        id: `p_${Date.now()}`,
        name: name.trim(),
        center,
        radiusM: radius,
        enabled: true,
        icon: iconFor(name),
      };
      if (await persist([g, ...places])) { setName(''); setWhere(''); }
    } catch (e: any) {
      Alert.alert('Could not add place', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  const toggle = (id: string, on: boolean) =>
    persist(places.map((p) => (p.id === id ? { ...p, enabled: on } : p)));

  const remove = (p: Geofence) => {
    Alert.alert('Delete place?', `"${p.name}" will stop producing arrive/leave alerts.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        // Deleting the place I am measured from must clear the choice, or the
        // publisher keeps looking for a name that no longer exists and the
        // reference line silently disappears with no way to see why. Only
        // AFTER the delete saved: a failed delete keeps the place, and with it
        // the choice.
        if (!(await persist(places.filter((x) => x.id !== p.id)))) return;
        setEditing(null);
        if (p.name === refName) {
          setRefName(null);
          await setDefaultRef(cid, null).catch(() => {});
          await reloadPlaces(cid).catch(() => {});
        }
      } },
    ]);
  };

  const openEdit = (p: Geofence) => setEditing(p);

  // ── v3: family-aware actions on the SHARED engine (never a second engine) ──
  const lockedHere = (p: Geofence) => lock.active && isFamilyLockFor(p.id);

  const lockPlace = async (p: Geofence) => {
    const r = clampRadius(p.radiusM);
    const doArm = async () => {
      const me = await getCurrentUserAsync().catch(() => null);
      let res: { ok: boolean; reason?: string };
      try {
        res = await armFamilyPlaceLock({
          circleId: cid, place: p,
          myId: String(me?.id ?? 'me'), myName: me?.name || me?.email || 'Me',
        });
      } catch (e: any) { res = { ok: false, reason: e?.message }; }
      if (!res.ok) { Alert.alert('Could not lock', res.reason ?? 'Try again.'); return; }
      setEditing(null);
    };
    if (r !== p.radiusM) {
      Alert.alert('Radius adjusted', `Location Lock monitors 10 m – 1 km, so "${p.name}" will be locked at ${r} m (place alerts keep the full ${p.radiusM} m).`,
        [{ text: 'Cancel', style: 'cancel' }, { text: `Lock at ${r} m`, onPress: doArm }]);
    } else { await doArm(); }
  };

  const unlockPlace = () => {
    Alert.alert('Unlock?', 'Monitoring stops and the session is saved to history.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlock', style: 'destructive', onPress: async () => {
        try { await unlockLock(); setEditing(null); }
        catch (e: any) { Alert.alert('Still locked', e?.message ?? 'Could not stop the lock. Try again.'); }
      } },
    ]);
  };

  /** The sheet validated the form; persist it. Guarded so a double tap on
   *  Save cannot write twice. */
  const saveEdit = async (patch: PlacePatch) => {
    if (!editing || saving) return;
    const nm = patch.name;
    setSaving(true);
    let ok = false;
    try {
      ok = await persist(places.map((p) => (p.id === editing.id ? {
        ...p, name: nm, radiusM: patch.radiusM, icon: iconFor(nm),
        schedule: patch.schedule, expiresAt: patch.expiresAt,
      } : p)));
    } finally { setSaving(false); }
    if (!ok) return;
    setEditing(null);
    // The reference is stored by NAME, so a rename has to follow it across or
    // the choice silently detaches from the place it was made for. Written
    // only once the rename itself saved, so a failed save changes nothing.
    if (editing.name === refName && nm !== refName) {
      setRefName(nm);
      await setDefaultRef(cid, nm).catch(() => {});
      await reloadPlaces(cid).catch(() => {});
    }
  };

  const activeCount = places.filter((p) => p.enabled !== false).length;

  return (
    <KeyboardSafe style={{ flex: 1, backgroundColor: G.bgMid }}>
      <Stack.Screen options={{
        headerShown: true, title: circleName ? `Safe Zones · ${circleName}` : 'Safe Zones', headerTitleAlign: 'center',
        headerStyle: { backgroundColor: G.bgTop }, headerTintColor: colors.text, headerShadowVisible: false,
      }} />
      <SpaceGround />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        <Text accessibilityRole="header" style={[st.h, { color: colors.textDim }]}>Add a safe zone</Text>

        <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}>
          <Ionicons name={iconFor(name)} size={18} color={colors.textDim} />
          <TextInput value={name} onChangeText={setName} placeholder="Name (Home, School, Work…)"
            accessibilityLabel="Place name" maxLength={60}
            placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} returnKeyType="next" />
        </View>

        <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint, marginTop: 10 }]}>
          <Ionicons name="search" size={18} color={colors.textDim} />
          <TextInput value={where} onChangeText={setWhere} placeholder="Address or lat, lng — blank = where I am now"
            accessibilityLabel="Address or latitude, longitude. Leave blank to use where you are now"
            placeholderTextColor={colors.textFaint} autoCapitalize="none" style={[st.input, { color: colors.text }]}
            returnKeyType="done" onSubmitEditing={add} />
          {!!where && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear the address" hitSlop={{ top: 14, bottom: 14, left: 10, right: 10 }} onPress={() => setWhere('')}><Ionicons name="close-circle" size={17} color={colors.textFaint} /></TouchableOpacity>
          )}
        </View>

        <View style={st.radii} accessibilityRole="radiogroup" accessibilityLabel="Radius">
          {RADII.map((r) => (
            <ZoneChoice key={r} on={radius === r} label={`${r} m`} a11y={`${r} metre radius`} fontSize={13}
              onPress={() => setRadius(r)} />
          ))}
        </View>

        <TouchableOpacity onPress={add} disabled={!name.trim() || busy}
          accessibilityRole="button" accessibilityState={{ disabled: !name.trim() || busy, busy }}
          style={[st.btn, { backgroundColor: name.trim() && !busy ? colors.brandOnLight : colors.border }]}>
          {busy
            ? <ActivityIndicator color={colors.onPrimary} />
            : <><Ionicons name="add-circle" size={18} color={colors.onPrimary} /><Text style={[st.btnTxt, { color: colors.onPrimary }]}>{where.trim() ? 'Add place' : 'Add here'}</Text></>}
        </TouchableOpacity>

        <View style={st.secHead}>
          <Text accessibilityRole="header" style={[st.h, { color: colors.textDim, marginBottom: 0 }]}>Places ({places.length})</Text>
          {places.length > 0 && (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>{activeCount} active</Text>
          )}
        </View>

        {places.length === 0 && (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            No places yet. Add one and your circle gets an alert when you arrive or leave.
          </Text>
        )}

        {/* Reference place (spec §14). What the circle sees is the DISTANCE —
            "3.7 km from Business" — computed on this device. The place's
            coordinate is never published, synced, or stored on the server, so
            choosing one tells your family how far away you are without telling
            them where your home, shop or school actually is. */}
        {places.length > 0 && (
          <View style={{ marginTop: 14 }}>
            <Text style={{ color: colors.text, fontSize: 12.5, fontWeight: '700' }}>Measure me from</Text>
            <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 3, marginBottom: 9 }}>
              Your circle sees the distance only — never where this place is.
            </Text>
            {/* Single choice; tapping the chosen one clears it. */}
            <View style={st.radii} accessibilityRole="radiogroup" accessibilityLabel="Measure me from">
              {places.map((p) => (
                <ZoneChoice key={p.id} on={refName === p.name} label={p.name} a11y={`Measure me from ${p.name}`}
                  fontSize={13} onPress={() => chooseRef(p.name)} />
              ))}
            </View>
            {!refName && (
              <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: 7 }}>
                None chosen — your first place leads.
              </Text>
            )}
          </View>
        )}

        {places.map((p) => {
          const on = p.enabled !== false;
          // "On" is the user's switch; "live" also accounts for schedule and
          // expiry, so a zone that is armed but asleep reads as asleep.
          const live = isZoneActive(p, new Date());
          return (
            <TouchableOpacity key={p.id} activeOpacity={0.7} onPress={() => openEdit(p)}
              accessibilityRole="button" accessibilityLabel={`${p.name}, ${describeZone(p, new Date())}`} accessibilityHint="Edit this place"
              style={[st.row, { borderColor: G.line }]}>
              <View style={[st.rowIcon, { backgroundColor: live ? brandAlpha(0.14) : G.paneFaint }]}>
                <Ionicons name={(p.icon as keyof typeof Ionicons.glyphMap) ?? iconFor(p.name)} size={18}
                  color={live ? colors.primary : colors.textFaint} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ color: on ? colors.text : colors.textDim, fontWeight: '600' }} numberOfLines={1}>{p.name}</Text>
                  {lockedHere(p) && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: tint(zoneColor(lock.state ?? 'safe'), 0.13) }}>
                      <Ionicons name="lock-closed" size={9} color={zoneColor(lock.state ?? 'safe')} />
                      <Text style={{ color: colors.text, fontSize: 11, fontWeight: '800' }}>
                        {(lock.state ?? 'safe') === 'safe' ? 'LOCKED · SAFE' : (lock.state ?? '').toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={{ color: colors.textDim, fontSize: 11.5 }} numberOfLines={1}>
                  {describeZone(p, new Date())}
                  {lockStats[p.name]?.visits ? ` · ${lockStats[p.name].visits} lock${lockStats[p.name].visits > 1 ? 's' : ''}` : ''}
                </Text>
              </View>
              <Switch value={on} onValueChange={(v) => { toggle(p.id, v); }} accessibilityLabel={`${p.name} alerts`} trackColor={{ true: colors.primary }} />
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <PlaceEditSheet
        place={editing}
        locked={!!editing && lockedHere(editing)}
        saving={saving}
        onClose={() => setEditing(null)}
        onSave={saveEdit}
        onDelete={remove}
        onNavigate={(p) => { navigateTo(p.center.lat, p.center.lng, p.name); setEditing(null); }}
        onLock={lockPlace}
        onUnlock={unlockPlace}
        onViewLock={() => { setEditing(null); router.push('/location-lock'); }}
      />
    </KeyboardSafe>
  );
}

const st = {
  ...formSt,
  ...StyleSheet.create({
    secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 10 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
    rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  }),
};
