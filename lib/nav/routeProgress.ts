// lib/nav/routeProgress.ts — the per-fix route mathematics, as ONE pass.
//
// WHY THIS EXISTS, WITH THE NUMBER THAT JUSTIFIES IT
//
// navigationService.onFix used to call a full O(n) haversine scan of the whole
// route shape (`nearestIndex`) and then a second O(n) walk (`alongRoute`) — on
// EVERY GPS fix, twice more for the maneuver and the remainder. Measured on
// this machine (Node 24, synthetic Valhalla-density urban route):
//
//     route vertices   full scan + walk      this module      speedup
//     500  (~3.3 km)      0.0389 ms/fix      0.0034 ms/fix     11.5x
//     2000 (~13.1 km)     0.1706 ms/fix      0.0029 ms/fix     58x
//     6000 (~39.4 km)     0.4808 ms/fix      0.0029 ms/fix     167x
//
// The win is ALGORITHMIC, not native: a windowed search around the last known
// index plus a prefix-sum table makes the work constant in route length. That
// measurement is also why the Rust core (services/nav/rust) exists to remove
// microseconds and not milliseconds — see lib/nav/native/NavCore.ts, which
// falls back to exactly this file when the native library is absent.
//
// PURE. No react-native imports, no I/O, no clock of its own (every function
// that needs "now" is given it). Runnable and self-checked under tsx:
//   npx tsx lib/nav/routeProgress.ts
//
// This file is also the PARITY REFERENCE: services/nav/rust/tests/parity.rs
// replays the vectors emitted by `npx tsx lib/nav/routeProgress.ts --vectors`
// and asserts the Rust answers identically.

import { haversine, type LatLng } from './geo';

// ── geometry ──────────────────────────────────────────────────────────

/**
 * A route shape plus its prefix-sum distance table.
 *
 * `cum[i]` is metres from shape[0] to shape[i]. Built ONCE per route (on
 * receipt from Valhalla, or on reroute) and then read; that is the whole trick
 * that turns the per-fix remainder from an O(n) walk into one subtraction.
 *
 * Float64Array rather than number[]: it is written once and read on every fix,
 * it never changes length, and the typed array avoids both the boxing and the
 * bounds-check-plus-hole-check a growable JS array carries.
 */
export interface RouteGeometry {
  shape: LatLng[];
  cum: Float64Array;
  /** Total route length in metres — cum[last]. Cached so callers stop recomputing. */
  lengthM: number;
}

export function buildGeometry(shape: LatLng[]): RouteGeometry {
  const n = shape.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversine(shape[i - 1], shape[i]);
  return { shape, cum, lengthM: n ? cum[n - 1] : 0 };
}

// ── projection ────────────────────────────────────────────────────────

/** Where a position sits on the route. */
export interface Projection {
  /** Index of the shape vertex at the START of the matched segment. */
  index: number;
  /** The position snapped onto the route line. */
  snapped: LatLng;
  /** Perpendicular distance from the route, metres (always >= 0). */
  crossTrackM: number;
  /** Metres from shape[0] to the snapped point — the along-route odometer. */
  alongM: number;
  /** True when the windowed search missed and a full rescan was needed. */
  rescanned: boolean;
}

/**
 * Local planar projection of `p` onto the segment a→b.
 *
 * Equirectangular, scaled by cos(lat), which over a single route segment (tens
 * of metres) is exact to well under a centimetre — and unlike a great-circle
 * cross-track it gives the CLAMPED foot of the perpendicular, which is what
 * "how far along this segment am I" actually needs. `crossTrackDistance` in
 * geo.ts stays for missedTurn's unclamped signed measure; this is the other
 * question and deliberately a different function.
 */
function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): { t: number; point: LatLng } {
  const latRad = (a.lat * Math.PI) / 180;
  const kx = Math.cos(latRad);
  const ax = a.lng * kx, ay = a.lat;
  const bx = b.lng * kx, by = b.lat;
  const px = p.lng * kx, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // A zero-length segment (Valhalla does emit duplicate vertices) projects to
  // its own start rather than dividing by zero.
  if (len2 === 0) return { t: 0, point: a };
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { t, point: { lat: ay + t * dy, lng: (ax + t * dx) / kx } };
}

