// components/spaces/useRunBroadcast.ts — the driver screen's location and
// detection effects, split out of app/space-run-driver.tsx unchanged: the
// heartbeat, the sealed position broadcast with on-vehicle detection, and the
// hand-off to the family background task.

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useFocusEffect } from 'expo-router';
import { pingRun } from '../../lib/spaces/api';
import { publishRunPosition, endRunBroadcast } from '../../lib/spaces/runSession';
import { setBackgroundRun, hasBackgroundPermission } from '../../lib/family/background';
import { ensureKeyDeliveredForRun } from '../../lib/family/presence';
import { feed, newDetectState, detectionText } from '../../lib/spaces/detect';
import { recordAlert, buildFamEvent } from '../../lib/family/alerts';
import { sendMessage } from '../../lib/chatService';
import type { LatLng } from '../../lib/nav/geo';
import type { Run, RunStop } from '../../lib/spaces/runs';

/** Heartbeat cadence. The server calls a run stale after 3 minutes, so a
 *  60s beat survives one lost request without raising a false GPS-offline. */
const PING_MS = 60_000;

export function useRunBroadcast({ spaceId, runId, run, loadedSpaceId, stops, myId }: {
  spaceId: string;
  runId: string;
  run: Run | null;
  /** The space the loaded run belongs to ('' while loading). */
  loadedSpaceId: string;
  stops: RunStop[];
  /** The signed-in driver's id, named as the actor of detection alerts. */
  myId: MutableRefObject<string>;
}): { noLocation: boolean } {
  // Foreground location refused: the bus is invisible to guardians and ops,
  // and the driver must be told rather than left believing it is tracked.
  const [noLocation, setNoLocation] = useState(false);
  // Detection state carries the hysteresis, so it must survive re-renders — a
  // fresh state on every render would re-arm every condition and turn one
  // incident into an alert per fix.
  const detectState = useRef(newDetectState());

  // The "route" a deviation is measured against is the run's own stop sequence.
  // Coarse by construction — see distanceFromStops for why the threshold is
  // wide rather than pretending to road-level precision.
  const routeStops: LatLng[] = useMemo(
    () => stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: s.lat!, lng: s.lng! })),
    [stops],
  );

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
  }, [run?.status, run?.vehicleLabel, run?.name, spaceId, runId, routeStops, myId]));

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

  return { noLocation };
}
