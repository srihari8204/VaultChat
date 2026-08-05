// lib/nav/routing.ts — real routing against the self-hosted Valhalla engine.
//
// The app never hits Valhalla directly: it calls the backend POST /nav/route
// (authenticated, rate-limited), which proxies to the internal Valhalla. Here we
// build the request, decode the response shape (Valhalla uses Google-encoded
// polyline at precision 6), and map Valhalla's maneuver enum onto our haptic
// events + an approximate turn angle for adaptiveDistance. The decode + mapping +
// parse are PURE (tsx-testable); fetchRoute is the one network hop.

import { type LatLng } from './geo';
import { type HapticEvent } from './hapticLanguage';
// NOTE: `api` is lazy-required inside fetchRoute (not imported at top) so this
// module's pure half (decode/map/parse) stays free of the react-native graph and
// remains runnable under tsx for the self-check.

export type Costing = 'auto' | 'motorcycle' | 'bicycle' | 'pedestrian' | 'truck';

/** Route preferences → Valhalla request extras (v2: Location Lock Pro). */
export interface RouteOpts {
  shortest?: boolean;        // minimize distance instead of time
  avoidTolls?: boolean;
  avoidHighways?: boolean;
}

/** Build the /nav/route request body (pure — the proxy forwards this shape to
 *  Valhalla, so costing_options ride along without a backend change). Toll/
 *  highway avoidance only applies to motorized costings. */
export function buildRouteRequest(from: LatLng, to: LatLng, costing: Costing, opts?: RouteOpts): any {
  const body: any = { from, to, costing };
  if (!opts) return body;
  const co: any = {};
  if (opts.shortest) co.shortest = true;
  if ((costing === 'auto' || costing === 'motorcycle' || costing === 'truck')) {
    if (opts.avoidTolls) co.use_tolls = 0;
    if (opts.avoidHighways) co.use_highways = 0;
  }
  if (Object.keys(co).length) body.costing_options = { [costing]: co };
  return body;
}

export interface Maneuver {
  event: HapticEvent | null;   // the haptic to fire for this maneuver (null = no buzz, e.g. continue)
  turnAngle: number;           // approx sharpness, deg (feeds adaptiveDistance)
  instruction: string;
  roadName: string;
  point: LatLng;               // where the maneuver happens (shape[beginIndex])
  beginIndex: number;          // into shape[]
  lengthM: number;             // length of the leg segment this maneuver starts
  timeS: number;
}
export interface Route { shape: LatLng[]; maneuvers: Maneuver[]; lengthM: number; timeS: number }

