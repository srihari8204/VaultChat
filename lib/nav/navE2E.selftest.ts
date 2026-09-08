// lib/nav/navE2E.selftest.ts — a whole journey, driven end to end, headless.
//
// WHAT THIS IS FOR
//
// The unit checks in routeProgress.ts and navPresentation.ts each prove one
// function. They cannot prove that a DRIVE works: that remaining distance only
// ever falls, that the camera does not pump, that one bad fix never reroutes
// but four consecutive ones do, that returning to the road clears the banner,
// and that arrival fires once at the end and not before. Those are properties
// of the sequence, and this file simulates the sequence.
//
// It drives the REAL modules — lib/nav/native/NavCore (which falls back to
// routeProgress under Node, exercising exactly the path an iOS build or a
// cargo-ndk-less build takes) and lib/nav/navPresentation. Nothing is mocked
// except the GPS, which is the only thing that cannot be present on a bench.
//
// It does NOT replace device testing. It proves the engine; pixels, gestures
// and permissions still need a phone.
//
// Run:  npx tsx lib/nav/navE2E.selftest.ts

import {
  syntheticRoute, buildGeometry, project,
  type NavStepInput,
} from './routeProgress';
import * as NavCore from './native/NavCore';
import { cameraForManeuver, offRouteBanner, formatDistance, formatEta, type CameraPlan } from './navPresentation';
import { haversine, destination, type LatLng } from './geo';

const A = (c: boolean, m: string) => { if (!c) throw new Error('navE2E: ' + m); };
let checks = 0;
const ok = (c: boolean, m: string) => { A(c, m); checks++; };

// ── the simulated drive ───────────────────────────────────────────────

interface Fix { lat: number; lng: number; accuracyM: number; speedMps: number; tsMs: number }

/** Deterministic pseudo-noise — a seeded LCG, so a failure is reproducible.
 *  Math.random() here would make this test flaky and useless. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/** Walk the route, emitting a fix per simulated second. */
function* drive(shape: LatLng[], opts: {
  jitterM?: number;
  detourFrom?: number;        // index at which to leave the road
  detourFixes?: number;       // how many fixes to stay away
  detourM?: number;           // how far off
  singleOutlierAt?: number;   // one wild fix, then straight back
  seed?: number;
}): Generator<Fix & { i: number; detoured: boolean }> {
  const rand = rng(opts.seed ?? 42);
  const jit = opts.jitterM ?? 0;
  let ts = 1_000_000;
  for (let i = 0; i < shape.length; i++) {
    let p = shape[i];
    let detoured = false;

    if (opts.detourFrom != null && i >= opts.detourFrom && i < opts.detourFrom + (opts.detourFixes ?? 0)) {
      p = destination(p, 90, opts.detourM ?? 300);
      detoured = true;
    }
    if (opts.singleOutlierAt === i) {
      p = destination(p, 270, 400);
      detoured = true;
    }
    if (jit > 0) {
      p = destination(p, rand() * 360, rand() * jit);
    }
    ts += 1000;
    // Decelerate over the last stretch, the way a driver actually arrives.
    // This matters: arrival deliberately requires proximity AND a slowdown, so
    // a simulation that barrels through the destination at 9 m/s would never
    // arrive — correctly. The first run of this file asserted the arrival and
    // failed for exactly that reason, which is the rule working.
    const left = shape.length - 1 - i;
    const speedMps = left > 12 ? 9 : Math.max(0.8, 9 * (left / 12));
    yield { i, lat: p.lat, lng: p.lng, accuracyM: 6, speedMps, tsMs: ts, detoured };
  }
}

// ── 1. a clean journey ────────────────────────────────────────────────

