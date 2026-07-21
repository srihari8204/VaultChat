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
import { detectMissedTurn, offRouteFrom } from './missedTurn';
import { playHaptic, stopHaptics, type DisplayMode } from './hapticPlayer';
import { fetchRoute, type Route, type Costing, type Maneuver } from './routing';
import { type NavProfile, type HapticEvent, type HapticPattern } from './hapticLanguage';

export interface NavBanner {
  active: boolean;
  event: HapticEvent | null;   // direction icon the banner draws
  instruction: string;
  roadName: string;
  distanceToManeuver: number;  // m to the next maneuver
  remainingM: number;          // m to destination
  etaEpochMs: number;          // arrival time
  progress: number;            // 0..1 toward the next maneuver (banner's shrinking line)
  rerouting: boolean;
}
const IDLE: NavBanner = { active: false, event: null, instruction: '', roadName: '', distanceToManeuver: 0, remainingM: 0, etaEpochMs: 0, progress: 0, rerouting: false };

// ── tiny external store for the banner ──
let banner: NavBanner = IDLE;
const subs = new Set<() => void>();
function setBanner(patch: Partial<NavBanner>) { banner = { ...banner, ...patch }; subs.forEach((c) => { try { c(); } catch {} }); }
export function getNavBanner(): NavBanner { return banner; }
export function useNavBanner(): NavBanner {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => banner, () => banner);
}

export interface StartNavOpts {
  to: LatLng; from?: LatLng; costing?: Costing;
  profile: NavProfile; mode?: DisplayMode; custom?: Partial<Record<HapticEvent, HapticPattern>>;
  timing?: NotifTiming;
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

// Nearest shape vertex to a position (index).
function nearestIndex(shape: LatLng[], pos: LatLng, from = 0): number {
  let best = from, bestD = Infinity;
  for (let i = from; i < shape.length; i++) {
    const d = haversine(shape[i], pos);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
// Along-route distance from pos (near `nearIdx`) forward to shape[toIdx].
function alongRoute(shape: LatLng[], pos: LatLng, nearIdx: number, toIdx: number): number {
  if (toIdx <= nearIdx) return haversine(pos, shape[Math.min(toIdx, shape.length - 1)]);
  let d = haversine(pos, shape[nearIdx]);
  for (let i = nearIdx; i < toIdx && i + 1 < shape.length; i++) d += haversine(shape[i], shape[i + 1]);
  return d;
}

async function reroute() {
  if (!dest || !opts || !last || rerouting) return;
  rerouting = true; setBanner({ rerouting: true });
  playHaptic('reroute', opts.profile, { mode: opts.mode, custom: opts.custom });
  try {
    route = await fetchRoute(last.pos, dest, opts.costing ?? 'auto');
    maneuverIdx = 0; timeline = null;
  } catch { /* keep the old route; next fix retries via missed-turn */ }
  finally { rerouting = false; setBanner({ rerouting: false }); }
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

  const shape = route.shape;
  const near = nearestIndex(shape, pos);

  // Advance past any maneuvers we've already reached.
  while (maneuverIdx < route.maneuvers.length && route.maneuvers[maneuverIdx].beginIndex < near - 1) maneuverIdx++;
  const m: Maneuver | undefined = route.maneuvers[maneuverIdx];
  if (!m) { setBanner({ active: true, event: 'destination', instruction: 'Arrive', roadName: '', distanceToManeuver: 0, progress: 1 }); return; }

  const distToManeuver = alongRoute(shape, pos, near, m.beginIndex);
  const remaining = alongRoute(shape, pos, near, shape.length - 1);

  // Missed-turn: off-route beyond GPS margin, or passed the turn still heading straight.
  const segEnd = shape[Math.min(near + 1, shape.length - 1)];
  const offRoute = offRouteFrom(pos, shape[near], segEnd);
  const afterPt = shape[Math.min(m.beginIndex + 1, shape.length - 1)];
  const expectedAfter = bearing(m.point, afterPt);
  const pastManeuver = m.beginIndex < near ? alongRoute(shape, m.point, m.beginIndex, near) : -distToManeuver;
  const miss = detectMissedTurn({ offRouteMeters: offRoute, metersPastManeuver: pastManeuver, heading, expectedHeadingAfter: expectedAfter, gpsAccuracy: acc });
  if (miss.missed) {
    playHaptic('missedTurn', opts.profile, { mode: opts.mode, custom: opts.custom });
    reroute();
  } else if (m.event) {
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
  setBanner({ active: true, event: m.event, instruction: m.instruction, roadName: m.roadName, distanceToManeuver: Math.round(distToManeuver), remainingM: Math.round(remaining), etaEpochMs: Math.round(etaMs), progress });
}

/** Start a real navigation session. Requests location permission, fetches the
 *  first route, and watches GPS until stopNavigation(). */
export async function startNavigation(o: StartNavOpts): Promise<void> {
  await stopNavigation();
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location permission is required for navigation.');

  opts = o; dest = o.to;
  const from = o.from ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })).coords;
  const fromLL: LatLng = 'lat' in (from as any) ? (from as LatLng) : { lat: (from as any).latitude, lng: (from as any).longitude };
  route = await fetchRoute(fromLL, o.to, o.costing ?? 'auto');
  maneuverIdx = 0; timeline = null; last = null;
  setBanner({ ...IDLE, active: true });

  watcher = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 4 },
    onFix,
  );
}

/** End the session — stop GPS, stop any looping buzz, clear the banner. */
export async function stopNavigation(): Promise<void> {
  try { watcher?.remove(); } catch {}
  watcher = null; route = null; timeline = null; dest = null; opts = null; last = null; rerouting = false;
  stopHaptics();
  setBanner(IDLE);
}

export default {};
