// lib/family/adaptive.ts — AdaptiveFamilyLocationEngine.
//
// Decides HOW OFTEN this device should take and publish a fix. Nothing else:
// it never produces a position, never guesses one, and never marks anything
// live. Given the situation it returns a cadence, and presence.ts/background.ts
// apply it. That separation is why it can be a pure function with a real
// self-check — the cadence rules are where the bugs live, not the plumbing.
//
// THE RULE THIS MODULE CANNOT BREAK: a slower cadence is a slower cadence. It
// is never a reason to synthesise a fix, to repeat an old one as if it were
// new, or to keep calling a member LIVE while their device has gone quiet.
// Freshness is judged from the fix's own timestamp in status.ts, so stretching
// the interval makes members correctly read as "2 min ago" — never as a lie.
//
// Before this existed the cadence was three hardcoded numbers (8 s foreground,
// 60 s background, 30 s keepalive) that took no account of movement, battery,
// charge state, GPS quality or network. A parked phone on 9% battery published
// exactly as hard as one doing 90 km/h.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/family/adaptive.ts

import { KMH_PER_MS, SPEED_BANDS } from './status';

export type AdaptiveMode =
  | 'movingForeground'
  | 'stationaryForeground'
  | 'movingBackground'
  | 'stationaryBackground'
  | 'lockedMoving'
  | 'lockedStationary'
  | 'batterySaver'
  | 'notSharing';

/** Everything the engine is allowed to consider. All of it optional except
 *  the three states the caller always knows. */
export interface LocationContext {
  /** App is in the foreground AND the user can see it. */
  foreground: boolean;
  /** Screen is locked. Distinct from background: an app can be backgrounded on
   *  an unlocked phone the user is actively holding. */
  locked: boolean;
  /** Am I broadcasting at all. */
  sharing: boolean;
  /** Metres per second from the last fix, when the platform reported one. */
  speedMs?: number | null;
  /** Metres moved since the previous fix, for phones that report no speed. */
  movedM?: number | null;
  batteryPct?: number | null;
  charging?: boolean;
  /** GPS accuracy of the last fix, metres. Large = the fix is mush. */
  accuracyM?: number | null;
  /** Network reachable. False means record locally and sync later. */
  online?: boolean;
}

export interface LocationPlan {
  mode: AdaptiveMode;
  /** expo-location watchPositionAsync timeInterval. */
  timeIntervalMs: number;
  /** expo-location watchPositionAsync distanceInterval, metres. */
  distanceIntervalM: number;
  /** How often a motionless device re-asserts its last fix, ms. */
  keepaliveMs: number;
  /** Maps to Location.Accuracy — high costs battery, low is a city block. */
  accuracy: 'high' | 'balanced' | 'low';
  /** Send to the network now. False = keep recording locally, sync later. */
  publish: boolean;
  /** Human explanation, for the diagnostics row and for logs. */
  reason: string;
}

/** Below this, treat the device as stationary. Same 10 km/h boundary the
 *  speed bands already use, so "moving" means one thing app-wide. */
export const MOVING_KMH = SPEED_BANDS.stationaryMax;
/** A phone that reports no speed but has moved this far since the last fix
 *  is moving. Comfortably above GPS jitter at rest. */
export const MOVED_M = 40;
/** At or below this, and not charging, the engine protects the battery. */
export const SAVER_PCT = 20;
/** A fix this vague says little; stop paying GPS for more of them. */
export const POOR_ACCURACY_M = 100;

/** Is the device moving? Speed wins when present; displacement is the fallback
 *  for the many phones that report speed only intermittently. */
export function isMoving(ctx: LocationContext): boolean {
  if (ctx.speedMs != null && Number.isFinite(ctx.speedMs) && ctx.speedMs >= 0) {
    return ctx.speedMs * KMH_PER_MS > MOVING_KMH;
  }
  if (ctx.movedM != null && Number.isFinite(ctx.movedM)) return ctx.movedM >= MOVED_M;
  return false;   // unknown is NOT moving — the cheaper assumption, and the safer one
}

