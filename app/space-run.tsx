// app/space-run.tsx — the guardian's and rider's view of a run
// (Spaces & Operations, S2.7, S2.10, S2.13).
//
// A parent opens this to answer one question — where is my child — so that
// answer is the first thing on the screen and everything else is below it.
//
// WHAT THIS SCREEN CAN AND CANNOT SHOW
//
// It shows the riders the SERVER returned, which for a guardian is their own
// child and nobody else's. There is no client-side filter here and there must
// never be one: filtering here would mean the other children's rows had already
// been sent to this device.
//
// The live vehicle position is NOT fetched by this screen. It arrives on the
// sealed live-location socket the space already runs, tagged with the run id —
// the server cannot read it, so there is no endpoint to call. Until this device
// receives such a ping there is no position to draw, and the screen says so
// rather than showing an empty map that reads as "the bus is nowhere".
//
// Arrival is a WINDOW, never a single time. See lib/spaces/runs.ts for why.

import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { Palette } from '../constants/theme';
import { getRun, getRunEvents } from '../lib/spaces/api';
import { subscribeRun, type RunPing } from '../lib/spaces/runSession';
import { haversine, type LatLng } from '../lib/nav/geo';
import { useRoadEta } from '../lib/nav/useRoadEta';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  arrivalWindow, stopsBetween, foldReplay, canDrawPath, isDelayed,
  type Run, type RunStop, type RunRider, type RunEvent, type RiderState, type ReplayEntry,
} from '../lib/spaces/runs';

/**
 * Drive time per stop, used only when no live position has arrived yet.
 *
 * A crude constant and deliberately visible as one. It feeds a window that is
 * already wide, and the honest alternative — showing nothing until a fix
 * arrives — leaves a parent staring at a blank space where the time goes.
 */
const FALLBACK_SECONDS_PER_STOP = 180;

/**
 * Assumed speed when the vehicle reports none, or reports a standstill.
 *
 * 25 km/h: urban with stops. A standstill must NOT be taken literally — a bus
 * at a red light would otherwise produce an infinite ETA, and "arriving never"
 * is worse than a rough guess.
 * ponytail: swap for the Valhalla estimate when the run screen can afford a
 * routing call per fix; the window's width already absorbs this much error.
 */
const ASSUMED_SPEED_MPS = 7;