function cleanJourney() {
  const shape = syntheticRoute(400);
  const geom = buildGeometry(shape);
  const total = NavCore.setRoute(shape);
  ok(Math.abs(total - geom.lengthM) < 0.01, 'setRoute must report the geometry length');
  ok(NavCore.activeBackend() !== 'none', 'a session must be active after setRoute');

  let prevRemaining = Infinity;
  let arrivedAt = -1;
  let prevIndex = 0;
  let cam: CameraPlan | null = null;
  let zoomFlips = 0;
  let prevZoom = -1;
  let sawManeuverCountdown = false;
  let lastDistToMan = Infinity;
  const MANEUVER_AT = 300;

  for (const f of drive(shape, { jitterM: 0 })) {
    const input: NavStepInput = {
      lat: f.lat, lng: f.lng, accuracyM: f.accuracyM, speedMps: f.speedMps,
      headingDeg: 0, tsMs: f.tsMs, prevIndex, maneuverBeginIndex: MANEUVER_AT,
    };
    const out = NavCore.step(input, shape)!;
    ok(!!out, 'every fix must produce a step');
    prevIndex = out.index;

    // 6/7 — live progress + remaining distance only ever fall.
    ok(out.remainingM <= prevRemaining + 0.5,
      `remaining must not increase (i=${f.i}: ${out.remainingM} > ${prevRemaining})`);
    prevRemaining = out.remainingM;

    // 13 — a clean drive is never off route.
    ok(out.verdict === 'on_route', `a clean drive must stay on_route (i=${f.i}, got ${out.verdict})`);

    // 9 — the maneuver counts down while it is ahead.
    if (f.i < MANEUVER_AT) {
      ok(out.distToManeuverM <= lastDistToMan + 0.5, `maneuver distance must count down (i=${f.i})`);
      if (out.distToManeuverM < lastDistToMan) sawManeuverCountdown = true;
      lastDistToMan = out.distToManeuverM;
    }

    // 10 — camera ladder, and it must not pump.
    cam = cameraForManeuver(out.distToManeuverM, out.remainingM, cam);
    if (prevZoom >= 0 && cam.zoom !== prevZoom) zoomFlips++;
    prevZoom = cam.zoom;

    if (out.arrived && arrivedAt < 0) arrivedAt = f.i;
  }

  ok(sawManeuverCountdown, 'the maneuver distance must actually have decreased');
  // 16 — arrival fires, and only near the end.
  ok(arrivedAt >= 0, 'the journey must end in an arrival');
  ok(arrivedAt > shape.length * 0.95,
    `arrival must not fire early (fired at ${arrivedAt} of ${shape.length})`);

  // 10 — the ladder has 5 bands; a clean run may cross each once, plus the
  // arrival band. More flips than that means the camera was oscillating, which
  // is the single most visible way a nav map feels cheap.
  ok(zoomFlips <= 8, `camera changed zoom ${zoomFlips} times — that is pumping, not tracking`);

  NavCore.clearRoute();
  ok(NavCore.activeBackend() === 'none', 'clearRoute must drop the session');
  ok(NavCore.step({
    lat: 1, lng: 1, accuracyM: 5, speedMps: 0, headingDeg: 0,
    tsMs: 1, prevIndex: 0, maneuverBeginIndex: 0,
  }, shape) === null, 'a step with no route must return null, not guess');
}

// ── 2. GPS jitter must not raise a false alarm (17) ───────────────────

function jitterIsAbsorbed() {
  const shape = syntheticRoute(300);
  NavCore.setRoute(shape);
  let prevIndex = 0;
  let worst: string = 'on_route';
  for (const f of drive(shape, { jitterM: 18, seed: 7 })) {
    const out = NavCore.step({
      lat: f.lat, lng: f.lng, accuracyM: 12, speedMps: 9,
      headingDeg: 0, tsMs: f.tsMs, prevIndex, maneuverBeginIndex: shape.length - 1,
    }, shape)!;
    prevIndex = out.index;
    if (out.verdict !== 'on_route') worst = out.verdict;
  }
  ok(worst === 'on_route',
    `18 m of jitter on a 12 m fix must never leave the corridor (worst: ${worst})`);
  NavCore.clearRoute();
}

// ── 3. ONE bad sample must never reroute (14, 17) ─────────────────────

function oneOutlierNeverReroutes() {
  const shape = syntheticRoute(200);
  NavCore.setRoute(shape);
  let prevIndex = 0;
  let rerouted = false;
  for (const f of drive(shape, { singleOutlierAt: 90 })) {
    const out = NavCore.step({
      lat: f.lat, lng: f.lng, accuracyM: 6, speedMps: 9,
      headingDeg: 0, tsMs: f.tsMs, prevIndex, maneuverBeginIndex: shape.length - 1,
    }, shape)!;
    prevIndex = out.index;
    if (out.verdict === 'reroute_required') rerouted = true;
  }
  ok(!rerouted, 'a single GPS outlier must never trigger a reroute');
  NavCore.clearRoute();
}

// ── 4. a real excursion IS detected, once, and clears (13, 14, 19) ────