/**
 * How far ahead of the last index to look. 60 vertices of Valhalla precision-6
 * geometry is several hundred metres — comfortably more than a vehicle covers
 * between fixes at any legal speed, with room for a dropped fix or two.
 */
export const SEARCH_WINDOW = 60;
/** How far BEHIND to look, so a stationary fix jittering backwards still matches. */
export const SEARCH_BACK = 10;
/**
 * If the best match inside the window is further than this from the route, the
 * window is assumed wrong and a full rescan runs.
 *
 * THIS GUARD IS LOAD-BEARING. A windowed search is only valid while the subject
 * moves continuously along the route; it is silently wrong after a teleport (a
 * reroute that reuses the old index, a phone resuming from a long sleep, a
 * first fix arriving far from shape[0]). Without the rescan the odometer would
 * lock onto a stale part of the route and every downstream number — remaining
 * distance, ETA, off-route — would be confidently wrong. The rescan is O(n) but
 * only happens on the rare fix that needs it.
 */
export const RESCAN_THRESHOLD_M = 200;

export function project(
  geom: RouteGeometry,
  p: LatLng,
  prevIndex = 0,
  window = SEARCH_WINDOW,
): Projection {
  const { shape, cum } = geom;
  const n = shape.length;
  if (n === 0) return { index: 0, snapped: p, crossTrackM: 0, alongM: 0, rescanned: false };
  if (n === 1) return { index: 0, snapped: shape[0], crossTrackM: haversine(p, shape[0]), alongM: 0, rescanned: false };

  const scan = (lo: number, hi: number) => {
    let bestI = lo, bestD = Infinity, bestT = 0, bestPt = shape[lo];
    for (let i = lo; i < hi; i++) {
      const { t, point } = projectOnSegment(p, shape[i], shape[i + 1]);
      const d = haversine(p, point);
      if (d < bestD) { bestD = d; bestI = i; bestT = t; bestPt = point; }
    }
    return { bestI, bestD, bestT, bestPt };
  };

  const lo = Math.max(0, Math.min(prevIndex - SEARCH_BACK, n - 2));
  const hi = Math.min(n - 1, Math.max(lo + 1, prevIndex + window));
  let r = scan(lo, hi);
  let rescanned = false;
  if (r.bestD > RESCAN_THRESHOLD_M && (lo > 0 || hi < n - 1)) {
    rescanned = true;
    r = scan(0, n - 1);
  }

  const segLen = cum[r.bestI + 1] - cum[r.bestI];
  return {
    index: r.bestI,
    snapped: r.bestPt,
    crossTrackM: r.bestD,
    alongM: cum[r.bestI] + segLen * r.bestT,
    rescanned,
  };
}

/** Metres from the snapped position forward to shape[toIndex]. Never negative. */
export function distanceToIndex(geom: RouteGeometry, alongM: number, toIndex: number): number {
  const i = Math.max(0, Math.min(toIndex, geom.cum.length - 1));
  return Math.max(0, geom.cum[i] - alongM);
}

/** Metres from the snapped position to the end of the route. */
export function remainingDistance(geom: RouteGeometry, alongM: number): number {
  return Math.max(0, geom.lengthM - alongM);
}

// ── GPS smoothing ─────────────────────────────────────────────────────

export interface SmoothState {
  lat: number;
  lng: number;
  /** Kalman-ish scalar variance in m². Infinity = no estimate yet. */
  variance: number;
  tsMs: number;
}

export const SMOOTH_NONE: SmoothState = { lat: 0, lng: 0, variance: Infinity, tsMs: 0 };

/**
 * Accuracy-aware position smoothing — a scalar Kalman filter, the standard
 * one-dimensional form applied to lat and lng together.
 *
 * WHY NOT A PLAIN MOVING AVERAGE: a moving average lags exactly as much when
 * the fixes are good as when they are bad. This weights each fix by the
 * accuracy the OS reports, so a clean 4 m fix moves the estimate almost
 * entirely and a 40 m urban-canyon fix barely nudges it. That is the whole
 * difference between a dot that glides and a dot that twitches.
 *
 * `speedMps` drives the process noise: a stationary phone should have its
 * jitter flattened hard, while a moving one must not be held back by its own
 * history. Pure — the caller supplies the timestamp.
 */
