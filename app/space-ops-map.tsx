// app/space-ops-map.tsx — every active run on one map (Spaces & Operations, S2.9).
//
// This is the transport office's screen: which vehicles are out, where they are,
// how far through their manifest, and which ones have stopped reporting.
//
// REUSES THE EXISTING MAP. A vehicle marker is a member marker with a different
// label — the clustered Leaflet WebView in components/family/FamilyMap.tsx
// already renders on no-GMS devices and already merges markers that collide at
// the current zoom. A second map renderer would be a second thing to keep
// working on those devices.
//
// EVERY POSITION HERE IS SEALED AND ARRIVES ON THE SOCKET. There is no endpoint
// that returns a vehicle's coordinates, because the server does not have them.
// This screen opens one subscription per active run and holds what it receives;
// nothing is fetched and nothing is stored. That has a consequence the UI has to
// be honest about: a bus that has not pinged since this screen opened has NO
// position to draw, which is different from a bus that is not moving.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, TextInput, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import FamilyMap, { type FamilyMarker } from '../components/family/FamilyMap';
import { getRunsWithManifest, type RunWithManifest } from '../lib/spaces/api';
import { subscribeRun, type RunPing } from '../lib/spaces/runSession';
import { progress, type Run, type RunRider } from '../lib/spaces/runs';
import { tilesForType, type RunSet } from '../lib/spaces/dashboard';
import { sendMessage } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import { AuroraBackground } from '../components/ui';
import LoadError from '../components/spaces/LoadError';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';

/** A fix older than this is drawn faded — the map must not imply freshness. */
const STALE_MS = 90_000;
/** How often the run list is re-read while the screen is focused. */
const RELOAD_MS = 60_000;