/** Battery-saving warranted? Charging always cancels it — a phone on a car
 *  charger is exactly when a family most wants a live position. */
export function inBatterySaver(ctx: LocationContext): boolean {
  if (ctx.charging) return false;
  return ctx.batteryPct != null && ctx.batteryPct <= SAVER_PCT;
}

const PLANS: Record<AdaptiveMode, Omit<LocationPlan, 'mode' | 'publish' | 'reason'>> = {
  // Someone is watching the map and the subject is moving: the one case that
  // justifies real GPS cost.
  movingForeground: { timeIntervalMs: 5_000, distanceIntervalM: 10, keepaliveMs: 20_000, accuracy: 'high' },
  // Still on screen, but parked. The map is not wrong at 20 s; it is just not
  // spending a battery to redraw the same dot.
  stationaryForeground: { timeIntervalMs: 20_000, distanceIntervalM: 25, keepaliveMs: 45_000, accuracy: 'balanced' },
  // Pocket, in a car. The case background location exists for.
  movingBackground: { timeIntervalMs: 30_000, distanceIntervalM: 50, keepaliveMs: 90_000, accuracy: 'balanced' },
  // Pocket, sitting at a desk. Distance-gated so a still phone is nearly silent.
  stationaryBackground: { timeIntervalMs: 120_000, distanceIntervalM: 100, keepaliveMs: 300_000, accuracy: 'balanced' },
  // Locked and travelling — the school-run case. Same tier as moving
  // background: the OS delivers these, and this is what the family needs.
  lockedMoving: { timeIntervalMs: 30_000, distanceIntervalM: 50, keepaliveMs: 90_000, accuracy: 'balanced' },
  // Locked and still: overnight. The slowest tier that still proves the phone
  // is alive.
  lockedStationary: { timeIntervalMs: 180_000, distanceIntervalM: 150, keepaliveMs: 600_000, accuracy: 'low' },
  // Low battery outranks everything except charging. Coarse and slow — a
  // family would rather have a rough position for six more hours than a
  // precise one until the phone dies.
  batterySaver: { timeIntervalMs: 300_000, distanceIntervalM: 250, keepaliveMs: 900_000, accuracy: 'low' },
  // Not sharing. The watcher may still run so I see MYSELF on my own map, but
  // it costs almost nothing and publishes nothing.
  notSharing: { timeIntervalMs: 60_000, distanceIntervalM: 100, keepaliveMs: 0, accuracy: 'balanced' },
};

/**
 * Pick the cadence for the current situation.
 *
 * Precedence, highest first:
 *   1. not sharing      — nothing to publish, so nothing to optimise
 *   2. battery saver    — a dead phone shares nothing at all
 *   3. locked           — the OS is the constraint, not our preference
 *   4. background
 *   5. foreground
 * and within 3–5, moving beats stationary.
 *
 * `online: false` does NOT slow anything down. Fixes keep being taken and
 * recorded at the normal cadence; only `publish` goes false, so the queue has
 * real data to sync when the network returns. Throttling the sensor because
 * the network is down would lose the very history the reconnect exists to send.
 */
