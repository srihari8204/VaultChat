// lib/groups/trips.ts — group trips: shared destination, ETA fan-out,
// deviation and arrival (Groups & Circles, G5).
//
// A trip is EPHEMERAL. It is live or it is over, and nobody wants last
// Tuesday's convoy in a table, so trip state rides the same sealed socket relay
// that presence already uses rather than getting a schema. The server relays
// ciphertext and learns nothing about where anyone is going.
//
// EACH DEVICE COMPUTES ITS OWN ETA. The alternative — send positions somewhere
// and have it work out arrival times — would need a service that can read every
// participant's location, which is the exact thing this product refuses to
// build. So a phone routes itself, derives its own ETA, and shares that one
// number sealed. An ETA is a far smaller disclosure than a track.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/trips.ts

import { haversine, crossTrackDistance, type LatLng } from '../nav/geo';

/** How far off the shared route counts as a deviation worth telling people. */
export const DEVIATION_M = 150;
/** Within this of the destination is "arrived". */
export const ARRIVAL_M = 80;
/** A participant whose last update is older than this has gone quiet. */
export const STALE_MS = 120_000;
/** Below this speed we will not pretend to know an ETA. */
export const MIN_SPEED_MPS = 0.5;

export type TripStatus = 'travelling' | 'arrived' | 'deviated' | 'stale';

/** What one participant publishes about themselves. Sealed before it leaves. */
export interface TripPing {
  userId: string;
  /** Metres still to travel along their own route. */
  remainingM: number;
  /** Current speed in m/s, if known. */
  speed?: number;
  /** Their own ETA in epoch ms, computed on their device. */
  etaAt: number | null;
  arrived: boolean;
  /** Distance from the shared route, if the trip has one. */
  offRouteM?: number;
  /**
   * Follow-the-leader: the leader's route, so followers measure deviation
   * against the agreed road rather than against whatever each phone routed for
   * itself. Only ever set by the leader, and only periodically — it is coarse
   * and bounded, not a full-fidelity polyline.
   */
  route?: LatLng[];
  at: number;
}

export interface Participant extends TripPing {
  name: string;
  status: TripStatus;
}

export interface Trip {
  id: string;
  groupId: string;
  destination: LatLng;
  destinationName: string;
  startedBy: string;
  startedAt: number;
  /** Follow-the-leader: everyone navigates this member's route. */
  leaderId: string | null;
}

/**
 * ETA from remaining distance and speed.
 *
 * Returns null rather than a guess when we cannot know: no speed, stopped, or a
 * nonsense distance. A calendar can shrug at a missing value; a convoy watching
 * for someone cannot, and an invented ETA is worse than an honest blank.
 */
export function estimateEta(remainingM: number, speedMps: number | undefined, now: number): number | null {
  if (!Number.isFinite(remainingM) || remainingM < 0) return null;
  if (speedMps == null || !Number.isFinite(speedMps) || speedMps < MIN_SPEED_MPS) return null;
  return now + Math.round((remainingM / speedMps) * 1000);
}

/** Has this participant reached the destination? */
export function hasArrived(pos: LatLng, destination: LatLng): boolean {
  return haversine(pos, destination) <= ARRIVAL_M;
}

/**
 * How far a position sits from the nearest leg of the shared route.
 *
 * Measured against the WHOLE route, not just the next leg: a member who
 * rejoined further along is on the route, and flagging them as deviating
 * because they skipped a leg would be a false alarm.
 */
export function distanceFromRoute(pos: LatLng, shape: LatLng[]): number {
  if (shape.length === 0) return Infinity;
  if (shape.length === 1) return haversine(pos, shape[0]);
  let best = Infinity;
  for (let i = 1; i < shape.length; i++) {
    const d = Math.abs(crossTrackDistance(pos, shape[i - 1], shape[i]));
    if (d < best) best = d;
  }
  return best;
}

export function isDeviating(offRouteM: number | undefined): boolean {
  return offRouteM != null && Number.isFinite(offRouteM) && offRouteM > DEVIATION_M;
}