export default function SpaceOpsMapScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [runs, setRuns] = useState<Run[]>([]);
  const [positions, setPositions] = useState<Record<string, RunPing>>({});
  const [manifests, setManifests] = useState<Record<string, RunRider[]>>({});
  // Runs whose manifest could not be read: their "done" counts are unknown.
  const [noManifest, setNoManifest] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The last list read, so a timer re-read against a server without
  // `include=` re-reads only the runs on the road (lib/spaces/api previous).
  const lastList = useRef<RunWithManifest[] | undefined>(undefined);
  const load = useCallback(async (timer = false) => {
    try {
      // Manifests come with the runs (one call where the server supports it,
      // else per run) so the office sees "22 of 40 aboard" rather than just a
      // dot. Failures are per-run and non-fatal — and marked, not drawn as 0/0.
      const list = await getRunsWithManifest(spaceId, { activeOnly: true, previous: timer ? lastList.current : undefined });
      lastList.current = list;
      setRuns(list.map((x) => x.run));
      // A run that finished or vanished since: the composer must not keep
      // addressing it.
      setFocus((f) => (f && list.some((x) => x.run.id === f) ? f : null));
      setManifests(Object.fromEntries(list.map((x) => [x.run.id, x.riders])));
      setNoManifest(list.filter((x) => x.failed).map((x) => x.run.id));
      setLoadError(null);
    } catch (e: any) {
      // Not "No runs are scheduled": an empty map after a failed read is a
      // false all-clear for an operator.
      setLoadError(e?.message ?? 'Could not load runs.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [spaceId]);

  // Read on focus, and again every minute while focused, so a run started
  // while this screen is open appears without leaving it.
  useFocusEffect(useCallback(() => {
    void load();
    const t = setInterval(() => { void load(true); }, RELOAD_MS);
    return () => clearInterval(t);
  }, [load]));

  // Re-render on a timer so "2 minutes ago" and the stale fade stay true
  // without any new data arriving. Cheap, and the alternative is a screen that
  // silently ages.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // One subscription per active run, opened in PARALLEL (awaiting them one by
  // one left the last bus dark until every earlier join had answered).
  // Re-established only when the SET of started runs changes — the periodic
  // re-read hands back a new array every minute, and must not resubscribe.
  const startedKey = useMemo(
    () => runs.filter((x) => x.status === 'started').map((x) => x.id).sort().join(','),
    [runs],
  );
  useEffect(() => {
    let live = true;
    const stops: (() => void)[] = [];
    const ids = startedKey ? startedKey.split(',') : [];
    (async () => {
      const me: { id?: string | number } | null = await getCurrentUserAsync().catch(() => null);
      const myId = me?.id != null ? String(me.id) : '';
      if (!live) return;
      await Promise.all(ids.map(async (runId) => {
        try {
          const off = await subscribeRun(spaceId, runId, myId, (e) => {
            if (!e.ping) {
              // The vehicle said it is done broadcasting. Drop the marker
              // rather than leaving a dot where the bus used to be.
              setPositions((p) => { const n = { ...p }; delete n[runId]; return n; });
              return;
            }
            setPositions((p) => ({ ...p, [runId]: e.ping! }));
          });
          if (live) stops.push(off); else off();
        } catch { /* one run failing to subscribe must not take the others down */ }
      }));
    })();
    return () => { live = false; stops.forEach((f) => f()); };
  }, [startedKey, spaceId]);

  const markers: FamilyMarker[] = useMemo(() => {
    const now = Date.now();
    return runs
      .map((r) => {
        const p = positions[r.id];
        if (!p) return null;
        return {
          id: r.id,
          name: r.vehicleLabel || r.name,
          lat: p.lat,
          lng: p.lng,
          stale: now - p.at > STALE_MS,
        } as FamilyMarker;
      })
      .filter(Boolean) as FamilyMarker[];
    // `tick` looks unused to the linter and is load-bearing: staleness is
    // computed from Date.now(), so without a dependency that changes with the
    // clock a marker would keep looking fresh for as long as no new ping
    // arrives — which is exactly the case where it is least true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, positions, tick]);

  const waiting = runs.filter((r) => r.status === 'started').length - markers.length;

  // S3.2: every figure derived from the state above. Nothing stored, nothing
  // incremented, and only ever as complete as what the server let this caller
  // see — which is correct, and why the roll-up takes its input as an argument.
  // S3.1: the board is chosen by the space's TYPE, because the question differs
  // — a school counts children, a cab fleet counts vehicles. Not styling.
  const tiles = useMemo(() => {
    const sets: RunSet[] = runs.map((r) => ({ run: r, riders: manifests[r.id] ?? [] }));
    return tilesForType(params.groupType ? String(params.groupType) : null, sets);
  }, [runs, manifests, params.groupType]);

  // S5.7: an instruction addressed to one run, from the screen that shows which
  // run needs it. Sent as an ordinary announcement carrying meta.audience, which
  // the server re-checks — the composer cannot address what the sender may not.
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  // Runs a partly-failed send did NOT reach. The text is kept with them, so
  // "Retry the rest" resends to exactly those and nobody gets it twice.
  const [unreached, setUnreached] = useState<string[] | null>(null);

  // Emergency mode (S5.7). It is a MODE rather than a label because it changes
  // what the composer does: addressing every active run at once instead of the
  // one selected on the map. During an incident the thing an office needs is to
  // reach all of them in one action, and hunting for each vehicle in turn is
  // the failure this exists to prevent.
  //
  // Local to this screen and this session. It is not persisted or broadcast:
  // a stored "we are in an emergency" flag is one nobody remembers to clear,
  // and a stale emergency banner is worse than none.
  const [emergency, setEmergency] = useState(false);
  const activeRuns = useMemo(() => runs.filter((r) => r.status === 'started'), [runs]);

  const deliver = useCallback(async (targets: string[], text: string) => {
    setSending(true);
    try {
      // One addressed announcement per run rather than a space-wide one, so a
      // parent whose child is not on the road is not woken by a message about
      // vehicles they have nothing to do with.
      const results = await Promise.allSettled(targets.map((runId) =>
        sendMessage(spaceId, text, 'text', {
          meta: { announcement: true, audience: `run:${runId}` },
        })));
      const missed = targets.filter((_, i) => results[i].status === 'rejected');
      if (missed.length === 0) {
        setInstruction('');
        setUnreached(null);
        Alert.alert('Sent', targets.length === 1
          ? 'The instruction has gone to that run.'
          : `The instruction has gone to all ${targets.length} runs.`);
        return;
      }
      // Keep the text and WHICH runs missed it. "Partly sent" with no number,
      // and an empty box, is what makes an operator resend to everyone.
      setUnreached(missed);
      Alert.alert(
        missed.length === targets.length ? 'Not sent' : 'Partly sent',
        `${targets.length - missed.length} of ${targets.length} ${targets.length === 1 ? 'run' : 'runs'} reached. `
        + 'The message is kept — use “Retry the rest” to send it to the others only.',
      );
    } finally {
      setSending(false);
    }
  }, [spaceId]);

  const sendInstruction = useCallback(() => {
    const text = instruction.trim();
    if (!text) return;
    // In emergency mode the audience is every run that is out; otherwise it is
    // the one the operator selected.
    const targets = emergency ? activeRuns.map((r) => r.id) : (focus ? [focus] : []);
    if (!targets.length) return;
    if (!emergency) { void deliver(targets, text); return; }
    // A broadcast to every vehicle on the road is one tap from a toggle: confirm it.
    Alert.alert(
      `Send to all ${targets.length} ${targets.length === 1 ? 'run' : 'runs'}?`,
      'Every driver on the road and the guardians of their riders are notified.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Send to all', style: 'destructive', onPress: () => { void deliver(targets, text); } }],
    );
  }, [instruction, focus, emergency, activeRuns, deliver]);

  // A new audience makes the old "not reached" list meaningless.
  useEffect(() => { setUnreached(null); }, [focus, emergency]);

  const retryRest = useCallback(() => {
    const text = instruction.trim();
    // Only runs still on the road: one that finished meanwhile has no audience.
    const still = (unreached ?? []).filter((id) => activeRuns.some((r) => r.id === id));
    if (!text || !still.length) { setUnreached(null); return; }
    void deliver(still, text);
  }, [instruction, unreached, activeRuns, deliver]);

  const s = useMemo(() => styles(colors), [colors]);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Operations')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardSafe style={s.screen} keyboardOnly>
      <AuroraBackground />
      <Stack.Screen options={spaceHeader(colors, params.name ? `${params.name} · Operations` : 'Operations', { id: spaceId, name: params.name })} />

      <FamilyMap members={markers} focusId={focus} onSelect={setFocus} style={s.map} />

      {/* What the map cannot show, said rather than left blank. */}
      {waiting > 0 && (
        <View style={s.banner}>
          <Ionicons name="cloud-offline-outline" size={16} color={colors.warning} />
          <Text style={s.bannerText}>
            {waiting} {waiting === 1 ? 'vehicle has' : 'vehicles have'} not sent a position since this
            screen opened. Positions are end-to-end encrypted and arrive live — there is no history to load.
          </Text>
        </View>
      )}

      <ScrollView
        style={s.list} contentContainerStyle={s.listBody} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />}
      >
        {/* A failed re-read keeps the last rows: say so, above them. */}
        {loadError && (
          <LoadError colors={colors} title="Could not load runs" message={loadError} onRetry={() => { void load(); }} />
        )}
        {loadError && runs.length > 0 && (
          <Text style={s.muted}>The runs below are from the last successful refresh and may be out of date.</Text>
        )}
        {/* Derived tiles (S3.2). Alert colour is reserved for what is actually
            wrong: riders still to collect on a running route is the normal state
            of a bus halfway round, and a dashboard that is red every morning is
            a dashboard nobody reads. */}
        {noManifest.length > 0 && (
          <Text style={s.muted}>
            Riders could not be loaded for {noManifest.length} {noManifest.length === 1 ? 'run' : 'runs'}, so the figures below may be low.
          </Text>
        )}
        {runs.length > 0 && (
          <View style={s.tiles}>
            {tiles.map((t) => (
              <View
                key={t.key} style={[s.tile, t.alert && s.tileAlert]}
                accessible accessibilityLabel={`${t.label}, ${t.value}${t.alert ? ', needs attention' : ''}`}
              >
                <Text style={[s.tileValue, t.alert && s.tileValueAlert]}>{t.value}</Text>
                <Text style={s.tileLabel} numberOfLines={2}>{t.label}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Targeted instruction (S5.7). Addressed to the selected run, sent as
            an announcement carrying meta.audience — which the server re-checks,
            so this composer cannot address what its sender may not. */}
        {/* The mode switch sits with the thing it changes, not in a menu: an
            operator reaching for it is already in a hurry. */}
        {activeRuns.length > 0 && (
          <TouchableOpacity
            style={[s.emergency, emergency && s.emergencyOn]}
            onPress={() => setEmergency((v) => !v)}
            accessibilityRole="switch"
            accessibilityState={{ checked: emergency }}
            accessibilityLabel="Emergency: address every run on the road at once"
          >
            {/* On-danger ink only on the solid danger fill. */}
            <Ionicons
              name={emergency ? 'warning' : 'warning-outline'}
              size={18}
              color={emergency ? colors.onDanger : colors.danger}
            />
            <Text style={[s.emergencyText, emergency && { color: colors.onDanger }]}>
              {emergency
                ? `Emergency — messages go to all ${activeRuns.length} runs on the road`
                : 'Emergency: address every run at once'}
            </Text>
          </TouchableOpacity>
        )}

        {(focus || emergency) && (
          <View style={s.composer}>
            <Text style={s.muted}>
              {emergency
                ? `Message all ${activeRuns.length} ${activeRuns.length === 1 ? 'run' : 'runs'} on the road`
                : `Message ${runs.find((r) => r.id === focus)?.vehicleLabel || 'this run'}`}
            </Text>
            <View style={s.composerRow}>
              <TextInput
                style={s.input}
                value={instruction}
                onChangeText={(t) => { setInstruction(t); if (unreached) setUnreached(null); }}
                accessibilityLabel={emergency ? 'Instruction to every run on the road' : 'Instruction to this run'}
                placeholder="Instruction to this vehicle…"
                placeholderTextColor={colors.textDim}
                multiline
              />
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Send instruction"
                style={[s.send, (!instruction.trim() || sending) && s.sendOff]}
                onPress={sendInstruction}
                disabled={!instruction.trim() || sending}
                accessibilityState={{ disabled: !instruction.trim() || sending, busy: sending }}
              >
                {/* White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1). */}
                {sending
                  ? <ActivityIndicator size="small" color={colors.onBrand} />
                  : <Ionicons name="send" size={16} color={colors.onBrand} />}
              </TouchableOpacity>
            </View>
            {!!unreached?.length && !sending && (
              <TouchableOpacity
                style={s.retry} onPress={retryRest}
                accessibilityRole="button"
                accessibilityLabel={`Retry the rest: send to the ${unreached.length} ${unreached.length === 1 ? 'run' : 'runs'} not reached`}
              >
                <Ionicons name="refresh" size={16} color={colors.primary} />
                <Text style={{ color: colors.primary, fontWeight: '600' }}>
                  Retry the rest ({unreached.length})
                </Text>
              </TouchableOpacity>
            )}
            <Text style={s.footnote}>
              Goes to {emergency ? 'every driver on the road and the guardians of their riders' : 'this run’s driver and the guardians of its riders'}.
              It is an ordinary encrypted message in this space — addressing it limits who is
              notified and shown it, not who could read it.
            </Text>
          </View>
        )}

        {!loadError && runs.length === 0 && (
          <Text style={s.muted}>No runs are scheduled or in progress.</Text>
        )}
        {runs.map((r) => {
          const p = positions[r.id];
          const prog = progress(manifests[r.id] ?? []);
          const noFix = r.status === 'started' && !p;
          const openRun = () => router.push({ pathname: '/space-run', params: { spaceId, runId: r.id, groupType: params.groupType ?? '', name: params.name ?? '' } });
          return (
            <View key={r.id} style={[s.row, focus === r.id && s.rowFocus]}>
              <TouchableOpacity
                style={s.rowMain}
                onPress={() => setFocus(r.id)}
                onLongPress={openRun}
                accessibilityRole="button"
                accessibilityState={{ selected: focus === r.id }}
                accessibilityLabel={`${r.vehicleLabel || r.name}${r.stale && r.status === 'started' ? ', not reporting' : ''}`}
                accessibilityHint="Selects this run for a message"
                accessibilityActions={[{ name: 'open', label: 'Open run' }]}
                onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'open') openRun(); }}
              >
                <View style={[s.dot, { backgroundColor: dotColour(r, noFix, colors) }]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.rowTitle} numberOfLines={1}>{r.vehicleLabel || r.name}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {r.status !== 'started' ? 'Not started'
                      : noManifest.includes(r.id) ? 'Riders could not be loaded'
                      : `${prog.total - prog.pending}/${prog.total} done${prog.absent ? ` · ${prog.absent} not travelling` : ''}`}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {/* The server's own staleness verdict, which is the one signal
                      that does not depend on this device having listened. */}
                  {r.stale && r.status === 'started' && (
                    <Text style={s.alert}>not reporting</Text>
                  )}
                  {noFix && !r.stale && <Text style={s.muted}>awaiting fix</Text>}
                  {p && <Text style={s.muted}>{ago(p.at)}</Text>}
                </View>
              </TouchableOpacity>
              {/* A visible, tappable way in — long-press alone is undiscoverable.
                  Beside the row, not nested in it, so each is its own target. */}
              <TouchableOpacity
                onPress={openRun} style={s.openBtn}
                accessibilityRole="button" accessibilityLabel={`Open ${r.vehicleLabel || r.name}`}
              >
                <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
              </TouchableOpacity>
            </View>
          );
        })}
        <Text style={s.footnote}>
          Tap a run to message it; tap the arrow to open it. Vehicle positions are relayed end-to-end encrypted;
          the server stores none of them, so this map shows only what has arrived while it has been open.
        </Text>
      </ScrollView>
    </KeyboardSafe>
  );
}

function dotColour(r: Run, noFix: boolean, c: Palette): string {
  if (r.status !== 'started') return c.textFaint;
  if (r.stale) return c.danger;      // the server has not heard from it at all
  if (noFix) return c.warning;       // it is reporting, we just have not received one yet
  return c.success;
}

function ago(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  return mins === 1 ? '1 min ago' : `${mins} min ago`;
}

const styles = (c: Palette) => StyleSheet.create({
  openBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  map: { height: '46%', width: '100%' },
  banner: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    backgroundColor: c.warning + '18', paddingHorizontal: 14, paddingVertical: 10,
  },
  bannerText: { color: c.text, flex: 1, fontSize: 12.5, lineHeight: 17 },
  list: { flex: 1 },
  listBody: { padding: 14, gap: 8, paddingBottom: 30 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: c.glassSoft, borderRadius: 12, paddingRight: 6,
    borderWidth: 1, borderColor: 'transparent',
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowFocus: { borderColor: c.primary },
  dot: { width: 10, height: 10, borderRadius: 5 },
  rowTitle: { color: c.text, fontSize: 15.5, fontWeight: '600' },
  muted: { color: c.textDim, fontSize: 12.5 },
  alert: { color: c.danger, fontSize: 12.5, fontWeight: '600' },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16, marginTop: 6 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  tile: {
    backgroundColor: c.glassSoft, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
    minWidth: 96, flexGrow: 1, borderWidth: 1, borderColor: 'transparent',
  },
  tileAlert: { borderColor: c.danger },
  tileValue: { color: c.text, fontSize: 22, fontWeight: '700' },
  tileValueAlert: { color: c.danger },
  tileLabel: { color: c.textDim, fontSize: 11.5 },
  emergency: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, padding: 12, borderWidth: 1, borderColor: c.danger,
  },
  emergencyOn: { backgroundColor: c.danger, borderColor: c.danger },
  emergencyText: { color: c.danger, fontSize: 13, fontWeight: '600', flex: 1 },
  composer: { backgroundColor: c.glassSoft, borderRadius: 12, padding: 12, gap: 8 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1, color: c.text, borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, maxHeight: 110,
  },
  retry: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    minHeight: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.primary,
  },
  send: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: c.brandOnLight,
    alignItems: 'center', justifyContent: 'center',
  },
  sendOff: { opacity: 0.4 },
});
