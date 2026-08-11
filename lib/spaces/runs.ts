// lib/spaces/runs.ts — the pure half of the run engine's client
// (Spaces & Operations, S2).
//
// Everything a run screen has to REASON about lives here: which stop the driver
// is working, who is expected at it, when a rider's stop will be reached, and
// what a finished run looked like. The screens themselves stay dumb.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/spaces/runs.ts

export type RunKind = 'school_pickup' | 'school_drop' | 'cab_pickup' | 'cab_drop' | 'generic';
export type RunStatus = 'scheduled' | 'started' | 'completed' | 'cancelled';
export type RiderState = 'pending' | 'boarded' | 'dropped' | 'absent' | 'no_show' | 'cancelled';

export interface Run {
  id: string;
  kind: RunKind;
  name: string;
  driverId: string | null;
  vehicleLabel: string | null;
  scheduledAt: string | null;
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  requireCode: boolean;
  /** Server-derived: an active run whose device has stopped reporting. */
  stale: boolean;
}

export interface RunStop {
  id: string;
  seq: number;
  label: string;
  lat: number | null;
  lng: number | null;
  plannedAt: string | null;
  arrivedAt: string | null;
}

export interface RunRider {
  riderId: string;
  stopId: string | null;
  state: RiderState;
  stateAt: string | null;
  note: string | null;
  displayName: string;
}

export interface RunEvent {
  id: number;
  kind: string;
  refId: string | null;
  actorId: string | null;
  at: string;
  detail: Record<string, any> | null;
}

/** A rider still expected: not yet dealt with, one way or the other. */
export function isPending(r: RunRider): boolean {
  return r.state === 'pending';
}

/** A rider the driver has finished with, however that went. */
export function isSettled(r: RunRider): boolean {
  return r.state !== 'pending';
}

/**
 * The stop the driver is working right now: the first in sequence that still
 * has a pending rider.
 *
 * Deliberately NOT "the first stop with no arrivedAt". A driver who reaches a
 * stop and finds nobody there marks the riders absent and drives on; the stop
 * is done even though nothing was collected. Pending riders are what is left to
 * do, so pending riders are what defines where we are.
 *
 * Returns null when every rider is settled — the run is finished in substance,
 * whatever its status column says.
 */
export function nextStop(stops: RunStop[], riders: RunRider[]): RunStop | null {
  const ordered = [...stops].sort((a, b) => a.seq - b.seq);
  for (const s of ordered) {
    if (riders.some((r) => r.stopId === s.id && isPending(r))) return s;
  }
  // Riders with no stop assigned still have to be dealt with; put them at the
  // first stop rather than stranding them off the end of the list where the
  // driver never sees them.
  if (riders.some((r) => !r.stopId && isPending(r))) return ordered[0] ?? null;
  return null;
}

