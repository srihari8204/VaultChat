// lib/lock/zoneMachine.ts — the pure geofence brain of Location Lock. Every
// accepted GPS fix is reduced to one of four zone states around the locked
// point, with the three defences that stop GPS scatter from screaming at the
// user: accuracy gating (a garbage fix never transitions), a short median
// window (one outlier among good fixes is absorbed), and hysteresis (the
// boundary is a band, not a line, so hovering on it can't flap exit/return).
//
// No RN imports → runnable in Node: `npx tsx lib/lock/zoneMachine.ts`.
// Alarm timing (grace, repeat) is NOT here — that's alarmController's job.
// This module only answers "where are we relative to the lock, right now".

import { haversine, destination, type LatLng } from '../nav/geo';

export type ZoneState = 'safe' | 'warning' | 'atLimit' | 'outside';

/** Transitions the alert layer cares about. Emitted at most once per crossing. */
export type ZoneEvent =
  | 'enterWarning'   // safe → warning/atLimit (one pre-alert per approach)
  | 'exit'           // inside → outside (starts the grace countdown)
  | 'return';        // outside → back inside (stops the alarm)

export interface LockGeometry {
  center: LatLng;
  radius: number;            // metres, valid 10..1000
}

export interface ZoneConfig {
  warningBand: number;       // m inside the boundary where Warning begins
  atLimitBand: number;       // m inside the boundary where At-Limit begins
  hysteresis: number;        // minimum m past/inside the boundary to flip outside/return
  maxAccuracy: number;       // reject fixes with accuracy worse than max(this, radius)
  smoothWindow: number;      // median window over accepted distances
}

export const DEFAULT_ZONE_CONFIG: ZoneConfig = {
  warningBand: 5,
  atLimitBand: 2,
  hysteresis: 3,
  maxAccuracy: 30,
  smoothWindow: 3,
};

export interface ZoneFix {
  pos: LatLng;
  accuracy: number;          // metres (GPS horizontal accuracy)
  t: number;                 // epoch ms
}

/** The whole machine state — plain data, so it can be persisted and restored. */
export interface ZoneSnapshot {
  state: ZoneState;
  distance: number;          // smoothed distance from center, m
  rawDistance: number;       // last accepted fix's unsmoothed distance, m
  accuracy: number;          // last accepted fix's accuracy, m
  window: number[];          // recent accepted distances feeding the median
  preAlerted: boolean;       // enterWarning already fired for this approach
  t: number;                 // time of last accepted fix
}

export interface ZoneStep {
  snap: ZoneSnapshot;
  events: ZoneEvent[];
  accepted: boolean;         // false ⇒ fix rejected by the accuracy gate (snap unchanged)
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Effective hysteresis widens with a poor fix but never exceeds half the radius. */
export function effectiveHysteresis(cfg: ZoneConfig, accuracy: number, radius: number): number {
  return Math.min(Math.max(cfg.hysteresis, accuracy / 2), radius / 2);
}

/** Initial snapshot from the arming fix (assumed inside — you lock where you stand). */
export function initialSnapshot(fix: ZoneFix, geom: LockGeometry): ZoneSnapshot {
  const d = haversine(fix.pos, geom.center);
  return { state: 'safe', distance: d, rawDistance: d, accuracy: fix.accuracy, window: [d], preAlerted: false, t: fix.t };
}

/**
 * Advance the machine by one fix. Pure: same inputs → same outputs.
 * A rejected fix returns the previous snapshot untouched (accepted:false).
 */
export function stepZone(
  prev: ZoneSnapshot,
  fix: ZoneFix,
  geom: LockGeometry,
  cfg: ZoneConfig = DEFAULT_ZONE_CONFIG,
): ZoneStep {
  // ── accuracy gate: a fix vaguer than the lock itself can't move the state ──
  if (fix.accuracy > Math.max(cfg.maxAccuracy, geom.radius)) {
    return { snap: prev, events: [], accepted: false };
  }

  const raw = haversine(fix.pos, geom.center);
  const window = [...prev.window, raw].slice(-Math.max(1, cfg.smoothWindow));
  const d = median(window);
  const r = geom.radius;
  const hyst = effectiveHysteresis(cfg, fix.accuracy, r);

  const events: ZoneEvent[] = [];
  let state: ZoneState;
  let preAlerted = prev.preAlerted;

  if (prev.state === 'outside') {
    // Re-entry needs to be CLEARLY inside — the boundary minus hysteresis.
    if (d < r - hyst) {
      state = d <= r - cfg.warningBand ? 'safe' : 'warning';
      events.push('return');
      preAlerted = state !== 'safe';       // still near the edge ⇒ keep the pre-alert spent
      if (state === 'safe') preAlerted = false;
    } else {
      state = 'outside';
    }
  } else {
    // Exit needs to be CLEARLY outside — the boundary plus hysteresis.
    if (d > r + hyst) {
      state = 'outside';
      events.push('exit');
    } else if (d > r - cfg.atLimitBand) {
      state = 'atLimit';
    } else if (d > r - cfg.warningBand) {
      state = 'warning';
    } else {
      state = 'safe';
    }
    // One pre-alert per approach: fires entering warning/atLimit from safe,
    // re-arms only after we're fully back in the green.
    if ((state === 'warning' || state === 'atLimit') && !preAlerted) {
      events.push('enterWarning');
      preAlerted = true;
    } else if (state === 'safe') {
      preAlerted = false;
    }
  }

  return {
    snap: { state, distance: d, rawDistance: raw, accuracy: fix.accuracy, window, preAlerted, t: fix.t },
    events,
    accepted: true,
  };
}

/** Zone → UI color key (the map circle + status card read this). */
export function zoneColor(state: ZoneState): '#22C55E' | '#EAB308' | '#F97316' | '#EF4444' {
  switch (state) {
    case 'safe':    return '#22C55E';
    case 'warning': return '#EAB308';
    case 'atLimit': return '#F97316';
    case 'outside': return '#EF4444';
  }
}

/** Clamp a requested radius to the supported 10 m – 1 km range. */
export function clampRadius(m: number): number {
  return Math.min(1000, Math.max(10, Math.round(m)));
}

// ── self-check: `npx tsx lib/lock/zoneMachine.ts` ──
function _selfCheck(): void {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('zoneMachine: ' + m); };
  const C: LatLng = { lat: 17.385, lng: 78.4867 };
  const geom: LockGeometry = { center: C, radius: 30 };
  const at = (m: number, acc = 5, t = 0): ZoneFix => ({ pos: destination(C, 90, m), accuracy: acc, t });