/**
 * Classify a participant. Order matters: arrival beats everything (someone who
 * got there by another road has still arrived, and calling that a deviation
 * would be absurd), and staleness beats deviation because an old off-route
 * reading says nothing about where they are now.
 */
export function statusOf(p: TripPing, now: number): TripStatus {
  if (p.arrived) return 'arrived';
  if (now - p.at > STALE_MS) return 'stale';
  if (isDeviating(p.offRouteM)) return 'deviated';
  return 'travelling';
}

/**
 * Fold the latest ping per participant into a display list.
 *
 * Only the NEWEST ping per person survives — trips are about where someone is
 * now, not where they have been, so an out-of-order delivery must never move
 * anyone backwards.
 */
export function foldParticipants(
  pings: TripPing[],
  names: Record<string, string>,
  now: number,
): Participant[] {
  const latest = new Map<string, TripPing>();
  for (const p of pings) {
    const cur = latest.get(p.userId);
    if (!cur || p.at > cur.at) latest.set(p.userId, p);
  }
  return [...latest.values()]
    .map((p) => ({ ...p, name: names[p.userId] ?? 'Member', status: statusOf(p, now) }))
    .sort((a, b) => {
      // Arrived last: the interesting people are the ones still moving.
      if ((a.status === 'arrived') !== (b.status === 'arrived')) return a.status === 'arrived' ? 1 : -1;
      // Then soonest ETA first, unknowns after the known.
      if (a.etaAt !== b.etaAt) {
        if (a.etaAt == null) return 1;
        if (b.etaAt == null) return -1;
        return a.etaAt - b.etaAt;
      }
      return a.name.localeCompare(b.name);
    });
}

/** The last participant expected to arrive — when the convoy is complete. */
export function lastEta(list: Participant[]): number | null {
  let last: number | null = null;
  for (const p of list) {
    if (p.status === 'arrived') continue;
    if (p.etaAt == null) return null;   // one unknown makes the whole answer unknown
    if (last == null || p.etaAt > last) last = p.etaAt;
  }
  return last;
}

export function everyoneArrived(list: Participant[]): boolean {
  return list.length > 0 && list.every((p) => p.status === 'arrived');
}

/** Minutes until an ETA, floored at zero. */
/** Points kept when a leader shares its route. Enough to measure against. */
export const ROUTE_MAX_POINTS = 120;

/**
 * Reduce a route to at most `max` points by even sampling, always keeping the
 * first and last.
 *
 * Even sampling rather than Douglas-Peucker: this only has to be good enough to
 * measure cross-track distance against, and an even sample cannot drop a whole
 * limb of the route the way an aggressive tolerance can. Losing a limb would
 * report every member travelling along it as off-route — a false alarm about
 * the one thing the group is watching for.
 */
