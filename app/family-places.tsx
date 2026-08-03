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

import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator,
  ScrollView, Switch, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { brandAlpha } from '../constants/theme';
import { getPlaces, setPlaces } from '../lib/family/store';
import { reloadPlaces } from '../lib/family/presence';
import { type Geofence } from '../lib/family/geofence';

const RADII = [100, 200, 500, 1000];
const MIN_RADIUS = 50;
const MAX_RADIUS = 5000;
const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

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

  useEffect(() => { if (cid) getPlaces(cid).then(setPlacesState).catch(() => {}); }, [cid]);

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
        Alert.alert('Location needed', 'Enable location to drop a place where you are, or type an address instead.');
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
      { text: 'Delete', style: 'destructive', onPress: () => { persist(places.filter((x) => x.id !== p.id)); setEditing(null); } },
    ]);
  };

  const openEdit = (p: Geofence) => {
    setEditing(p);
    setEditName(p.name);
    setEditRadius(String(p.radiusM));
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
    await persist(places.map((p) => (p.id === editing.id ? { ...p, name: nm, radiusM: r, icon: iconFor(nm) } : p)));
    setEditing(null);
  };

  const activeCount = places.filter((p) => p.enabled !== false).length;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: circleName ? `Safe Zones · ${circleName}` : 'Safe Zones', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        <Text style={[st.h, { color: colors.text }]}>Add a safe zone</Text>

        <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Ionicons name={iconFor(name)} size={18} color={colors.textDim} />
          <TextInput value={name} onChangeText={setName} placeholder="Name (Home, School, Work…)"
            placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} returnKeyType="next" />
        </View>

        <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface, marginTop: 10 }]}>
          <Ionicons name="search" size={18} color={colors.textDim} />
          <TextInput value={where} onChangeText={setWhere} placeholder="Address or lat, lng — blank = where I am now"
            placeholderTextColor={colors.textFaint} autoCapitalize="none" style={[st.input, { color: colors.text }]}
            returnKeyType="done" onSubmitEditing={add} />
          {!!where && (
            <TouchableOpacity onPress={() => setWhere('')}><Ionicons name="close-circle" size={17} color={colors.textFaint} /></TouchableOpacity>
          )}
        </View>

        <View style={st.radii}>
          {RADII.map((r) => (
            <TouchableOpacity key={r} onPress={() => setRadius(r)}
              style={[st.rchip, { borderColor: radius === r ? colors.primary : colors.border, backgroundColor: radius === r ? brandAlpha(0.1) : 'transparent' }]}>
              <Text style={{ color: radius === r ? colors.primary : colors.text, fontWeight: radius === r ? '700' : '500', fontSize: 13 }}>{r} m</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity onPress={add} disabled={!name.trim() || busy}
          style={[st.btn, { backgroundColor: name.trim() && !busy ? colors.primary : colors.border }]}>
          {busy
            ? <ActivityIndicator color="#fff" />
            : <><Ionicons name="add-circle" size={18} color="#fff" /><Text style={st.btnTxt}>{where.trim() ? 'Add place' : 'Add here'}</Text></>}
        </TouchableOpacity>

        <View style={st.secHead}>
          <Text style={[st.h, { color: colors.text, marginBottom: 0 }]}>Places ({places.length})</Text>
          {places.length > 0 && (
            <Text style={{ color: colors.textDim, fontSize: 12 }}>{activeCount} active</Text>
          )}
        </View>

        {places.length === 0 && (
          <Text style={{ color: colors.textDim, fontSize: 13.5 }}>
            No places yet. Add one and your circle gets an alert when you arrive or leave.
          </Text>
        )}

        {places.map((p) => {
          const on = p.enabled !== false;
          return (
            <TouchableOpacity key={p.id} activeOpacity={0.7} onPress={() => openEdit(p)}
              style={[st.row, { borderColor: colors.border }]}>
              <View style={[st.rowIcon, { backgroundColor: on ? brandAlpha(0.12) : colors.surface }]}>
                <Ionicons name={(p.icon as keyof typeof Ionicons.glyphMap) ?? iconFor(p.name)} size={18}
                  color={on ? colors.primary : colors.textFaint} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: on ? colors.text : colors.textDim, fontWeight: '600' }} numberOfLines={1}>{p.name}</Text>
                <Text style={{ color: colors.textDim, fontSize: 11.5 }} numberOfLines={1}>
                  {p.radiusM} m · {p.center.lat.toFixed(4)}, {p.center.lng.toFixed(4)}
                </Text>
              </View>
              <Switch value={on} onValueChange={(v) => toggle(p.id, v)} trackColor={{ true: colors.primary }} />
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* edit sheet */}
      <Modal visible={!!editing} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        <View style={st.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setEditing(null)} />
          <View style={[st.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16, marginBottom: 14 }}>Edit place</Text>

            <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Ionicons name={iconFor(editName)} size={18} color={colors.textDim} />
              <TextInput value={editName} onChangeText={setEditName} placeholder="Name"
                placeholderTextColor={colors.textFaint} style={[st.input, { color: colors.text }]} />
            </View>

            <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface, marginTop: 10 }]}>
              <Ionicons name="resize" size={18} color={colors.textDim} />
              <TextInput value={editRadius} onChangeText={setEditRadius} keyboardType="number-pad"
                placeholder={`Radius in metres (${MIN_RADIUS}–${MAX_RADIUS})`} placeholderTextColor={colors.textFaint}
                style={[st.input, { color: colors.text }]} />
            </View>

            <View style={st.radii}>
              {RADII.map((r) => (
                <TouchableOpacity key={r} onPress={() => setEditRadius(String(r))}
                  style={[st.rchip, { borderColor: Number(editRadius) === r ? colors.primary : colors.border, backgroundColor: Number(editRadius) === r ? brandAlpha(0.1) : 'transparent' }]}>
                  <Text style={{ color: Number(editRadius) === r ? colors.primary : colors.text, fontSize: 13 }}>{r} m</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity onPress={saveEdit} style={[st.btn, { backgroundColor: colors.primary }]}>
              <Ionicons name="checkmark" size={18} color="#fff" /><Text style={st.btnTxt}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => editing && remove(editing)} style={[st.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger, marginTop: 8 }]}>
              <Ionicons name="trash" size={18} color={colors.danger} />
              <Text style={[st.btnTxt, { color: colors.danger }]}>Delete place</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 50 },
  input: { flex: 1, fontSize: 15 },
  radii: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  rchip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 13, marginTop: 14 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, padding: 18, paddingBottom: 34 },
});
