// lib/nav/useRoadEta.ts — road distance + ETA between two points, for screens.
//
// WHY THIS EXISTS
// ---------------
// Several screens estimated arrival as `haversine(a, b) / speed`. That is
// crow-flies distance divided by a guess, and it is wrong in the direction that
// hurts: it always reports the vehicle as CLOSER and SOONER than it is, because
// no road is ever shorter than the straight line between its ends. A school bus
// 2km away across a railway line can be 5km of driving; a rider told "arriving
// now" walks out and waits.
//
// Valhalla returns the road distance AND its own duration, which accounts for
// road classes and turn costs rather than assuming one speed for a whole city.
// The duration is the better number and is preferred when present.
//
// THE POSITION IS ROUNDED BEFORE IT BECOMES A DEPENDENCY. A vehicle ping lands
// every few seconds and jitters by metres while stationary; re-routing on the
// raw coordinate would issue a request per tick to move an ETA by nothing.
// ~110m (3 decimal places) is below what changes a displayed arrival window.
//
// IT ALWAYS DEGRADES, NEVER BLOCKS. Router down, unreachable stop, slow reply:
// the caller keeps whatever estimate it already had. An ETA that is a little
// wrong beats a screen with no ETA on it.

import { useEffect, useMemo, useState } from 'react';
import type { LatLng } from './geo';

export interface RoadEta {
  /** Metres by road. */
  distanceM: number;
  /** Seconds, as estimated by the routing engine. */
  durationS: number;
}

/** Decimal places to round a coordinate to before it becomes a dependency.
 *  3 dp is ~110m — below the resolution of any arrival window we render. */
const KEY_DP = 3;

function keyOf(p: LatLng | null | undefined): string {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return '';
  // (0,0) is what a missing fix serialises to, not a place anyone is.
  if (p.lat === 0 && p.lng === 0) return '';
  return `${p.lat.toFixed(KEY_DP)},${p.lng.toFixed(KEY_DP)}`;
}

/**
 * Road distance and ETA from `from` to `to`, or null while unknown.
 *
 * Returns null rather than a guess: callers already own a fallback that is
 * honest about being one, and replacing it with a fabricated road figure would
 * be worse than leaving it alone.
 */
export function useRoadEta(
  from: LatLng | null | undefined,
  to: LatLng | null | undefined,
  costing: 'auto' | 'pedestrian' | 'bicycle' = 'auto',
): RoadEta | null {
  const [eta, setEta] = useState<RoadEta | null>(null);
  const fromKey = useMemo(() => keyOf(from), [from]);
  const toKey = useMemo(() => keyOf(to), [to]);

  useEffect(() => {
    if (!fromKey || !toKey || fromKey === toKey) { setEta(null); return; }
    let cancel = false;
    (async () => {
      try {
        const { fetchRoute } = require('./routing');
        const r = await fetchRoute(
          { lat: Number(fromKey.split(',')[0]), lng: Number(fromKey.split(',')[1]) },
          { lat: Number(toKey.split(',')[0]), lng: Number(toKey.split(',')[1]) },
          costing,
        );
        if (cancel) return;
        // Route carries lengthM/timeS, NOT distanceM/durationS — those are the
        // MATRIX result's names. Reading the wrong pair returns NaN and the
        // hook silently answers null forever, which looks exactly like "the
        // router is down" and would never be noticed.
        const distanceM = Number(r?.lengthM);
        const durationS = Number(r?.timeS);
        if (!Number.isFinite(distanceM) || distanceM < 0) { setEta(null); return; }
        setEta({
          distanceM,
          durationS: Number.isFinite(durationS) && durationS >= 0 ? durationS : 0,
        });
      } catch {
        if (!cancel) setEta(null);   // caller keeps its own estimate
      }
    })();
    return () => { cancel = true; };
  }, [fromKey, toKey, costing]);

  return eta;
}

export default useRoadEta;