function realExcursionIsDetected() {
  const shape = syntheticRoute(300);
  NavCore.setRoute(shape);
  let prevIndex = 0;
  const seen: string[] = [];
  let rerouteCount = 0;
  for (const f of drive(shape, { detourFrom: 100, detourFixes: 12, detourM: 400 })) {
    const out = NavCore.step({
      lat: f.lat, lng: f.lng, accuracyM: 6, speedMps: 9,
      headingDeg: 0, tsMs: f.tsMs, prevIndex, maneuverBeginIndex: shape.length - 1,
    }, shape)!;
    prevIndex = out.index;
    seen.push(out.verdict);
    if (out.verdict === 'reroute_required') rerouteCount++;
  }
  ok(seen.includes('temporarily_uncertain'), 'an excursion must pass through uncertainty first');
  ok(seen.includes('reroute_required'), 'a sustained excursion must ask for a reroute');
  ok(rerouteCount === 1, `exactly one reroute per excursion, got ${rerouteCount}`);
  // …and the ordering: uncertainty strictly precedes the reroute request.
  ok(seen.indexOf('temporarily_uncertain') < seen.indexOf('reroute_required'),
    'the user must be told "checking" before being told "off route"');
  // 13 — returning to the road clears it.
  ok(seen[seen.length - 1] === 'on_route', 'coming back to the route must clear the excursion');
  NavCore.clearRoute();
}

// ── 5. reroute resets the excursion (14, 15) ──────────────────────────

function rerouteResetsState() {
  const shape = syntheticRoute(200);
  NavCore.setRoute(shape);
  let prevIndex = 0;
  // push it off-route until it asks for a reroute
  let asked = false;
  for (let k = 0; k < 8 && !asked; k++) {
    const off = destination(shape[50], 90, 500);
    const out = NavCore.step({
      lat: off.lat, lng: off.lng, accuracyM: 6, speedMps: 9,
      headingDeg: 0, tsMs: 1_000_000 + k * 1000, prevIndex, maneuverBeginIndex: 199,
    }, shape)!;
    prevIndex = out.index;
    if (out.verdict === 'reroute_required') asked = true;
  }
  ok(asked, 'the harness must be able to provoke a reroute');

  // A NEW route arrives (what forceReroute/reroute() does).
  const shape2 = syntheticRoute(180);
  NavCore.setRoute(shape2);
  const fresh = NavCore.step({
    lat: shape2[0].lat, lng: shape2[0].lng, accuracyM: 6, speedMps: 9,
    headingDeg: 0, tsMs: 2_000_000, prevIndex: 0, maneuverBeginIndex: 179,
  }, shape2)!;
  ok(fresh.verdict === 'on_route',
    'a fresh route must start clean — not judged by the deviation that caused it');
  NavCore.clearRoute();
}

// ── 6. a Valhalla failure must not break an in-flight journey (18) ────

function routerFailureIsSurvivable() {
  const shape = syntheticRoute(150);
  NavCore.setRoute(shape);
  let prevIndex = 0;
  // A reroute that throws leaves the OLD route in place (navigationService
  // catches and keeps `route`). The engine must keep answering from it.
  const before = NavCore.step({
    lat: shape[40].lat, lng: shape[40].lng, accuracyM: 6, speedMps: 9,
    headingDeg: 0, tsMs: 1_000_000, prevIndex, maneuverBeginIndex: 149,
  }, shape)!;
  prevIndex = before.index;
  // simulate the failed fetch: nothing is set, session untouched
  const after = NavCore.step({
    lat: shape[41].lat, lng: shape[41].lng, accuracyM: 6, speedMps: 9,
    headingDeg: 0, tsMs: 1_001_000, prevIndex, maneuverBeginIndex: 149,
  }, shape)!;
  ok(after.remainingM < before.remainingM, 'the old route keeps answering after a failed reroute');
  ok(after.verdict === 'on_route', 'a failed reroute must not manufacture an off-route state');

  // And the UI says something useful rather than nothing.
  const b = offRouteBanner('off_route', false, true);
  ok(b.showRerouteButton && b.text === 'Could not find a new route',
    'a failed automatic reroute must leave a manual way out');
  NavCore.clearRoute();
}

// ── 7. the TS fallback is the SAME journey (backend parity) ───────────

function fallbackIsIdentical() {
  const shape = syntheticRoute(250);

  const run = () => {
    NavCore.setRoute(shape);
    const out: number[] = [];
    let prevIndex = 0;
    for (const f of drive(shape, { jitterM: 4, seed: 99 })) {
      const s = NavCore.step({
        lat: f.lat, lng: f.lng, accuracyM: 6, speedMps: 9,
        headingDeg: 0, tsMs: f.tsMs, prevIndex, maneuverBeginIndex: 200,
      }, shape)!;
      prevIndex = s.index;
      out.push(Math.round(s.remainingM * 1000));
    }
    const backend = NavCore.activeBackend();
    NavCore.clearRoute();
    return { out, backend };
  };

  NavCore.preferNative(true);
  const a = run();
  NavCore.preferNative(false);
  const b = run();
  NavCore.preferNative(true);

  ok(b.backend === 'ts', 'preferNative(false) must force the TypeScript path');
  ok(a.out.length === b.out.length, 'both backends must produce the same number of fixes');
  ok(a.out.every((v, i) => v === b.out[i]),
    'the two backends must agree exactly — parity is what makes the fallback invisible');
  // Under Node there is no Nitro module, so the "native" run falls back too.
  // That is the point being asserted: the fallback path is the one that runs on
  // iOS and on any build made without cargo-ndk, and it is identical.
  ok(a.backend === 'ts', 'under Node the native module is absent and the fallback must engage');
  ok(NavCore.nativeNavInitError() !== null, 'the reason the native core is unavailable must be reportable');
}

