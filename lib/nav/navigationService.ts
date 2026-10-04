// lib/nav/navigationService.ts — the real navigation loop. Real GPS (expo-location)
// → follow a real Valhalla route → drive the (tested, pure) haptic core → publish
// the mini-banner state → reroute on a real missed turn. No mock anything: every
// fix is a real device position, every route is a real Valhalla response.
//
// Orchestration only — the reasoning lives in the pure modules (adaptiveDistance,
// notificationTimeline, missedTurn) that already pass their self-checks.

import * as Location from 'expo-location';
import { useSyncExternalStore } from 'react';
import { haversine, bearing, type LatLng } from './geo';
import { triggerDistances, type RoadClass, type NotifTiming } from './adaptiveDistance';
import { newTimeline, advanceTimeline, type TimelineState } from './notificationTimeline';
import { detectMissedTurn } from './missedTurn';
import { playHaptic, stopHaptics, type DisplayMode } from './hapticPlayer';
import { fetchRoute, type Route, type Costing, type Maneuver, type RouteOpts } from './routing';
import { buildGeometry, type RouteGeometry, type OffRouteVerdict } from './routeProgress';
// The per-fix maths runs through the backend selector: the Rust core when the
// native library is present, lib/nav/routeProgress.ts otherwise. Both are
// proven equal by services/nav/rust/tests/parity.rs, so which one answers is
// invisible here — see lib/nav/native/NavCore.ts.
import * as NavCore from './native/NavCore';
import { type NavProfile, type HapticEvent, type HapticPattern } from './hapticLanguage';
import { startVoiceGuide, stopVoiceGuide, feedVoiceGuide } from './voiceGuide';
import { showThenManeuver } from './navPresentation';
import { navUserError, NAV_PERMISSION_TEXT } from './navErrorText';

export interface NavBanner {
  active: boolean;
  event: HapticEvent | null;   // direction icon the banner draws
  instruction: string;
  roadName: string;
  distanceToManeuver: number;  // m to the next maneuver
  remainingM: number;          // m to destination
  totalM: number;              // full route length (v2.1: overall progress bar)
  etaEpochMs: number;          // arrival time
  progress: number;            // 0..1 toward the next maneuver (banner's shrinking line)
  rerouting: boolean;
  /**
   * Off-route confidence from the hysteresis engine (lib/nav/routeProgress).
   * ADDITIVE: NavBanner.tsx and voiceGuide predate this and simply ignore it.
   * The UI needs the middle ground — "Checking route…" before "You're off
   * route" — which a boolean could not express.
   */
  verdict: OffRouteVerdict;
  /** Destination reached: close enough AND slowed down. */
  arrived: boolean;
  /** The maneuver after next, only when it follows closely (navPresentation.showThenManeuver). */
  thenEvent: HapticEvent | null;
  thenRoadName: string;
}
const IDLE: NavBanner = { active: false, event: null, instruction: '', roadName: '', distanceToManeuver: 0, remainingM: 0, totalM: 0, etaEpochMs: 0, progress: 0, rerouting: false, verdict: 'on_route', arrived: false, thenEvent: null, thenRoadName: '' };

// ── tiny external store for the banner ──
let banner: NavBanner = IDLE;
const subs = new Set<() => void>();
function setBanner(patch: Partial<NavBanner>) {
  banner = { ...banner, ...patch };
  subs.forEach((c) => { try { c(); } catch {} });
  // v2 voice guidance: a pure observer — no-op unless a voice mode is active.
  feedVoiceGuide({
    active: banner.active, instruction: banner.instruction,
    distanceToManeuver: banner.distanceToManeuver, remainingM: banner.remainingM,
    rerouting: banner.rerouting, event: banner.event,
  });
}
export function getNavBanner(): NavBanner { return banner; }
export function useNavBanner(): NavBanner {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => banner, () => banner);
}

