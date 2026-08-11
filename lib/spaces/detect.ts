// lib/spaces/detect.ts — on-vehicle detection (Spaces & Operations, S5.4).
//
// Overspeed, route deviation and long stops are detected HERE, on the driver's
// own device, and emitted as sealed alerts. Not because that is convenient —
// because the server cannot read a position and is deliberately not going to be
// given one. A plaintext position feed for school children would be the highest
// value target in the system and would make every other E2EE claim in VaultChat
// a marketing line.
//
// The honest cost, stated in the design doc and repeated here so nobody has to
// go looking: a patched client can suppress its own overspeed alert. The
// mitigation is the server-visible ping gap and the run's own timestamped stop
// events, not a position feed. A school that needs tamper-proof telematics needs
// a tachograph, not a chat app.
//
// EVERYTHING HERE IS EDGE-TRIGGERED AND HYSTERETIC. A detector that fires on
// every fix while a condition holds produces forty alerts for one incident, and
// forty alerts is the same as none. Each condition must be SUSTAINED to raise,
// and must clear by a margin before it can raise again.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/spaces/detect.ts

import { haversine, type LatLng } from '../nav/geo';

export interface Fix {
  pos: LatLng;
  /** metres per second, when the platform reported one */
  speed?: number;
  /** claimed accuracy in metres; a wild fix is discounted rather than believed */
  accuracy?: number;
  at: number;
}

export interface DetectConfig {
  /** m/s. Default 22.2 ≈ 80 km/h. */
  speedLimitMps: number;
  /** How long a breach must persist before it counts. */
  overspeedSustainMs: number;
  /** Metres from the route before it is a deviation. */
  deviationM: number;
  /** How long off-route before it counts. */
  deviationSustainMs: number;
  /** Below this speed the vehicle counts as stopped. */
  stoppedMps: number;
  /** How long stationary before it is a long stop. */
  longStopMs: number;
  /** Fixes claiming worse accuracy than this are ignored entirely. */
  maxAccuracyM: number;
}

export const DEFAULTS: DetectConfig = {
  speedLimitMps: 22.2,
  overspeedSustainMs: 15_000,
  deviationM: 250,
  deviationSustainMs: 60_000,
  stoppedMps: 1,
  longStopMs: 8 * 60_000,
  // 100 m: a fix worse than this in a moving vehicle is the phone guessing from
  // cell towers, and guessing has produced both 200 km/h and 3 km off-route.
  maxAccuracyM: 100,
};

export type DetectionKind = 'overspeed' | 'deviation' | 'longstop';

export interface Detection {
  kind: DetectionKind;
  at: number;
  /** Speed in m/s for overspeed, metres off-route for deviation, ms for a stop. */
  value: number;
}

interface Condition {
  since: number | null;
  raised: boolean;
}

export interface DetectState {
  overspeed: Condition;
  deviation: Condition;
  stopped: Condition;
  lastPos: LatLng | null;
  lastAt: number | null;
}

export function newDetectState(): DetectState {
  return {
    overspeed: { since: null, raised: false },
    deviation: { since: null, raised: false },
    stopped: { since: null, raised: false },
    lastPos: null,
    lastAt: null,
  };
}

/**
 * Speed for a fix.
 *
 * Prefers the platform's own value; falls back to distance over time between
 * fixes. The fallback is capped at a plausible maximum because two consecutive
 * fixes 3 km apart — which happens when a phone re-acquires GPS after a tunnel —
 * would otherwise read as 400 km/h and alert a whole school.
 */
export function speedOf(fix: Fix, state: DetectState): number | null {
  if (fix.speed != null && fix.speed >= 0) return fix.speed;
  if (!state.lastPos || state.lastAt == null) return null;
  const dt = (fix.at - state.lastAt) / 1000;
  if (dt <= 0) return null;
  const v = haversine(fix.pos, state.lastPos) / dt;
  // 60 m/s ≈ 216 km/h. Anything above is a GPS artefact, not a vehicle.
  return v > 60 ? null : v;
}

/**
 * Distance from a route, as the shortest distance to any of its points.
 *
 * Point-wise rather than segment-wise: the route here is a stop sequence, which
 * is a handful of coarse points, and pretending to segment precision over
 * points that are kilometres apart would produce confident nonsense. The
 * deviation threshold is set wide for the same reason.
 */
