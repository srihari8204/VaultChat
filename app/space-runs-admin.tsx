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

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, TextInput, Modal, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getRuns, getRun, createRun, setRunStops, setRunRiders, setRunDriver, setRunStatus,
  getRoster, type RosterEntry,
} from '../lib/spaces/api';
import type { Run, RunStop, RunRider } from '../lib/spaces/runs';
import { circleMembers } from '../lib/family/circle';
import type { CircleMember } from '../lib/family/types';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import LoadError from '../components/spaces/LoadError';
import {
  parseCoords, parseClock, plannedAtOn, clockOf, stopPayload, remapRiders, idsPreserved, dayOf, stopDay,
} from '../lib/spaces/runPlan';
import { geocodeSearch } from '../lib/nav/geocode';
import { permissionDenied } from '../lib/permissionDenied';
import ChatDoorButton from '../components/spaces/ChatDoorButton';
// The app's one cross-platform date+time picker (native dialog on Android,
// inline sheet on iOS). Shared with finance; nothing in it is finance-specific
// beyond its sheet colours.
import { useDatePicker } from '../components/finance/useDatePicker';

/** One stop as the editor holds it: its OLD server id (null when new) plus the
 *  fields the server stores. See lib/spaces/runPlan.ts for why the old id matters. */
type StopDraft = { prevId: string | null; label: string; lat: number | null; lng: number | null; plannedAt: string | null };
const draftOf = (st: RunStop): StopDraft =>
  ({ prevId: st.id, label: st.label, lat: st.lat, lng: st.lng, plannedAt: st.plannedAt });

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
  const insets = useSafeAreaInsets();
  const spaceId = String(params.spaceId || '');

  const [runs, setRuns] = useState<Run[]>([]);
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('school_pickup');
  const [newVehicle, setNewVehicle] = useState('');
  // When the run happens. Setting it here means stop times are anchored to the
  // run's own day, so the per-stop "Day of the run" field is rarely needed.
  const [newWhen, setNewWhen] = useState<Date | null>(null);
  const [newRequireCode, setNewRequireCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A run that could not be opened, shown inline with a retry instead of an Alert.
  const [openError, setOpenError] = useState<{ run: Run; message: string } | null>(null);
  const picker = useDatePicker();

  // The run being edited, with its stops and manifest.
  const [editing, setEditing] = useState<{ run: Run; stops: RunStop[]; riders: RunRider[] } | null>(null);
  // The stop form: index into the ordered stops, or null for a new stop.
  const [stopForm, setStopForm] = useState<{ index: number | null; label: string; where: string; time: string; day: string } | null>(null);
  // The rider whose stop is being picked.
  const [stopFor, setStopFor] = useState<RunRider | null>(null);

  const load = useCallback(async () => {
    try {
      // Any of the three failing is an error, not an empty list: "No runs yet"
      // after a timeout invites an administrator to build a second copy.
      const [rs, mem, ros] = await Promise.all([
        getRuns(spaceId), circleMembers(spaceId), getRoster(spaceId),
      ]);
      setRuns(rs);
      setMembers(mem);
      setRoster(ros.roster);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? 'Could not load the runs.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openRun = useCallback(async (r: Run) => {
    try {
      setEditing(await getRun(spaceId, r.id));
      setOpenError(null);
    } catch (e: any) {
      setOpenError({ run: r, message: e?.message ?? 'Check your connection and try again.' });
    }
  }, [spaceId]);

  const onCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { id } = await createRun(spaceId, {
        name, kind: newKind, vehicleLabel: newVehicle.trim() || undefined,
        ...(newWhen ? { scheduledAt: newWhen.toISOString() } : {}),
        ...(newRequireCode ? { requireCode: true } : {}),
      });
      setCreating(false); setNewName(''); setNewVehicle(''); setNewWhen(null); setNewRequireCode(false);
      await load();
      const full = await getRun(spaceId, id);
      setEditing(full);
    } catch (e: any) {
      Alert.alert('Could not create the run', e?.message ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [newName, newKind, newVehicle, newWhen, newRequireCode, spaceId, load]);

  const orderedStops = useMemo(
    () => [...(editing?.stops ?? [])].sort((a, b) => a.seq - b.seq),
    [editing?.stops],
  );

  /**
   * Save the whole stop list, keeping every rider on their stop.
   *
   * Existing stops are sent with their ids, which a current server updates in
   * place (riders and arrival marks kept). An older server re-creates every
   * stop and its foreign key nulls each rider's stop, so then — and only then,
   * per idsPreserved — the manifest is re-sent against the new ids in the same
   * gesture; otherwise one stop edit would quietly unassign the run.
   */
  const saveStops = useCallback(async (drafts: StopDraft[]) => {
    if (!editing) return false;
    setBusy(true);
    try {
      const res = await setRunStops(spaceId, editing.run.id, stopPayload(drafts));
      const prevIds = drafts.map((d) => d.prevId);
      const saved = await getRun(spaceId, editing.run.id);
      if (!idsPreserved(prevIds, res?.stopIds) && editing.riders.some((r) => r.stopId)) {
        try {
          await setRunRiders(spaceId, editing.run.id,
            remapRiders(editing.riders, prevIds, saved.stops));
        } catch (e: any) {
          Alert.alert('Stops saved, rider stops were not',
            `${e?.message ?? 'The manifest could not be saved.'} Check each rider’s stop below.`);
        }
      }
      setEditing(await getRun(spaceId, editing.run.id));
      return true;
    } catch (e: any) {
      // unknown_stop: the list changed elsewhere since this editor loaded it.
      // Re-read rather than let the admin retry against stale ids.
      if (e?.body?.code === 'unknown_stop') {
        Alert.alert('The stops changed', 'Someone else edited this run’s stops. The latest list is shown now — make your change again.');
        getRun(spaceId, editing.run.id).then(setEditing).catch(() => {});
      } else {
        Alert.alert('Could not save the stops', e?.message ?? 'Try again.');
      }
      return false;
    } finally {
      setBusy(false);
    }
  }, [editing, spaceId]);

  /** Stop edits on a run in progress: a current server keeps arrival marks on
   *  stops it keeps, but an older one re-creates every stop and clears them. */
  const confirmStopEdit = useCallback((go: () => void) => {
    if (editing?.run.status !== 'started') { go(); return; }
    Alert.alert(
      'Change stops on a run in progress?',
      'Arrival marks on a stop you remove are lost, and on an older server every recorded arrival may be cleared. Riders keep their state.',
      [{ text: 'Keep as is', style: 'cancel' }, { text: 'Change stops', style: 'destructive', onPress: go }],
    );
  }, [editing?.run.status]);

  const fillHere = useCallback(async () => {
    try {
      const Location = await import('expo-location');
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        permissionDenied('Location needed', 'Allow location to place this stop where you are standing, or type an address or "lat, lng".', perm.canAskAgain);
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setStopForm((f) => f && { ...f, where: `${loc.coords.latitude.toFixed(6)}, ${loc.coords.longitude.toFixed(6)}` });
    } catch (e: any) {
      Alert.alert('Could not read your location', e?.message ?? 'Try again.');
    }
  }, []);

  const submitStop = useCallback(async () => {
    if (!editing || !stopForm || !stopForm.label.trim()) return;
    const where = stopForm.where.trim();
    const time = stopForm.time.trim();
    const minutes = time ? parseClock(time) : null;
    if (time && minutes == null) {
      Alert.alert('Planned time', 'Use a 24-hour time such as 07:45, or leave it blank.');
      return;
    }
    const base = minutes == null ? null : stopDay(editing.run.scheduledAt, stopForm.day);
    if (minutes != null && base == null) {
      Alert.alert('Which day?', 'This run has no scheduled date. Enter the day of the run, such as 2026-10-05, so the planned time is not measured against the wrong day.');
      return;
    }
    let place: { lat: number; lng: number } | null = null;
    if (where) {
      place = parseCoords(where);
      if (!place) {
        setBusy(true);
        const hits = await geocodeSearch(where).catch(() => []);
        setBusy(false);
        if (!hits[0]) {
          Alert.alert('Place not found', `Could not find "${where}". Try an address, "lat, lng", or use your current location.`);
          return;
        }
        place = { lat: hits[0].lat, lng: hits[0].lng };
      }
    }
    const draft: StopDraft = {
      prevId: stopForm.index == null ? null : orderedStops[stopForm.index].id,
      label: stopForm.label.trim(),
      lat: place?.lat ?? null,
      lng: place?.lng ?? null,
      plannedAt: minutes == null || base == null ? null : plannedAtOn(base, minutes),
    };
    const drafts = orderedStops.map(draftOf);
    if (stopForm.index == null) drafts.push(draft); else drafts[stopForm.index] = draft;
    confirmStopEdit(async () => { if (await saveStops(drafts)) setStopForm(null); });
  }, [editing, stopForm, orderedStops, saveStops, confirmStopEdit]);

  const editStop = useCallback((index: number | null) => {
    const st = index == null ? null : orderedStops[index];
    setStopForm({
      index,
      label: st?.label ?? '',
      where: st && st.lat != null && st.lng != null ? `${st.lat.toFixed(6)}, ${st.lng.toFixed(6)}` : '',
      time: clockOf(st?.plannedAt ?? null),
      // Only asked for when the run has no scheduled day: this stop's day, a
      // sibling's, or the day the run started — the admin can see and change it.
      day: dayOf(st?.plannedAt ?? orderedStops.find((x) => x.plannedAt)?.plannedAt ?? editing?.run.startedAt ?? null),
    });
  }, [orderedStops, editing?.run.startedAt]);

  const removeStop = useCallback((st: RunStop) => {
    const riding = editing?.riders.filter((r) => r.stopId === st.id).length ?? 0;
    Alert.alert(
      `Remove ${st.label}?`,
      riding > 0
        ? `${riding} ${riding === 1 ? 'rider is' : 'riders are'} assigned to it and will have no stop until you pick a new one.`
        : 'The stop is removed from this run.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: () => confirmStopEdit(() => {
            void saveStops(orderedStops.filter((x) => x.id !== st.id).map(draftOf));
          }),
        },
      ],
    );
  }, [editing?.riders, orderedStops, saveStops, confirmStopEdit]);

  const moveStopUp = useCallback((index: number) => {
    if (index <= 0) return;
    const drafts = orderedStops.map(draftOf);
    [drafts[index - 1], drafts[index]] = [drafts[index], drafts[index - 1]];
    confirmStopEdit(() => { void saveStops(drafts); });
  }, [orderedStops, saveStops, confirmStopEdit]);

  const saveRiders = useCallback(async (next: { riderId: string; stopId: string | null }[]) => {
    if (!editing) return;
    setBusy(true);
    try {
      await setRunRiders(spaceId, editing.run.id, next);
      setEditing(await getRun(spaceId, editing.run.id));
    } catch (e: any) {
      Alert.alert('Could not save the manifest', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  }, [editing, spaceId]);

  const toggleRider = useCallback((entry: RosterEntry) => {
    if (!editing) return;
    const current = editing.riders.map((r) => ({ riderId: r.riderId, stopId: r.stopId ?? null }));
    const on = current.some((r) => r.riderId === entry.id);
    void saveRiders(on
      ? current.filter((r) => r.riderId !== entry.id)
      : [...current, { riderId: entry.id, stopId: null }]);
  }, [editing, saveRiders]);

  const assignStop = useCallback((rider: RunRider, stopId: string | null) => {
    if (!editing) return;
    setStopFor(null);
    void saveRiders(editing.riders.map((r) => ({
      riderId: r.riderId, stopId: r.riderId === rider.riderId ? stopId : (r.stopId ?? null),
    })));
  }, [editing, saveRiders]);

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

  const pickDriver = useCallback((userId: string | null) => {
    if (editing?.run.status !== 'started') { void assignDriver(userId); return; }
    // Mid-run, the current driver's screen stops being theirs.
    Alert.alert(
      'Change the driver of a run in progress?',
      'The current driver will no longer be able to mark riders on this run.',
      [{ text: 'Keep driver', style: 'cancel' }, { text: 'Change', style: 'destructive', onPress: () => { void assignDriver(userId); } }],
    );
  }, [editing?.run.status, assignDriver]);

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
  const stopLabel = (stopId: string | null) =>
    orderedStops.find((x) => x.id === stopId)?.label ?? (orderedStops.length ? 'No stop · first stop' : 'No stop');

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
      <AuroraBackground />
      <Stack.Screen
        options={{
          ...spaceHeader(colors, params.name ? `${params.name} · Runs` : 'Runs'),
          // The add button sits NEXT TO the chat door, not in place of it.
          headerRight: () => (
            <View style={s.headerActions}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="New run" onPress={() => setCreating(true)} style={s.hit}>
                <Ionicons name="add" size={24} color={colors.primary} />
              </TouchableOpacity>
              {!!spaceId && (
                <ChatDoorButton
                  colors={colors} chat={{ id: spaceId, name: params.name }}
                  fallbackTitle="Runs" accessibilityLabel="Open the space chat"
                />
              )}
            </View>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />}
      >
        {loadError && (
          <LoadError colors={colors} title="Could not load the runs" message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        )}
        {openError && (
          <LoadError
            colors={colors} title={`Could not open ${openError.run.vehicleLabel || openError.run.name}`}
            message={openError.message} onRetry={() => { void openRun(openError.run); }}
          />
        )}
        {!loadError && runs.length === 0 && (
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
          <TouchableOpacity
            key={r.id} style={s.card} onPress={() => openRun(r)}
            accessibilityRole="button"
            accessibilityLabel={`${r.vehicleLabel || r.name}, ${statusLabel(r)}, ${driverName(r.driverId)}`}
            accessibilityHint="Opens the run to edit its driver, stops and riders"
          >
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
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>New run</Text>
            <TextInput
              style={s.input} value={newName} onChangeText={setNewName}
              placeholder="Name, e.g. Route 1 morning" placeholderTextColor={colors.textDim} autoFocus
              accessibilityLabel="Run name"
            />
            <TextInput
              style={s.input} value={newVehicle} onChangeText={setNewVehicle}
              placeholder="Vehicle, e.g. Bus 01" placeholderTextColor={colors.textDim}
              accessibilityLabel="Vehicle"
            />
            <View style={s.kinds}>
              {KINDS.map((k) => (
                <TouchableOpacity
                  key={k.key}
                  onPress={() => setNewKind(k.key)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: newKind === k.key }}
                  style={[s.kind, newKind === k.key && { backgroundColor: colors.brandOnLight }]}
                >
                  {/* White ink on the solid brandOnLight fill (deep blue in both schemes). */}
                  <Text style={[s.kindText, newKind === k.key && { color: '#fff' }]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {/* When: picked, not typed. Optional — an unscheduled run asks for
                a day only when a stop is given a planned time. */}
            <View style={s.pickRow}>
              <TouchableOpacity
                style={[s.addStop, { flex: 1 }]}
                onPress={() => picker.open(newWhen ?? nextMorning(), setNewWhen, 'datetime')}
                accessibilityRole="button"
                accessibilityLabel={newWhen ? `Scheduled for ${whenLabel(newWhen)}. Change` : 'Set the date and time of the run'}
              >
                <Ionicons name="calendar-outline" size={18} color={colors.primary} />
                <Text style={{ color: colors.primary, fontWeight: '600', flexShrink: 1 }}>
                  {newWhen ? whenLabel(newWhen) : 'Set date and time (optional)'}
                </Text>
              </TouchableOpacity>
              {newWhen && (
                <TouchableOpacity onPress={() => setNewWhen(null)} style={s.iconHit} accessibilityRole="button" accessibilityLabel="Clear the date and time">
                  <Ionicons name="close-circle-outline" size={19} color={colors.textDim} />
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              style={s.pickRow} onPress={() => setNewRequireCode((v) => !v)}
              accessibilityRole="checkbox" accessibilityState={{ checked: newRequireCode }}
              accessibilityLabel="Ask for a handover code when a rider boards and is dropped off"
            >
              <Ionicons name={newRequireCode ? 'checkbox' : 'square-outline'} size={19} color={newRequireCode ? colors.primary : colors.textDim} />
              <Text style={[s.pickText, newRequireCode && { color: colors.text }]}>Ask for a handover code at boarding and drop-off</Text>
            </TouchableOpacity>
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setCreating(false)} accessibilityRole="button">
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.primaryBtn, (!newName.trim() || busy) && s.off]}
                onPress={onCreate} disabled={!newName.trim() || busy}
                accessibilityRole="button" accessibilityLabel="Create run"
                accessibilityState={{ disabled: !newName.trim() || busy }}
              >
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.primaryText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
        {/* Inside this Modal so it stacks above it on iOS. */}
        {picker.element}
      </Modal>

      {/* ── edit ── */}
      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <KeyboardSafe keyboardOnly>
        <View style={[s.screen, { backgroundColor: colors.bg }]}>
          <View style={[s.sheetHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" onPress={() => setEditing(null)} style={s.hit}><Ionicons name="close" size={24} color={colors.text} /></TouchableOpacity>
            <Text style={s.sheetTitle} numberOfLines={1}>
              {editing?.run.vehicleLabel || editing?.run.name}
            </Text>
            {busy && <ActivityIndicator size="small" color={colors.primary} />}
            {editing && editing.run.status !== 'completed' && editing.run.status !== 'cancelled' && (
              <TouchableOpacity onPress={() => cancelRun(editing.run)} accessibilityRole="button" style={s.hit}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Cancel run</Text>
              </TouchableOpacity>
            )}
          </View>

          <ScrollView contentContainerStyle={[s.body, { paddingBottom: 40 + insets.bottom }]}>
            {/* driver */}
            <Text style={s.section}>DRIVER</Text>
            <View style={s.card}>
              {members.length === 0 && <Text style={s.muted}>Nobody in this space can be assigned yet.</Text>}
              {members.map((m) => {
                const on = editing?.run.driverId === m.id;
                return (
                  <TouchableOpacity
                    key={m.id} style={[s.pickRow, busy && s.off]} onPress={() => pickDriver(on ? null : m.id)}
                    disabled={busy}
                    accessibilityRole="radio" accessibilityLabel={m.name}
                    accessibilityState={{ checked: on, disabled: busy }}
                  >
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
              {orderedStops.length === 0 && (
                <Text style={s.muted}>
                  No stops yet. Without stops the driver sees everyone on one list, and
                  guardians get no arrival estimate or late warning.
                </Text>
              )}
              {orderedStops.map((st, i) => (
                <View key={st.id} style={s.pickRow}>
                  <Text style={s.seq}>{i + 1}</Text>
                  <TouchableOpacity
                    style={{ flex: 1 }} onPress={() => editStop(i)} disabled={busy}
                    accessibilityRole="button" accessibilityLabel={`Edit stop ${st.label}`}
                  >
                    <Text style={[s.pickText, { color: colors.text }]}>{st.label}</Text>
                    <Text style={s.muted}>
                      {st.plannedAt ? clockOf(st.plannedAt) : 'No planned time'}
                      {' · '}
                      {st.lat != null && st.lng != null ? 'Location set' : 'No location'}
                    </Text>
                  </TouchableOpacity>
                  {i > 0 && (
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Move ${st.label} earlier`} onPress={() => moveStopUp(i)} disabled={busy} style={s.iconHit}>
                      <Ionicons name="arrow-up" size={18} color={colors.textDim} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${st.label}`} onPress={() => removeStop(st)} disabled={busy} style={s.iconHit}>
                    <Ionicons name="close-circle-outline" size={19} color={colors.textDim} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity
                style={[s.addStop, busy && s.off]} onPress={() => editStop(null)} disabled={busy}
                accessibilityRole="button" accessibilityLabel="Add a stop"
              >
                <Ionicons name="add-circle-outline" size={19} color={colors.primary} />
                <Text style={{ color: colors.primary, fontWeight: '600' }}>Add a stop</Text>
              </TouchableOpacity>
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
                const rider = editing?.riders.find((r) => r.riderId === entry.id);
                const on = !!rider;
                return (
                  <View key={entry.id} style={s.pickRow}>
                    <TouchableOpacity
                      style={[s.riderToggle, busy && s.off]} onPress={() => toggleRider(entry)} disabled={busy}
                      accessibilityRole="checkbox" accessibilityLabel={entry.displayName}
                      accessibilityState={{ checked: on, disabled: busy }}
                    >
                      <Ionicons
                        name={on ? 'checkbox' : 'square-outline'}
                        size={19} color={on ? colors.primary : colors.textDim}
                      />
                      <Text numberOfLines={1} style={[s.pickText, on && { color: colors.text }]}>{entry.displayName}</Text>
                    </TouchableOpacity>
                    {rider && orderedStops.length > 0 && (
                      <TouchableOpacity
                        style={s.stopChip} onPress={() => setStopFor(rider)} disabled={busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Stop for ${entry.displayName}: ${stopLabel(rider.stopId)}. Change`}
                      >
                        <Text numberOfLines={1} style={[s.stopChipText, !rider.stopId && { color: colors.warning }]}>
                          {stopLabel(rider.stopId)}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color={colors.textDim} />
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
            </View>

            <Text style={s.footnote}>
              Stops and the manifest are saved as a whole list each time, so what you see
              here is what the run is. A rider with no stop is shown to the driver at the
              first stop. Guardians are notified as riders are marked on the road, never
              from this screen.
            </Text>
          </ScrollView>
        </View>
        </KeyboardSafe>

        {/* ── stop form (inside the edit modal so it stacks above it) ── */}
        <Modal visible={!!stopForm} transparent animationType="fade" onRequestClose={() => setStopForm(null)}>
          <KeyboardSafe keyboardOnly>
          <View style={s.modalWrap}>
            <View style={s.modal}>
              <Text style={s.modalTitle}>{stopForm?.index == null ? 'New stop' : 'Edit stop'}</Text>
              <TextInput
                style={s.input} value={stopForm?.label ?? ''} autoFocus
                onChangeText={(t) => setStopForm((f) => f && { ...f, label: t })}
                placeholder="Name, e.g. Green Lane" placeholderTextColor={colors.textDim}
                accessibilityLabel="Stop name" maxLength={120}
              />
              <TextInput
                style={s.input} value={stopForm?.where ?? ''}
                onChangeText={(t) => setStopForm((f) => f && { ...f, where: t })}
                placeholder='Address or "lat, lng" (optional)' placeholderTextColor={colors.textDim}
                accessibilityLabel="Stop location: an address or latitude, longitude"
              />
              <TouchableOpacity style={s.addStop} onPress={fillHere} accessibilityRole="button" accessibilityLabel="Use my current location">
                <Ionicons name="locate-outline" size={18} color={colors.primary} />
                <Text style={{ color: colors.primary, fontWeight: '600' }}>Use my current location</Text>
              </TouchableOpacity>
              <TextInput
                style={s.input} value={stopForm?.time ?? ''}
                onChangeText={(t) => setStopForm((f) => f && { ...f, time: t })}
                placeholder="Planned time, e.g. 07:45 (optional)" placeholderTextColor={colors.textDim}
                accessibilityLabel="Planned time, 24-hour" keyboardType="numbers-and-punctuation" maxLength={5}
              />
              {!!stopForm?.time.trim() && stopDay(editing?.run.scheduledAt ?? null, '') == null && (
                <TextInput
                  style={s.input} value={stopForm?.day ?? ''}
                  onChangeText={(t) => setStopForm((f) => f && { ...f, day: t })}
                  placeholder="Day of the run, e.g. 2026-10-05" placeholderTextColor={colors.textDim}
                  accessibilityLabel="Day of the run, year-month-day" keyboardType="numbers-and-punctuation" maxLength={10}
                />
              )}
              <Text style={s.muted}>
                The location gives guardians an arrival estimate and lets the driver’s phone
                notice a route deviation. The planned time is what “running late” is measured against.
              </Text>
              <View style={s.modalRow}>
                <TouchableOpacity style={s.modalBtn} onPress={() => setStopForm(null)} accessibilityRole="button">
                  <Text style={s.muted}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.modalBtn, s.primaryBtn, (!stopForm?.label.trim() || busy) && s.off]}
                  onPress={submitStop} disabled={!stopForm?.label.trim() || busy}
                  accessibilityRole="button" accessibilityLabel="Save stop"
                  accessibilityState={{ disabled: !stopForm?.label.trim() || busy }}
                >
                  {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.primaryText}>Save</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </View>
          </KeyboardSafe>
        </Modal>

        {/* ── rider stop picker ── */}
        <Modal visible={!!stopFor} transparent animationType="fade" onRequestClose={() => setStopFor(null)}>
          <View style={s.modalWrap}>
            <View style={s.modal}>
              <Text style={s.modalTitle}>Stop for {stopFor?.displayName}</Text>
              {[{ id: null as string | null, label: 'No stop (shown at the first stop)' },
                ...orderedStops.map((st, i) => ({ id: st.id as string | null, label: `${i + 1}. ${st.label}` }))].map((o) => {
                const on = (stopFor?.stopId ?? null) === o.id;
                return (
                  <TouchableOpacity
                    key={o.id ?? 'none'} style={s.pickRow}
                    onPress={() => stopFor && assignStop(stopFor, o.id)}
                    accessibilityRole="radio" accessibilityLabel={o.label} accessibilityState={{ checked: on }}
                  >
                    <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={19} color={on ? colors.primary : colors.textDim} />
                    <Text numberOfLines={1} style={[s.pickText, on && { color: colors.text, fontWeight: '600' }]}>{o.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <View style={s.modalRow}>
                <TouchableOpacity style={s.modalBtn} onPress={() => setStopFor(null)} accessibilityRole="button">
                  <Text style={s.muted}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </Modal>
    </View>
  );
}

/** Tomorrow at 07:00 local — the picker's starting point for a new run. */
function nextMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d;
}
const whenLabel = (d: Date) =>
  d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

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
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, minHeight: 44 },
  pickText: { color: c.textDim, flex: 1, fontSize: 14.5 },
  seq: { color: c.textDim, width: 20, fontVariant: ['tabular-nums'] },
  addStop: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  iconHit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  riderToggle: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minHeight: 44 },
  stopChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 160, minHeight: 44,
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 16, paddingHorizontal: 10,
  },
  stopChipText: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  input: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12,
    color: c.text, fontSize: 15,
  },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 22, paddingHorizontal: 14,
    minHeight: 44, justifyContent: 'center',
  },
  kindText: { color: c.textDim, fontSize: 12.5 },
  // A fixed dark scrim behind the dialog, the same in both schemes.
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  primaryBtn: { backgroundColor: c.brandOnLight },
  primaryText: { color: '#fff', fontWeight: '700' },
  off: { opacity: 0.4 },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: c.glassStroke,
  },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '700', flex: 1 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
});