// ── geographic state for the map (route line, live position, destination) ──
export interface NavGeo { shape: LatLng[]; pos: LatLng | null; heading: number; dest: LatLng | null; }
const GEO_IDLE: NavGeo = { shape: [], pos: null, heading: 0, dest: null };
let geo: NavGeo = GEO_IDLE;
const geoSubs = new Set<() => void>();
function setGeo(patch: Partial<NavGeo>) { geo = { ...geo, ...patch }; geoSubs.forEach((c) => { try { c(); } catch {} }); }
export function getNavGeo(): NavGeo { return geo; }
export function useNavGeo(): NavGeo {
  return useSyncExternalStore((cb) => { geoSubs.add(cb); return () => geoSubs.delete(cb); }, () => geo, () => geo);
}

export interface StartNavOpts {
  to: LatLng; from?: LatLng; costing?: Costing;
  profile: NavProfile; mode?: DisplayMode; custom?: Partial<Record<HapticEvent, HapticPattern>>;
  timing?: NotifTiming;
  routeOpts?: RouteOpts;      // fastest/shortest + toll/highway avoidance (v2)
  /** A route the user already chose (e.g. a Valhalla alternative from the
   *  preview). Driven as-is instead of fetching the primary; a reroute after
   *  leaving it fetches fresh, as for any route. */
  route?: Route;
}

// ── active session ──
let watcher: Location.LocationSubscription | null = null;
let route: Route | null = null;
let maneuverIdx = 0;
let timeline: TimelineState | null = null;
let dest: LatLng | null = null;
let opts: StartNavOpts | null = null;
let last: { pos: LatLng; t: number } | null = null;
let rerouting = false;

const roadClassFor = (speed: number): RoadClass => (speed > 22 ? 'highway' : speed > 11 ? 'primary' : 'city');

/**
 * The route's prefix-sum geometry, rebuilt whenever `route` is replaced.
 *
 * WHY THIS REPLACED THE OLD PER-FIX SCANS. `nearestIndex` used to walk the
 * WHOLE shape on every GPS fix and `alongRoute` walked it again — twice more
 * for the maneuver and the remainder. Measured on a synthetic Valhalla-density
 * route: 0.4808 ms/fix at 6000 vertices, versus 0.0029 ms/fix for the windowed
 * search + prefix table in lib/nav/routeProgress.ts — 167x, and constant in
 * route length instead of linear.
 *
 * `lastIndex` seeds the windowed search from where the previous fix landed;
 * routeProgress.project falls back to a full rescan by itself when that seed
 * turns out to be stale (a reroute, a resumed app, a first fix far from the
 * start), so the optimisation cannot silently lock onto the wrong part of the
 * route. Reset alongside the route in setRouteGeometry().
 */
/** Kept on THIS side purely for cumulative-distance lookups (cum[maneuver]),
 *  which are array reads, not per-fix work. The hot path lives in NavCore. */
let geometry: RouteGeometry | null = null;
let lastIndex = 0;

/** Adopt a new route's geometry. The ONLY place `geometry` is assigned, so it
 *  can never drift out of sync with `route`. */
function setRouteGeometry(r: Route | null): void {
  geometry = r ? buildGeometry(r.shape) : null;
  lastIndex = 0;
  // Adopting a route also resets the smoothing filter and the off-route
  // strikes inside NavCore. That reset is load-bearing: keeping the strikes
  // would let a just-delivered reroute be judged by the deviation that caused
  // it, and immediately ask for another.
  if (r) NavCore.setRoute(r.shape); else NavCore.clearRoute();
}

async function reroute() {
  if (!dest || !opts || !last || rerouting) return;
  rerouting = true; setBanner({ rerouting: true });
  playHaptic('reroute', opts.profile, { mode: opts.mode, custom: opts.custom });
  try {
    route = await fetchRoute(last.pos, dest, opts.costing ?? 'auto', opts.routeOpts);
    setRouteGeometry(route);   // new shape -> new prefix table, and reseed the window
    maneuverIdx = 0; timeline = null;
    setGeo({ shape: route.shape });
    setBanner({ totalM: route.lengthM });
  } catch { /* keep the old route; next fix retries via missed-turn */ }
  finally { rerouting = false; setBanner({ rerouting: false }); }
}

/** Manual "Re-route now" (v2), and the hook for live route-option changes:
 *  optionally swap the route preferences, then recalculate from the current
 *  position. No-op when no session is active. */
