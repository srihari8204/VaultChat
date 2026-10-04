// app/space-run-driver.tsx — the driver's screen (Spaces & Operations, S2.6).
//
// This screen is deliberately the smallest one in the app. A driver looks at it
// at a kerb, with the engine running and a queue of children behind them, so it
// shows ONE stop, the people expected there, and two buttons.
//
// WHAT IS NOT HERE, ON PURPOSE
// No dashboard, no other routes, no space-wide anything. That is not a styling
// choice: the server scopes a driver to their own runs (RLS policy plus the
// route predicate in spaces_runs.go), so this screen could not show the rest of
// the school even if someone added a tab for it.
//
// RETRIES ARE THE NORMAL CASE, NOT THE EDGE
// A bus is a moving faraday cage. Every state change carries a transitionId
// derived from (run, rider, state, second) — so a double-tap, an impatient
// retry and an automatic replay all collapse into ONE server-side transition.
// The optimistic update is applied immediately and reconciled from the server's
// `applied` flag, because a driver cannot wait for a round trip before turning
// to the next child.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  Alert, TextInput, Modal,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getRun, setRiderState, setRunStatus, pingRun, fileIncident, arriveAtStop,
} from '../lib/spaces/api';
import { publishRunPosition, endRunBroadcast } from '../lib/spaces/runSession';
import { setBackgroundRun, hasBackgroundPermission } from '../lib/family/background';
import { ensureKeyDeliveredForRun } from '../lib/family/presence';
import { feed, newDetectState, detectionText } from '../lib/spaces/detect';
import { recordAlert, buildFamEvent } from '../lib/family/alerts';
import { sendMessage, createDirectChat } from '../lib/chatService';
import { Sheet, type SheetAction } from '../components/ui/Sheet';
import { getCurrentUserAsync } from './(constants)/authService';
import type { LatLng } from '../lib/nav/geo';
import {
  driverView, progress, newTransitionId,
  type Run, type RunStop, type RunRider, type RiderState,
} from '../lib/spaces/runs';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import LoadError from '../components/spaces/LoadError';

/** Heartbeat cadence. The server calls a run stale after 3 minutes, so a
 *  60s beat survives one lost request without raising a false GPS-offline. */
const PING_MS = 60_000;

const INCIDENTS: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'breakdown', label: 'Breakdown', icon: 'construct-outline' },
  { key: 'accident', label: 'Accident', icon: 'warning-outline' },
  { key: 'route_blocked', label: 'Road blocked', icon: 'remove-circle-outline' },
  { key: 'medical', label: 'Medical', icon: 'medkit-outline' },
  { key: 'other', label: 'Something else', icon: 'ellipsis-horizontal' },
];

