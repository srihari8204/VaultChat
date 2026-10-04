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
  View, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, Modal, RefreshControl,
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
  stopWhenText, stopPayload, remapRiders, idsPreserved, plannedPickStart,
} from '../lib/spaces/runPlan';
import ChatDoorButton from '../components/spaces/ChatDoorButton';
import { runsAdminStyles } from '../components/spaces/runsAdminStyles';
import NewRunModal, { type NewRunBody, whenLabel } from '../components/spaces/NewRunModal';
import StopFormModal, { type StopFormInitial, type StopFormResult } from '../components/spaces/StopFormModal';
import { errCode, errMsg } from '../lib/spaces/errors';

/** One stop as the editor holds it: its OLD server id (null when new) plus the
 *  fields the server stores. See lib/spaces/runPlan.ts for why the old id matters. */
type StopDraft = { prevId: string | null; label: string; lat: number | null; lng: number | null; plannedAt: string | null };
/** What opening a run needs: its id, and its labels for the error card. */
type OpenTarget = Pick<Run, 'id' | 'name' | 'vehicleLabel'>;
const draftOf = (st: RunStop): StopDraft =>
  ({ prevId: st.id, label: st.label, lat: st.lat, lng: st.lng, plannedAt: st.plannedAt });

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
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A run that could not be opened, shown inline with a retry instead of an Alert.
  const [openError, setOpenError] = useState<{ run: OpenTarget; message: string } | null>(null);

  // The run being edited, with its stops and manifest.
  const [editing, setEditing] = useState<{ run: Run; stops: RunStop[]; riders: RunRider[] } | null>(null);
  // The stop form's starting values (index null = a new stop); null = closed.
  const [stopForm, setStopForm] = useState<StopFormInitial | null>(null);
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
    } catch (e) {
      setLoadError(errMsg(e) ?? 'Could not load the runs.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  /** Reads only the id, and the name/vehicle for its error card. */
  const openRun = useCallback(async (r: OpenTarget) => {
    try {
      setEditing(await getRun(spaceId, r.id));
      setOpenError(null);
    } catch (e) {
      setOpenError({ run: r, message: errMsg(e) ?? 'Check your connection and try again.' });
    }
  }, [spaceId]);

  const onCreate = useCallback(async (body: NewRunBody): Promise<boolean> => {
    setBusy(true);
    let id: string;
    try {
      ({ id } = await createRun(spaceId, body));
    } catch (e) {
      Alert.alert('Could not create the run', errMsg(e) ?? 'Try again.');
      return false;
    } finally {
      setBusy(false);
    }
    // Created: close the dialog, then open the new run (a failed open shows
    // its own inline retry rather than reading as "not created").
    setCreating(false);
    await load();
    await openRun({ id, name: body.name, vehicleLabel: body.vehicleLabel ?? null });
    return true;
  }, [spaceId, load, openRun]);

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
        } catch (e) {
          Alert.alert('Stops saved, rider stops were not',
            `${errMsg(e) ?? 'The manifest could not be saved.'} Check each rider’s stop below.`);
        }
      }
      setEditing(await getRun(spaceId, editing.run.id));
      return true;
    } catch (e) {
      // unknown_stop: the list changed elsewhere since this editor loaded it.
      // Re-read rather than let the admin retry against stale ids.
      if (errCode(e) === 'unknown_stop') {
        Alert.alert('The stops changed', 'Someone else edited this run’s stops. The latest list is shown now — make your change again.');
        getRun(spaceId, editing.run.id).then(setEditing).catch(() => {});
      } else {
        Alert.alert('Could not save the stops', errMsg(e) ?? 'Try again.');
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

  const submitStop = useCallback((v: StopFormResult) => {
    if (!editing || !stopForm) return;
    const draft: StopDraft = {
      prevId: stopForm.index == null ? null : orderedStops[stopForm.index].id,
      label: v.label,
      lat: v.place?.lat ?? null,
      lng: v.place?.lng ?? null,
      plannedAt: v.plannedAt,
    };
    const drafts = orderedStops.map(draftOf);
    if (stopForm.index == null) drafts.push(draft); else drafts[stopForm.index] = draft;
    confirmStopEdit(async () => { if (await saveStops(drafts)) setStopForm(null); });
  }, [editing, stopForm, orderedStops, saveStops, confirmStopEdit]);

  const editStop = useCallback((index: number | null) => {
    const st = index == null ? null : orderedStops[index];
    const t = st?.plannedAt ? Date.parse(st.plannedAt) : NaN;
    setStopForm({
      index,
      label: st?.label ?? '',
      where: st && st.lat != null && st.lng != null ? `${st.lat.toFixed(6)}, ${st.lng.toFixed(6)}` : '',
      planned: Number.isFinite(t) ? new Date(t) : null,
    });
  }, [orderedStops]);
  // Where the stop picker starts when the stop has no time: a sibling's, the
  // run's scheduled or start time, else tomorrow morning (lib/spaces/runPlan).
  const pickStart = useMemo(() => plannedPickStart(
    null, orderedStops.find((x) => x.plannedAt)?.plannedAt ?? null,
    editing?.run.scheduledAt ?? null, editing?.run.startedAt ?? null, Date.now(),
  ), [orderedStops, editing?.run.scheduledAt, editing?.run.startedAt]);

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
    } catch (e) {
      Alert.alert('Could not save the manifest', errMsg(e) ?? 'Try again.');
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
    } catch (e) {
      // The server refuses a driver who already has a run in progress; say so
      // rather than leaving the picker looking broken.
      Alert.alert('Could not assign', errMsg(e) ?? 'Try again.');
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
            catch (e) { Alert.alert('Could not cancel', errMsg(e) ?? 'Try again.'); }
          },
        },
      ],
    );
  }, [spaceId, load]);

  const s = useMemo(() => runsAdminStyles(colors), [colors]);
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
        {loadError && runs.length > 0 && (
          <Text style={s.muted}>The list below is from the last successful refresh and may be out of date.</Text>
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
      <NewRunModal
        visible={creating} colors={colors} s={s} busy={busy}
        onClose={() => setCreating(false)} onCreate={onCreate}
      />

      {/* ── edit ── */}
      <Modal visible={!!editing} animationType="slide" onRequestClose={() => setEditing(null)}>
        <KeyboardSafe keyboardOnly>
        <View style={[s.screen, { backgroundColor: colors.bg }]}>
          <View style={[s.sheetHeader, { paddingTop: insets.top + 12 }]}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" onPress={() => setEditing(null)} style={s.hit}><Ionicons name="close" size={24} color={colors.text} /></TouchableOpacity>
            <Text style={s.sheetTitle} numberOfLines={1} accessibilityRole="header">
              {editing?.run.vehicleLabel || editing?.run.name}
            </Text>
            {busy && <ActivityIndicator size="small" color={colors.primary} />}
            {editing && editing.run.status !== 'completed' && editing.run.status !== 'cancelled' && (
              <TouchableOpacity onPress={() => cancelRun(editing.run)} accessibilityRole="button" accessibilityLabel="Cancel this run" style={s.hit}>
                <Text style={{ color: colors.danger, fontWeight: '600' }}>Cancel run</Text>
              </TouchableOpacity>
            )}
          </View>

          <ScrollView contentContainerStyle={[s.body, { paddingBottom: 40 + insets.bottom }]}>
            {/* driver */}
            <Text style={s.section}>DRIVER</Text>
            <View style={s.card} accessibilityRole="radiogroup" accessibilityLabel="Driver">
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
              {orderedStops.map((st, i) => {
                const when = stopWhenText(st.plannedAt, editing?.run.scheduledAt ?? null, whenLabel);
                return (
                <View key={st.id} style={s.pickRow}>
                  <Text style={s.seq}>{i + 1}</Text>
                  <TouchableOpacity
                    style={{ flex: 1 }} onPress={() => editStop(i)} disabled={busy}
                    accessibilityRole="button" accessibilityLabel={`Edit stop ${st.label}, ${when || 'no planned time'}`}
                  >
                    <Text style={[s.pickText, { color: colors.text }]}>{st.label}</Text>
                    <Text style={s.muted}>
                      {when || 'No planned time'}
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
                );
              })}
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
        <StopFormModal
          initial={stopForm} colors={colors} s={s} busy={busy}
          pickStart={pickStart} scheduledAt={editing?.run.scheduledAt ?? null}
          onClose={() => setStopForm(null)} onSubmit={submitStop}
        />

        {/* ── rider stop picker ── */}
        <Modal visible={!!stopFor} transparent animationType="fade" onRequestClose={() => setStopFor(null)}>
          <View style={s.modalWrap}>
            <View style={s.modal}>
              <Text style={s.modalTitle} accessibilityRole="header">Stop for {stopFor?.displayName}</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel={`Stop for ${stopFor?.displayName ?? 'this rider'}`}>
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
              </View>
              <View style={s.modalRow}>
                <TouchableOpacity style={s.modalBtn} onPress={() => setStopFor(null)} accessibilityRole="button" accessibilityLabel="Cancel">
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