export function distanceFromStops(pos: LatLng, stops: LatLng[]): number | null {
  if (!stops.length) return null;
  let best = Infinity;
  for (const s of stops) {
    const d = haversine(pos, s);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Feed one fix; get back whatever newly became true.
 *
 * Returns an array because a fix can trip more than one condition at once — a
 * vehicle can be off-route AND stationary, and reporting only the first would
 * hide a breakdown behind a wrong turn.
 *
 * MUTATES `state`, which is the point: the hysteresis lives there.
 */
export function feed(
  state: DetectState,
  fix: Fix,
  routeStops: LatLng[],
  cfg: DetectConfig = DEFAULTS,
): Detection[] {
  const out: Detection[] = [];

  // A fix the phone itself does not believe is not evidence of anything.
  if (fix.accuracy != null && fix.accuracy > cfg.maxAccuracyM) return out;

  const speed = speedOf(fix, state);
  const offBy = distanceFromStops(fix.pos, routeStops);

  // ── overspeed ──
  if (speed != null) {
    if (speed > cfg.speedLimitMps) {
      if (state.overspeed.since == null) state.overspeed.since = fix.at;
      if (!state.overspeed.raised && fix.at - state.overspeed.since >= cfg.overspeedSustainMs) {
        state.overspeed.raised = true;
        out.push({ kind: 'overspeed', at: fix.at, value: speed });
      }
    } else if (speed < cfg.speedLimitMps * 0.9) {
      // Clears at 90% of the limit, not at the limit: a vehicle holding exactly
      // the threshold would otherwise flap in and out and alert repeatedly.
      state.overspeed.since = null;
      state.overspeed.raised = false;
    }
  }

  // ── deviation ──
  if (offBy != null) {
    if (offBy > cfg.deviationM) {
      if (state.deviation.since == null) state.deviation.since = fix.at;
      if (!state.deviation.raised && fix.at - state.deviation.since >= cfg.deviationSustainMs) {
        state.deviation.raised = true;
        out.push({ kind: 'deviation', at: fix.at, value: offBy });
      }
    } else if (offBy < cfg.deviationM * 0.8) {
      state.deviation.since = null;
      state.deviation.raised = false;
    }
  }

  // ── long stop ──
  if (speed != null) {
    if (speed <= cfg.stoppedMps) {
      if (state.stopped.since == null) state.stopped.since = fix.at;
      if (!state.stopped.raised && fix.at - state.stopped.since >= cfg.longStopMs) {
        state.stopped.raised = true;
        out.push({ kind: 'longstop', at: fix.at, value: fix.at - state.stopped.since });
      }
    } else if (speed > cfg.stoppedMps * 2) {
      state.stopped.since = null;
      state.stopped.raised = false;
    }
  }

  state.lastPos = fix.pos;
  state.lastAt = fix.at;
  return out;
}

/**
 * Human text for an alert.
 *
 * Reports the FACT, never a position. A member sharing approximately, or not at
 * all, must not be pinpointed by an alert about their vehicle — the same rule
 * lib/groups/tripSession.ts follows for deviation.
 */
export function detectionText(d: Detection, vehicle: string): string {
  switch (d.kind) {
    case 'overspeed':
      return `${vehicle} is travelling at about ${Math.round(d.value * 3.6)} km/h`;
    case 'deviation':
      return `${vehicle} has left its route`;
    case 'longstop':
      return `${vehicle} has been stopped for ${Math.round(d.value / 60_000)} minutes`;
  }
}

// ── self-check ──
if (require.main === module) {
  const base: LatLng = { lat: 12.9, lng: 77.6 };
  const t0 = 1_700_000_000_000;
  const fix = (secs: number, speed?: number, pos: LatLng = base, accuracy?: number): Fix =>
    ({ pos, speed, accuracy, at: t0 + secs * 1000 });

  // overspeed must be SUSTAINED, not instantaneous
  let st = newDetectState();
  if (feed(st, fix(0, 30), [base]).length) throw new Error('a single fast fix must not alert');
  if (feed(st, fix(10, 30), [base]).length) throw new Error('10s is under the 15s sustain');
  let got = feed(st, fix(20, 30), [base]);
  if (got.length !== 1 || got[0].kind !== 'overspeed') throw new Error('sustained overspeed should alert');
  // ...and must not alert again while it persists
  if (feed(st, fix(30, 30), [base]).length) throw new Error('overspeed must be edge-triggered');
  // dropping to just under the limit does NOT clear it (hysteresis)
  feed(st, fix(40, 22), [base]);
  if (!st.overspeed.raised) throw new Error('should not clear at 99% of the limit');
  // dropping well below clears, and it can fire again afterwards
  feed(st, fix(50, 10), [base]);
  if (st.overspeed.raised) throw new Error('should clear below 90% of the limit');
  feed(st, fix(60, 30), [base]);
  got = feed(st, fix(80, 30), [base]);
  if (got.length !== 1) throw new Error('should be able to alert again after clearing');

  // a wildly inaccurate fix is ignored entirely
  st = newDetectState();
  feed(st, fix(0, 30, base, 500), [base]);
  feed(st, fix(20, 30, base, 500), [base]);
  if (st.overspeed.since !== null) throw new Error('a low-accuracy fix must not start a breach');

  // derived speed: a tunnel re-acquisition must not read as 400 km/h
  st = newDetectState();
  st.lastPos = base; st.lastAt = t0;
  const jump: Fix = { pos: { lat: 12.93, lng: 77.6 }, at: t0 + 10_000 }; // ~3.3km in 10s
  if (speedOf(jump, st) !== null) throw new Error('an implausible derived speed must be discarded');
  // a plausible derived speed IS used
  st = newDetectState();
  st.lastPos = base; st.lastAt = t0;
  const ok: Fix = { pos: { lat: 12.9018, lng: 77.6 }, at: t0 + 10_000 }; // ~200m in 10s = 20 m/s
  const v = speedOf(ok, st);
  if (v == null || v < 15 || v > 25) throw new Error(`derived speed wrong: ${v}`);

  // deviation, also sustained
  st = newDetectState();
  const far: LatLng = { lat: 13.0, lng: 77.6 }; // ~11 km away
  if (feed(st, { pos: far, speed: 10, at: t0 }, [base]).length) throw new Error('one off-route fix must not alert');
  got = feed(st, { pos: far, speed: 10, at: t0 + 61_000 }, [base]);
  if (got.length !== 1 || got[0].kind !== 'deviation') throw new Error('sustained deviation should alert');
  if (feed(st, { pos: far, speed: 10, at: t0 + 120_000 }, [base]).length) throw new Error('deviation must be edge-triggered');
  // back on route clears it
  feed(st, { pos: base, speed: 10, at: t0 + 180_000 }, [base]);
  if (st.deviation.raised) throw new Error('returning to the route should clear the deviation');

  // no route means no deviation claim — never "off route" against nothing
  st = newDetectState();
  if (feed(st, { pos: far, speed: 10, at: t0 + 61_000 }, []).length) throw new Error('no stops means no deviation');

  // long stop
  st = newDetectState();
  if (feed(st, fix(0, 0), [base]).length) throw new Error('being stopped is not immediately an alert');
  if (feed(st, fix(60, 0), [base]).length) throw new Error('one minute stopped is normal');
  got = feed(st, fix(8 * 60, 0), [base]);
  if (got.length !== 1 || got[0].kind !== 'longstop') throw new Error('8 minutes stopped should alert');
  if (feed(st, fix(9 * 60, 0), [base]).length) throw new Error('long stop must be edge-triggered');
  feed(st, fix(10 * 60, 5), [base]);
  if (st.stopped.raised) throw new Error('moving off should clear the stop');

  // two conditions at once are both reported
  st = newDetectState();
  feed(st, { pos: far, speed: 0, at: t0 }, [base]);
  got = feed(st, { pos: far, speed: 0, at: t0 + 9 * 60_000 }, [base]);
  const kinds = got.map((d) => d.kind).sort().join(',');
  if (kinds !== 'deviation,longstop') throw new Error(`expected both, got "${kinds}"`);

  // text reports the fact and never a coordinate
  for (const d of [
    { kind: 'overspeed' as const, at: t0, value: 25 },
    { kind: 'deviation' as const, at: t0, value: 900 },
    { kind: 'longstop' as const, at: t0, value: 600_000 },
  ]) {
    const text = detectionText(d, 'Bus 01');
    if (!text.includes('Bus 01')) throw new Error('text should name the vehicle');
    if (/\d+\.\d{3,}/.test(text)) throw new Error(`text must never carry a coordinate: ${text}`);
  }

  console.log('spaces/detect self-check OK');
}
