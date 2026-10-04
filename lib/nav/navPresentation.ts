// lib/nav/navPresentation.ts — what the navigation UI SHOWS, as data.
//
// The camera ladder and the off-route wording are decisions, not rendering, so
// they live here where they can be asserted without a renderer — the same rule
// lib/spaces/layout.ts follows for space sections. components/family/NavigationLayer
// only draws what these functions return.
//
// PURE. Runnable and self-checked:  npx tsx lib/nav/navPresentation.ts

import type { OffRouteVerdict } from './routeProgress';

// ── camera ladder (spec §14, §18) ─────────────────────────────────────

/**
 * The seven camera states, in the order a journey passes through them.
 * `overview` and `member` are pre-navigation; the rest are live guidance.
 */
export type CameraStage =
  | 'family'      // everyone in frame
  | 'member'      // one member selected
  | 'route'       // the whole route fitted
  | 'navigating'  // chase cam, normal
  | 'approaching' // a maneuver is near
  | 'turn'        // at the maneuver
  | 'arriving';   // destination in sight

export interface CameraPlan {
  stage: CameraStage;
  /** MapLibre zoom level. */
  zoom: number;
  /** Camera pitch, degrees. Flat for overviews, pitched while guiding. */
  pitch: number;
  /** True when the camera should rotate to the travel heading. */
  headingUp: boolean;
}

/**
 * Zoom by distance to the next maneuver (spec §18).
 *
 * THE BANDS ARE DELIBERATELY WIDE AND THE HYSTERESIS IS BUILT INTO THEIR EDGES.
 * A naive `zoom = f(distance)` recomputed every fix makes the camera breathe in
 * and out continuously, which reads as a fault and is the single most common
 * way a navigation map feels cheap. Discrete bands mean the camera moves only
 * when the driver has genuinely crossed a threshold, and `stageFor` below
 * refuses to step back out until the distance has grown well past the boundary
 * it came in on.
 */
const BANDS: { maxM: number; stage: CameraStage; zoom: number; pitch: number }[] = [
  { maxM: 50, stage: 'turn', zoom: 18.5, pitch: 60 },
  { maxM: 120, stage: 'approaching', zoom: 17.8, pitch: 58 },
  { maxM: 250, stage: 'approaching', zoom: 17.2, pitch: 55 },
  { maxM: 500, stage: 'navigating', zoom: 16.6, pitch: 52 },
  { maxM: Infinity, stage: 'navigating', zoom: 16.0, pitch: 50 },
];

/** How far past a band's edge the distance must grow before we zoom back out. */
export const ZOOM_HYSTERESIS_M = 40;

/**
 * Pick the camera for a live navigation frame.
 *
 * `prev` is the previous plan, and passing it is what prevents oscillation: a
 * band is only left when the distance exceeds its boundary by
 * ZOOM_HYSTERESIS_M. Pass `null` on the first frame.
 */
export function cameraForManeuver(
  distToManeuverM: number,
  remainingM: number,
  prev: CameraPlan | null,
): CameraPlan {
  // Destination in sight outranks any maneuver band: the last 80 m is about
  // finding the door, not about a turn.
  if (remainingM <= 80) {
    return { stage: 'arriving', zoom: 18.0, pitch: 45, headingUp: true };
  }

  let i = BANDS.findIndex((b) => distToManeuverM <= b.maxM);
  if (i < 0) i = BANDS.length - 1;

  // Hysteresis: only widen (a HIGHER index = further away = wider) once the
  // distance has cleared the previous band's edge by the margin.
  if (prev) {
    const prevI = BANDS.findIndex((b) => b.stage === prev.stage && b.zoom === prev.zoom);
    if (prevI >= 0 && i > prevI) {
      const edge = BANDS[prevI].maxM;
      if (distToManeuverM < edge + ZOOM_HYSTERESIS_M) i = prevI;
    }
  }

  const b = BANDS[i];
  return { stage: b.stage, zoom: b.zoom, pitch: b.pitch, headingUp: true };
}