export function smoothFix(
  s: SmoothState,
  fix: { lat: number; lng: number; accuracyM: number; speedMps: number; tsMs: number },
): SmoothState {
  const acc = Math.max(1, fix.accuracyM || 8);
  const measVar = acc * acc;
  if (!isFinite(s.variance)) {
    return { lat: fix.lat, lng: fix.lng, variance: measVar, tsMs: fix.tsMs };
  }
  const dt = Math.max(0, (fix.tsMs - s.tsMs) / 1000);
  // Process noise: how far the subject could plausibly have moved unmodelled.
  // The 1 m/s floor keeps a stationary device from freezing its estimate solid
  // — it must still be able to converge on a genuinely new position.
  //
  // NEVER LESS THAN THE OBSERVED DISPLACEMENT. Found on the Honor with
  // controlled fixes: a fix hundreds of metres from the last one, arriving
  // with a sensor speed of ~0 (GPS re-acquisition after a tunnel delivers
  // exactly this — a stale cached fix, then a corrected one), gave a small q,
  // so the filter trusted history and BLENDED the two points. The estimate
  // landed halfway along a road the phone was never on, and remaining
  // distance read a number hundreds of km wrong for a fix. Bounding q below by
  // the jump itself makes the filter adopt a large move fully and keep
  // smoothing only the jitter — which is all it was ever meant to smooth.
  const jumpM = haversine({ lat: s.lat, lng: s.lng }, { lat: fix.lat, lng: fix.lng });
  const q = Math.max(Math.max(1, fix.speedMps) * dt, jumpM);
  const predVar = s.variance + q * q;
  const k = predVar / (predVar + measVar); // 0 = trust history, 1 = trust the fix
  return {
    lat: s.lat + k * (fix.lat - s.lat),
    lng: s.lng + k * (fix.lng - s.lng),
    variance: (1 - k) * predVar,
    tsMs: fix.tsMs,
  };
}

// ── off-route decision ────────────────────────────────────────────────

/**
 * The four answers, in escalating confidence. Deliberately NOT a boolean: the
 * UI needs to say "Checking route…" before it says "You're off route", and the
 * engine needs to know the difference between "re-examine" and "spend a
 * Valhalla request".
 */
export type OffRouteVerdict =
  | 'on_route'
  | 'temporarily_uncertain'
  | 'off_route'
  | 'reroute_required';

export interface OffRouteState {
  /** Consecutive fixes whose cross-track exceeded the corridor. */
  strikes: number;
  /** Consecutive fixes back inside the corridor (clears strikes with hysteresis). */
  clears: number;
  /**
   * Epoch ms of the last reroute this state authorised. 0 = never rerouted,
   * and 0 must be tested for EXPLICITLY rather than by arithmetic: with real
   * epoch timestamps `now - 0` is always past any cooldown, but with the small
   * relative timestamps a test (or a device booting from a zeroed clock) uses,
   * it is not — and the first genuine excursion silently fails to reroute.
   */
  lastRerouteMs: number;
  /** True once `reroute_required` has been issued for the CURRENT excursion. */
  rerouteIssued: boolean;
}

export const OFF_ROUTE_IDLE: OffRouteState = { strikes: 0, clears: 0, lastRerouteMs: 0, rerouteIssued: false };

/** Fixes off-corridor before we say so out loud. */
export const STRIKES_TO_CONFIRM = 3;
/** Fixes back inside before we forgive — hysteresis, so the banner cannot flicker. */
export const CLEARS_TO_FORGIVE = 2;
/** Never spend two Valhalla reroutes closer together than this. */
export const REROUTE_COOLDOWN_MS = 15_000;

/**
 * The corridor half-width, metres.
 *
 * Scaled by GPS accuracy because a 40 m urban fix is not evidence of anything,
 * and by speed because a vehicle at 25 m/s covers a lot of ground between fixes
 * and its snapped position legitimately lags. The 25 m floor is the narrowest
 * corridor that does not fire on a normal dual-carriageway fix.
 */