export async function forceReroute(routeOpts?: RouteOpts): Promise<void> {
  if (!opts) return;
  if (routeOpts) opts = { ...opts, routeOpts };
  await reroute();
}

function onFix(loc: Location.LocationObject) {
  if (!route || !opts) return;
  const now = loc.timestamp || Date.now();
  const pos: LatLng = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const acc = loc.coords.accuracy ?? 8;

  // Speed + heading: prefer the sensor, else derive from the last fix.
  let speed = loc.coords.speed != null && loc.coords.speed >= 0 ? loc.coords.speed : 0;
  let heading = loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : NaN;
  if (last) {
    const dt = (now - last.t) / 1000;
    const dm = haversine(last.pos, pos);
    if (speed === 0 && dt > 0) speed = dm / dt;
    if (Number.isNaN(heading) && dm > 2) heading = bearing(last.pos, pos);
  }
  if (Number.isNaN(heading)) heading = 0;
  last = { pos, t: now };
  setGeo({ pos, heading });

  const shape = route.shape;
  if (!geometry) setRouteGeometry(route);
  const geom = geometry!;

  // ONE pass per fix — smoothing, projection, progress, off-route and arrival
  // together. Batched deliberately: the cost of the native boundary is paid per
  // CALL, so six small queries would cost six times what this costs.
  const stepped = NavCore.step({
    lat: pos.lat, lng: pos.lng, accuracyM: acc, speedMps: speed,
    headingDeg: heading, tsMs: now,
    prevIndex: lastIndex,
    // The maneuver we were heading for as of the previous fix; re-derived below
    // if this fix turns out to have passed it.
    maneuverBeginIndex: route.maneuvers[maneuverIdx]?.beginIndex ?? (shape.length - 1),
  }, shape);
  if (!stepped) return;
  lastIndex = stepped.index;
  const near = stepped.index;

  // Advance past any maneuvers we've already reached.
  while (maneuverIdx < route.maneuvers.length && route.maneuvers[maneuverIdx].beginIndex < near - 1) maneuverIdx++;
  const m: Maneuver | undefined = route.maneuvers[maneuverIdx];
  if (!m) { setBanner({ active: true, event: 'destination', instruction: 'Arrive', roadName: '', distanceToManeuver: 0, progress: 1, thenEvent: null, thenRoadName: '' }); return; }
  // The one after it, for the "Then" chip when the two come close together.
  const after: Maneuver | undefined = route.maneuvers[maneuverIdx + 1];
  const thenGap = after
    ? geom.cum[Math.min(after.beginIndex, geom.cum.length - 1)] - geom.cum[Math.min(m.beginIndex, geom.cum.length - 1)]
    : Infinity;
  const showThen = !!after?.event && showThenManeuver(thenGap);

  // The loop above may have moved us on to a LATER maneuver than the one the
  // step was asked about, in which case stepped.distToManeuverM answers the
  // wrong question. Always recompute from the odometer instead — subtracting
  // two numbers, not rescanning the shape — so the maneuver distance is right
  // whether or not the index advanced on this fix.
  const manCum = geom.cum[Math.min(m.beginIndex, geom.cum.length - 1)];
  const distToManeuver = Math.max(0, manCum - stepped.alongM);
  const remaining = stepped.remainingM;

  // Missed-turn: off-route beyond GPS margin, or passed the turn still heading
  // straight. The cross-track now comes from the same projection — the CLAMPED
  // perpendicular to the matched segment, which is the more accurate form of
  // the number offRouteFrom() computed unclamped from the nearest vertex.
  const offRoute = stepped.crossTrackM;
  const afterPt = shape[Math.min(m.beginIndex + 1, shape.length - 1)];
  const expectedAfter = bearing(m.point, afterPt);
  // Metres travelled PAST the maneuver, read straight off the odometer:
  // positive once the maneuver is behind us, negative while it is ahead.
  const pastManeuver = stepped.alongM - manCum;
  const miss = detectMissedTurn({ offRouteMeters: offRoute, metersPastManeuver: pastManeuver, heading, expectedHeadingAfter: expectedAfter, gpsAccuracy: acc });

  // TWO SIGNALS, AND THEY ARE NOT THE SAME QUESTION.
  //
  //   `verdict`   — cross-track distance, with strikes, hysteresis and a
  //                 cooldown. Answers "have they LEFT the road".
  //   `miss`      — heading past a turn point. Answers "did they fail to TURN",
  //                 which a driver can do while still perfectly on a road.
  //
  // Rerouting used to fire on `miss.missed` alone, which meant ONE bad GPS
  // sample under a bridge spent a Valhalla request and moved the route out from
  // under a driver who had never left it. The network call is now gated on the
  // confirmed verdict; the heading-based miss still earns its haptic
  // immediately, because feeling a buzz for a turn you actually missed is
  // useful even while the engine is still making up its mind about the road.
  const verdict: OffRouteVerdict = stepped.verdict;

  if (miss.missed) {
    playHaptic('missedTurn', opts.profile, { mode: opts.mode, custom: opts.custom });
  }
  if (verdict === 'reroute_required' || (miss.reason === 'passed-no-turn' && verdict !== 'on_route')) {
    reroute();
  }
  if (!miss.missed && m.event) {
    // Adaptive haptic timeline toward this maneuver.
    const triggers = triggerDistances({ speed, turnAngle: m.turnAngle, gpsAccuracy: acc, roadClass: roadClassFor(speed), timing: opts.timing ?? 'normal' });
    if (!timeline) timeline = newTimeline(m.event);
    const justPassed = m.beginIndex < near;
    const { state, fire } = advanceTimeline(timeline, distToManeuver, triggers, justPassed);
    timeline = state;
    if (fire) playHaptic(fire, opts.profile, { mode: opts.mode, custom: opts.custom });
    if (state.stage === 'done') { maneuverIdx++; timeline = null; }
  }

  // Banner state.
  const etaMs = now + (route.timeS ? (remaining / Math.max(1, route.lengthM)) * route.timeS * 1000 : 0);
  const legStart = maneuverIdx > 0 ? route.maneuvers[maneuverIdx].lengthM : m.lengthM;
  const progress = legStart > 0 ? Math.max(0, Math.min(1, 1 - distToManeuver / legStart)) : 0;
  setBanner({
    active: true, event: m.event, instruction: m.instruction, roadName: m.roadName,
    distanceToManeuver: Math.round(distToManeuver), remainingM: Math.round(remaining),
    etaEpochMs: Math.round(etaMs), progress,
    verdict, arrived: stepped.arrived,
    thenEvent: showThen ? after!.event : null, thenRoadName: showThen ? after!.roadName : '',
  });
}

