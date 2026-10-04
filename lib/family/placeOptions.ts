// lib/family/placeOptions.ts — the Safe Zones choices and labels, moved out of
// app/family-places.tsx so the screen and its edit sheet
// (components/family/PlaceEditSheet.tsx) share one copy.
//
// Pure — no react-native imports — so placeOptions.selftest.ts runs under tsx.

import type { Ionicons } from '@expo/vector-icons';
import { isZoneActive, type Geofence, type ZoneSchedule } from './geofence';

export const RADII = [100, 200, 500, 1000];
export const MIN_RADIUS = 50;
export const MAX_RADIUS = 5000;
export const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
/** Spoken names for the day chips — "S"/"T" alone are ambiguous. */
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Windows people actually configure, so most users never touch the hours. */
export const PRESETS: { label: string; sched: ZoneSchedule | null }[] = [
  { label: 'Always',       sched: null },
  { label: 'School hours', sched: { days: [1, 2, 3, 4, 5], fromMin: 9 * 60,  toMin: 15 * 60 } },
  { label: 'Work hours',   sched: { days: [1, 2, 3, 4, 5], fromMin: 9 * 60,  toMin: 17 * 60 } },
  { label: 'Overnight',    sched: { days: [],              fromMin: 22 * 60, toMin: 6 * 60 } },
];
/** Temporary zones: how long before the zone stops mattering. */
export const LIFETIMES: { label: string; ms: number | null }[] = [
  { label: 'Permanent', ms: null },
  { label: '8 hours',   ms: 8 * 3600_000 },
  { label: '24 hours',  ms: 24 * 3600_000 },
  { label: '7 days',    ms: 7 * 24 * 3600_000 },
];

/** rchip/day chips draw ~34–36 dp tall; this carries the tap target to 44. */
export const CHIP_SLOP = { top: 6, bottom: 6 };

export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** One-line summary of when a zone is live, for the list row. */
export function describeZone(f: Geofence, now: Date): string {
  if (f.enabled === false) return 'Alerts off';
  if (f.expiresAt != null && now.getTime() >= f.expiresAt) return 'Expired';
  const bits: string[] = [`${f.radiusM} m`];
  if (f.schedule) {
    const d = f.schedule.days?.length ? f.schedule.days.map((n) => DAYS[n]).join('') : 'daily';
    bits.push(`${hhmm(f.schedule.fromMin)}–${hhmm(f.schedule.toMin)} ${d}`);
  }
  if (f.expiresAt != null) bits.push('temporary');
  // Say plainly when a zone exists but is dormant right now.
  if (!isZoneActive(f, now)) bits.push('asleep');
  return bits.join(' · ');
}

/** Guess a sensible icon so the list reads like the mockup's. */
export function iconFor(name: string): keyof typeof Ionicons.glyphMap {
  const n = name.toLowerCase();
  if (/home|house/.test(n)) return 'home';
  if (/school|college|class/.test(n)) return 'school';
  if (/work|office|job/.test(n)) return 'briefcase';
  if (/gym|fit/.test(n)) return 'barbell';
  if (/park|play/.test(n)) return 'leaf';
  if (/hospital|clinic|doctor/.test(n)) return 'medkit';
  return 'location';
}