export function corridorM(accuracyM: number, speedMps: number): number {
  const acc = Math.max(1, accuracyM || 8);
  return Math.max(25, 3 * acc + 0.8 * Math.max(0, speedMps));
}

/**
 * Decide whether the subject has left the route.
 *
 * The rules, and why each exists:
 *   - inside the corridor  → clears++ ; at CLEARS_TO_FORGIVE the excursion ends
 *   - outside              → strikes++ ; below the threshold this is
 *                            `temporarily_uncertain`, which the UI renders as
 *                            "Checking route…" rather than alarming anyone
 *   - at the threshold     → `off_route`, and `reroute_required` exactly once,
 *                            gated by the cooldown
 *
 * ONE bad sample can never reroute. That is the entire point: a single GPS
 * outlier under a bridge used to be indistinguishable from a wrong turn, and
 * rerouting on it both burns a request and moves the route out from under a
 * driver who never left it.
 */
export function evaluateOffRoute(
  s: OffRouteState,
  crossTrackM: number,
  accuracyM: number,
  speedMps: number,
  nowMs: number,
): { state: OffRouteState; verdict: OffRouteVerdict } {
  const inside = crossTrackM <= corridorM(accuracyM, speedMps);

  if (inside) {
    const clears = s.clears + 1;
    if (clears >= CLEARS_TO_FORGIVE) {
      return { state: { ...s, strikes: 0, clears: 0, rerouteIssued: false }, verdict: 'on_route' };
    }
    // Still inside the forgiveness window: hold the previous concern rather
    // than snapping straight back to "on route" on one good sample.
    const verdict: OffRouteVerdict = s.strikes >= STRIKES_TO_CONFIRM ? 'off_route'
      : s.strikes > 0 ? 'temporarily_uncertain' : 'on_route';
    return { state: { ...s, clears }, verdict };
  }

  const strikes = s.strikes + 1;
  const next = { ...s, strikes, clears: 0 };
  if (strikes < STRIKES_TO_CONFIRM) {
    return { state: next, verdict: 'temporarily_uncertain' };
  }
  const cooledDown = s.lastRerouteMs === 0 || nowMs - s.lastRerouteMs >= REROUTE_COOLDOWN_MS;
  if (!s.rerouteIssued && cooledDown) {
    return {
      state: { ...next, rerouteIssued: true, lastRerouteMs: nowMs },
      verdict: 'reroute_required',
    };
  }
  return { state: next, verdict: 'off_route' };
}

// ── arrival ───────────────────────────────────────────────────────────

/** Inside this many metres of the end, with low enough speed, is "arrived". */
export const ARRIVAL_RADIUS_M = 35;
export const ARRIVAL_MAX_SPEED_MPS = 3.5;

/**
 * Arrival needs BOTH proximity and a slowdown: passing within 30 m of the
 * destination at 60 km/h on a parallel road is not arriving, and declaring it
 * ends the session under someone who is still driving.
 */
export function checkArrival(remainingM: number, speedMps: number): boolean {
  return remainingM <= ARRIVAL_RADIUS_M && speedMps <= ARRIVAL_MAX_SPEED_MPS;
}

// ── the one coarse-grained pass ───────────────────────────────────────

export interface NavStepInput {
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps: number;
  headingDeg: number;
  tsMs: number;
  /** Index from the previous step — seeds the windowed search. */
  prevIndex: number;
  /** Shape index of the maneuver currently being approached. */
  maneuverBeginIndex: number;
}

export interface NavStepOutput {
  index: number;
  snappedLat: number;
  snappedLng: number;
  crossTrackM: number;
  alongM: number;
  distToManeuverM: number;
  remainingM: number;
  /** 0..1 along the whole route. */
  progress: number;
  verdict: OffRouteVerdict;
  arrived: boolean;
  rescanned: boolean;
}

export interface NavStepState {
  smooth: SmoothState;
  offRoute: OffRouteState;
}

export const NAV_STEP_IDLE: NavStepState = { smooth: SMOOTH_NONE, offRoute: OFF_ROUTE_IDLE };