/** Riders expected at one stop, settled ones last, then by name. */
export function ridersAtStop(riders: RunRider[], stopId: string | null): RunRider[] {
  const at = riders.filter((r) => (r.stopId ?? null) === (stopId ?? null));
  return at.sort((a, b) => {
    if (isPending(a) !== isPending(b)) return isPending(a) ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

export interface RunProgress {
  total: number;
  pending: number;
  boarded: number;
  dropped: number;
  absent: number;
  /** Settled / total, 0..1. 1 when there is nothing to do, including no riders. */
  fraction: number;
}

export function progress(riders: RunRider[]): RunProgress {
  const count = (s: RiderState) => riders.filter((r) => r.state === s).length;
  const total = riders.length;
  const pending = count('pending');
  return {
    total,
    pending,
    boarded: count('boarded'),
    dropped: count('dropped'),
    // no_show and absent are the same fact to a progress bar: nobody got on.
    absent: count('absent') + count('no_show'),
    fraction: total === 0 ? 1 : (total - pending) / total,
  };
}

/**
 * An arrival WINDOW, not a time.
 *
 * A single ETA on a school run is a promise the road cannot keep, and a parent
 * who is told 08:12 and sees 08:19 stops trusting the number. So the estimate
 * widens with everything that makes it uncertain:
 *
 *   - each intervening stop adds dwell time AND dwell VARIANCE (how long a
 *     child takes to get on a bus is the least predictable part of the trip)
 *   - the window never claims to be tighter than ±1 minute
 *
 * `etaSeconds` is whatever the routing engine says for the drive itself; this
 * function only turns one number into an honest range. Returns epoch ms.
 */
export function arrivalWindow(
  nowMs: number,
  etaSeconds: number,
  interveningStops: number,
  dwellSecondsPerStop = 45,
): { earliest: number; latest: number } {
  const stops = Math.max(0, interveningStops);
  const dwell = stops * dwellSecondsPerStop;
  const centre = nowMs + (Math.max(0, etaSeconds) + dwell) * 1000;
  // Variance grows with the square root of the stop count, not linearly: delays
  // at successive stops are partly independent and partly cancel out, so a
  // 16-stop route is not 16× as uncertain as a 1-stop one.
  const spreadSec = 60 + Math.sqrt(stops) * dwellSecondsPerStop;
  return {
    earliest: Math.max(nowMs, centre - spreadSec * 1000),
    latest: centre + spreadSec * 1000,
  };
}

/** How many stops sit between the vehicle's current stop and a rider's stop. */
export function stopsBetween(stops: RunStop[], fromStopId: string | null, toStopId: string | null): number {
  const ordered = [...stops].sort((a, b) => a.seq - b.seq);
  const i = ordered.findIndex((s) => s.id === fromStopId);
  const j = ordered.findIndex((s) => s.id === toStopId);
  if (i < 0 || j < 0) return 0;
  return Math.max(0, j - i);
}

/**
 * Is the run late enough to say so?
 *
 * Thresholded on purpose. A run that is ninety seconds behind is a run, not an
 * incident, and a delay notification for every one of them trains people to
 * ignore the next one that matters.
 */
export function isDelayed(plannedAt: string | null, expectedMs: number, thresholdMinutes = 10): boolean {
  if (!plannedAt) return false;
  const planned = Date.parse(plannedAt);
  if (!Number.isFinite(planned)) return false;
  return expectedMs - planned > thresholdMinutes * 60_000;
}

export interface ReplayEntry {
  at: number;
  kind: string;
  label: string;
  refId: string | null;
  actorId: string | null;
}

/**
 * Fold the event log into a human timeline.
 *
 * Names are resolved from a lookup the CALLER supplies, because a rider the
 * viewer may not see must not be named — the server already withheld that row,
 * and the timeline must not reintroduce it from an id. Unknown ids become
 * "Someone", never the raw uuid.
 */
export function foldReplay(
  events: RunEvent[],
  nameOf: (riderId: string) => string | null,
): ReplayEntry[] {
  const out: ReplayEntry[] = [];
  for (const e of events) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    const who = e.refId ? nameOf(e.refId) ?? 'Someone' : null;
    let label: string;
    switch (e.kind) {
      case 'run_created':   label = 'Run created'; break;
      case 'run_started':   label = 'Run started'; break;
      case 'run_completed': label = 'Run completed'; break;
      case 'run_cancelled': label = 'Run cancelled'; break;
      case 'driver_changed': label = 'Driver changed'; break;
      case 'stop_arrived':  label = 'Arrived at stop'; break;
      case 'incident_filed': label = `Incident reported${e.detail?.category ? ` (${e.detail.category})` : ''}`; break;
      case 'rider_boarded': label = `${who} boarded`; break;
      case 'rider_dropped': label = `${who} dropped off`; break;
      case 'rider_absent':  label = `${who} not present`; break;
      case 'rider_no_show': label = `${who} did not travel`; break;
      default:              label = e.kind.replace(/_/g, ' ');
    }
    out.push({ at, kind: e.kind, label, refId: e.refId, actorId: e.actorId });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Can this device draw the road path for a replay?
 *
 * Only if it actually received the sealed position stream while the run was
 * happening. There is no server-side path to fall back on, and interpolating a
 * straight line between stops would be inventing a journey. The screens use
 * this to SAY the path is unavailable rather than quietly showing a timeline
 * and letting the absence of a map read as "nothing to show".
 */
export function canDrawPath(breadcrumbCount: number): boolean {
  return breadcrumbCount >= 2;
}

/** A transition id that survives a retry on a moving bus. */
export function newTransitionId(runId: string, riderId: string, state: string, nowMs: number): string {
  // Deterministic within a second, so a double-tap and an automatic retry of
  // the same tap collapse to one server-side transition. Not random: random
  // would make every retry a NEW transition, which is the bug this prevents.
  return `${runId}:${riderId}:${state}:${Math.floor(nowMs / 1000)}`;
}

// ── self-check ──
if (require.main === module) {
  const stop = (id: string, seq: number): RunStop =>
    ({ id, seq, label: `Stop ${seq}`, lat: null, lng: null, plannedAt: null, arrivedAt: null });
  const rider = (id: string, stopId: string | null, state: RiderState, name = id): RunRider =>
    ({ riderId: id, stopId, state, stateAt: null, note: null, displayName: name });

  const stops = [stop('s2', 1), stop('s1', 0), stop('s3', 2)];

  // next stop follows PENDING riders, not arrival marks
  let riders = [rider('a', 's1', 'boarded'), rider('b', 's2', 'pending'), rider('c', 's3', 'pending')];
  if (nextStop(stops, riders)?.id !== 's2') throw new Error('next stop should be the first with a pending rider');

  // a stop where everyone was absent is DONE — the driver dealt with it
  riders = [rider('a', 's1', 'absent'), rider('b', 's2', 'pending')];
  if (nextStop(stops, riders)?.id !== 's2') throw new Error('an all-absent stop is finished');

  // nothing pending → no next stop
  if (nextStop(stops, [rider('a', 's1', 'dropped')]) !== null) throw new Error('settled run has no next stop');

  // a rider with no stop must not be stranded off the end of the route
  if (nextStop(stops, [rider('x', null, 'pending')])?.id !== 's1') throw new Error('unassigned rider goes to the first stop');

  // empty run
  if (nextStop([], []) !== null) throw new Error('empty run has no next stop');

  // riders at a stop: pending first, then alphabetical
  const at = ridersAtStop([
    rider('c', 's1', 'boarded', 'Cara'), rider('b', 's1', 'pending', 'Bob'),
    rider('a', 's1', 'pending', 'Ann'), rider('z', 's2', 'pending', 'Zed'),
  ], 's1');
  if (at.map((r) => r.displayName).join(',') !== 'Ann,Bob,Cara') throw new Error(`ordering wrong: ${at.map((r) => r.displayName)}`);

  // progress
  const p = progress([
    rider('a', 's1', 'boarded'), rider('b', 's1', 'pending'),
    rider('c', 's1', 'absent'), rider('d', 's1', 'no_show'),
  ]);
  if (p.total !== 4 || p.pending !== 1 || p.boarded !== 1 || p.absent !== 2) throw new Error('progress counts wrong');
  if (Math.abs(p.fraction - 0.75) > 1e-9) throw new Error('progress fraction wrong');
  if (progress([]).fraction !== 1) throw new Error('an empty manifest is complete, not stalled');

  // arrival window: a range, never a point, and never in the past
  const now = 1_700_000_000_000;
  const w0 = arrivalWindow(now, 300, 0);
  if (!(w0.latest > w0.earliest)) throw new Error('window must have width');
  if (w0.earliest < now) throw new Error('window must not start in the past');
  const w5 = arrivalWindow(now, 300, 5);
  if (!(w5.latest - w5.earliest > w0.latest - w0.earliest)) throw new Error('more stops must widen the window');
  if (!(w5.latest > w0.latest)) throw new Error('more stops must push the estimate later');
  // sub-linear: 16 stops is not 16x the spread of 1
  const w1 = arrivalWindow(now, 0, 1), w16 = arrivalWindow(now, 0, 16);
  const s1 = w1.latest - w1.earliest, s16 = w16.latest - w16.earliest;
  if (s16 >= s1 * 16) throw new Error('uncertainty should grow sub-linearly');
  // a negative eta from a confused router must not produce a window in the past
  if (arrivalWindow(now, -500, 0).earliest < now) throw new Error('negative eta must clamp');

  // stops between
  if (stopsBetween(stops, 's1', 's3') !== 2) throw new Error('stopsBetween wrong');
  if (stopsBetween(stops, 's3', 's1') !== 0) throw new Error('backwards is zero, not negative');
  if (stopsBetween(stops, 'nope', 's1') !== 0) throw new Error('unknown stop is zero');

  // delay threshold
  const planned = new Date(now).toISOString();
  if (isDelayed(planned, now + 5 * 60_000)) throw new Error('5 minutes is not a delay at a 10 minute threshold');
  if (!isDelayed(planned, now + 11 * 60_000)) throw new Error('11 minutes is a delay');
  if (isDelayed(null, now + 60 * 60_000)) throw new Error('no planned time means no delay claim');
  if (isDelayed('not a date', now)) throw new Error('unparseable planned time must not claim a delay');

  // replay fold: sorted, named through the lookup, unknown ids anonymised
  const names: Record<string, string> = { r1: 'Ada' };
  const replay = foldReplay([
    { id: 2, kind: 'rider_boarded', refId: 'r1', actorId: 'd', at: new Date(now + 1000).toISOString(), detail: null },
    { id: 1, kind: 'run_started', refId: null, actorId: 'd', at: new Date(now).toISOString(), detail: null },
    { id: 3, kind: 'rider_dropped', refId: 'secret', actorId: 'd', at: new Date(now + 2000).toISOString(), detail: null },
  ], (id) => names[id] ?? null);
  if (replay.map((r) => r.kind).join(',') !== 'run_started,rider_boarded,rider_dropped') throw new Error('replay not sorted');
  if (replay[1].label !== 'Ada boarded') throw new Error('replay should name known riders');
  if (!replay[2].label.startsWith('Someone')) throw new Error('an unseeable rider must not be named');
  if (replay[2].label.includes('secret')) throw new Error('a raw id must never reach the timeline');
  if (foldReplay([{ id: 9, kind: 'x', refId: null, actorId: null, at: 'nonsense', detail: null }], () => null).length !== 0) {
    throw new Error('unparseable timestamps must be dropped, not rendered');
  }

  // path availability is honest about having no data
  if (canDrawPath(0) || canDrawPath(1)) throw new Error('one breadcrumb is not a path');
  if (!canDrawPath(2)) throw new Error('two breadcrumbs is a path');

  // transition ids collapse retries within the same second
  const t1 = newTransitionId('run', 'kid', 'boarded', now);
  const t2 = newTransitionId('run', 'kid', 'boarded', now + 200);
  const t3 = newTransitionId('run', 'kid', 'boarded', now + 1500);
  if (t1 !== t2) throw new Error('a retry within the same second must reuse the transition id');
  if (t1 === t3) throw new Error('a genuinely later action must be a new transition');

  console.log('spaces/runs self-check OK');
}