/** Start a real navigation session. Requests location permission, fetches the
 *  first route, and watches GPS until stopNavigation(). */
export async function startNavigation(o: StartNavOpts): Promise<void> {
  await stopNavigation();
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw navUserError(NAV_PERMISSION_TEXT);

  opts = o; dest = o.to;
  const from = o.from ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })).coords;
  const fromLL: LatLng = 'lat' in (from as any) ? (from as LatLng) : { lat: (from as any).latitude, lng: (from as any).longitude };
  route = o.route && o.route.shape.length > 1
    ? o.route
    : await fetchRoute(fromLL, o.to, o.costing ?? 'auto', o.routeOpts);
  setRouteGeometry(route);
  maneuverIdx = 0; timeline = null; last = null;
  startVoiceGuide(o.mode ?? 'vibrationOnly');
  setBanner({ ...IDLE, active: true, totalM: route.lengthM });
  setGeo({ shape: route.shape, dest: o.to, pos: fromLL, heading: 0 });

  watcher = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 4 },
    onFix,
  );
}

/** End the session — stop GPS, stop any looping buzz, clear the banner. */
export async function stopNavigation(): Promise<void> {
  try { watcher?.remove(); } catch {}
  watcher = null; route = null; timeline = null; dest = null; opts = null; last = null; rerouting = false;
  setRouteGeometry(null);   // do not keep a journey's geometry after it ends
  stopHaptics();
  stopVoiceGuide();
  setBanner(IDLE);
  setGeo(GEO_IDLE);
}

export default {};