export default function SpaceRunScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; runId?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');
  const runId = String(params.runId || '');

  const [run, setRun] = useState<Run | null>(null);
  // Server's per-space setting; isDelayed's own default (10) is only a
  // fallback for the instant before the first load answers — otherwise the
  // on-screen badge could disagree with the server's own "running late" push,
  // which fires on this same threshold (spaces_ops.go shiftSet).
  const [delayThresholdMin, setDelayThresholdMin] = useState<number | undefined>(undefined);
  const [stops, setStops] = useState<RunStop[]>([]);
  const [riders, setRiders] = useState<RunRider[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  // The vehicle's latest sealed position, and the trail this device has actually
  // received. The trail is what makes a path drawable — there is no server-side
  // copy to fall back on, so a device that was not listening has no path and
  // says so.
  const [vehicle, setVehicle] = useState<RunPing | null>(null);
  const [trail, setTrail] = useState<LatLng[]>([]);
  const breadcrumbs = trail.length;

  const load = useCallback(async () => {
    try {
      const data = await getRun(spaceId, runId);
      setRun(data.run);
      setStops(data.stops || []);
      setRiders(data.riders || []);
      setDelayThresholdMin(data.delayThresholdMinutes);
    } catch (e: any) {
      Alert.alert('Could not load the run', e?.message ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  }, [spaceId, runId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Watch the vehicle (S2.8). The subscription is a REQUEST: the server admits
  // this socket to the run's room only if this user may see the run. So "no
  // pings ever arrived" is a legitimate outcome, and the card below says that
  // rather than rendering an empty map.
  useFocusEffect(useCallback(() => {
    if (!spaceId || !runId || run?.status !== 'started') return;
    let stop: (() => void) | null = null;
    let live = true;
    (async () => {
      const me = await getCurrentUserAsync().catch(() => null);
      if (!live) return;
      stop = await subscribeRun(spaceId, runId, String((me as any)?.id ?? ''), (e) => {
        if (!e.ping) { setVehicle(null); return; }
        setVehicle(e.ping);
        // Bounded: a two-hour run at one fix per ten seconds is 720 points, and
        // a parent looking at a phone needs the shape, not every metre.
        setTrail((t) => [...t, { lat: e.ping!.lat, lng: e.ping!.lng }].slice(-300));
      });
    })();
    return () => { live = false; stop?.(); };
  }, [spaceId, runId, run?.status]));

  const openHistory = useCallback(async () => {
    setShowHistory(true);
    if (events.length) return;
    try {
      setEvents(await getRunEvents(spaceId, runId));
    } catch (e: any) {
      Alert.alert('Could not load the history', e?.message ?? 'Try again.');
    }
  }, [events.length, spaceId, runId]);

  /** Name lookup for the timeline. Only riders the server sent us are named. */
  const nameOf = useCallback(
    (riderId: string) => riders.find((r) => r.riderId === riderId)?.displayName ?? null,
    [riders],
  );

  const timeline: ReplayEntry[] = useMemo(
    () => foldReplay(events, nameOf), [events, nameOf],
  );

  /** The stop the vehicle has most recently reached, by arrival marks. */
  const reachedStopId = useMemo(() => {
    const done = [...stops].filter((s) => s.arrivedAt).sort((a, b) => a.seq - b.seq);
    return done.length ? done[done.length - 1].id : (stops.length ? [...stops].sort((a, b) => a.seq - b.seq)[0].id : null);
  }, [stops]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
        <Stack.Screen options={spaceHeader(colors, 'Run')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!run) {
    return (
      <View style={[s.screen, s.centre]}>
        <Stack.Screen options={spaceHeader(colors, 'Run')} />
        <Text style={s.muted}>This run is not available.</Text>
      </View>
    );
  }

  const active = run.status === 'started';

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.body}>
      <Stack.Screen options={spaceHeader(colors, run.name)} />

      {/* the answer to the only question that matters, first */}
      {riders.map((r) => (
        <RiderCard
          key={r.riderId}
          rider={r}
          run={run}
          stops={stops}
          reachedStopId={reachedStopId}
          vehicle={vehicle}
          colors={colors}
          delayThresholdMin={delayThresholdMin}
        />
      ))}
      {riders.length === 0 && (
        <View style={s.card}>
          <Text style={s.muted}>Nobody you can see is on this run.</Text>
        </View>
      )}

      {/* vehicle */}
      <View style={s.card}>
        <Text style={s.cardTitle}>{run.vehicleLabel || 'Vehicle'}</Text>
        <Row icon="ellipse" label="Status" value={statusLabel(run)} colors={colors} />
        {run.stale && active && (
          <View style={s.warn}>
            <Ionicons name="cloud-offline-outline" size={16} color="#F59E0B" />
            <Text style={s.warnText}>
              This vehicle has stopped reporting. Its last known position may be out of date.
            </Text>
          </View>
        )}
        {!active && (
          <Text style={s.muted}>
            {run.status === 'scheduled' ? 'This run has not started yet.' : 'This run has finished.'}
          </Text>
        )}
      </View>

      {/* live position — absent, and said so */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Live position</Text>
        {vehicle ? (
          <>
            <View style={s.row}>
              <Ionicons name="navigate" size={18} color={colors.success} />
              <Text style={s.muted}>Last update {ago(vehicle.at)}</Text>
            </View>
            {vehicle.speed != null && vehicle.speed > 1 && (
              <Text style={s.muted}>Moving at about {Math.round(vehicle.speed * 3.6)} km/h</Text>
            )}
            <Text style={s.footnote}>
              {breadcrumbs} position {breadcrumbs === 1 ? 'update' : 'updates'} received on this device.
              Positions are end-to-end encrypted and are not stored on the server.
            </Text>
          </>
        ) : (
          <View style={s.row}>
            <Ionicons name="location-outline" size={18} color={colors.textDim} />
            <Text style={s.muted}>
              {active
                ? 'Waiting for the vehicle’s first position update. Positions are end-to-end encrypted, so they arrive on this device directly — nothing is stored on the server.'
                : 'No live position: the run is not active.'}
            </Text>
          </View>
        )}
      </View>

      {/* stops */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Route</Text>
        {[...stops].sort((a, b) => a.seq - b.seq).map((st) => (
          <View key={st.id} style={s.stopRow}>
            <Ionicons
              name={st.arrivedAt ? 'checkmark-circle' : 'ellipse-outline'}
              size={18}
              color={st.arrivedAt ? colors.success : colors.textDim}
            />
            <Text style={[s.stopText, st.arrivedAt && s.stopDone]}>{st.label}</Text>
            {st.plannedAt && <Text style={s.muted}>{clock(st.plannedAt)}</Text>}
          </View>
        ))}
        {stops.length === 0 && <Text style={s.muted}>No stops have been set for this run.</Text>}
      </View>

      {/* history */}
      <TouchableOpacity style={s.card} onPress={openHistory} disabled={showHistory}>
        <View style={s.row}>
          <Ionicons name="time-outline" size={18} color={colors.text} />
          <Text style={s.cardTitle}>What happened</Text>
        </View>
        {!showHistory && <Text style={s.muted}>Tap to load the timeline.</Text>}
        {showHistory && timeline.length === 0 && <Text style={s.muted}>Nothing recorded yet.</Text>}
        {showHistory && timeline.map((t, i) => (
          <View key={`${t.at}-${i}`} style={s.stopRow}>
            <Text style={s.timeCell}>{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
            <Text style={s.stopText}>{t.label}</Text>
          </View>
        ))}
        {showHistory && !canDrawPath(breadcrumbs) && timeline.length > 0 && (
          <Text style={s.footnote}>
            Road-by-road replay is not available: this device did not receive the vehicle’s
            encrypted position updates during the run, and the server keeps no copy.
          </Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

function RiderCard({ rider, run, stops, reachedStopId, vehicle, colors, delayThresholdMin }: {
  rider: RunRider; run: Run; stops: RunStop[]; reachedStopId: string | null;
  vehicle: RunPing | null; colors: Palette;
  /** The space's server-side threshold, once loaded — undefined only for the
   *  instant before the first getRun answers, when isDelayed's own default
   *  (10) is the honest fallback. */
  delayThresholdMin?: number;
}) {
  const s = styles(colors);
  const now = Date.now();
  const between = stopsBetween(stops, reachedStopId, rider.stopId);
  const myStop = stops.find((x) => x.id === rider.stopId);

  // BY ROAD, because a bus is. Straight-line distance over an assumed speed is
  // wrong in the direction that hurts: no road is ever shorter than the line
  // between its ends, so the estimate always says the vehicle is nearer and
  // sooner than it is, and a rider told "arriving now" walks out and waits. A
  // bus 2km away across a railway line can be 5km of driving.
  //
  // The router's own duration is preferred over distance/speed even when both
  // are available: it prices road classes and turns instead of assuming one
  // speed for a whole city.
  const road = useRoadEta(
    vehicle ? { lat: vehicle.lat, lng: vehicle.lng } : null,
    myStop?.lat != null && myStop?.lng != null ? { lat: myStop.lat, lng: myStop.lng } : null,
  );

  // Falls back to a per-stop constant only while no fix has arrived — and the
  // window's width is what makes either honest.
  let etaSeconds = between * FALLBACK_SECONDS_PER_STOP;
  if (road && road.durationS > 0) {
    etaSeconds = road.durationS;
  } else if (vehicle && myStop?.lat != null && myStop?.lng != null) {
    // No road answer yet (or the router is down): the straight line divided by
    // a speed is still better than a per-stop constant, and it is what was
    // shown before routing existed.
    const metres = road?.distanceM
      ?? haversine({ lat: vehicle.lat, lng: vehicle.lng }, { lat: myStop.lat, lng: myStop.lng });
    const speed = vehicle.speed && vehicle.speed > 1 ? vehicle.speed : ASSUMED_SPEED_MPS;
    etaSeconds = metres / speed;
  }
  const win = arrivalWindow(now, etaSeconds, between);
  const waiting = rider.state === 'pending' && run.status === 'started';
  // delayThresholdMin undefined (first instant before load) → isDelayed's own
  // default (10) applies, same as before this fix.
  const late = waiting && isDelayed(myStop?.plannedAt ?? null, win.latest, delayThresholdMin);

  return (
    <View style={[s.card, s.hero]}>
      <Text style={s.heroName}>{rider.displayName}</Text>
      <Text style={s.heroState}>{riderHeadline(rider.state, run)}</Text>

      {waiting && (
        <>
          <Text style={s.window}>
            {between === 0 ? 'Arriving now' : `Between ${clockMs(win.earliest)} and ${clockMs(win.latest)}`}
          </Text>
          <Text style={s.muted}>
            {myStop ? `at ${myStop.label}` : 'at the first stop'}
            {between > 0 ? ` · ${between} ${between === 1 ? 'stop' : 'stops'} away` : ''}
          </Text>
          {late && (
            <View style={s.warn}>
              <Ionicons name="alert-circle-outline" size={16} color="#F59E0B" />
              <Text style={s.warnText}>Running behind the scheduled time.</Text>
            </View>
          )}
        </>
      )}

      {rider.stateAt && rider.state !== 'pending' && (
        <Text style={s.muted}>{clock(rider.stateAt)}</Text>
      )}
    </View>
  );
}

function Row({ icon, label, value, colors }: { icon: any; label: string; value: string; colors: Palette }) {
  const s = styles(colors);
  return (
    <View style={s.row}>
      <Ionicons name={icon} size={14} color={colors.textDim} />
      <Text style={s.muted}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

function riderHeadline(state: RiderState, run: Run): string {
  switch (state) {
    case 'boarded': return run.kind === 'school_pickup' ? 'On board, on the way to school' : 'On board';
    case 'dropped': return 'Dropped off';
    case 'absent': return 'Was not at the stop';
    case 'no_show': return 'Did not travel today';
    case 'cancelled': return 'Not travelling on this run';
    default: return run.status === 'started' ? 'Waiting to be picked up' : 'Expected on this run';
  }
}

function statusLabel(run: Run): string {
  switch (run.status) {
    case 'scheduled': return 'Not started';
    case 'started': return run.stale ? 'On the road (not reporting)' : 'On the road';
    case 'completed': return 'Finished';
    case 'cancelled': return 'Cancelled';
    default: return run.status;
  }
}

/** "just now" / "3 min ago" — a stale fix must look stale. */
function ago(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const clockMs = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 16, gap: 8 },
  hero: { borderWidth: 1, borderColor: c.border },
  heroName: { color: c.text, fontSize: 24, fontWeight: '700' },
  heroState: { color: c.text, fontSize: 16 },
  window: { color: c.primary, fontSize: 20, fontWeight: '700', marginTop: 4 },
  cardTitle: { color: c.text, fontSize: 16, fontWeight: '600' },
  muted: { color: c.textDim, fontSize: 14, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowValue: { color: c.text, marginLeft: 'auto', fontWeight: '600' },
  stopRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  stopText: { color: c.text, flex: 1 },
  stopDone: { color: c.textDim },
  timeCell: { color: c.textDim, width: 54, fontVariant: ['tabular-nums'] },
  warn: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    backgroundColor: '#F59E0B18', borderRadius: 10, padding: 10, marginTop: 4,
  },
  warnText: { color: c.text, flex: 1, fontSize: 13 },
  footnote: { color: c.textFaint, fontSize: 12, marginTop: 8, lineHeight: 17 },
});
