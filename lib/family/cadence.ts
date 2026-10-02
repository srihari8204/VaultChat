// lib/family/cadence.ts — how often a Family Space presence ping is PUBLISHED,
// as a function of how the phone is moving (tasks F1.4 + F2.3).
//
// Before this, `presence.onFix` emitted on every single fix. With the watcher
// pinned at 8 s / 15 m that is ~450 sealed blobs an hour from a phone sitting
// on a desk, each one a radio wake — the dominant cost of leaving sharing on,
// and the reason "share my location" felt like a battery switch.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not re-arm the GPS watcher. The
// watcher keeps its existing cadence, so every fix still reaches the geofence
// engine and the history store at full resolution — safe zones stay exactly as
// accurate as they are today, and no fix is ever dropped. Only the network
// emit is throttled, which is precisely what F1.4 asks for ("publish on the
// existing socket at an adaptive interval").
//
// Pure — no RN imports, no storage. Self-check:
//   node --experimental-strip-types lib/family/cadence.ts
//
// ponytail: throttling the emit saves the radio, not the GPS chip. Driving the
// watcher itself from the motion state would save more, but re-arming
// `watchPositionAsync` mid-session risks a fix gap, so it is left for a change
// that can be field-tested on a real device.

import { STALE_MS } from './types';

export type MotionState = 'stationary' | 'walking' | 'driving';

/**
 * Speed thresholds, m/s, with separate enter/exit values so a phone hovering on
 * a boundary cannot flap between states on GPS noise — the same hysteresis idea
 * as geofence.ts, applied to speed instead of distance.
 */
export const WALK_ENTER = 0.7;   // ~2.5 km/h — above this you are on foot
export const WALK_EXIT  = 0.4;   // fall back to stationary only below this
export const DRIVE_ENTER = 3.5;  // ~12.6 km/h — above this you are in a vehicle
export const DRIVE_EXIT  = 2.5;  // drop to walking only below this

/** Publish interval = base × this, per state. Driving keeps the user's setting. */
export const STATE_MULTIPLIER: Record<MotionState, number> = {
  driving: 1,
  walking: 2,
  stationary: 8,
};

/** Never publish faster than this, whatever the caller asks for. */
export const MIN_PUBLISH_MS = 4_000;

/**
 * Never publish SLOWER than this. This is not a tuning knob — it is a
 * correctness bound. A receiver dims a member as stale once their last fix is
 * older than STALE_MS (90 s), so a publish gap at or beyond that would show a
 * perfectly healthy, sharing member as "stale" on everyone else's map. Two
 * thirds of the stale window leaves room for one lost packet.
 */
export const MAX_PUBLISH_MS = Math.round((STALE_MS * 2) / 3);   // 60_000

/**
 * Fold a new speed reading into the motion state.
 *
 * A fix with no speed (`undefined` — common indoors, and on the first fix after
 * a cold start) KEEPS the previous state rather than guessing. Treating absent
 * speed as zero would silently demote a moving car to `stationary` and stretch
 * its publish interval to a minute.
 */
export function nextMotion(prev: MotionState, speed?: number): MotionState {
  if (speed == null || !Number.isFinite(speed) || speed < 0) return prev;
  switch (prev) {
    case 'driving':
      return speed < DRIVE_EXIT ? (speed < WALK_EXIT ? 'stationary' : 'walking') : 'driving';
    case 'walking':
      if (speed >= DRIVE_ENTER) return 'driving';
      return speed < WALK_EXIT ? 'stationary' : 'walking';
    default: // stationary
      if (speed >= DRIVE_ENTER) return 'driving';
      return speed >= WALK_ENTER ? 'walking' : 'stationary';
  }
}

/** The publish interval for a state, given the user's configured moving cadence. */
export function publishIntervalMs(state: MotionState, baseMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : MIN_PUBLISH_MS;
  const raw = base * STATE_MULTIPLIER[state];
  return Math.round(Math.max(MIN_PUBLISH_MS, Math.min(MAX_PUBLISH_MS, raw)));
}

/**
 * Is a publish due? `lastPublishAt = 0` means "never published on this session",
 * which always publishes — so toggling sharing on, or an SOS, reaches the circle
 * immediately instead of waiting out a stationary interval.
 */
export function shouldPublish(
  lastPublishAt: number,
  now: number,
  state: MotionState,
  baseMs: number,
): boolean {
  if (!lastPublishAt) return true;
  if (now < lastPublishAt) return true;          // clock moved backwards — don't stall
  return now - lastPublishAt >= publishIntervalMs(state, baseMs);
}

