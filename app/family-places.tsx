// app/family-places.tsx — Family Space Safe Zones (mockup screen 19).
//
// Definitions stay on-device; only the RESULT of a crossing ("arrived at / left
// <place>") becomes an E2EE system message plus a local alert. No coordinate for
// a place ever leaves the phone.
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
  ScrollView, Switch, Modal, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import SpaceGround, { useSpaceGlass } from '../components/spaces/SpaceGround';
import { getPlaces, setPlaces, getDefaultRef, setDefaultRef } from '../lib/family/store';
import { reloadPlaces } from '../lib/family/presence';
import { isZoneActive, type Geofence, type ZoneSchedule } from '../lib/family/geofence';
// v3 — shared Location Lock engine (ONE engine app-wide; see lib/family/lockBridge)
import { armFamilyPlaceLock, isFamilyLockFor } from '../lib/family/lockBridge';
import { useLockView, unlockLock } from '../lib/lock/lockService';
import { zoneColor, clampRadius } from '../lib/lock/zoneMachine';
import { statsForPlace, type PlaceLockStats } from '../lib/lock/lockStore';
import { navigateTo } from '../lib/nav/openNavigation';
import { getCurrentUserAsync } from './(constants)/authService';
import { permissionDenied } from '../lib/permissionDenied';

const RADII = [100, 200, 500, 1000];
const MIN_RADIUS = 50;
const MAX_RADIUS = 5000;
const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
/** Windows people actually configure, so most users never touch the hours. */
const PRESETS: { label: string; sched: ZoneSchedule | null }[] = [
  { label: 'Always',       sched: null },
  { label: 'School hours', sched: { days: [1, 2, 3, 4, 5], fromMin: 9 * 60,  toMin: 15 * 60 } },
  { label: 'Work hours',   sched: { days: [1, 2, 3, 4, 5], fromMin: 9 * 60,  toMin: 17 * 60 } },
  { label: 'Overnight',    sched: { days: [],              fromMin: 22 * 60, toMin: 6 * 60 } },
];
/** Temporary zones: how long before the zone stops mattering. */
const LIFETIMES: { label: string; ms: number | null }[] = [
  { label: 'Permanent', ms: null },
  { label: '8 hours',   ms: 8 * 3600_000 },
  { label: '24 hours',  ms: 24 * 3600_000 },
  { label: '7 days',    ms: 7 * 24 * 3600_000 },
];

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** One-line summary of when a zone is live, for the list row. */
function describeZone(f: Geofence, now: Date): string {
  if (f.enabled === false) return 'Alerts off';
  if (f.expiresAt != null && now.getTime() >= f.expiresAt) return 'Expired';
  const bits: string[] = [`${f.radiusM} m`];
  if (f.schedule) {
    const d = f.schedule.days?.length ? f.schedule.days.map((n) => DAYS[n]).join('') : 'daily';
    bits.push(`${hhmm(f.schedule.fromMin)}–${hhmm(f.schedule.toMin)} ${d}`);
  }
  if (f.expiresAt != null) bits.push('temporary');
  // Say plainly when a zone exists but is dormant right now.
  if (!isZoneActive(f, now)) bits.push('asleep');
  return bits.join(' · ');
}