  // Walk-out sequence: 5 m → 28 m → 40 m ⇒ safe → (warning|atLimit) → outside,
  // with enterWarning and exit each emitted exactly once.
  let s = initialSnapshot(at(5), geom);
  A(s.state === 'safe', 'starts safe');
  let r1 = stepZone(s, at(26), geom);              // window [5,26] → median 15.5, still safe
  let r2 = stepZone(r1.snap, at(28), geom);        // window [5,26,28] → 26 → warning
  A(r2.snap.state === 'warning' || r2.snap.state === 'atLimit', 'near boundary warns');
  A(r2.events.includes('enterWarning'), 'pre-alert fired');
  let r3 = stepZone(r2.snap, at(40), geom);        // median(26,28,40)=28 — smoothing holds it in
  let r4 = stepZone(r3.snap, at(45), geom);        // median(28,40,45)=40 > 33 ⇒ outside
  A(r4.snap.state === 'outside' && r4.events.includes('exit'), 'clear exit fires once');
  A(!r3.events.includes('exit'), 'smoothing absorbs the first far fix');

  // Pre-alert fires once per approach, re-arms after going green. Two green
  // fixes are needed — the median window absorbs the first one by design.
  A(!stepZone(r2.snap, at(28), geom).events.includes('enterWarning'), 'no repeat pre-alert');
  let back = stepZone(r2.snap, at(5), geom);
  back = stepZone(back.snap, at(5), geom);
  A(back.snap.state === 'safe' && !back.snap.preAlerted, 'green re-arms the pre-alert');

  // Noisy fix rejected: stationary at 10 m, one ±50 m fix claiming 40 m → ignored.
  let q = initialSnapshot(at(10), geom);
  const noisy = stepZone(q, at(40, 50), geom);
  A(!noisy.accepted && noisy.snap.state === 'safe' && noisy.events.length === 0, 'accuracy gate rejects');

  // Boundary hover cannot flap: oscillate 29/31 m — hysteresis (±3) never crosses.
  let h = initialSnapshot(at(29), geom);
  h = stepZone(h, at(31), geom).snap;
  let flips = 0;
  for (let i = 0; i < 20; i++) {
    const st = stepZone(h, at(i % 2 ? 31 : 29), geom);
    flips += st.events.filter((e) => e === 'exit' || e === 'return').length;
    h = st.snap;
  }
  A(flips === 0, 'hover produces zero exit/return transitions');

  // Return: clearly out, then clearly back in ⇒ exactly one return event.
  let o = initialSnapshot(at(5), geom);
  o = stepZone(o, at(50), geom).snap;
  o = stepZone(o, at(50), geom).snap;
  o = stepZone(o, at(50), geom).snap;              // median fully outside
  A(o.state === 'outside', 'went outside');
  let rt = stepZone(o, at(10), geom);
  rt = stepZone(rt.snap, at(10), geom);
  rt = stepZone(rt.snap, at(10), geom);
  A(rt.snap.state === 'safe', 'came back safe');
  // count returns across those three steps
  let backSteps = [stepZone(o, at(10), geom)];
  backSteps.push(stepZone(backSteps[0].snap, at(10), geom));
  backSteps.push(stepZone(backSteps[1].snap, at(10), geom));
  const returns = backSteps.flatMap((x) => x.events).filter((e) => e === 'return').length;
  A(returns === 1, 'exactly one return event');

  // Grace-window support: exit is an event, not a latch — alarmController times it.
  // Hysteresis widens with bad accuracy but is capped at radius/2.
  A(effectiveHysteresis(DEFAULT_ZONE_CONFIG, 5, 30) === 3, 'good fix → base hysteresis');
  A(effectiveHysteresis(DEFAULT_ZONE_CONFIG, 20, 30) === 10, 'poor fix → widened');
  A(effectiveHysteresis(DEFAULT_ZONE_CONFIG, 60, 30) === 15, 'capped at radius/2');

  A(clampRadius(3) === 10 && clampRadius(5000) === 1000 && clampRadius(250) === 250, 'radius clamp');
  A(zoneColor('safe') === '#22C55E' && zoneColor('outside') === '#EF4444', 'zone colors');

  console.log('zoneMachine self-check: OK');
}
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