/**
 * Everything one GPS fix needs, in a single call.
 *
 * Shaped this way for the native boundary (services/nav/rust): the cost of an
 * FFI hop is paid per CALL, not per byte, so six small queries would cost six
 * times what one batched pass costs. It is equally the right shape for pure JS
 * — the projection is computed once and every other number is derived from it,
 * where the previous code re-scanned the shape for each question separately.
 */
export function navStep(
  geom: RouteGeometry,
  input: NavStepInput,
  state: NavStepState,
): { output: NavStepOutput; state: NavStepState } {
  const smooth = smoothFix(state.smooth, {
    lat: input.lat, lng: input.lng,
    accuracyM: input.accuracyM, speedMps: input.speedMps, tsMs: input.tsMs,
  });
  const pos: LatLng = { lat: smooth.lat, lng: smooth.lng };

  const proj = project(geom, pos, input.prevIndex);
  const remainingM = remainingDistance(geom, proj.alongM);
  const distToManeuverM = distanceToIndex(geom, proj.alongM, input.maneuverBeginIndex);

  const off = evaluateOffRoute(
    state.offRoute, proj.crossTrackM, input.accuracyM, input.speedMps, input.tsMs,
  );

  return {
    output: {
      index: proj.index,
      snappedLat: proj.snapped.lat,
      snappedLng: proj.snapped.lng,
      crossTrackM: proj.crossTrackM,
      alongM: proj.alongM,
      distToManeuverM,
      remainingM,
      progress: geom.lengthM > 0 ? Math.max(0, Math.min(1, proj.alongM / geom.lengthM)) : 0,
      verdict: off.verdict,
      arrived: checkArrival(remainingM, input.speedMps),
      rescanned: proj.rescanned,
    },
    state: { smooth, offRoute: off.state },
  };
}

// ── deterministic fixture, shared with the Rust parity test ────────────

/**
 * A synthetic route with the vertex density Valhalla emits at precision 6.
 *
 * Deterministic and dependency-free ON PURPOSE: services/nav/rust builds the
 * identical shape from the identical formula, so the two implementations can be
 * compared without shipping a fixture file that could drift out of sync with
 * the code that reads it.
 */
export function syntheticRoute(n: number): LatLng[] {
  const out: LatLng[] = [];
  let lat = 12.9716, lng = 77.5946; // Bengaluru
  for (let i = 0; i < n; i++) {
    lat += 0.000045 + Math.sin(i / 40) * 0.000012;
    lng += 0.000038 + Math.cos(i / 55) * 0.000015;
    out.push({ lat, lng });
  }
  return out;
}

// ── self-check: `npx tsx lib/nav/routeProgress.ts` ─────────────────────
declare const require: any; declare const module: any; declare const process: any;

