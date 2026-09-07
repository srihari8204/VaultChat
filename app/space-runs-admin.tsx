// app/space-runs-admin.tsx — build and staff a run (Spaces & Operations).
//
// The missing half of the run engine: every endpoint behind this screen has
// existed since S2, and until now nothing in the app could call them, so a
// transport office could watch runs it had no way to create.
//
// ── two things this screen refuses to do ──
//
// It will not assign a driver who is not in the space, and it will not put a
// rider on a run who is not on the space's roster. Both are refused by the
// server anyway; refusing them HERE means an administrator finds out while they
// are still looking at the form, rather than through a 400 after they thought
// they were finished.
//
// Stops and riders are each saved as a WHOLE LIST (PUT, not PATCH). A stop
// sequence is ordered, and incremental edits to an ordered list are where
// off-by-one reordering bugs live — so the client sends what it wants to be
// true and the server makes it so.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, TextInput, Modal,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { Palette } from '../constants/theme';
import {
  getRuns, getRun, createRun, setRunStops, setRunRiders, setRunDriver, setRunStatus,
  getRoster, type RosterEntry,
} from '../lib/spaces/api';
import type { Run, RunStop, RunRider } from '../lib/spaces/runs';
import { circleMembers } from '../lib/family/circle';
import type { CircleMember } from '../lib/family/types';
import { AuroraBackground } from '../components/ui';

const KINDS: { key: string; label: string }[] = [
  { key: 'school_pickup', label: 'Morning pickup' },
  { key: 'school_drop', label: 'Afternoon drop' },
  { key: 'cab_pickup', label: 'Cab pickup' },
  { key: 'cab_drop', label: 'Cab drop' },
  { key: 'generic', label: 'Other' },
];