/** The pre-navigation camera stages, which are about framing, not guidance. */
export function cameraForStage(stage: 'family' | 'member' | 'route'): CameraPlan {
  switch (stage) {
    case 'family': return { stage: 'family', zoom: 13, pitch: 0, headingUp: false };
    case 'member': return { stage: 'member', zoom: 16, pitch: 0, headingUp: false };
    case 'route': return { stage: 'route', zoom: 14, pitch: 0, headingUp: false };
  }
}

// ── off-route wording (spec §19) ──────────────────────────────────────

export interface OffRouteBannerState {
  /** Null = draw nothing. */
  text: string | null;
  /** 'info' while uncertain, 'warn' once confirmed. Never color-only — the
   *  text says which it is (spec §29). */
  tone: 'info' | 'warn';
  /** Show a manual Reroute button (automatic recovery failed). */
  showRerouteButton: boolean;
  busy: boolean;
}

/**
 * Turn an engine verdict into what the user reads.
 *
 * The ladder matters: `temporarily_uncertain` must NOT alarm anyone, because
 * most of the time it resolves by itself within a fix or two and an app that
 * cries "You're off route" at every underpass gets ignored exactly when it is
 * right. Only a confirmed excursion says so.
 */
export function offRouteBanner(
  verdict: OffRouteVerdict,
  rerouting: boolean,
  rerouteFailed: boolean,
): OffRouteBannerState {
  if (rerouting) {
    return { text: 'Recalculating…', tone: 'info', showRerouteButton: false, busy: true };
  }
  if (rerouteFailed) {
    return { text: 'Could not find a new route', tone: 'warn', showRerouteButton: true, busy: false };
  }
  switch (verdict) {
    case 'temporarily_uncertain':
      return { text: 'Checking route…', tone: 'info', showRerouteButton: false, busy: true };
    case 'off_route':
      return { text: "You're off route", tone: 'warn', showRerouteButton: true, busy: false };
    case 'reroute_required':
      return { text: 'Recalculating…', tone: 'info', showRerouteButton: false, busy: true };
    case 'on_route':
    default:
      return { text: null, tone: 'info', showRerouteButton: false, busy: false };
  }
}

// ── distance + ETA formatting (spec §16) ──────────────────────────────

/**
 * The countdown the user watches. Precision INCREASES as the number shrinks,
 * because "2.8 km" and "950 m" are each the useful form at their own scale and
 * "2.847 km" is useful at none.
 */