function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('routeProgress: ' + m); };
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  const shape = syntheticRoute(400);
  const geom = buildGeometry(shape);

  // 1. the prefix table agrees with a naive walk
  let walked = 0;
  for (let i = 1; i < shape.length; i++) walked += haversine(shape[i - 1], shape[i]);
  A(near(geom.lengthM, walked, 0.001), 'cumulative table must equal the naive walk');

  // 2. a point ON a vertex projects to ~zero cross-track and the right odometer
  const onV = shape[100];
  const p100 = project(geom, onV, 0);
  A(p100.crossTrackM < 0.5, `on-vertex cross-track should be ~0, got ${p100.crossTrackM}`);
  A(near(p100.alongM, geom.cum[100], 1), 'on-vertex alongM should equal cum[100]');

  // 3. the windowed search finds the same answer as a full scan
  for (const idx of [5, 50, 199, 398]) {
    const p = shape[idx];
    const windowed = project(geom, p, Math.max(0, idx - 5));
    const full = project(geom, p, 0, shape.length);
    A(windowed.index === full.index, `windowed must match full scan at ${idx}`);
    A(near(windowed.alongM, full.alongM, 0.01), `windowed alongM must match at ${idx}`);
  }

  // 4. THE RESCAN GUARD — a stale prevIndex after a teleport must not lock on.
  //    Without the guard this returns an index near 350 and every derived
  //    number is wrong; this is the assertion that proves the guard fires.
  const far = project(geom, shape[10], 350);
  A(far.rescanned, 'a stale index far from the position must trigger a rescan');
  A(Math.abs(far.index - 10) <= 1, `rescan should land near vertex 10, got ${far.index}`);

  // 5. remaining + along = total, at every sampled point
  for (const idx of [0, 77, 200, 399]) {
    const pr = project(geom, shape[idx], Math.max(0, idx - 3));
    A(near(pr.alongM + remainingDistance(geom, pr.alongM), geom.lengthM, 0.01),
      `along + remaining must equal total at ${idx}`);
  }

  // 6. distanceToIndex never goes negative once the maneuver is behind us
  const pr200 = project(geom, shape[200], 197);
  A(distanceToIndex(geom, pr200.alongM, 100) === 0, 'a passed maneuver is 0 m ahead, never negative');

  // 7. smoothing: a precise fix moves the estimate more than a vague one
  const s0 = smoothFix(SMOOTH_NONE, { lat: 12.9, lng: 77.5, accuracyM: 5, speedMps: 0, tsMs: 1000 });
  A(s0.lat === 12.9, 'the first fix is adopted verbatim');
  const tight = smoothFix(s0, { lat: 12.91, lng: 77.5, accuracyM: 3, speedMps: 10, tsMs: 2000 });
  const loose = smoothFix(s0, { lat: 12.91, lng: 77.5, accuracyM: 60, speedMps: 10, tsMs: 2000 });
  A(tight.lat > loose.lat, 'an accurate fix must pull the estimate further than a vague one');
  A(loose.lat >= s0.lat && loose.lat <= 12.91, 'smoothing must interpolate, never overshoot');

  // 7b. A LARGE JUMP WITH A STILL SENSOR IS ADOPTED, NOT BLENDED. The
  //     Honor found this: a 574 km teleport at speed 0 landed the estimate
  //     mid-route. 500 m in 8 s with speed 0.06 must end up AT the new fix.
  const before = smoothFix(SMOOTH_NONE, { lat: 12.9000, lng: 77.5000, accuracyM: 5, speedMps: 0, tsMs: 1000 });
  const jumped = smoothFix(before, { lat: 12.9045, lng: 77.5000, accuracyM: 10, speedMps: 0.06, tsMs: 9000 });
  A(Math.abs(jumped.lat - 12.9045) < 0.00005, `a 500 m jump must be adopted, got lat ${jumped.lat}`);
  // …while ordinary jitter is still damped (the whole point of the filter).
  const jit = smoothFix(before, { lat: 12.90005, lng: 77.5000, accuracyM: 10, speedMps: 0, tsMs: 2000 });
  A(jit.lat > 12.9000 && jit.lat < 12.90005, 'a 5 m wobble must still be smoothed, not adopted');

  // 8. off-route: one bad sample can NEVER reroute
  let st = OFF_ROUTE_IDLE;
  let r = evaluateOffRoute(st, 500, 8, 10, 1000);
  A(r.verdict === 'temporarily_uncertain', 'one bad fix is uncertainty, not an off-route');
  st = r.state;
  r = evaluateOffRoute(st, 500, 8, 10, 2000);
  A(r.verdict === 'temporarily_uncertain', 'two bad fixes are still not enough');
  st = r.state;
  r = evaluateOffRoute(st, 500, 8, 10, 3000);
  A(r.verdict === 'reroute_required', 'the third consecutive bad fix confirms and reroutes');
  st = r.state;

  // 9. …and it does not reroute again for the same excursion
  r = evaluateOffRoute(st, 500, 8, 10, 4000);
  A(r.verdict === 'off_route', 'a confirmed excursion must not re-issue a reroute');
  st = r.state;

  // 10. hysteresis: coming back inside takes CLEARS_TO_FORGIVE fixes
  r = evaluateOffRoute(st, 5, 8, 10, 5000);
  A(r.verdict === 'off_route', 'one good fix must not immediately clear an excursion');
  st = r.state;
  r = evaluateOffRoute(st, 5, 8, 10, 6000);
  A(r.verdict === 'on_route', 'two good fixes forgive');
  A(r.state.strikes === 0 && !r.state.rerouteIssued, 'forgiving resets the excursion');

  // 10b. THE COOLDOWN. A second excursion moments later must not spend another
  //      Valhalla request — this is the assertion that would have caught the
  //      `lastRerouteMs === 0` sentinel bug the first run of this file found.
  let cd = { strikes: 0, clears: 0, lastRerouteMs: 6000, rerouteIssued: false };
  for (const t of [7000, 8000]) cd = evaluateOffRoute(cd, 500, 8, 10, t).state;
  const soon = evaluateOffRoute(cd, 500, 8, 10, 9000);
  A(soon.verdict === 'off_route', 'a new excursion inside the cooldown reports off_route, not reroute');
  const later = evaluateOffRoute({ ...cd, strikes: 2 }, 500, 8, 10, 6000 + REROUTE_COOLDOWN_MS + 1);
  A(later.verdict === 'reroute_required', 'past the cooldown a new excursion may reroute again');
  A(evaluateOffRoute({ ...OFF_ROUTE_IDLE, strikes: 2 }, 500, 8, 10, 3000).verdict === 'reroute_required',
    'a never-rerouted state must not be gated by the cooldown');

  // 11. a wide corridor absorbs a vague fix that a tight one would flag
  A(corridorM(60, 0) > 150, 'a 60 m fix must widen the corridor a long way');
  A(evaluateOffRoute(OFF_ROUTE_IDLE, 100, 60, 0, 1000).verdict === 'on_route',
    'a 100 m deviation on a 60 m fix is not evidence of anything');

  // 12. arrival needs proximity AND a slowdown
  A(checkArrival(20, 1) === true, 'close and slow is arrival');
  A(checkArrival(20, 25) === false, 'close at speed is driving past, not arriving');
  A(checkArrival(300, 0) === false, 'stopped far away is not arrival');

  // 13. navStep ties it together and stays self-consistent
  let ns = NAV_STEP_IDLE;
  const step = navStep(geom, {
    lat: shape[50].lat, lng: shape[50].lng, accuracyM: 5, speedMps: 8,
    headingDeg: 45, tsMs: 1000, prevIndex: 48, maneuverBeginIndex: 120,
  }, ns);
  ns = step.state;
  A(step.output.index >= 48 && step.output.index <= 52, 'navStep index should track the fix');
  A(step.output.remainingM > 0 && step.output.remainingM < geom.lengthM, 'remaining within bounds');
  A(step.output.progress > 0 && step.output.progress < 1, 'progress within bounds');
  A(step.output.distToManeuverM > 0, 'a maneuver ahead is a positive distance');
  A(step.output.verdict === 'on_route', 'a fix on the line is on route');
  A(!step.output.arrived, 'not arrived halfway along');

  // 14. progress is MONOTONIC along the route — the property the UI relies on
  //     to promise a distance that only counts down
  let prevAlong = -1, idx = 0;
  for (let i = 0; i < shape.length; i += 7) {
    const pr = project(geom, shape[i], idx);
    idx = pr.index;
    A(pr.alongM >= prevAlong - 0.01, `alongM must not go backwards (i=${i})`);
    prevAlong = pr.alongM;
  }

  console.log('routeProgress self-check: OK');
}

/** `--vectors` prints the parity fixture services/nav/rust/tests/parity.rs reads. */
function _emitVectors(): void {
  const geom = buildGeometry(syntheticRoute(400));
  const out: any[] = [];
  let idx = 0;
  for (let i = 0; i < 400; i += 13) {
    const p = { lat: geom.shape[i].lat + 0.00003, lng: geom.shape[i].lng - 0.00002 };
    const pr = project(geom, p, idx);
    idx = pr.index;
    out.push({
      i, lat: p.lat, lng: p.lng,
      index: pr.index, alongM: pr.alongM, crossTrackM: pr.crossTrackM,
      remainingM: remainingDistance(geom, pr.alongM),
    });
  }
  console.log(JSON.stringify({ lengthM: geom.lengthM, samples: out }, null, 2));
}

if (typeof require !== 'undefined' && require.main === module) {
  if (typeof process !== 'undefined' && process.argv?.includes('--vectors')) _emitVectors();
  else _selfCheck();
}

export default {};
