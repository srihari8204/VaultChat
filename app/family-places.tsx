// app/family-places.tsx — manage a circle's Places (geofences). Definitions live
// on-device only; crossing them fires an E2EE "arrived/left" system message. You
// drop a place at your current location, name it, and pick a radius.

import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView } from 'react-native';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { getPlaces, setPlaces } from '../lib/family/store';
import { reloadPlaces } from '../lib/family/presence';
import { type Geofence } from '../lib/family/geofence';

const RADII = [100, 200, 500];

export default function FamilyPlacesScreen() {
  const { colors } = useTheme();
  const { circleId, name: circleName } = useLocalSearchParams<{ circleId?: string; name?: string }>();
  const cid = String(circleId || '');
  const [places, setPlacesState] = useState<Geofence[]>([]);
  const [name, setName] = useState('');
  const [radius, setRadius] = useState(150);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (cid) getPlaces(cid).then(setPlacesState).catch(() => {}); }, [cid]);

  const persist = async (next: Geofence[]) => { setPlacesState(next); await setPlaces(cid, next); await reloadPlaces(cid); };

  const addHere = async () => {
    if (!name.trim() || busy || !cid) return;
    setBusy(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') { Alert.alert('Location needed', 'Enable location to drop a place at where you are.'); return; }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const g: Geofence = { id: `p_${Date.now()}`, name: name.trim(), center: { lat: loc.coords.latitude, lng: loc.coords.longitude }, radiusM: radius };
      await persist([g, ...places]);
      setName('');
    } catch (e: any) { Alert.alert('Could not add place', e?.message ?? 'Try again.'); }
    finally { setBusy(false); }
  };

  const remove = (id: string) => persist(places.filter((p) => p.id !== id));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: circleName ? `Places · ${circleName}` : 'Places', headerTitleAlign: 'center' }} />
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <Text style={[st.h, { color: colors.text }]}>Add a place at my location</Text>
        <View style={[st.field, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Ionicons name="location" size={18} color={colors.textDim} />
          <TextInput value={name} onChangeText={setName} placeholder="Place name (Home, School…)" placeholderTextColor={colors.textFaint}
            style={[st.input, { color: colors.text }]} returnKeyType="done" onSubmitEditing={addHere} />
        </View>
        <View style={st.radii}>
          {RADII.map((r) => (
            <TouchableOpacity key={r} onPress={() => setRadius(r)}
              style={[st.rchip, { borderColor: radius === r ? colors.primary : colors.border, backgroundColor: radius === r ? colors.primary + '1a' : 'transparent' }]}>
              <Text style={{ color: radius === r ? colors.primary : colors.text, fontWeight: radius === r ? '700' : '500', fontSize: 13 }}>{r} m</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity onPress={addHere} disabled={!name.trim() || busy} style={[st.btn, { backgroundColor: name.trim() ? colors.primary : colors.border }]}>
          {busy ? <ActivityIndicator color="#fff" /> : <><Ionicons name="add-circle" size={18} color="#fff" /><Text style={st.btnTxt}>Add here</Text></>}
        </TouchableOpacity>

        <Text style={[st.h, { color: colors.text, marginTop: 26 }]}>Places ({places.length})</Text>
        {places.length === 0 && <Text style={{ color: colors.textDim, fontSize: 13.5 }}>No places yet. Add one and your circle gets an alert when you arrive or leave.</Text>}
        {places.map((p) => (
          <View key={p.id} style={[st.row, { borderColor: colors.border }]}>
            <Ionicons name="pin" size={20} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>{p.name}</Text>
              <Text style={{ color: colors.textDim, fontSize: 12 }}>{p.radiusM} m · {p.center.lat.toFixed(4)}, {p.center.lng.toFixed(4)}</Text>
            </View>
            <TouchableOpacity onPress={() => remove(p.id)} style={{ padding: 6 }}><Ionicons name="trash" size={18} color={colors.danger} /></TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  h: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 10 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, height: 50 },
  input: { flex: 1, fontSize: 15 },
  radii: { flexDirection: 'row', gap: 8, marginTop: 12 },
  rchip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 13, marginTop: 14 },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
});