// ── 8. presentation over a real journey (7, 8, 10) ────────────────────

function presentationHoldsUp() {
  ok(formatDistance(2847) === '2.8 km' && formatDistance(423) === '420 m',
    'distance formatting gains precision as it shrinks');
  ok(formatEta(20) === '1 min', 'ETA never reads 0 min');

  // The banner ladder, in the order a driver meets it.
  ok(offRouteBanner('on_route', false, false).text === null, 'on route: no banner');
  ok(offRouteBanner('temporarily_uncertain', false, false).tone === 'info', 'uncertainty must not alarm');
  ok(offRouteBanner('off_route', false, false).tone === 'warn', 'a confirmed excursion warns');
  ok(offRouteBanner('reroute_required', false, false).busy, 'a reroute request shows progress');

  // 12 — the camera never fights: cameraForManeuver is pure and takes the
  // previous plan, so a caller that stops calling it (user panned) simply
  // leaves the camera where the user put it. Assert the hysteresis directly.
  const a = cameraForManeuver(115, 5000, null);
  ok(cameraForManeuver(125, 5000, a).zoom === a.zoom, 'a 10 m wobble must not move the camera');
}

// ── 9. distances used by the Family overview (1) ──────────────────────

function familyDistancesAreRoadAware() {
  // The overview's straight-line fallback and the projection agree about where
  // a member is; the ROAD number comes from /nav/matrix (one call for the whole
  // family — asserted structurally in lib/nav/routing.ts's own self-check).
  const shape = syntheticRoute(120);
  const geom = buildGeometry(shape);
  const p = project(geom, shape[60], 0);
  ok(Math.abs(p.alongM - geom.cum[60]) < 1, 'a member on the route projects to their odometer point');
  const straight = haversine(shape[0], shape[60]);
  ok(p.alongM >= straight - 0.01,
    'along-route distance can never be shorter than the straight line between the same points');
}

// ── 10. privacy: routing may only consume ALREADY-AUTHORISED coordinates ──
//
// A source scan, which is why this lives in a *.selftest.ts and not in an
// embedded require.main check: Metro resolves require('fs') statically and an
// embedded one breaks assembleRelease.
//
// The rule being enforced: every coordinate that reaches a route request comes
// either from `presences` (delivered by the server under locVisibleWhere /
// locCanSee, so already authorised for this viewer) or from MY OWN saved
// places (device-local, lib/family/store). The saved-place destination chips
// added for the picker must therefore read `myPlaces` and nothing else — a
// chip sourced from another member's places would publish a coordinate this
// device is not entitled to display.

function routingOnlyUsesAuthorisedCoordinates() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  const src: string = fs.readFileSync('app/family-map.tsx', 'utf8');

  const chipBlock = src.slice(src.indexOf('SAVED PLACES'), src.indexOf('FAMILY TRIP BAR'));
  ok(chipBlock.length > 200, 'the saved-place chip block must be findable');
  ok(chipBlock.includes('myPlaces.slice'),
    'the destination chips must enumerate MY OWN places');
  ok(!/presences\[[^\]]+\]\.refs/.test(chipBlock),
    'the chips must not read the reference places another member published');
  // The only coordinate fields the chip block dereferences are on `pl` (a
  // Geofence from getPlaces, i.e. this device's own store).
  const coordReads: string[] = chipBlock.match(/(\w+)\.center\.(lat|lng)/g) ?? [];
  ok(coordReads.length > 0, 'the chips must set a destination from a place centre');
  ok(coordReads.every((m) => m.startsWith('pl.')),
    `chips may only read pl.center (own place); saw ${coordReads.join(', ')}`);

  // And nothing in this screen may route from a raw member coordinate that did
  // not come through `presences`.
  ok(!src.includes('locations/latest?all'), 'no bypass of the per-viewer location policy');
}

// ── run ───────────────────────────────────────────────────────────────

cleanJourney();
jitterIsAbsorbed();
oneOutlierNeverReroutes();
realExcursionIsDetected();
rerouteResetsState();
routerFailureIsSurvivable();
fallbackIsIdentical();
presentationHoldsUp();
familyDistancesAreRoadAware();
routingOnlyUsesAuthorisedCoordinates();

console.log(`navE2E: OK — ${checks} assertions across 10 simulated scenarios`);