// ── self-check ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('cadence: ' + m); };

  // classification from rest
  A(nextMotion('stationary', 0) === 'stationary', 'still at 0');
  A(nextMotion('stationary', 1.2) === 'walking', '1.2 m/s ⇒ walking');
  A(nextMotion('stationary', 14) === 'driving', '14 m/s ⇒ driving');

  // hysteresis: between exit and enter you KEEP the current state
  A(nextMotion('walking', 0.5) === 'walking', '0.5 holds walking (above WALK_EXIT)');
  A(nextMotion('stationary', 0.5) === 'stationary', '0.5 holds stationary (below WALK_ENTER)');
  // the band itself: 3.0 m/s sits between DRIVE_EXIT and DRIVE_ENTER, so the
  // SAME speed resolves to a different state depending on where you came from.
  A(nextMotion('driving', 3.0) === 'driving', '3.0 holds driving (above DRIVE_EXIT)');
  A(nextMotion('walking', 3.0) === 'walking', '3.0 does not yet enter driving');
  A(nextMotion('driving', 2.4) === 'walking', '2.4 finally leaves driving');

  // a red light does not demote a car all the way to stationary in one step
  A(nextMotion('driving', 0.6) === 'walking', 'driving ⇒ walking at 0.6, not stationary');
  A(nextMotion('driving', 0.1) === 'stationary', 'fully stopped ⇒ stationary');

  // absent / bogus speed keeps the previous state
  A(nextMotion('driving', undefined) === 'driving', 'no speed keeps driving');
  A(nextMotion('walking', NaN) === 'walking', 'NaN keeps walking');
  A(nextMotion('driving', -1) === 'driving', 'negative sentinel keeps driving');

  // intervals at the shipped default (8 s)
  A(publishIntervalMs('driving', 8000) === 8000, 'driving = base');
  A(publishIntervalMs('walking', 8000) === 16000, 'walking = 2x');
  A(publishIntervalMs('stationary', 8000) === 60000, 'stationary clamps to MAX (8x would be 64s)');

  // THE correctness bound: a healthy sharer must never look stale
  A(MAX_PUBLISH_MS < STALE_MS, 'max publish must stay inside the stale window');
  for (const s of ['stationary', 'walking', 'driving'] as MotionState[]) {
    for (const base of [1, 8000, 30_000, 10 ** 9]) {
      const ms = publishIntervalMs(s, base);
      A(ms >= MIN_PUBLISH_MS && ms <= MAX_PUBLISH_MS, `clamped for ${s}/${base}`);
      A(ms < STALE_MS, `never stale for ${s}/${base}`);
    }
  }
  // garbage base falls back rather than producing NaN
  A(Number.isFinite(publishIntervalMs('driving', NaN)), 'NaN base is finite');
  A(publishIntervalMs('driving', 0) === MIN_PUBLISH_MS, '0 base floors');

  // ordering: never publish more often while parked than while driving
  A(publishIntervalMs('stationary', 8000) >= publishIntervalMs('walking', 8000), 'stationary ≥ walking');
  A(publishIntervalMs('walking', 8000) >= publishIntervalMs('driving', 8000), 'walking ≥ driving');

  // due-ness
  A(shouldPublish(0, 1_000_000, 'stationary', 8000), 'first publish is always due');
  A(!shouldPublish(1_000_000, 1_005_000, 'stationary', 8000), '5 s into a 60 s parked gap: not due');
  A(shouldPublish(1_000_000, 1_061_000, 'stationary', 8000), '61 s parked: due');
  A(shouldPublish(1_000_000, 1_008_000, 'driving', 8000), '8 s driving: due');
  A(!shouldPublish(1_000_000, 1_007_999, 'driving', 8000), '7.999 s driving: not due');
  A(shouldPublish(1_000_000, 999_000, 'driving', 8000), 'backwards clock publishes');

  console.log('family/cadence self-check OK');
}
// Runnable both ways: `npx tsx lib/family/cadence.ts` (CommonJS, how the other
// self-checks run) and `node --experimental-strip-types lib/family/cadence.ts`
// (ES module, which has no `require`/`module`).
declare const require: any; declare const module: any; declare const process: any;
const _isMain =
  typeof require !== 'undefined' && typeof module !== 'undefined'
    ? require.main === module
    : typeof process !== 'undefined' && /[\\/]cadence\.ts$/.test(String(process.argv?.[1] ?? ''));
if (_isMain) _selfCheck();