/** Guess a sensible icon so the list reads like the mockup's. */
function iconFor(name: string): keyof typeof Ionicons.glyphMap {
  const n = name.toLowerCase();
  if (/home|house/.test(n)) return 'home';
  if (/school|college|class/.test(n)) return 'school';
  if (/work|office|job/.test(n)) return 'briefcase';
  if (/gym|fit/.test(n)) return 'barbell';
  if (/park|play/.test(n)) return 'leaf';
  if (/hospital|clinic|doctor/.test(n)) return 'medkit';
  return 'location';
}

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
  const [editName, setEditName] = useState('');
  const [editRadius, setEditRadius] = useState('');
  const [lockStats, setLockStats] = useState<Record<string, PlaceLockStats>>({});
  const router = useRouter();
  const lock = useLockView();   // shared engine's live state (chip on locked place)
  const [editSched, setEditSched] = useState<ZoneSchedule | null>(null);
  const [editExpiry, setEditExpiry] = useState<number | null>(null);

  useEffect(() => { if (cid) getPlaces(cid).then(setPlacesState).catch(() => {}); }, [cid]);

  // Which place my circle sees me measured against ("1.2 km from Home").
  // Never inferred — the spec is explicit that it must not be guessed from
  // relationship, age or occupation. Absent until the member picks one.
  const [refName, setRefName] = useState<string | null>(null);
  useEffect(() => { if (cid) getDefaultRef(cid).then(setRefName).catch(() => {}); }, [cid]);

  /** Choose (or clear) my reference place, and push it into the live publisher. */
  const chooseRef = async (nameOrNull: string | null) => {
    const next = refName === nameOrNull ? null : nameOrNull;   // tapping the chosen one clears it
    setRefName(next);
    await setDefaultRef(cid, next);
    await reloadPlaces(cid);   // the broadcaster caches this; refresh it now
  };

  // Per-place lock stats from the SHARED history store (visits · time inside).
  useEffect(() => {
    (async () => {
      const out: Record<string, PlaceLockStats> = {};
      for (const p of places) { try { out[p.name] = await statsForPlace(p.name); } catch {} }
      setLockStats(out);
    })();
  }, [places]);

  const persist = async (next: Geofence[]) => {
    setPlacesState(next);
    await setPlaces(cid, next);
    await reloadPlaces(cid);   // push the new fence set into the live watcher
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
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    const hit = await Location.geocodeAsync(q);
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
      await persist([g, ...places]);
      setName(''); setWhere('');
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
        // reference line silently disappears with no way to see why.
        if (p.name === refName) { setRefName(null); await setDefaultRef(cid, null); }
        await persist(places.filter((x) => x.id !== p.id));
        setEditing(null);
      } },
    ]);
  };

  const openEdit = (p: Geofence) => {
    setEditing(p);
    setEditName(p.name);
    setEditRadius(String(p.radiusM));
    setEditSched(p.schedule ?? null);
    setEditExpiry(p.expiresAt ?? null);
  };

  // ── v3: family-aware actions on the SHARED engine (never a second engine) ──
  const lockedHere = (p: Geofence) => lock.active && isFamilyLockFor(p.id);

  const lockPlace = async (p: Geofence) => {
    const r = clampRadius(p.radiusM);
    const doArm = async () => {
      const me = await getCurrentUserAsync().catch(() => null);
      const res = await armFamilyPlaceLock({
        circleId: cid, place: p,
        myId: String(me?.id ?? 'me'), myName: me?.name || me?.email || 'Me',
      });
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
      { text: 'Unlock', style: 'destructive', onPress: () => { unlockLock().catch(() => {}); setEditing(null); } },
    ]);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const nm = editName.trim();
    const r = Math.round(Number(editRadius));
    if (!nm) { Alert.alert('Name required', 'Give the place a name.'); return; }
    if (!Number.isFinite(r) || r < MIN_RADIUS || r > MAX_RADIUS) {
      Alert.alert('Radius', `Pick a radius between ${MIN_RADIUS} and ${MAX_RADIUS} metres.`);
      return;
    }
    // The reference is stored by NAME, so a rename has to follow it across or
    // the choice silently detaches from the place it was made for.
    if (editing.name === refName && nm !== refName) {
      setRefName(nm);
      await setDefaultRef(cid, nm);
    }
    await persist(places.map((p) => (p.id === editing.id ? {
      ...p, name: nm, radiusM: r, icon: iconFor(nm),
      // Undefined rather than null, so an "always on / permanent" zone carries
      // no schedule keys at all and reads identically to one saved before
      // schedules existed.
      schedule: editSched ?? undefined,
      expiresAt: editExpiry ?? undefined,
    } : p)));
    setEditing(null);
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

        <Text style={[st.h, { color: colors.textDim }]}>Add a safe zone</Text>

        <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}>
          <Ionicons name={iconFor(name)} size={18} color={colors.textDim} />
          <TextInput value={name} onChangeText={setName} placeholder="Name (Home, School, Work…)"
            placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} returnKeyType="next" />
        </View>

        <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint, marginTop: 10 }]}>
          <Ionicons name="search" size={18} color={colors.textDim} />
          <TextInput value={where} onChangeText={setWhere} placeholder="Address or lat, lng — blank = where I am now"
            placeholderTextColor={colors.textFaint} autoCapitalize="none" style={[st.input, { color: colors.text }]}
            returnKeyType="done" onSubmitEditing={add} />
          {!!where && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear" onPress={() => setWhere('')}><Ionicons name="close-circle" size={17} color={colors.textFaint} /></TouchableOpacity>
          )}
        </View>

        <View style={st.radii}>
          {RADII.map((r) => (
            <TouchableOpacity key={r} onPress={() => setRadius(r)}
              style={[st.rchip, { borderColor: radius === r ? colors.primary : G.chipEdge, backgroundColor: radius === r ? brandAlpha(0.14) : G.paneFaint }]}>
              <Text style={{ color: radius === r ? G.accentText : colors.text, fontWeight: radius === r ? '700' : '500', fontSize: 13 }}>{r} m</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity onPress={add} disabled={!name.trim() || busy}
          style={[st.btn, { backgroundColor: name.trim() && !busy ? colors.brandOnLight : colors.border }]}>
          {busy
            ? <ActivityIndicator color="#fff" />
            : <><Ionicons name="add-circle" size={18} color="#fff" /><Text style={st.btnTxt}>{where.trim() ? 'Add place' : 'Add here'}</Text></>}
        </TouchableOpacity>

        <View style={st.secHead}>
          <Text style={[st.h, { color: colors.textDim, marginBottom: 0 }]}>Places ({places.length})</Text>
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
            <View style={st.radii}>
              {places.map((p) => {
                const on = refName === p.name;
                return (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => chooseRef(p.name)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`Measure me from ${p.name}${on ? ', selected' : ''}`}
                    style={[st.rchip, { borderColor: on ? colors.primary : G.chipEdge, backgroundColor: on ? brandAlpha(0.14) : G.paneFaint }]}
                  >
                    <Text numberOfLines={1} style={{ color: on ? G.accentText : colors.text, fontWeight: on ? '700' : '500', fontSize: 13 }}>
                      {p.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
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
              style={[st.row, { borderColor: G.line }]}>
              <View style={[st.rowIcon, { backgroundColor: live ? brandAlpha(0.14) : G.paneFaint }]}>
                <Ionicons name={(p.icon as keyof typeof Ionicons.glyphMap) ?? iconFor(p.name)} size={18}
                  color={live ? colors.primary : colors.textFaint} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ color: on ? colors.text : colors.textDim, fontWeight: '600' }} numberOfLines={1}>{p.name}</Text>
                  {lockedHere(p) && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: zoneColor(lock.state ?? 'safe') + '22' }}>
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
              <Switch value={on} onValueChange={(v) => toggle(p.id, v)} trackColor={{ true: colors.primary }} />
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* edit sheet */}
      <Modal visible={!!editing} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        {/* KeyboardSafe, not the screen-level one above (2026-09-18): a React
            Native <Modal> is its own Android window, so the wrapper around the
            screen does not reach in here and the sheet — which is pinned to the
            bottom — sat underneath the keyboard. The inner ScrollView could not
            rescue it, because the sheet itself was covered, not just its
            content. keyboardOnly: the sheet already pads its own bottom. */}
        <KeyboardSafe keyboardOnly style={st.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setEditing(null)} />
          {/* Height-capped with an inner scroll: radius + schedule + lifetime
              + four buttons overflow a short phone, and the keyboard renders
              over a native Modal with no KeyboardAvoidingView — scrolling is
              what keeps Save reachable while typing. */}
          <View style={[st.sheet, { backgroundColor: G.sheet, borderColor: G.edge, maxHeight: '88%' }]}>
            <View style={[st.grab, { backgroundColor: colors.border }]} />
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 18, marginBottom: 14, textAlign: 'center' }}>Edit place</Text>
            <ScrollView bounces={false} keyboardShouldPersistTaps="handled">

            <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint }]}>
              <Ionicons name={iconFor(editName)} size={18} color={colors.textDim} />
              <TextInput value={editName} onChangeText={setEditName} placeholder="Name"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} />
            </View>

            <View style={[st.field, { borderColor: G.chipEdge, backgroundColor: G.paneFaint, marginTop: 10 }]}>
              <Ionicons name="resize" size={18} color={colors.textDim} />
              <TextInput value={editRadius} onChangeText={setEditRadius} keyboardType="number-pad"
                placeholder={`Radius in metres (${MIN_RADIUS}–${MAX_RADIUS})`} placeholderTextColor={colors.textFaint}
                style={[st.input, { color: colors.text }]} />
            </View>

            <View style={st.radii}>
              {RADII.map((r) => (
                <TouchableOpacity key={r} onPress={() => setEditRadius(String(r))}
                  style={[st.rchip, { borderColor: Number(editRadius) === r ? colors.primary : G.chipEdge, backgroundColor: Number(editRadius) === r ? brandAlpha(0.14) : G.paneFaint }]}>
                  <Text style={{ color: Number(editRadius) === r ? G.accentText : colors.text, fontSize: 13 }}>{r} m</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[st.h, { color: colors.textDim, marginTop: 20, marginBottom: 8 }]}>When it&apos;s active</Text>
            <View style={st.radii}>
              {PRESETS.map((pr) => {
                // "Always" is the one with no schedule; the rest match on window.
                const on = pr.sched == null
                  ? editSched == null
                  : !!editSched && editSched.fromMin === pr.sched.fromMin && editSched.toMin === pr.sched.toMin;
                return (
                  <TouchableOpacity key={pr.label} onPress={() => setEditSched(pr.sched ? { ...pr.sched } : null)}
                    style={[st.rchip, { borderColor: on ? colors.primary : G.chipEdge, backgroundColor: on ? brandAlpha(0.14) : G.paneFaint }]}>
                    <Text style={{ color: on ? G.accentText : colors.text, fontSize: 12.5, fontWeight: on ? '700' : '500' }}>{pr.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {!!editSched && (
              <>
                <View style={[st.days, { marginTop: 12 }]}>
                  {DAYS.map((d, i) => {
                    // An empty day list means EVERY day, so render that as all-on
                    // rather than as none-selected, which would read as broken.
                    const all = !editSched.days || editSched.days.length === 0;
                    const on = all || editSched.days!.includes(i);
                    return (
                      <TouchableOpacity key={i} onPress={() => {
                        const cur = all ? [0, 1, 2, 3, 4, 5, 6] : [...editSched.days!];
                        const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort();
                        // Deselecting the last day would silently disable the zone;
                        // treat "none" as "every day" instead.
                        setEditSched({ ...editSched, days: next.length ? next : [] });
                      }}
                        style={[st.day, { borderColor: on ? colors.primary : G.chipEdge, backgroundColor: on ? brandAlpha(0.14) : G.paneFaint }]}>
                        <Text style={{ color: on ? G.accentText : colors.textDim, fontSize: 12, fontWeight: '700' }}>{d}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 10 }}>
                  {hhmm(editSched.fromMin)} to {hhmm(editSched.toMin)}
                  {editSched.fromMin > editSched.toMin ? ' (overnight)' : ''}
                </Text>
              </>
            )}

            <Text style={[st.h, { color: colors.textDim, marginTop: 20, marginBottom: 8 }]}>How long it lasts</Text>
            <View style={st.radii}>
              {LIFETIMES.map((lt) => {
                const on = lt.ms == null ? editExpiry == null : false;
                return (
                  <TouchableOpacity key={lt.label}
                    onPress={() => setEditExpiry(lt.ms == null ? null : Date.now() + lt.ms)}
                    style={[st.rchip, { borderColor: on ? colors.primary : G.chipEdge, backgroundColor: on ? brandAlpha(0.14) : G.paneFaint }]}>
                    <Text style={{ color: on ? G.accentText : colors.text, fontSize: 12.5, fontWeight: on ? '700' : '500' }}>{lt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {editExpiry != null && (
              <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 8 }}>
                Stops on {new Date(editExpiry).toLocaleString()}
              </Text>
            )}

            {/* v3 — actions on the shared engines (Navigate module + Lock engine) */}
            {editing && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                <TouchableOpacity
                  onPress={() => { navigateTo(editing.center.lat, editing.center.lng, editing.name); setEditing(null); }}
                  style={[st.btn, { flex: 1, marginTop: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: G.chipEdge }]}>
                  <Ionicons name="navigate" size={17} color={colors.primary} />
                  <Text style={[st.btnTxt, { color: colors.text }]}>Navigate</Text>
                </TouchableOpacity>
                {lockedHere(editing) ? (
                  <TouchableOpacity onPress={unlockPlace}
                    style={[st.btn, { flex: 1, marginTop: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger }]}>
                    <Ionicons name="lock-open" size={17} color={G.dangerText} />
                    <Text style={[st.btnTxt, { color: G.dangerText }]}>Unlock</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={() => lockPlace(editing)}
                    style={[st.btn, { flex: 1, marginTop: 0, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary }]}>
                    <Ionicons name="lock-closed" size={17} color={colors.primary} />
                    <Text style={[st.btnTxt, { color: G.accentText }]}>Lock here</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            {editing && lockedHere(editing) && (
              <TouchableOpacity onPress={() => { setEditing(null); router.push('/location-lock' as any); }} style={{ alignSelf: 'center', marginTop: 10 }}>
                <Text style={{ color: G.accentText, fontWeight: '600', fontSize: 13 }}>View live lock status</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={saveEdit} style={[st.btn, { backgroundColor: colors.brandOnLight }]}>
              <Ionicons name="checkmark" size={18} color="#fff" /><Text style={st.btnTxt}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => editing && remove(editing)} style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger, marginTop: 8 }]}>
              <Ionicons name="trash" size={18} color={G.dangerText} />
              <Text style={[st.btnTxt, { color: G.dangerText }]}>Delete place</Text>
            </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardSafe>
      </Modal>
    </KeyboardSafe>
  );
}

const st = StyleSheet.create({
  h: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, minHeight: 50 },
  input: { flex: 1, fontSize: 15 },
  radii: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  days: { flexDirection: 'row', gap: 6 },
  // 2026-09-18: the day letter scales with the OS font, the pinned 36 did not.
  // minHeight keeps the row of seven identical at scale 1.0.
  day: { flex: 1, minHeight: 36, paddingVertical: 6, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rchip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 50, borderRadius: 16, marginTop: 14 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 10 },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderTopWidth: 1, padding: 18, paddingBottom: 34 },
});
