// lib/lock/lockEngine.ts — the one fix-processing pipeline both halves share.
//
// The foreground service (lib/lock/lockService.ts) and the headless background
// task (lib/lock/background.ts) receive GPS fixes from different OS paths, but
// the meaning of a fix must be identical in both: same zone machine, same
// aggregate accounting, same persistence. advanceActiveLock is the pure step;
// persistAdvance writes its outcome (events + aggregate deltas + the refreshed
// ActiveLock blob) so a kill at any point resumes from the last accepted fix.

import { haversine, type LatLng } from '../nav/geo';
import { stepZone, DEFAULT_ZONE_CONFIG, type ZoneEvent, type ZoneFix } from './zoneMachine';
import {
  addEvent, bumpAggregates, saveActiveLock, type ActiveLock,
} from './lockStore';

export interface AdvanceDeltas {
  insideMs: number;
  outsideMs: number;
  traveled: number;      // metres moved since the previous accepted fix
  maxDistance: number;   // raw distance of this fix (MAX-merged in SQL)
}

export interface AdvanceResult {
  next: ActiveLock;
  events: ZoneEvent[];
  accepted: boolean;
  deltas: AdvanceDeltas;
}

/** Pure step: apply one fix to the active lock. No I/O. */
export function advanceActiveLock(a: ActiveLock, fix: ZoneFix): AdvanceResult {
  const step = stepZone(a.snap, fix, { center: a.center, radius: a.radius }, DEFAULT_ZONE_CONFIG);
  if (!step.accepted || fix.t <= a.snap.t) {
    // Rejected by the accuracy gate — or already processed (the foreground
    // watcher and the background task can both deliver the same fix).
    return { next: a, events: [], accepted: false, deltas: { insideMs: 0, outsideMs: 0, traveled: 0, maxDistance: 0 } };
  }

  const dt = Math.max(0, fix.t - a.snap.t);
  const wasOutside = a.snap.state === 'outside';
  const deltas: AdvanceDeltas = {
    insideMs: wasOutside ? 0 : dt,
    outsideMs: wasOutside ? dt : 0,
    traveled: a.lastPos ? haversine(a.lastPos, fix.pos) : 0,
    maxDistance: step.snap.rawDistance,
  };

  let graceUntil = a.graceUntil;
  let alarmSilenced = a.alarmSilenced;
  for (const ev of step.events) {
    if (ev === 'exit') graceUntil = fix.t + Math.max(0, Math.min(60, a.alerts.graceS)) * 1000;
    if (ev === 'return') { graceUntil = null; alarmSilenced = false; }
  }

  return {
    next: { ...a, snap: step.snap, lastPos: fix.pos, graceUntil, alarmSilenced },
    events: step.events,
    accepted: true,
    deltas,
  };
}

/** Persist one accepted step: event rows, aggregate deltas, active-lock blob. */
export async function persistAdvance(r: AdvanceResult): Promise<void> {
  if (!r.accepted) return;
  const a = r.next;
  await saveActiveLock(a);
  await bumpAggregates(a.sessionId, {
    insideMs: r.deltas.insideMs,
    outsideMs: r.deltas.outsideMs,
    traveled: r.deltas.traveled,
    maxDistance: r.deltas.maxDistance,
  });
  for (const ev of r.events) {
    if (ev === 'exit') await bumpAggregates(a.sessionId, { exits: 1 });
    if (ev === 'return') await bumpAggregates(a.sessionId, { returns: 1 });
    await addEvent(
      a.sessionId,
      ev === 'enterWarning' ? 'warning' : ev,
      a.snap.t,
      a.snap.rawDistance,
    );
  }
}

/** Convert an expo-location LocationObject into a ZoneFix. */
export function toZoneFix(loc: {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  timestamp?: number;
}): ZoneFix {
  return {
    pos: { lat: loc.coords.latitude, lng: loc.coords.longitude } as LatLng,
    accuracy: loc.coords.accuracy ?? 15,
    t: loc.timestamp || Date.now(),
  };
}

export default {};