// ── Google encoded polyline decode (Valhalla default precision = 6) ──
export function polylineDecode(str: string, precision = 6): LatLng[] {
  const factor = Math.pow(10, precision);
  const out: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    let result = 0, shift = 0, b: number;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

// Valhalla maneuver type enum → our haptic event (only the ones that warrant a cue).
const TYPE_EVENT: Record<number, HapticEvent | null> = {
  4: 'destination', 5: 'destination', 6: 'destination',
  9: 'slightRight', 10: 'right', 11: 'right',       // slight / right / sharp-right
  12: 'uturn', 13: 'uturn',
  14: 'left', 15: 'left', 16: 'slightLeft',         // sharp-left / left / slight-left
  26: 'roundabout', 27: 'roundabout',
};
// Approx turn sharpness (deg) per type — drives how early adaptiveDistance alerts.
const TYPE_ANGLE: Record<number, number> = {
  9: 25, 10: 90, 11: 130, 14: 130, 15: 90, 16: 25, 12: 180, 13: 180, 26: 90, 27: 60,
};

export const valhallaEvent = (type: number): HapticEvent | null => TYPE_EVENT[type] ?? null;
export const valhallaAngle = (type: number): number => TYPE_ANGLE[type] ?? 0;

/** Parse a Valhalla /route response into our Route (pure). */
export function parseRoute(resp: any): Route {
  const trip = resp?.trip;
  if (!trip?.legs?.length) throw new Error('no route');
  const shape: LatLng[] = [];
  const maneuvers: Maneuver[] = [];
  for (const leg of trip.legs) {
    const base = shape.length;
    const pts = polylineDecode(leg.shape || '', 6);
    for (const p of pts) shape.push(p);
    for (const m of leg.maneuvers || []) {
      const begin = base + (m.begin_shape_index || 0);
      maneuvers.push({
        event: valhallaEvent(m.type),
        turnAngle: valhallaAngle(m.type),
        instruction: m.instruction || '',
        roadName: (m.street_names && m.street_names[0]) || '',
        point: shape[begin] ?? shape[shape.length - 1] ?? { lat: 0, lng: 0 },
        beginIndex: begin,
        lengthM: Math.round((m.length || 0) * 1000),  // Valhalla length is km
        timeS: Math.round(m.time || 0),
      });
    }
  }
  return {
    shape, maneuvers,
    lengthM: Math.round((trip.summary?.length || 0) * 1000),
    timeS: Math.round(trip.summary?.time || 0),
  };
}

/** Request a real route from the self-hosted Valhalla via the backend proxy. */
export async function fetchRoute(from: LatLng, to: LatLng, costing: Costing = 'auto', opts?: RouteOpts): Promise<Route> {
  const { api } = require('../api');
  const resp = await api('/nav/route', { method: 'POST', json: buildRouteRequest(from, to, costing, opts) });
  return parseRoute(resp);
}

// ── self-check: `npx tsx lib/nav/routing.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('routing: ' + m); };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

  // Google's canonical precision-5 vector
  const pts = polylineDecode('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  A(pts.length === 3, 'decode 3 points');
  A(near(pts[0].lat, 38.5) && near(pts[0].lng, -120.2), 'first point');
  A(near(pts[2].lat, 43.252) && near(pts[2].lng, -126.453), 'last point');

  // maneuver mapping
  A(valhallaEvent(15) === 'left' && valhallaEvent(10) === 'right', 'left/right');
  A(valhallaEvent(12) === 'uturn' && valhallaEvent(26) === 'roundabout', 'uturn/roundabout');
  A(valhallaEvent(4) === 'destination' && valhallaEvent(8) === null, 'destination / continue-null');
  A(valhallaAngle(15) === 90 && valhallaAngle(12) === 180, 'angles');

  // parse a minimal response
  const enc = '_p~iF~ps|U_ulLnnqC';  // 2 points (p5)
  const route = parseRoute({ trip: {
    legs: [{ shape: enc, maneuvers: [
      { type: 15, begin_shape_index: 0, length: 0.12, time: 15, street_names: ['Main St'], instruction: 'Turn left onto Main St' },
      { type: 4, begin_shape_index: 1, length: 0, time: 0 },
    ] }],
    summary: { length: 1.2, time: 90 },
  } });
  A(route.maneuvers.length === 2, 'two maneuvers');
  A(route.maneuvers[0].event === 'left' && route.maneuvers[0].roadName === 'Main St', 'left onto Main St');
  A(route.maneuvers[0].lengthM === 120 && route.lengthM === 1200, 'km→m conversion');
  A(route.maneuvers[1].event === 'destination', 'destination maneuver');

  // route options → Valhalla costing_options mapping
  const p0 = { lat: 0, lng: 0 };
  A(!buildRouteRequest(p0, p0, 'auto').costing_options, 'no opts → no costing_options');
  const rq = buildRouteRequest(p0, p0, 'auto', { shortest: true, avoidTolls: true, avoidHighways: true });
  A(rq.costing_options.auto.shortest === true && rq.costing_options.auto.use_tolls === 0
    && rq.costing_options.auto.use_highways === 0, 'auto: shortest + avoid tolls/highways');
  const rw = buildRouteRequest(p0, p0, 'pedestrian', { avoidTolls: true, avoidHighways: true });
  A(!rw.costing_options, 'pedestrian ignores toll/highway avoidance');
  const rs = buildRouteRequest(p0, p0, 'pedestrian', { shortest: true });
  A(rs.costing_options.pedestrian.shortest === true, 'pedestrian shortest still applies');

  console.log('routing self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