export default function SpaceRunsAdminScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [runs, setRuns] = useState<Run[]>([]);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('school_pickup');
  const [newVehicle, setNewVehicle] = useState('');
  const [busy, setBusy] = useState(false);

  // The run being edited, with its stops and manifest.
  const [editing, setEditing] = useState<{ run: Run; stops: RunStop[]; riders: RunRider[] } | null>(null);
  const [stopDraft, setStopDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const [rs, mem, ros] = await Promise.all([
        getRuns(spaceId).catch(() => [] as Run[]),
        circleMembers(spaceId).catch(() => [] as CircleMember[]),
        getRoster(spaceId).catch(() => ({ roster: [] as RosterEntry[], truncated: false, scoped: false })),
      ]);
      setRuns(rs);
      setMembers(mem);
      setRoster(ros.roster);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openRun = useCallback(async (r: Run) => {
    try {
      setEditing(await getRun(spaceId, r.id));
    } catch (e: any) {
      Alert.alert('Could not open the run', e?.message ?? 'Try again.');
    }
  }, [spaceId]);

  const onCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { id } = await createRun(spaceId, {
        name, kind: newKind, vehicleLabel: newVehicle.trim() || undefined,
      });
      setCreating(false); setNewName(''); setNewVehicle('');
      await load();
      const full = await getRun(spaceId, id);
      setEditing(full);
    } catch (e: any) {
      Alert.alert('Could not create the run', e?.message ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [newName, newKind, newVehicle, spaceId, load]);

  const addStop = useCallback(async () => {
    if (!editing || !stopDraft.trim()) return;
    const next = [...editing.stops, {
      id: `tmp_${Date.now()}`, seq: editing.stops.length, label: stopDraft.trim(),
      lat: null, lng: null, plannedAt: null, arrivedAt: null,
    }];
    setStopDraft('');
    setBusy(true);
    try {
      // The whole list, every time. See the header note on ordered lists.
      await setRunStops(spaceId, editing.run.id, next.map((st) => ({ label: st.label })));
      setEditing(await getRun(spaceId, editing.run.id));
    } catch (e: any) {
      Alert.alert('Could not save the stops', e?.message ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [editing, stopDraft, spaceId]);

  const removeStop = useCallback(async (stopId: string) => {
    if (!editing) return;
    setBusy(true);
    try {
      const kept = editing.stops.filter((st) => st.id !== stopId);
      await setRunStops(spaceId, editing.run.id, kept.map((st) => ({ label: st.label })));
      setEditing(await getRun(spaceId, editing.run.id));
    } catch (e: any) {
      Alert.alert('Could not save the stops', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  }, [editing, spaceId]);

  const toggleRider = useCallback(async (entry: RosterEntry) => {
    if (!editing) return;
    const on = editing.riders.some((r) => r.riderId === entry.id);
    const next = on
      ? editing.riders.filter((r) => r.riderId !== entry.id)
      : [...editing.riders, { riderId: entry.id } as any];
    setBusy(true);
    try {
      await setRunRiders(spaceId, editing.run.id,
        next.map((r: any) => ({ riderId: r.riderId, stopId: r.stopId ?? null })));
      setEditing(await getRun(spaceId, editing.run.id));
    } catch (e: any) {
      Alert.alert('Could not save the manifest', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  }, [editing, spaceId]);

  const assignDriver = useCallback(async (userId: string | null) => {
    if (!editing) return;
    setBusy(true);
    try {
      await setRunDriver(spaceId, editing.run.id, userId);
      setEditing(await getRun(spaceId, editing.run.id));
      await load();
    } catch (e: any) {
      // The server refuses a driver who already has a run in progress; say so
      // rather than leaving the picker looking broken.
      Alert.alert('Could not assign', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  }, [editing, spaceId, load]);

  const cancelRun = useCallback((r: Run) => {
    Alert.alert(
      `Cancel ${r.vehicleLabel || r.name}?`,
      'The run stops immediately. Its record and everything already marked on it stay.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel run',
          style: 'destructive',
          onPress: async () => {
            try { await setRunStatus(spaceId, r.id, 'cancelled'); setEditing(null); await load(); }
            catch (e: any) { Alert.alert('Could not cancel', e?.message ?? 'Try again.'); }
          },
        },
      ],
    );
  }, [spaceId, load]);

  const s = styles(colors);
  const driverName = useMemo(
    () => (id: string | null) => id ? (members.find((m) => m.id === id)?.name ?? 'Assigned') : 'No driver',
    [members],
  );

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Runs')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          ...spaceHeader(colors, params.name ? `${params.name} · Runs` : 'Runs'),
          headerRight: () => (
            <TouchableOpacity onPress={() => setCreating(true)} style={{ paddingHorizontal: 8 }}>
              <Ionicons name="add" size={24} color={colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView contentContainerStyle={s.body}>
        {runs.length === 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>No runs yet</Text>
            <Text style={s.muted}>
              A run is one journey: a driver, an ordered list of stops, and the people
              expected at them. The same shape serves a school bus and an office cab.
            </Text>
          </View>
        )}

        {/* The list stays deliberately cheap — status and driver only. Rider
            counts would mean a fetch per run to render a screen whose job is to
            get you into one. */}
        {runs.map((r) => (
          <TouchableOpacity key={r.id} style={s.card} onPress={() => openRun(r)}>
            <View style={s.row}>
              <View style={[s.dot, { backgroundColor: statusColour(r, colors) }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.cardTitle} numberOfLines={1}>{r.vehicleLabel || r.name}</Text>
                <Text style={s.muted} numberOfLines={1}>
                  {statusLabel(r)} · {driverName(r.driverId)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* ── create ── */}
      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>New run</Text>
            <TextInput
              style={s.input} value={newName} onChangeText={setNewName}
              placeholder="Name, e.g. Route 1 morning" placeholderTextColor={colors.textDim} autoFocus
            />
            <TextInput
              style={s.input} value={newVehicle} onChangeText={setNewVehicle}
              placeholder="Vehicle, e.g. Bus 01" placeholderTextColor={colors.textDim}
            />
            <View style={s.kinds}>
              {KINDS.map((k) => (
                <TouchableOpacity
                  key={k.key}
                  onPress={() => setNewKind(k.key)}
                  style={[s.kind, newKind === k.key && { backgroundColor: colors.primary }]}
                >
                  <Text style={[s.kindText, newKind === k.key && { color: '#fff' }]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setCreating(false)}>
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.primaryBtn, (!newName.trim() || busy) && s.off]}
                onPress={onCreate} disabled={!newName.trim() || busy}
              >
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.primaryText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── edit ── */}
      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <View style={s.screen}>
          <View style={s.sheetHeader}>
            <TouchableOpacity onPress={() => setEditing(null)}><Ionicons name="close" size={24} color={colors.text} /></TouchableOpacity>
            <Text style={s.sheetTitle} numberOfLines={1}>
              {editing?.run.vehicleLabel || editing?.run.name}
            </Text>
            {editing && editing.run.status !== 'completed' && editing.run.status !== 'cancelled' && (
              <TouchableOpacity onPress={() => cancelRun(editing.run)}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Cancel run</Text>
              </TouchableOpacity>
            )}
          </View>

          <ScrollView contentContainerStyle={s.body}>
            {/* driver */}
            <Text style={s.section}>DRIVER</Text>
            <View style={s.card}>
              {members.length === 0 && <Text style={s.muted}>Nobody in this space can be assigned yet.</Text>}
              {members.map((m) => {
                const on = editing?.run.driverId === m.id;
                return (
                  <TouchableOpacity key={m.id} style={s.pickRow} onPress={() => assignDriver(on ? null : m.id)}>
                    <Ionicons
                      name={on ? 'radio-button-on' : 'radio-button-off'}
                      size={19} color={on ? colors.primary : colors.textDim}
                    />
                    <Text numberOfLines={1} style={[s.pickText, on && { color: colors.text, fontWeight: '600' }]}>{m.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* stops */}
            <Text style={s.section}>STOPS, IN ORDER</Text>
            <View style={s.card}>
              {editing?.stops.length === 0 && <Text style={s.muted}>No stops yet.</Text>}
              {editing?.stops.map((st, i) => (
                <View key={st.id} style={s.pickRow}>
                  <Text style={s.seq}>{i + 1}</Text>
                  <Text style={[s.pickText, { color: colors.text }]}>{st.label}</Text>
                  <TouchableOpacity onPress={() => removeStop(st.id)}>
                    <Ionicons name="close-circle-outline" size={19} color={colors.textDim} />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={s.addRow}>
                <TextInput
                  style={[s.input, { flex: 1 }]} value={stopDraft} onChangeText={setStopDraft}
                  placeholder="Add a stop" placeholderTextColor={colors.textDim}
                  onSubmitEditing={addStop}
                />
                <TouchableOpacity style={[s.addBtn, (!stopDraft.trim() || busy) && s.off]} onPress={addStop} disabled={!stopDraft.trim() || busy}>
                  <Ionicons name="add" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>

            {/* manifest */}
            <Text style={s.section}>WHO IS ON THIS RUN</Text>
            <View style={s.card}>
              {roster.length === 0 && (
                <Text style={s.muted}>
                  Nobody is on the roster yet. Add people under Roster &amp; links first —
                  a run can only carry people the space knows about.
                </Text>
              )}
              {roster.map((entry) => {
                const on = !!editing?.riders.some((r) => r.riderId === entry.id);
                return (
                  <TouchableOpacity key={entry.id} style={s.pickRow} onPress={() => toggleRider(entry)}>
                    <Ionicons
                      name={on ? 'checkbox' : 'square-outline'}
                      size={19} color={on ? colors.primary : colors.textDim}
                    />
                    <Text numberOfLines={1} style={[s.pickText, on && { color: colors.text }]}>{entry.displayName}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={s.footnote}>
              Stops and the manifest are saved as a whole list each time, so what you see
              here is what the run is. Guardians are notified as riders are marked on the
              road, never from this screen.
            </Text>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function statusLabel(r: Run): string {
  switch (r.status) {
    case 'scheduled': return 'Not started';
    case 'started': return r.stale ? 'On the road (not reporting)' : 'On the road';
    case 'completed': return 'Finished';
    default: return 'Cancelled';
  }
}
function statusColour(r: Run, c: Palette): string {
  if (r.status === 'started') return r.stale ? c.danger : c.success;
  if (r.status === 'scheduled') return c.textDim;
  return c.textFaint;
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  section: { color: c.textDim, fontSize: 11.5, letterSpacing: 1, marginTop: 8 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  pickText: { color: c.textDim, flex: 1, fontSize: 14.5 },
  seq: { color: c.textDim, width: 20, fontVariant: ['tabular-nums'] },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  addBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  input: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12,
    color: c.text, fontSize: 15,
  },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  kindText: { color: c.textDim, fontSize: 12.5 },
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 10 },
  primaryBtn: { backgroundColor: c.primary },
  primaryText: { color: '#fff', fontWeight: '700' },
  off: { opacity: 0.4 },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 54, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: c.glassStroke,
  },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '700', flex: 1 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
});
