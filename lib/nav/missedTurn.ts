// lib/nav/missedTurn.ts — decide whether the driver missed the maneuver, so the
// engine can fire the strong "missed turn" haptic + reroute. Two independent
// signals, both scaled by GPS accuracy so a fuzzy urban fix doesn't cry wolf:
//   1. off-route  — perpendicular distance from the intended route exceeds a
//                   margin (cross-track distance, from geo.ts).
//   2. passed-no-turn — we've driven past the turn point but our heading still
//                   doesn't match the post-turn direction (we didn't turn).
// Pure → tsx-testable.

import { angleDiff, crossTrackDistance, type LatLng } from './geo';

export interface MissedTurnInput {
  offRouteMeters: number;        // |cross-track distance| to the intended route (see offRouteFrom)
  metersPastManeuver: number;    // >0 once we've driven past the turn point along the road
  heading: number;               // current heading, degrees
  expectedHeadingAfter: number;  // heading a correct turn would leave us on
  gpsAccuracy?: number;          // m (default 8)
}
export type MissedReason = 'off-route' | 'passed-no-turn' | null;
export interface MissedTurnResult { missed: boolean; reason: MissedReason }

const HEADING_TOL = 45; // within this of the post-turn heading = we turned correctly

/** Convenience: perpendicular distance of a fix from the current route segment. */
export function offRouteFrom(pos: LatLng, segStart: LatLng, segEnd: LatLng): number {
  return Math.abs(crossTrackDistance(pos, segStart, segEnd));
}

export function detectMissedTurn(i: MissedTurnInput): MissedTurnResult {
  const gps = i.gpsAccuracy ?? 8;
  const offRouteLimit = Math.max(25, 4 * gps);   // must clearly leave the road, not GPS jitter
  const pastLimit = Math.max(20, 2 * gps);

  if (i.offRouteMeters > offRouteLimit) return { missed: true, reason: 'off-route' };

  if (i.metersPastManeuver > pastLimit && Math.abs(angleDiff(i.heading, i.expectedHeadingAfter)) > HEADING_TOL) {
    return { missed: true, reason: 'passed-no-turn' };
  }
  return { missed: false, reason: null };
}

// ── self-check: `npx tsx lib/nav/missedTurn.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('missedTurn: ' + m); };
  const base: MissedTurnInput = { offRouteMeters: 5, metersPastManeuver: -10, heading: 0, expectedHeadingAfter: 90, gpsAccuracy: 8 };

  // clearly off-route → missed
  A(detectMissedTurn({ ...base, offRouteMeters: 60 }).reason === 'off-route', 'off-route trips');
  // small offset within GPS margin → fine
  A(detectMissedTurn({ ...base, offRouteMeters: 15 }).missed === false, 'small offset OK');
  // fuzzy GPS raises the bar → no false positive
  A(detectMissedTurn({ ...base, offRouteMeters: 40, gpsAccuracy: 15 }).missed === false, 'fuzzy GPS forgiving');

  // passed the turn still heading straight (should have gone to 90) → missed
  A(detectMissedTurn({ ...base, metersPastManeuver: 40, heading: 0, expectedHeadingAfter: 90 }).reason === 'passed-no-turn', 'passed w/o turning');
  // passed but heading now matches the turn → fine
  A(detectMissedTurn({ ...base, metersPastManeuver: 40, heading: 88, expectedHeadingAfter: 90 }).missed === false, 'turned correctly');
  // not yet at the maneuver → never missed on the heading signal
  A(detectMissedTurn({ ...base, metersPastManeuver: -5, heading: 0, expectedHeadingAfter: 90 }).missed === false, 'not reached yet');

  // offRouteFrom: a point 50 m off an east-west segment reads ~50 m
  const start: LatLng = { lat: 17.385, lng: 78.4867 };
  const end: LatLng = { lat: 17.385, lng: 78.4967 };          // due east
  const off: LatLng = { lat: 17.3854, lng: 78.4917 };          // ~44 m north of the line
  A(offRouteFrom(off, start, end) > 30 && offRouteFrom(off, start, end) < 60, 'offRouteFrom sane');

  console.log('missedTurn self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