export function planFor(ctx: LocationContext): LocationPlan {
  const moving = isMoving(ctx);
  const saver = inBatterySaver(ctx);
  const online = ctx.online !== false;

  let mode: AdaptiveMode;
  let reason: string;
  if (!ctx.sharing) {
    mode = 'notSharing';
    reason = 'Not sharing location';
  } else if (saver) {
    mode = 'batterySaver';
    reason = `Battery ${ctx.batteryPct}% — saving power`;
  } else if (ctx.locked) {
    mode = moving ? 'lockedMoving' : 'lockedStationary';
    reason = moving ? 'Screen locked, moving' : 'Screen locked, stationary';
  } else if (!ctx.foreground) {
    mode = moving ? 'movingBackground' : 'stationaryBackground';
    reason = moving ? 'In background, moving' : 'In background, stationary';
  } else {
    mode = moving ? 'movingForeground' : 'stationaryForeground';
    reason = moving ? 'Open and moving' : 'Open and stationary';
  }

  const base = PLANS[mode];
  let distanceIntervalM = base.distanceIntervalM;
  let accuracy = base.accuracy;

  // A stream of ±150 m fixes tells the family nothing and costs the same as
  // good ones. Widen the gate so only a real move gets through — and do not
  // ask for high accuracy the environment has just demonstrated it cannot give.
  if (ctx.accuracyM != null && ctx.accuracyM > POOR_ACCURACY_M) {
    distanceIntervalM = Math.max(distanceIntervalM, Math.round(ctx.accuracyM * 1.5));
    if (accuracy === 'high') accuracy = 'balanced';
    reason += ` · weak GPS ±${Math.round(ctx.accuracyM)} m`;
  }

  if (!online) reason += ' · offline, will sync';

  return {
    mode,
    timeIntervalMs: base.timeIntervalMs,
    distanceIntervalM,
    keepaliveMs: base.keepaliveMs,
    accuracy,
    publish: ctx.sharing && online,
    reason,
  };
}

/**
 * Is the new plan different enough to be worth re-arming the OS watcher?
 *
 * Re-arming is not free — it tears down and recreates a platform subscription,
 * and doing it on every fix would be worse than never adapting at all. A mode
 * change is the signal; identical numbers under a different label are not.
 */
export function shouldRearm(prev: LocationPlan | null, next: LocationPlan): boolean {
  if (!prev) return true;
  return prev.timeIntervalMs !== next.timeIntervalMs
    || prev.distanceIntervalM !== next.distanceIntervalM
    || prev.accuracy !== next.accuracy;
}

