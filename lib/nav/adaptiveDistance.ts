// lib/nav/adaptiveDistance.ts — the "when to alert" brain. Instead of a fixed
// 100/200/400 m, compute soft/medium/strong trigger distances from physics:
// reaction distance + the distance needed to slow to a safe turn speed + a GPS-
// uncertainty margin, scaled by road class and the user's early/normal/late
// preference. Pure → runnable in tsx. Distances in metres, speeds in m/s.

export type RoadClass = 'highway' | 'primary' | 'city' | 'residential';
export type NotifTiming = 'early' | 'normal' | 'late';

export interface AdaptiveInput {
  speed: number;              // current speed, m/s
  turnAngle: number;          // maneuver sharpness, degrees 0 (straight) .. 180 (U-turn)
  gpsAccuracy?: number;       // horizontal accuracy, m (default 8)
  reactionTime?: number;      // driver reaction, s (default 1.5)
  roadClass?: RoadClass;      // default 'primary'
  timing?: NotifTiming;       // user preference (default 'normal')
  decel?: number;             // comfortable deceleration, m/s² (default 2.5)
}
export interface TriggerDistances { soft: number; medium: number; strong: number }

const MIN_TRIGGER = 20;       // never alert closer than this
const MAX_TRIGGER = 1200;     // nor absurdly far

const ROAD_MULT: Record<RoadClass, number> = { highway: 1.35, primary: 1.0, city: 0.85, residential: 0.8 };
const TIMING_MULT: Record<NotifTiming, number> = { early: 1.3, normal: 1.0, late: 0.8 };

/** Safe speed (m/s) to take a turn of `angle` degrees — sharper ⇒ slower. */
export function turnTargetSpeed(angle: number): number {
  const a = Math.abs(angle);
  if (a < 20) return Infinity;   // straight / slight → no slowing needed
  if (a < 50) return 11;         // ~40 km/h
  if (a < 100) return 6;         // ~22 km/h — a normal turn
  if (a < 160) return 4;         // sharp
  return 3;                      // U-turn crawl
}

/** Compute soft/medium/strong trigger distances for an upcoming maneuver. */
export function triggerDistances(input: AdaptiveInput): TriggerDistances {
  const v = Math.max(0, input.speed);
  const reaction = input.reactionTime ?? 1.5;
  const gps = input.gpsAccuracy ?? 8;
  const decel = input.decel ?? 2.5;
  const roadMult = ROAD_MULT[input.roadClass ?? 'primary'];
  const timeMult = TIMING_MULT[input.timing ?? 'normal'];

  const vTarget = turnTargetSpeed(input.turnAngle);
  // distance to bleed off speed to the safe turn speed (0 if we're already slow enough)
  const decelDist = vTarget >= v ? 0 : (v * v - vTarget * vTarget) / (2 * decel);
  const reactionDist = v * reaction;
  const gpsMargin = 2 * gps;               // alert earlier when the fix is fuzzy

  // "strong" = must-act-now distance; soft/medium are earlier heads-ups.
  const strongRaw = (reactionDist + decelDist + gpsMargin + 8) * roadMult * timeMult;
  const strong = clamp(strongRaw);
  const medium = clamp(strongRaw * 1.9);
  const soft = clamp(strongRaw * 3.4);
  return { soft, medium, strong };
}

function clamp(d: number): number { return Math.round(Math.max(MIN_TRIGGER, Math.min(MAX_TRIGGER, d))); }

// ── self-check: `npx tsx lib/nav/adaptiveDistance.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('adaptiveDistance: ' + m); };

  const base: AdaptiveInput = { speed: 14, turnAngle: 90 }; // ~50 km/h, normal turn
  const b = triggerDistances(base);

  // monotonic + clamped
  A(b.soft >= b.medium && b.medium >= b.strong, 'soft ≥ medium ≥ strong');
  A(b.strong >= MIN_TRIGGER && b.soft <= MAX_TRIGGER, 'within clamp');

  // faster → alert earlier (larger)
  A(triggerDistances({ ...base, speed: 28 }).strong > b.strong, 'faster ⇒ farther');

  // sharper turn → farther (more decel)
  A(triggerDistances({ ...base, turnAngle: 170 }).strong > b.strong, 'sharper ⇒ farther');
  // straight/slight → no decel component (smaller than a sharp turn at same speed)
  A(triggerDistances({ ...base, turnAngle: 5 }).strong < b.strong, 'straight ⇒ nearer');

  // worse GPS → farther
  A(triggerDistances({ ...base, gpsAccuracy: 40 }).strong > b.strong, 'fuzzy GPS ⇒ farther');

  // highway > city at same inputs; early > late
  A(triggerDistances({ ...base, roadClass: 'highway' }).strong > triggerDistances({ ...base, roadClass: 'city' }).strong, 'highway > city');
  A(triggerDistances({ ...base, timing: 'early' }).strong > triggerDistances({ ...base, timing: 'late' }).strong, 'early > late');

  // target speed monotonic by sharpness
  A(turnTargetSpeed(10) === Infinity && turnTargetSpeed(90) === 6 && turnTargetSpeed(180) === 3, 'target-speed buckets');

  // stopped car (speed 0) still gives a sane minimum, not 0/NaN
  const stopped = triggerDistances({ speed: 0, turnAngle: 90 });
  A(stopped.strong >= MIN_TRIGGER && Number.isFinite(stopped.soft), 'speed 0 sane');

  console.log('adaptiveDistance self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
