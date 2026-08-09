// lib/family/geofence.ts — on-device geofence evaluation for Family Circle
// "Places". Definitions AND crossing decisions stay on the device; only the
// RESULT (arrived at / left <place>) is surfaced by the caller as an E2EE system
// message. Pure + self-checked: `npx tsx lib/family/geofence.ts`.
//
// Hysteresis: you're "in" once within radius, and only "out" once past radius +
// EXIT_MARGIN. That stops a member parked on the boundary from flapping
// enter/leave every GPS jitter.

import { haversine, type LatLng } from '../nav/geo';

/**
 * `enabled` is optional and absent-means-ON: places saved before per-place
 * toggles existed must keep firing, so only an explicit `false` mutes one.
 * Filtering happens in fixPipeline.activeFences(), not here — evaluateFences
 * stays a pure geometry fold.
 */
export interface Geofence {
  id: string;
  name: string;
  center: LatLng;
  radiusM: number;
  enabled?: boolean;
  icon?: string;        // Ionicons glyph for the Places list
  /** Temporary zone: stops mattering after this instant (epoch ms). */
  expiresAt?: number;
  /** Scheduled activation. Absent = always on while enabled. */
  schedule?: ZoneSchedule;
}

/**
 * When a zone is live. Minutes are counted from local midnight, so a window may
 * WRAP past midnight (22:00 → 06:00), which "school nights" and "night shift"
 * both need and a naive from < to comparison gets wrong.
 */
export interface ZoneSchedule {
  /** Days it applies to, 0 = Sunday. Empty or absent = every day. */
  days?: number[];
  fromMin: number;
  toMin: number;
}

const DAY_MIN = 24 * 60;

/** Minutes since local midnight for a Date. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Is a schedule open at this moment?
 *
 * A window where from === to is treated as ALWAYS OPEN rather than as a
 * zero-length instant nobody could ever hit — an accidental equal pair should
 * not silently disable a zone the user thinks is armed.
 */