// ── self-check: `npx tsx lib/family/adaptive.ts` ───────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('adaptive: ' + m); };
  const ctx = (o: Partial<LocationContext>): LocationContext =>
    ({ foreground: true, locked: false, sharing: true, ...o });
  const fast = 15 / KMH_PER_MS;     // ~54 km/h — unambiguously moving
  const slow = 0.5;                 // ~1.8 km/h — a stationary phone's noise

  // 1. THE EIGHT BEHAVIOURS, each named in the spec
  const cases: [string, LocationContext, AdaptiveMode][] = [
    ['moving + foreground',    ctx({ speedMs: fast }),                                   'movingForeground'],
    ['stationary + foreground',ctx({ speedMs: slow }),                                   'stationaryForeground'],
    ['moving + background',    ctx({ foreground: false, speedMs: fast }),                'movingBackground'],
    ['stationary + background',ctx({ foreground: false, speedMs: slow }),                'stationaryBackground'],
    ['locked + moving',        ctx({ foreground: false, locked: true, speedMs: fast }),  'lockedMoving'],
    ['locked + stationary',    ctx({ foreground: false, locked: true, speedMs: slow }),  'lockedStationary'],
    ['low battery',            ctx({ batteryPct: 9, speedMs: fast }),                    'batterySaver'],
    ['not sharing',            ctx({ sharing: false, speedMs: fast }),                   'notSharing'],
  ];
  for (const [label, c, want] of cases) {
    const got = planFor(c).mode;
    A(got === want, `${label}: expected ${want}, got ${got}`);
  }

  // 2. the cadences are actually ORDERED — the whole point of adapting
  const ms = (c: LocationContext) => planFor(c).timeIntervalMs;
  A(ms(ctx({ speedMs: fast })) < ms(ctx({ speedMs: slow })), 'moving must poll faster than stationary');
  A(ms(ctx({ speedMs: fast })) < ms(ctx({ foreground: false, speedMs: fast })), 'foreground must beat background');
  A(ms(ctx({ foreground: false, speedMs: slow })) < ms(ctx({ locked: true, speedMs: slow })), 'locked+still is the quietest normal tier');
  A(ms(ctx({ batteryPct: 5, speedMs: fast })) > ms(ctx({ speedMs: fast })), 'battery saver must be slower than normal');

  // 3. charging cancels the saver — a car charger is when live matters most
  A(planFor(ctx({ batteryPct: 5, charging: true, speedMs: fast })).mode === 'movingForeground',
    'charging must cancel battery saver');
  A(!inBatterySaver(ctx({ batteryPct: 3, charging: true })), 'charging is never battery saver');
  A(inBatterySaver(ctx({ batteryPct: SAVER_PCT })), 'the threshold itself counts as low');
  A(!inBatterySaver(ctx({ batteryPct: null })), 'unknown battery is not low');

  // 4. movement detection: speed wins, displacement is the fallback, unknown
  //    is stationary (the cheap, safe assumption)
  A(isMoving(ctx({ speedMs: fast })), 'fast speed is moving');
  A(!isMoving(ctx({ speedMs: slow })), 'walking-pace noise is not moving');
  A(isMoving(ctx({ movedM: 100 })), 'displacement alone can prove movement');
  A(!isMoving(ctx({ movedM: 5 })), 'GPS jitter is not movement');
  A(!isMoving(ctx({})), 'unknown movement must default to stationary');
  A(!isMoving(ctx({ speedMs: -1, movedM: 5 })), 'a negative speed must not read as moving');

  // 5. OFFLINE STOPS PUBLISHING, NEVER SENSING — the queue needs real fixes to
  //    send when the network comes back
  const off = planFor(ctx({ speedMs: fast, online: false }));
  A(off.publish === false, 'offline must not publish');
  A(off.timeIntervalMs === planFor(ctx({ speedMs: fast })).timeIntervalMs,
    'offline must NOT slow the sensor — the history is what syncs later');
  A(off.reason.includes('sync'), 'offline should say it will sync');
  A(planFor(ctx({ sharing: false })).publish === false, 'not sharing never publishes');
  A(planFor(ctx({ speedMs: fast })).publish === true, 'sharing and online must publish');

  // 6. weak GPS widens the gate instead of spraying mush
  const weak = planFor(ctx({ speedMs: fast, accuracyM: 300 }));
  A(weak.distanceIntervalM >= 450, `weak GPS should widen the gate, got ${weak.distanceIntervalM}`);
  A(weak.accuracy !== 'high', 'do not demand high accuracy the environment cannot give');
  A(planFor(ctx({ speedMs: fast, accuracyM: 8 })).distanceIntervalM === 10, 'a good fix must not widen the gate');

  // 7. re-arm only on a real change — tearing down the OS watcher is not free
  const p1 = planFor(ctx({ speedMs: fast }));
  A(shouldRearm(null, p1), 'the first plan always arms');
  A(!shouldRearm(p1, planFor(ctx({ speedMs: fast }))), 'an identical plan must not re-arm');
  A(shouldRearm(p1, planFor(ctx({ speedMs: slow }))), 'stopping must re-arm');
  // lockedMoving and movingBackground share numbers — a label change alone is
  // not worth a teardown.
  A(!shouldRearm(planFor(ctx({ foreground: false, speedMs: fast })),
    planFor(ctx({ foreground: false, locked: true, speedMs: fast }))),
    'same cadence under a different name must not re-arm');

  // 8. every mode is reachable and every plan is sane
  for (const mode of Object.keys(PLANS) as AdaptiveMode[]) {
    const p = PLANS[mode];
    A(p.timeIntervalMs > 0 && p.distanceIntervalM > 0, `${mode}: non-positive interval`);
    A(p.keepaliveMs === 0 || p.keepaliveMs > p.timeIntervalMs, `${mode}: keepalive must outlast the poll`);
  }

  console.log('family/adaptive self-check: OK');
}

export default {};
