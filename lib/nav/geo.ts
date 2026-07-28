// lib/nav/geo.ts — pure geodesy for the haptic-nav core. No RN imports → runnable
// in Node/tsx. Everything the navigation brain needs to reason about position,
// heading, and off-route distance, without pulling in a map/routing library.

const R = 6_371_000; // mean Earth radius, metres
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export interface LatLng { lat: number; lng: number }

/** Great-circle distance between two points, metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a→b, degrees in [0,360). */
export function bearing(a: LatLng, b: LatLng): number {
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest signed difference b−a, in (−180,180]. Positive = b is clockwise of a. */
export function angleDiff(a: number, b: number): number {
  let d = ((b - a + 540) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * Signed perpendicular (cross-track) distance of `pt` from the great circle
 * through seg start→end, metres. |value| is how far off-route we are; used for
 * GPS-deviation / off-route detection.
 */
export function crossTrackDistance(pt: LatLng, start: LatLng, end: LatLng): number {
  const d13 = haversine(start, pt) / R;              // angular distance start→pt
  const t13 = toRad(bearing(start, pt));
  const t12 = toRad(bearing(start, end));
  return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * R;
}

/** Move `metres` from `p` along `bearingDeg` — for building test fixtures. */
export function destination(p: LatLng, bearingDeg: number, metres: number): LatLng {
  const d = metres / R;
  const b = toRad(bearingDeg);
  const la1 = toRad(p.lat), lo1 = toRad(p.lng);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: toDeg(la2), lng: toDeg(lo2) };
}

// ── self-check: `npx tsx lib/nav/geo.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('geo: ' + m); };
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  const p0: LatLng = { lat: 17.385, lng: 78.4867 }; // Hyderabad-ish
  // destination + haversine round-trip: 500 m due east ≈ 500 m back
  const east = destination(p0, 90, 500);
  A(near(haversine(p0, east), 500, 1), 'haversine≈destination 500m');
  A(near(bearing(p0, east), 90, 0.5), 'bearing east ≈ 90');

  // angleDiff basics
  A(angleDiff(350, 10) === 20, 'wrap 350→10 = +20');
  A(angleDiff(10, 350) === -20, 'wrap 10→350 = -20');
  A(Math.abs(angleDiff(0, 180)) === 180, 'opposite = 180');

  // cross-track: a point 50 m north of a point on an east-west line is ~50 m off
  const start = p0, end = destination(p0, 90, 1000);   // east line
  const onLine = destination(p0, 90, 500);             // 500 m east, on the line
  const offN = destination(onLine, 0, 50);             // 50 m north of the line
  A(near(Math.abs(crossTrackDistance(offN, start, end)), 50, 1), 'cross-track ≈ 50 m');
  A(Math.abs(crossTrackDistance(onLine, start, end)) < 1, 'on-line cross-track ≈ 0');

  console.log('geo self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