export default function SpaceRunDriverScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; runId?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const spaceId = String(params.spaceId || '');
  const runId = String(params.runId || '');

  const [run, setRun] = useState<Run | null>(null);
  const [loadedSpaceId, setLoadedSpaceId] = useState('');
  const [stops, setStops] = useState<RunStop[]>([]);
  const [riders, setRiders] = useState<RunRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Foreground location refused: the bus is invisible to guardians and ops,
  // and the driver must be told rather than left believing it is tracked.
  const [noLocation, setNoLocation] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<{ rider: RunRider; state: RiderState } | null>(null);
  const [code, setCode] = useState('');
  const [incidentOpen, setIncidentOpen] = useState(false);
  // Detection state carries the hysteresis, so it must survive re-renders — a
  // fresh state on every render would re-arm every condition and turn one
  // incident into an alert per fix.
  const detectState = useRef(newDetectState());
  const myId = useRef('');

  useEffect(() => {
    getCurrentUserAsync().then((u: { id?: string | number } | null) => { myId.current = String(u?.id ?? ''); }).catch(() => {});
  }, []);

  // The "route" a deviation is measured against is the run's own stop sequence.
  // Coarse by construction — see distanceFromStops for why the threshold is
  // wide rather than pretending to road-level precision.
  const routeStops: LatLng[] = useMemo(
    () => stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: s.lat!, lng: s.lng! })),
    [stops],
  );

  const load = useCallback(async () => {
    setLoadedSpaceId('');
    try {
      const data = await getRun(spaceId, runId);
      setRun(data.run);
      setLoadedSpaceId(spaceId);
      setStops(data.stops || []);
      setRiders(data.riders || []);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? 'Could not load the run.');
    } finally {
      setLoading(false);
    }
  }, [spaceId, runId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  useFocusEffect(useCallback(() => {
    // Heartbeat only while the screen is open and the run is out. Pinging a
    // scheduled or finished run would be claiming a bus is on the road.
    if (!spaceId.trim() || !runId.trim() || loadedSpaceId !== spaceId
      || run?.id !== runId || run.status !== 'started') return;
    const timer = setInterval(() => {
      pingRun(spaceId, runId).catch(() => { /* the gap IS the signal; nothing to do here */ });
    }, PING_MS);
    return () => clearInterval(timer);
  }, [spaceId, runId, loadedSpaceId, run?.id, run?.status]));

  // Broadcast this vehicle's position while the run is out (S2.8).
  //
  // Sealed with the driver's existing presence key, so this publishes nothing a
  // driver who is sharing location was not already sharing — and publishes
  // NOTHING AT ALL if they are not sharing, rather than silently falling back to
  // plaintext. It stops the moment the run does.
  useFocusEffect(useCallback(() => {
    if (run?.status !== 'started') return;
    let live = true;
    let sub: { remove: () => void } | null = null;
    // Whether the background task will actually keep broadcasting after this
    // screen blurs — it needs "Allow all the time", a separate and rarer grant
    // than the foreground permission this effect itself checks. Read once per
    // mount so the cleanup below (synchronous, no await) can act on it.
    let willContinueInBackground = false;
    (async () => {
      const Location = await import('expo-location');
      const { status } = await Location.getForegroundPermissionsAsync();
      if (!live) return;
      setNoLocation(status !== 'granted');
      if (status !== 'granted') return;
      willContinueInBackground = await hasBackgroundPermission();
      if (!live) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 10_000, distanceInterval: 25 },
        (loc) => {
          const fix = {
            pos: { lat: loc.coords.latitude, lng: loc.coords.longitude },
            speed: loc.coords.speed ?? undefined,
            accuracy: loc.coords.accuracy ?? undefined,
            at: Date.now(),
          };
          publishRunPosition(spaceId, runId, fix.pos,
            { speed: fix.speed, accuracy: fix.accuracy },
          ).catch(() => { /* one lost fix is not worth an alert to a driving driver */ });

          // Detection runs HERE, on the vehicle, because the server cannot read
          // a position and is not going to be given one (S5.4). The alert that
          // leaves this device reports the FACT and never a coordinate.
          for (const d of feed(detectState.current, fix, routeStops)) {
            const alert = {
              kind: d.kind === 'overspeed' ? 'overspeed' as const : d.kind === 'longstop' ? 'longstop' as const : 'deviation' as const,
              actorId: myId.current,
              actorName: run?.vehicleLabel || run?.name || 'Vehicle',
              text: detectionText(d, run?.vehicleLabel || run?.name || 'The vehicle'),
            };
            recordAlert({ circleId: spaceId, ...alert }).then((rec) => {
              // Then to everyone in the space, sealed, on the same famEvent
              // path geofence crossings use (S5.4): the space's E2EE thread, so
              // the server relays it without reading it, and every member's
              // alert inbox folds it in (app/_layout.tsx ingestFamEvent).
              // Only when it was not a local duplicate, so one condition is one
              // message. meta.silent: chat surfaces hide it; the inbox is its
              // surface. Never carries a coordinate (detectionText).
              if (rec && alert.actorId) {
                sendMessage(spaceId, buildFamEvent({ ...alert, at: rec.at }), 'system', { meta: { silent: true } })
                  .catch(() => { /* the local alert stands; a lost fix-time alert is not retried */ });
              }
            }).catch(() => {});
          }
        },
      );
    })();
    return () => {
      live = false;
      sub?.remove();
      // Blur is NOT the end of the run for a driver whose background task will
      // keep broadcasting — sending run_end here used to tell every watcher
      // the bus stopped reporting while the background task (below) was about
      // to keep it alive. But a driver who never granted "Allow all the time"
      // has NO background task at all: without this, the bus freezes at its
      // last position and is presented as live for the rest of the run, with
      // no gap indicator. Restore the honest signal for exactly that cohort.
      if (!willContinueInBackground) endRunBroadcast(spaceId, runId).catch(() => {});
    };
  }, [run?.status, run?.vehicleLabel, run?.name, spaceId, runId, routeStops]));

  // Keep the vehicle broadcasting from a pocket: hand the started run to the
  // family background task (same persisted presence key seals its pings), and
  // take it back when the run is no longer out. Keyed on status so a run
  // started on ANOTHER device — or resumed after a process restart — is picked
  // up the moment this screen learns about it.
  useEffect(() => {
    if (run?.status === 'started') {
      setBackgroundRun({ spaceId, runId }).catch(() => {});
      // The key that opens this run's pings must reach the space even if the
      // driver's personal presence privacy for it is off/invisible — see
      // ensureKeyDeliveredForRun for why the bypass is deliberate.
      ensureKeyDeliveredForRun(spaceId).catch(() => {});
    } else if (run) {
      // Name the run being cleared — a single persisted slot must not let
      // opening a DIFFERENT run's driver screen kill an unrelated live
      // broadcast (see setBackgroundRun).
      setBackgroundRun(null, runId).catch(() => {});
    }
    // Only status (plus the route's own spaceId/runId) drives this effect —
    // the body reads no other field of `run`, so depending on the whole
    // object rewrote the identical K_RUN value to storage on every poll. The
    // closure's `run` is never stale relative to `run?.status`: whenever the
    // status changes, this effect runs on THAT SAME render's `run`, and the
    // body only ever checks its truthiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status, spaceId, runId]);

  // The stop being worked and everyone markable there — including riders with
  // no stop, who used to be routed to the first stop and then filtered out.
  const view = useMemo(() => driverView(stops, riders), [stops, riders]);
  const current = view?.stop ?? null;

  const [arriving, setArriving] = useState(false);
  const onArrive = async (stop: RunStop) => {
    setArriving(true);
    try {
      const res = await arriveAtStop(spaceId, runId, stop.id);
      // Reflect it locally rather than refetching the whole run: a driver at a
      // kerb should see this land immediately, not after a round trip.
      setStops((ss) => ss.map((x) => (x.id === stop.id ? { ...x, arrivedAt: res.arrivedAt } : x)));
    } catch (e: any) {
      Alert.alert('Could not record arrival', e?.message ?? 'Please try again.');
    } finally {
      setArriving(false);
    }
  };
  const here = view?.riders ?? [];
  const prog = useMemo(() => progress(riders), [riders]);
  const started = run?.status === 'started';

  const apply = useCallback(async (rider: RunRider, state: RiderState, verifyCode?: string) => {
    if (!run) return;
    const transitionId = newTransitionId(runId, rider.riderId, state, Date.now());
    const before = riders;
    setBusy(rider.riderId);
    // Optimistic: the driver is already looking at the next child.
    setRiders((rs) => rs.map((r) => (r.riderId === rider.riderId
      ? { ...r, state, stateAt: new Date().toISOString() } : r)));
    try {
      await setRiderState(spaceId, runId, rider.riderId, { state, transitionId, code: verifyCode });
    } catch (e: any) {
      setRiders(before); // put it back — a wrong manifest is worse than a slow one
      Alert.alert('Not recorded', e?.message ?? 'Try again.');
    } finally {
      setBusy(null);
    }
  }, [run, riders, runId, spaceId]);

  const onMark = useCallback((rider: RunRider, state: RiderState) => {
    // Handover verification is server-enforced; asking here is just so the
    // driver is not surprised by a 403 at the kerb.
    if (run?.requireCode && (state === 'boarded' || state === 'dropped')) {
      setCode('');
      setCodeFor({ rider, state });
      return;
    }
    apply(rider, state);
  }, [run, apply]);

  // Calling a guardian. runGet gives the ASSIGNED DRIVER each rider's
  // guardians; a call needs the direct chat with them, opened (or created) the
  // same way space-transport calls a driver.
  const [guardianSheet, setGuardianSheet] = useState<{ title: string; actions: SheetAction[] } | null>(null);
  const [calling, setCalling] = useState<string | null>(null);
  const callGuardian = useCallback(async (g: { userId: string; displayName: string }) => {
    if (calling) return;
    setCalling(g.userId);
    try {
      const chat = await createDirectChat({ userId: g.userId });
      router.push({ pathname: '/voicecall', params: { chatId: chat.id, peerUid: g.userId, peerName: g.displayName } });
    } catch (e: any) {
      Alert.alert('Could not start the call', e?.message ?? 'Check your connection and try again.');
    } finally { setCalling(null); }
  }, [calling, router]);
  const callParent = useCallback((rider: RunRider) => {
    const gs = rider.guardians;
    if (!gs) {
      // An older server does not send guardians, so there is nobody to dial.
      Alert.alert(
        'Call guardian',
        'Guardian contacts are not shared with drivers on this server yet. Call your transport office, '
        + 'or use “Report a problem” so they can reach the family.',
      );
      return;
    }
    if (gs.length === 1) { void callGuardian(gs[0]); return; }
    setGuardianSheet({
      title: `Call ${rider.displayName}’s guardian`,
      actions: gs.map((g) => ({ label: g.displayName, icon: 'call-outline', onPress: () => { setGuardianSheet(null); void callGuardian(g); } })),
    });
  }, [callGuardian]);

  // The panic control (S5.6). Deliberately NOT one of the incident categories:
  // an incident is a form you fill in, and a driver in trouble is not filling in
  // a form. One confirmation to survive a pocket press, then it goes at the
  // highest severity the alert model has.
  const onPanic = useCallback(() => {
    setIncidentOpen(false);
    Alert.alert(
      'Send an emergency alert?',
      'Everyone running this space is alerted immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send alert',
          style: 'destructive',
          onPress: () => {
            const vehicle = run?.vehicleLabel || run?.name || 'A vehicle';
            // Local alert first — it is what the driver's own device shows and
            // it must not depend on the network.
            recordAlert({
              circleId: spaceId,
              kind: 'sos',
              actorId: myId.current,
              actorName: vehicle,
              text: `${vehicle}: emergency alert from the driver`,
            }).catch(() => {});
            // Then the durable record, which is what reaches the office. Filed
            // as an incident so it lands in the same queue ops already watches
            // rather than a channel nobody has open — but under its OWN
            // category, so it arrives with its own wording and its own
            // notification channel instead of looking like a blocked road.
            // A failed send offers the retry right there: a driver in trouble
            // must not have to find the panic control again.
            // ponytail: not queued across app restarts; retry is one tap while
            // the screen is open. Replace with the outbox once incidents have one.
            const send = () => fileIncident(spaceId, { category: 'sos', runId, note: '' })
              .then(() => Alert.alert('Alert sent', 'The office has been alerted.'))
              .catch(() => Alert.alert(
                'Alert not sent yet',
                'It is raised on this device, but the office has not received it. Try again when you have signal.',
                [{ text: 'Later', style: 'cancel' }, { text: 'Try again', onPress: () => { void send(); } }],
              ));
            void send();
          },
        },
      ],
    );
  }, [run?.vehicleLabel, run?.name, spaceId, runId]);

  const onIncident = useCallback(async (category: string) => {
    setIncidentOpen(false);
    try {
      await fileIncident(spaceId, { category, runId });
      Alert.alert('Reported', 'The transport office has been notified.');
    } catch (e: any) {
      Alert.alert('Could not report', e?.message ?? 'Try again.');
    }
  }, [spaceId, runId]);

  const doStatus = useCallback(async (next: 'started' | 'completed') => {
    try {
      await setRunStatus(spaceId, runId, next);
      if (next === 'completed') {
        // The real end of the broadcast — blur no longer sends this.
        endRunBroadcast(spaceId, runId).catch(() => {});
        setBackgroundRun(null).catch(() => {});
      }
      await load();
    } catch (e: any) {
      // The server owns the lifecycle (trigger in migration 086), so an invalid
      // transition comes back as a 409 with a reason rather than being guessed
      // at here.
      Alert.alert('Could not update the run', e?.message ?? 'Try again.');
    }
  }, [spaceId, runId, load]);

  const onStartStop = useCallback(async () => {
    if (!run) return;
    const next = started ? 'completed' : 'started';
    // Finishing with people unmarked is allowed — a driver must be able to end a
    // run — but it is said out loud, because "unmarked" is what a missing child
    // looks like in the record.
    if (next === 'completed' && prog.pending > 0) {
      Alert.alert(
        'Finish the run?',
        `${prog.pending} ${prog.pending === 1 ? 'person is' : 'people are'} still unmarked. ` +
        'They will stay unmarked in the record.',
        [{ text: 'Keep going', style: 'cancel' }, { text: 'Finish', style: 'destructive', onPress: () => doStatus(next) }],
      );
      return;
    }
    doStatus(next);
  }, [run, started, prog.pending, doStatus]);

  const s = useMemo(() => styles(colors), [colors]);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Run')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!run) {
    return (
      <View style={[s.screen, s.centre, { padding: 16 }]}>
        <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Run')} />
        {loadError
          ? <LoadError colors={colors} title="Could not load the run" message={loadError} onRetry={() => { setLoading(true); void load(); }} />
          : <Text style={s.muted}>This run is not available.</Text>}
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={spaceHeader(colors, run.name)} />

      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={s.vehicle}>{run.vehicleLabel || run.name}</Text>
          <Text style={s.muted}>
            {prog.total - prog.pending} of {prog.total} done
            {prog.absent > 0 ? ` · ${prog.absent} not travelling` : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={[s.runBtn, started ? s.runBtnStop : s.runBtnGo]}
          onPress={onStartStop}
          accessibilityRole="button"
          accessibilityLabel={started ? 'Finish run' : 'Start run'}
        >
          {/* Finish: on-danger ink. Start: white on the solid brandOnLight fill
              (deep blue in both schemes, 6.3:1). */}
          <Text style={[s.runBtnText, started && { color: colors.onDanger }]}>{started ? 'Finish' : 'Start'}</Text>
        </TouchableOpacity>
      </View>

      <View style={s.progressTrack}>
        <View style={[s.progressFill, { width: `${Math.round(prog.fraction * 100)}%` }]} />
      </View>

      <ScrollView contentContainerStyle={[s.body, { paddingBottom: 90 + insets.bottom }]}>
        {!started && (
          <View style={s.notice}>
            <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
            <Text style={s.noticeText}>Start the run to mark people on and off.</Text>
          </View>
        )}

        {loadError && (
          <LoadError colors={colors} title="Could not refresh the run" message={loadError} onRetry={() => { void load(); }} />
        )}
        {started && noLocation && (
          <View style={s.notice}>
            <Ionicons name="location-outline" size={18} color={colors.warning} />
            <Text style={s.noticeText}>
              Location is off for VaultChat, so guardians and the office cannot see this vehicle.
              Allow location in Settings to share it.
            </Text>
          </View>
        )}

        {view ? (
          <>
            {current ? (
              <>
                <Text style={s.stopLabel}>{current.arrivedAt ? 'AT THIS STOP' : 'NEXT STOP'}</Text>
                <Text style={s.stopName}>{current.label}</Text>
              </>
            ) : (
              // No stops on this run: one list of everybody, no arrival step.
              <Text style={s.stopLabel}>EVERYONE ON THIS RUN</Text>
            )}

            {/* ARRIVED — the step before any pickup, and the one that matters to
                a parent, because it is the moment to be at the kerb. Announcing
                only "picked up" tells them after the fact.

                It stays available once tapped rather than disappearing: the
                server keeps the first arrival time, so a second tap is harmless
                and a driver who is unsure whether it registered can just tap
                again. Hiding it would leave them with no way to find out. */}
            {started && current && (
              <TouchableOpacity
                style={[s.arriveBtn, current.arrivedAt && s.arriveBtnDone]}
                onPress={() => onArrive(current)}
                disabled={arriving}
                accessibilityRole="button"
                accessibilityState={{ disabled: arriving, busy: arriving }}
              >
                {/* White ink on the solid brandOnLight fill until arrived. */}
                <Ionicons
                  name={current.arrivedAt ? 'checkmark-circle' : 'location'}
                  size={18}
                  color={current.arrivedAt ? colors.success : colors.onBrand}
                />
                <Text style={[s.arriveText, current.arrivedAt && { color: colors.success }]}>
                  {arriving ? 'Telling everyone…'
                    : current.arrivedAt
                      ? `Arrived ${new Date(current.arrivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : 'I have arrived'}
                </Text>
              </TouchableOpacity>
            )}

            {here.map((r) => (
              <View key={r.riderId} style={[s.rider, r.state !== 'pending' && s.riderDone]}>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={s.riderName}>{r.displayName}</Text>
                  {r.state !== 'pending' && <Text style={s.riderState}>{stateLabel(r.state)}</Text>}
                </View>

                {r.state === 'pending' && started ? (
                  <View style={s.actions}>
                    {/* Hidden when the server says nobody is linked ([]); shown with
                        an honest explanation when it cannot say (older server). */}
                    {(!r.guardians || r.guardians.length > 0) && (
                      <TouchableOpacity
                        style={s.iconBtn} onPress={() => callParent(r)} disabled={!!calling}
                        accessibilityRole="button" accessibilityLabel={`Call ${r.displayName}’s guardian`}
                        accessibilityState={{ disabled: !!calling, busy: !!calling }}
                      >
                        {calling && r.guardians?.some((g) => g.userId === calling)
                          ? <ActivityIndicator size="small" color={colors.primary} />
                          : <Ionicons name="call-outline" size={20} color={colors.primary} />}
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[s.actionBtn, s.absentBtn]}
                      onPress={() => onMark(r, 'absent')}
                      disabled={busy === r.riderId}
                      accessibilityRole="button"
                      accessibilityLabel={`${r.displayName} is not here`}
                      accessibilityState={{ disabled: busy === r.riderId }}
                    >
                      <Text style={s.absentText}>Not here</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.actionBtn, s.boardBtn]}
                      onPress={() => onMark(r, isDropRun(run) ? 'dropped' : 'boarded')}
                      disabled={busy === r.riderId}
                      accessibilityRole="button"
                      accessibilityLabel={`${r.displayName} ${isDropRun(run) ? 'dropped off' : 'on board'}`}
                      accessibilityState={{ disabled: busy === r.riderId, busy: busy === r.riderId }}
                    >
                      {busy === r.riderId
                        ? <ActivityIndicator size="small" color={colors.onBrand} />
                        : <Text style={s.boardText}>{isDropRun(run) ? 'Dropped' : 'On board'}</Text>}
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Ionicons
                    name={r.state === 'pending' ? 'time-outline' : settledIcon(r.state)}
                    size={22}
                    color={r.state === 'pending' ? colors.textDim : settledColour(r.state, colors)}
                  />
                )}
              </View>
            ))}

            {here.length === 0 && <Text style={s.muted}>Nobody is expected at this stop.</Text>}
          </>
        ) : (
          <View style={s.done}>
            <Ionicons name="checkmark-circle" size={44} color={colors.success} />
            <Text style={s.doneText}>Everyone has been marked.</Text>
            {started && <Text style={s.muted}>Tap Finish to close the run.</Text>}
          </View>
        )}
      </ScrollView>

      <TouchableOpacity style={[s.incidentBar, { bottom: 20 + insets.bottom }]} onPress={() => setIncidentOpen(true)} accessibilityRole="button">
        <Ionicons name="alert-circle-outline" size={20} color={colors.danger} />
        <Text style={s.incidentText}>Report a problem</Text>
      </TouchableOpacity>

      {/* handover code */}
      <Modal visible={!!codeFor} transparent animationType="fade" onRequestClose={() => setCodeFor(null)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Handover code</Text>
            <Text style={s.muted}>Ask the guardian for {codeFor?.rider.displayName}’s code.</Text>
            <TextInput
              accessibilityLabel={`Handover code for ${codeFor?.rider.displayName ?? 'this rider'}`}
              style={s.codeInput}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={8}
              autoFocus
              placeholder="0000"
              placeholderTextColor={colors.textDim}
            />
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setCodeFor(null)} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.boardBtn, !code.trim() && { opacity: 0.4 }]}
                onPress={() => { const c = codeFor; setCodeFor(null); if (c) apply(c.rider, c.state, code.trim()); }}
                disabled={!code.trim()}
                accessibilityRole="button" accessibilityLabel="Confirm handover code"
                accessibilityState={{ disabled: !code.trim() }}
              >
                <Text style={s.boardText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>

      {/* incident */}
      <Modal visible={incidentOpen} transparent animationType="slide" onRequestClose={() => setIncidentOpen(false)}>
        <View style={s.sheetWrap}>
          <View style={[s.sheet, { paddingBottom: 18 + insets.bottom }]}>
            <Text style={s.modalTitle} accessibilityRole="header">Report a problem</Text>
            <TouchableOpacity style={[s.sheetRow, s.panicRow]} onPress={onPanic} accessibilityRole="button">
              <Ionicons name="alert-circle" size={22} color={colors.onDanger} />
              <Text style={[s.sheetText, { color: colors.onDanger, fontWeight: '700' }]}>Emergency — alert everyone now</Text>
            </TouchableOpacity>
            {INCIDENTS.map((i) => (
              <TouchableOpacity key={i.key} style={s.sheetRow} onPress={() => onIncident(i.key)} accessibilityRole="button">
                <Ionicons name={i.icon} size={20} color={colors.text} />
                <Text style={s.sheetText}>{i.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.sheetRow} onPress={() => setIncidentOpen(false)} accessibilityRole="button">
              <Ionicons name="close" size={20} color={colors.textDim} />
              <Text style={[s.sheetText, { color: colors.textDim }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Sheet
        visible={!!guardianSheet} title={guardianSheet?.title}
        actions={guardianSheet?.actions ?? []} onClose={() => setGuardianSheet(null)}
      />
    </View>
  );
}

/** An afternoon route drops people off; the button must say what it does. */
function isDropRun(run: Run): boolean {
  return run.kind === 'school_drop' || run.kind === 'cab_drop';
}

function stateLabel(s: RiderState): string {
  switch (s) {
    case 'boarded': return 'On board';
    case 'dropped': return 'Dropped off';
    case 'absent': return 'Not present';
    case 'no_show': return 'Did not travel';
    case 'cancelled': return 'Cancelled';
    default: return '';
  }
}

function settledIcon(s: RiderState): keyof typeof Ionicons.glyphMap {
  return s === 'absent' || s === 'no_show' ? 'close-circle' : 'checkmark-circle';
}

function settledColour(s: RiderState, colors: Palette): string {
  // Amber, not red: a child who was not at the stop is a fact to follow up, not
  // a failure. Red is reserved for incidents.
  return s === 'absent' || s === 'no_show' ? colors.warning : colors.success;
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  vehicle: { fontSize: 22, fontWeight: '700', color: c.text },
  muted: { color: c.textDim, fontSize: 14 },
  runBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, minHeight: 44, justifyContent: 'center' },
  runBtnGo: { backgroundColor: c.brandOnLight },
  runBtnStop: { backgroundColor: c.danger },
  runBtnText: { color: c.onBrand, fontWeight: '700', fontSize: 16 },
  progressTrack: { height: 4, backgroundColor: c.border, marginHorizontal: 16, borderRadius: 2 },
  progressFill: { height: 4, backgroundColor: c.brandOnLight, borderRadius: 2 },
  body: { padding: 16, paddingBottom: 90, gap: 10 },
  notice: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: 10, backgroundColor: c.glassSoft },
  noticeText: { color: c.text, flex: 1 },
  stopLabel: { color: c.textDim, fontSize: 12, letterSpacing: 1, marginTop: 4 },
  stopName: { color: c.text, fontSize: 26, fontWeight: '700', marginBottom: 8 },
  // Rows are tall on purpose: this is tapped one-handed, at a kerb.
  rider: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, minHeight: 68,
  },
  riderDone: { opacity: 0.6 },
  riderName: { color: c.text, fontSize: 18, fontWeight: '600' },
  riderState: { color: c.textDim, fontSize: 13, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  actionBtn: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, minWidth: 84, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  absentBtn: { backgroundColor: c.border },
  arriveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.brandOnLight, borderRadius: 12, paddingVertical: 14, marginBottom: 12,
  },
  arriveBtnDone: { backgroundColor: c.success + '18' },
  arriveText: { color: c.onBrand, fontWeight: '800', fontSize: 15 },
  absentText: { color: c.text, fontWeight: '600' },
  boardBtn: { backgroundColor: c.brandOnLight },
  boardText: { color: c.onBrand, fontWeight: '700' },
  done: { alignItems: 'center', gap: 8, paddingVertical: 40 },
  doneText: { color: c.text, fontSize: 18, fontWeight: '600' },
  incidentBar: {
    position: 'absolute', left: 16, right: 16, bottom: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    // surfaceSolid: this floats OVER the scrolling manifest, and the dusk
    // skin's translucent card let rider rows bleed through the button.
    paddingVertical: 14, borderRadius: 12, backgroundColor: c.surfaceSolid,
    borderWidth: 1, borderColor: c.danger,
  },
  incidentText: { color: c.danger, fontWeight: '600' },
  // Fixed dark scrims behind the dialog and sheet, the same in both schemes.
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  codeInput: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 14,
    fontSize: 24, letterSpacing: 6, textAlign: 'center', color: c.text,
  },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  sheetWrap: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, gap: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16 },
  // Visually separated from the categories below it: this is not one more thing
  // to choose from a list, it is the one that stops everything else.
  panicRow: {
    backgroundColor: c.danger, borderRadius: 12, paddingHorizontal: 14,
    marginBottom: 6, minHeight: 60,
  },
  sheetText: { color: c.text, fontSize: 16 },
});