export function scheduleOpen(s: ZoneSchedule, at: Date): boolean {
  const from = ((s.fromMin % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const to = ((s.toMin % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const mins = minutesOfDay(at);

  const wraps = from > to;
  // For a wrapping window the DAY is the day the window STARTED, so an 06:00
  // check inside a 22:00→06:00 Friday window still counts as Friday.
  const day = at.getDay();
  const startDay = wraps && mins < from ? (day + 6) % 7 : day;
  if (s.days && s.days.length && !s.days.includes(startDay)) return false;

  if (from === to) return true;
  return wraps ? (mins >= from || mins < to) : (mins >= from && mins < to);
}

/** Should this zone take part in evaluation right now? */
export function isZoneActive(f: Geofence, at: Date = new Date()): boolean {
  if (f.enabled === false) return false;
  if (f.expiresAt != null && at.getTime() >= f.expiresAt) return false;
  if (f.schedule) return scheduleOpen(f.schedule, at);
  return true;
}
export interface FenceEvent { id: string; name: string; type: 'enter' | 'leave' }

export const EXIT_MARGIN_M = 40;

/**
 * Fold a new position into the set of fences we're currently inside, returning
 * the transitions that just happened. Mutates `inside` (the caller persists it).
 */
export function evaluateFences(fences: Geofence[], pos: LatLng, inside: Set<string>): FenceEvent[] {
  const events: FenceEvent[] = [];
  for (const f of fences) {
    const d = haversine(f.center, pos);
    const was = inside.has(f.id);
    if (!was && d <= f.radiusM) { inside.add(f.id); events.push({ id: f.id, name: f.name, type: 'enter' }); }
    else if (was && d > f.radiusM + EXIT_MARGIN_M) { inside.delete(f.id); events.push({ id: f.id, name: f.name, type: 'leave' }); }
  }
  // Drop fences that no longer exist so a deleted place can't linger as "inside".
  const live = new Set(fences.map((f) => f.id));
  for (const id of [...inside]) if (!live.has(id)) inside.delete(id);
  return events;
}

// self-check
if (require.main === module) {
  const home: Geofence = { id: 'home', name: 'Home', center: { lat: 12.9716, lng: 77.5946 }, radiusM: 100 };
  const inside = new Set<string>();
  const near = home.center;                                  // dead centre → enter
  const far = { lat: 12.9800, lng: 77.5946 };                // ~930 m north → leave
  const edge = { lat: 12.9716 + 0.0005, lng: 77.5946 };      // ~55 m: inside radius+margin, no leave

  let ev = evaluateFences([home], near, inside);
  if (ev.length !== 1 || ev[0].type !== 'enter') throw new Error('expected enter, got ' + JSON.stringify(ev));
  ev = evaluateFences([home], edge, inside);
  if (ev.length !== 0) throw new Error('hysteresis: should NOT leave at 55m, got ' + JSON.stringify(ev));
  if (!inside.has('home')) throw new Error('should still be inside at the edge');
  ev = evaluateFences([home], far, inside);
  if (ev.length !== 1 || ev[0].type !== 'leave') throw new Error('expected leave, got ' + JSON.stringify(ev));
  ev = evaluateFences([home], near, inside);                 // re-enter
  if (ev.length !== 1 || ev[0].type !== 'enter') throw new Error('expected re-enter');
  // deleted fence shouldn't linger
  evaluateFences([], near, inside);
  if (inside.size !== 0) throw new Error('deleted fence lingered in inside set');

  // ── scheduled / temporary zones ──
  const at = (day: number, h: number, m = 0) => {
    // 2026-08-02 was a Sunday, so +day lands on the weekday we want.
    const d = new Date(2026, 7, 2 + day, h, m, 0, 0);
    if (d.getDay() !== day) throw new Error('test date helper drifted');
    return d;
  };
  const zone = (o: Partial<Geofence>): Geofence => ({ id: 'z', name: 'Z', center: home.center, radiusM: 100, ...o });

  if (!isZoneActive(zone({}), at(1, 12))) throw new Error('a plain zone is always active');
  if (isZoneActive(zone({ enabled: false }), at(1, 12))) throw new Error('disabled beats everything');

  // temporary
  const t = at(1, 12).getTime();
  if (isZoneActive(zone({ expiresAt: t - 1 }), at(1, 12))) throw new Error('expired zone must be inactive');
  if (!isZoneActive(zone({ expiresAt: t + 1000 }), at(1, 12))) throw new Error('live temporary zone must be active');

  // simple window 09:00-15:00
  const school = zone({ schedule: { fromMin: 9 * 60, toMin: 15 * 60 } });
  if (!isZoneActive(school, at(1, 10))) throw new Error('10:00 is inside 09:00-15:00');
  if (isZoneActive(school, at(1, 8))) throw new Error('08:00 is outside');
  if (isZoneActive(school, at(1, 15))) throw new Error('the end of the window is exclusive');

  // day filter — Monday only
  const monOnly = zone({ schedule: { days: [1], fromMin: 9 * 60, toMin: 15 * 60 } });
  if (!isZoneActive(monOnly, at(1, 10))) throw new Error('Monday 10:00 should match');
  if (isZoneActive(monOnly, at(2, 10))) throw new Error('Tuesday should not match a Monday-only zone');

  // WRAPPING window 22:00-06:00 — the case a naive from<to comparison breaks
  const night = zone({ schedule: { fromMin: 22 * 60, toMin: 6 * 60 } });
  if (!isZoneActive(night, at(1, 23))) throw new Error('23:00 is inside a wrapping window');
  if (!isZoneActive(night, at(1, 2))) throw new Error('02:00 is inside a wrapping window');
  if (isZoneActive(night, at(1, 12))) throw new Error('midday is outside a wrapping window');

  // a wrapping window belongs to the day it STARTED: Fri 22:00-06:00 covers
  // Saturday 02:00, and must not be judged as a Saturday window.
  const friNight = zone({ schedule: { days: [5], fromMin: 22 * 60, toMin: 6 * 60 } });
  if (!isZoneActive(friNight, at(5, 23))) throw new Error('Fri 23:00 should match');
  if (!isZoneActive(friNight, at(6, 2))) throw new Error('Sat 02:00 belongs to the Friday window');
  if (isZoneActive(friNight, at(6, 23))) throw new Error('Sat 23:00 must NOT match a Friday-only window');

  // an accidental equal pair means always-on, not never-on
  if (!isZoneActive(zone({ schedule: { fromMin: 600, toMin: 600 } }), at(3, 4))) {
    throw new Error('from === to should read as always open');
  }
  console.log('geofence self-check OK');
}