export function simplifyRoute(shape: LatLng[], max: number = ROUTE_MAX_POINTS): LatLng[] {
  if (max < 2) return shape.length ? [shape[0]] : [];
  if (shape.length <= max) return shape;
  const out: LatLng[] = [];
  const step = (shape.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(shape[Math.round(i * step)]);
  // Rounding can land the last sample short of the end; the destination end of
  // a route is exactly where deviation matters most.
  out[out.length - 1] = shape[shape.length - 1];
  return out;
}

export function minutesUntil(etaAt: number, now: number): number {
  return Math.max(0, Math.round((etaAt - now) / 60000));
}

/**
 * A trip announcement older than this is over, whether or not anyone said so.
 *
 * Announcements are harvested from group message HISTORY, and history has no
 * expiry — without a TTL, yesterday's convoy re-appears as an active trip on
 * every fresh subscribe until 60 newer messages push it out of the window.
 */
export const TRIP_TTL_MS = 8 * 3600_000;

/**
 * Is a harvested trip still the group's live trip?
 *
 * `endedIds` are trip ids an end-marker was seen for (same history harvest).
 * An explicit end beats everything; the TTL catches the trip nobody ended.
 */
export function tripLive(t: Trip, endedIds: Iterable<string>, now: number): boolean {
  for (const id of endedIds) if (id === t.id) return false;
  return now - t.startedAt <= TRIP_TTL_MS;
}

// ── self-check ──
if (require.main === module) {
  const now = 1_700_000_000_000;
  const ping = (o: Partial<TripPing>): TripPing =>
    ({ userId: 'u', remainingM: 1000, speed: 10, etaAt: now + 100_000, arrived: false, at: now, ...o });

  // 1. ETA maths
  if (estimateEta(1000, 10, now) !== now + 100_000) throw new Error('1000m at 10m/s is 100s');
  // …and refuses to guess rather than inventing a number
  if (estimateEta(1000, undefined, now) !== null) throw new Error('no speed must give no ETA');
  if (estimateEta(1000, 0, now) !== null) throw new Error('stopped must give no ETA');
  if (estimateEta(1000, 0.1, now) !== null) throw new Error('crawling must give no ETA');
  if (estimateEta(-5, 10, now) !== null) throw new Error('negative distance must give no ETA');
  if (estimateEta(NaN, 10, now) !== null) throw new Error('NaN distance must give no ETA');
  if (estimateEta(0, 10, now) !== now) throw new Error('zero distance is now');

  // 2. arrival
  const dest = { lat: 12.9716, lng: 77.5946 };
  if (!hasArrived(dest, dest)) throw new Error('at the destination is arrived');
  if (hasArrived({ lat: 12.9800, lng: 77.5946 }, dest)) throw new Error('900m away is not arrived');

  // 3. distance from a route, measured against the WHOLE shape
  const shape: LatLng[] = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }];
  if (distanceFromRoute({ lat: 0, lng: 0.5 }, shape) > 5) throw new Error('a point on the first leg is on-route');
  // a point on the LAST leg is also on-route, even though it skipped ahead
  if (distanceFromRoute({ lat: 0.5, lng: 1 }, shape) > 5) throw new Error('a point on a later leg must not read as deviating');
  if (distanceFromRoute({ lat: 0, lng: 0 }, []) !== Infinity) throw new Error('no shape means unknown');

  // 4. deviation threshold
  if (isDeviating(undefined)) throw new Error('unknown offset is not a deviation');
  if (isDeviating(DEVIATION_M)) throw new Error('exactly at the threshold is not over it');
  if (!isDeviating(DEVIATION_M + 1)) throw new Error('past the threshold deviates');
  if (isDeviating(Infinity as any) !== false) throw new Error('a non-finite offset must not raise a false alarm');

  // 5. status precedence
  if (statusOf(ping({ arrived: true, offRouteM: 9999, at: now - 999_999 }), now) !== 'arrived') {
    throw new Error('arrival must beat both staleness and deviation');
  }
  if (statusOf(ping({ at: now - 999_999, offRouteM: 9999 }), now) !== 'stale') {
    throw new Error('staleness must beat deviation — an old reading says nothing about now');
  }
  if (statusOf(ping({ offRouteM: 500 }), now) !== 'deviated') throw new Error('off route deviates');
  if (statusOf(ping({}), now) !== 'travelling') throw new Error('normal is travelling');

  // 6. only the NEWEST ping per person counts
  const folded = foldParticipants([
    ping({ userId: 'a', at: now, remainingM: 500 }),
    ping({ userId: 'a', at: now - 60_000, remainingM: 9000 }),  // older, arrives late
  ], { a: 'Ann' }, now);
  if (folded.length !== 1) throw new Error('one person, one row');
  if (folded[0].remainingM !== 500) throw new Error('an older ping must not move someone backwards');
  if (folded[0].name !== 'Ann') throw new Error('names should resolve');

  // 7. ordering: still-moving before arrived, soonest ETA first, unknown last
  const order = foldParticipants([
    ping({ userId: 'arr', arrived: true, etaAt: now }),
    ping({ userId: 'slow', etaAt: now + 900_000 }),
    ping({ userId: 'unknown', etaAt: null }),
    ping({ userId: 'soon', etaAt: now + 60_000 }),
  ], {}, now).map((p) => p.userId);
  if (order.join(',') !== 'soon,slow,unknown,arr') throw new Error('ordering wrong: ' + order);

  // 8. the convoy is only done when everyone is in
  const mixed = foldParticipants([
    ping({ userId: 'a', arrived: true }), ping({ userId: 'b' }),
  ], {}, now);
  if (everyoneArrived(mixed)) throw new Error('one still travelling means not done');
  if (!everyoneArrived(foldParticipants([ping({ userId: 'a', arrived: true })], {}, now))) {
    throw new Error('all arrived means done');
  }
  if (everyoneArrived([])) throw new Error('an empty trip has not "arrived"');

  // 9. the convoy ETA is the LAST arrival, and one unknown makes it unknown
  if (lastEta(foldParticipants([
    ping({ userId: 'a', etaAt: now + 60_000 }), ping({ userId: 'b', etaAt: now + 300_000 }),
  ], {}, now)) !== now + 300_000) throw new Error('convoy ETA should be the slowest');
  if (lastEta(foldParticipants([
    ping({ userId: 'a', etaAt: now + 60_000 }), ping({ userId: 'b', etaAt: null }),
  ], {}, now)) !== null) throw new Error('one unknown ETA makes the convoy ETA unknown');
  // people already there do not hold the convoy ETA back
  if (lastEta(foldParticipants([
    ping({ userId: 'a', arrived: true, etaAt: null }), ping({ userId: 'b', etaAt: now + 60_000 }),
  ], {}, now)) !== now + 60_000) throw new Error('arrived members must not block the convoy ETA');

  // 10. minutes
  if (minutesUntil(now + 90_000, now) !== 2) throw new Error('90s rounds to 2 minutes');
  if (minutesUntil(now - 60_000, now) !== 0) throw new Error('a passed ETA floors at zero');

  // 11. trip liveness — a harvested announcement must not resurrect last
  //     week's convoy. Ended beats age; age alone also ends it.
  const t = (startedAt: number): Trip => ({
    id: 'trip_x', groupId: 'g', destination: dest, destinationName: 'Cafe',
    startedBy: 'a', startedAt, leaderId: null,
  });
  if (!tripLive(t(now - 60_000), [], now)) throw new Error('a fresh trip is live');
  if (tripLive(t(now - 60_000), ['trip_x'], now)) throw new Error('an explicitly ended trip is dead');
  if (tripLive(t(now - TRIP_TTL_MS - 1), [], now)) throw new Error('a trip past the TTL is dead');
  if (!tripLive(t(now - TRIP_TTL_MS + 60_000), [], now)) throw new Error('a trip inside the TTL is live');
  if (tripLive(t(now - 60_000), ['other', 'trip_x'], now)) throw new Error('ended-list membership, not position, decides');

  // simplifyRoute — follow-the-leader shares a bounded route
  const line = (n: number): LatLng[] =>
    Array.from({ length: n }, (_, i) => ({ lat: 10 + i * 0.001, lng: 20 }));

  if (simplifyRoute(line(50), 120).length !== 50) throw new Error('a short route is untouched');
  const cut = simplifyRoute(line(1000), 120);
  if (cut.length !== 120) throw new Error(`expected 120 points, got ${cut.length}`);
  if (cut[0].lat !== 10) throw new Error('the start must be kept');
  if (cut[cut.length - 1].lat !== line(1000)[999].lat) throw new Error('the END must be kept — deviation matters most there');
  // strictly increasing: an even sample must not repeat or reverse points
  for (let i = 1; i < cut.length; i++) {
    if (cut[i].lat <= cut[i - 1].lat) throw new Error('sampled route must stay ordered and distinct');
  }
  // A simplified route must still measure deviation sanely: a point ON the
  // original line is on the sample too.
  const onLine = { lat: 10 + 500 * 0.001, lng: 20 };
  if (distanceFromRoute(onLine, cut) > 50) throw new Error('a point on the route must not read as off it');
  // …and one well off it still reads as off.
  if (distanceFromRoute({ lat: 10.5, lng: 21 }, cut) < 1000) throw new Error('a far point must read as off route');
  if (simplifyRoute([], 120).length !== 0) throw new Error('empty route stays empty');
  if (simplifyRoute(line(3), 1).length !== 1) throw new Error('a degenerate max must not crash');

  console.log('groups/trips self-check OK');
}