export function formatDistance(m: number): string {
  if (!isFinite(m) || m < 0) return '—';
  if (m < 10) return 'Arrived';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** "6 min" / "1 h 12 min". Never "0 min" — that reads as broken, not as close. */
export function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/**
 * The "Then" chip (maneuver after next) shows only when that maneuver follows
 * the next one closely — far apart, it is noise the driver does not need yet.
 */
export const THEN_CHIP_MAX_GAP_M = 300;
export function showThenManeuver(gapM: number): boolean {
  return Number.isFinite(gapM) && gapM >= 0 && gapM <= THEN_CHIP_MAX_GAP_M;
}

/** "LEFT IN 120 m" — the maneuver capsule's line (spec §17). */
export function maneuverLine(instruction: string, distM: number): string {
  const d = formatDistance(distM);
  if (d === 'Arrived') return instruction;
  return `${instruction} in ${d}`;
}

// ── self-check: `npx tsx lib/nav/navPresentation.ts` ───────────────────
declare const require: any; declare const module: any;

function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('navPresentation: ' + m); };

  // 1. the ladder tightens as the turn approaches
  const far = cameraForManeuver(900, 5000, null);
  const mid = cameraForManeuver(300, 5000, null);
  const close = cameraForManeuver(100, 5000, null);
  const at = cameraForManeuver(30, 5000, null);
  A(far.zoom < mid.zoom && mid.zoom < close.zoom && close.zoom < at.zoom,
    'zoom must increase monotonically as the maneuver nears');
  A(at.stage === 'turn' && close.stage === 'approaching' && far.stage === 'navigating',
    'stages must follow the distance bands');

  // 2. THE OSCILLATION GUARD. Crossing a boundary back and forth by a metre
  //    must not move the camera — this is the assertion that keeps the map
  //    from breathing, and the reason `prev` is a parameter at all.
  const inBand = cameraForManeuver(115, 5000, null);
  const justOut = cameraForManeuver(125, 5000, inBand);
  A(justOut.zoom === inBand.zoom, 'a 10 m wobble past a band edge must not zoom out');
  const wellOut = cameraForManeuver(200, 5000, inBand);
  A(wellOut.zoom < inBand.zoom, 'clearing the edge by the margin does zoom out');

  // 3. arrival outranks the maneuver bands
  const arriving = cameraForManeuver(400, 60, null);
  A(arriving.stage === 'arriving', 'the last 80 m is an arrival, whatever the next turn says');

  // 4. pre-nav stages are flat and north-up
  for (const s of ['family', 'member', 'route'] as const) {
    A(cameraForStage(s).pitch === 0 && !cameraForStage(s).headingUp,
      `${s} camera should be flat and north-up`);
  }
  A(cameraForStage('family').zoom < cameraForStage('member').zoom, 'family view is wider than one member');

  // 5. off-route wording never alarms early
  A(offRouteBanner('on_route', false, false).text === null, 'on route draws nothing');
  A(offRouteBanner('temporarily_uncertain', false, false).text === 'Checking route…',
    'uncertainty must not accuse');
  A(offRouteBanner('temporarily_uncertain', false, false).tone === 'info', 'uncertainty is info, not warn');
  A(offRouteBanner('off_route', false, false).text === "You're off route", 'a confirmed excursion says so');
  A(offRouteBanner('off_route', false, false).showRerouteButton, 'a confirmed excursion offers a manual reroute');
  A(offRouteBanner('off_route', true, false).text === 'Recalculating…', 'rerouting outranks the verdict');
  A(offRouteBanner('on_route', false, true).showRerouteButton, 'a failed reroute must leave a way to retry');

  // 6. distance formatting gains precision as it shrinks
  A(formatDistance(2847) === '2.8 km', `2847 -> 2.8 km, got ${formatDistance(2847)}`);
  A(formatDistance(950) === '950 m', `950 -> 950 m, got ${formatDistance(950)}`);
  A(formatDistance(423) === '420 m', `423 -> 420 m, got ${formatDistance(423)}`);
  A(formatDistance(45000) === '45 km', '45000 -> 45 km');
  A(formatDistance(5) === 'Arrived', 'under 10 m is arrival');
  A(formatDistance(-1) === '—' && formatDistance(NaN) === '—', 'nonsense formats as a dash');

  // 7. ETA never says "0 min"
  A(formatEta(20) === '1 min', 'a few seconds rounds up to 1 min, never 0');
  A(formatEta(360) === '6 min', '360 s -> 6 min');
  A(formatEta(4320) === '1 h 12 min', '4320 s -> 1 h 12 min');

  // 8. the maneuver line
  A(maneuverLine('Turn left', 120) === 'Turn left in 120 m', 'maneuver line reads naturally');
  A(maneuverLine('Arrive', 4) === 'Arrive', 'an arrival needs no distance suffix');

  // 9. the "Then" chip only for a maneuver that follows closely
  A(showThenManeuver(120) && showThenManeuver(THEN_CHIP_MAX_GAP_M), 'a close follow-up maneuver shows Then');
  A(!showThenManeuver(THEN_CHIP_MAX_GAP_M + 1) && !showThenManeuver(Infinity) && !showThenManeuver(-5),
    'a distant, missing or nonsense gap shows nothing');

  console.log('navPresentation self-check: OK');
}

if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
