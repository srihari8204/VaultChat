// lib/spaces/attendance.ts — attendance as a PROJECTION (Spaces & Operations, S4).
//
// There is no attendance engine and no attendance table. A workplace already has
// a safe zone, and crossing it already raises an 'enter'/'leave' alert on the
// device that owns the event. Attendance is that stream read against a shift
// window — nothing more — which is why the entire server-side footprint of this
// feature is three columns on `chats`.
//
// THE RULE THAT MATTERS: UNKNOWN IS NOT ABSENT.
//
// A phone that was off, out of battery, or not sharing location produces no
// crossings. Reporting that person as absent accuses them of not turning up
// because their battery died, and an attendance system that does that gets
// switched off within a week. Every function here distinguishes "we know they
// were not there" from "we do not know", and the UI is expected to keep them
// apart too.
//
// Nothing computed here is uploaded. It is derived on the device of someone who
// is already entitled to the underlying events.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/spaces/attendance.ts

export type AttendanceState = 'present' | 'late' | 'left_early' | 'absent' | 'unknown';

/** One geofence crossing, reduced to what attendance needs. */
export interface Crossing {
  /** 'enter' | 'leave' — the same kinds lib/family/alerts.ts already records. */
  kind: 'enter' | 'leave';
  at: number;
}

/** A shift, as configured on the space. Minutes since local midnight. */
export interface ShiftWindow {
  startMin: number;
  endMin: number;
  graceMin: number;
}

/**
 * Parse "HH:MM" into minutes since midnight, or null.
 *
 * Null rather than a default: a space with no shift configured has no opinion
 * about lateness, and inventing 09:00 would mark half a company late on the day
 * the feature shipped.
 */
export function parseClock(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function makeShift(
  start: string | null | undefined,
  end: string | null | undefined,
  graceMin = 10,
): ShiftWindow | null {
  const s = parseClock(start), e = parseClock(end);
  if (s == null || e == null) return null;
  return { startMin: s, endMin: e, graceMin: Math.max(0, graceMin) };
}

/** Minutes since local midnight for an instant, in the DEVICE's timezone. */
export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export interface DayAttendance {
  state: AttendanceState;
  /** First entry of the day, epoch ms, or null when never seen. */
  firstIn: number | null;
  /** Last exit of the day, or null. */
  lastOut: number | null;
  /** Minutes late past the grace period; 0 when on time or unknown. */
  lateBy: number;
  /** Total time inside the zone, in minutes, from paired crossings. */
  minutesInside: number;
}

/**
 * Project one person's crossings for one day against the shift.
 *
 * `nowMs` matters: a shift that has not ended yet cannot produce "left early" or
 * "absent" — someone who has not arrived at 08:55 for a 09:00 start is not
 * absent, they are early in the morning. Judging a day before it is over is the
 * most common way an attendance report becomes a lie.
 */
export function projectDay(
  crossings: Crossing[],
  shift: ShiftWindow | null,
  nowMs: number,
): DayAttendance {
  const sorted = [...crossings].sort((a, b) => a.at - b.at);
  const firstIn = sorted.find((c) => c.kind === 'enter')?.at ?? null;
  const lastOut = [...sorted].reverse().find((c) => c.kind === 'leave')?.at ?? null;

  // Pair up enter→leave to total the time inside. An unmatched trailing 'enter'
  // means they are still there, which is counted up to now.
  let minutesInside = 0;
  let openedAt: number | null = null;
  for (const c of sorted) {
    if (c.kind === 'enter') {
      if (openedAt == null) openedAt = c.at;
    } else if (openedAt != null) {
      minutesInside += Math.max(0, c.at - openedAt) / 60_000;
      openedAt = null;
    }
  }
  if (openedAt != null) minutesInside += Math.max(0, nowMs - openedAt) / 60_000;
  minutesInside = Math.round(minutesInside);

  // No shift configured → we can report the facts but not judge them.
  if (!shift) {
    return {
      state: firstIn ? 'present' : 'unknown',
      firstIn, lastOut, lateBy: 0, minutesInside,
    };
  }

  const nowMin = minutesOfDay(nowMs);
  const shiftEnded = nowMin >= shift.endMin;

  if (!firstIn) {
    // Never seen. Before the shift ends this is simply "not yet", and calling
    // it absent would flag every early morning.
    return { state: shiftEnded ? 'absent' : 'unknown', firstIn: null, lastOut, lateBy: 0, minutesInside };
  }

  const inMin = minutesOfDay(firstIn);
  const lateBy = Math.max(0, inMin - (shift.startMin + shift.graceMin));

  // Left early is only knowable once they have actually left AND the shift is
  // still running. Someone who left after the end is not early, and someone
  // still inside has not left at all.
  const stillInside = openedAt != null;
  if (!stillInside && lastOut != null) {
    const outMin = minutesOfDay(lastOut);
    if (outMin < shift.endMin) {
      return { state: 'left_early', firstIn, lastOut, lateBy, minutesInside };
    }
  }

  return { state: lateBy > 0 ? 'late' : 'present', firstIn, lastOut, lateBy, minutesInside };
}

/**
 * Derive crossings from position samples.
 *
 * WHY THIS EXISTS AT ALL. The geofence pipeline only evaluates a device's OWN
 * fixes (`processFix` returns early unless `opts.self`), so an `enter`/`leave`
 * alert lives on the phone that crossed the zone and nowhere else. A supervisor
 * therefore has no crossings for their team — but they DO have the team's
 * position samples, because those are recorded for every member the space
 * already shares location with.
 *
 * So attendance for other people is derived from samples this device was
 * already entitled to hold. No new event, no new sync, nothing uploaded.
 *
 * The exit margin mirrors evaluateFences: leaving requires clearing the radius
 * by a margin, so a phone jittering on the boundary does not produce a dozen
 * arrivals. Entering has no margin, deliberately — being early to work should
 * not need to be proven twice.
 */
export function crossingsFromSamples(
  samples: { lat: number; lng: number; ts: number }[],
  zone: { lat: number; lng: number; radiusM: number },
  exitMarginM = 50,
): Crossing[] {
  const out: Crossing[] = [];
  let inside: boolean | null = null;
  for (const s of [...samples].sort((a, b) => a.ts - b.ts)) {
    const d = metres(s, zone);
    if (inside !== true && d <= zone.radiusM) {
      inside = true;
      out.push({ kind: 'enter', at: s.ts });
    } else if (inside === true && d > zone.radiusM + exitMarginM) {
      inside = false;
      out.push({ kind: 'leave', at: s.ts });
    } else if (inside === null) {
      // First sample and it is outside: that is not a crossing, it is a
      // starting position. Recording a 'leave' here would invent an exit from
      // a place they were never seen to enter.
      inside = false;
    }
  }
  return out;
}

/** Equirectangular metres — good to a fraction of a percent at zone scale. */
function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const mLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const x = dLng * Math.cos(mLat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/** Keep only the crossings that fall on the local day containing `dayMs`. */
export function crossingsForDay(crossings: Crossing[], dayMs: number): Crossing[] {
  const d = new Date(dayMs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // The next local midnight, not start + 24h: a daylight-saving day is 23 or 25 hours.
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return crossings.filter((c) => c.at >= start && c.at < end);
}

/** The same wall-clock time `daysAgo` CALENDAR days before `nowMs`. Not
 *  nowMs - n×24h, which lands on the wrong day across a daylight-saving change
 *  when the time is near midnight. Self-checked in attendanceDays.selftest.ts. */
export function calendarDaysAgo(nowMs: number, daysAgo: number): number {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/** Where the track read for a `days`-column week starts: the local midnight
 *  `days` calendar days back — the whole day before the oldest column, so the
 *  samples leading into that column's midnight are read too. Calendar days,
 *  like the columns, not days × 24 h. */
export function sampleWindowStart(nowMs: number, days: number): number {
  const d = new Date(calendarDaysAgo(nowMs, days));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export interface Summary {
  present: number;
  late: number;
  leftEarly: number;
  absent: number;
  unknown: number;
  /** Total minutes inside across everyone counted. */
  minutesInside: number;
}

/**
 * Roll up a set of per-person projections.
 *
 * `unknown` is reported as its own figure and never folded into `absent`. A
 * dashboard that shows "3 absent" when the truth is "1 absent, 2 phones off" is
 * the failure this whole module is arranged around.
 */
export function summarise(days: DayAttendance[]): Summary {
  const s: Summary = { present: 0, late: 0, leftEarly: 0, absent: 0, unknown: 0, minutesInside: 0 };
  for (const d of days) {
    s.minutesInside += d.minutesInside;
    switch (d.state) {
      case 'present': s.present++; break;
      case 'late': s.late++; break;
      case 'left_early': s.leftEarly++; break;
      case 'absent': s.absent++; break;
      default: s.unknown++;
    }
  }
  return s;
}

export const STATE_LABELS: Record<AttendanceState, string> = {
  present: 'Present',
  late: 'Late',
  left_early: 'Left early',
  absent: 'Absent',
  unknown: 'No data',
};

/** The fields of a safe zone that choosing one needs (structural, so this
 *  module stays free of the family store's types). */
export interface ZoneLike { id: string; name: string; enabled?: boolean; expiresAt?: number }

/** A name that says "this is where people work or study". */
const WORKPLACE_NAME = /\b(work|workplace|office|school|college|campus|site|depot|factory|warehouse|shop|store|plant|hq)\b/i;

/** Zones that can be read against today: switched on and not expired. */
export function liveZones<Z extends ZoneLike>(zones: Z[], now = Date.now()): Z[] {
  return zones.filter((z) => z.enabled !== false && !(z.expiresAt != null && z.expiresAt <= now));
}

/**
 * The zone attendance is read against.
 *
 * The viewer's own choice wins while that zone still exists and is live. Then a
 * zone NAMED like a workplace, because a space's first zone is often "Home" or a
 * pickup point and reading attendance against it marks the whole team absent.
 * Then the first live zone. A disabled or expired zone is never chosen.
 */
export function pickWorkZone<Z extends ZoneLike>(
  zones: Z[], chosenId: string | null | undefined, now = Date.now(),
): Z | null {
  const live = liveZones(zones, now);
  return live.find((z) => z.id === chosenId)
    ?? live.find((z) => WORKPLACE_NAME.test(z.name))
    ?? live[0]
    ?? null;
}

// ── self-check ──
if (require.main === module) {
  const at = (h: number, m = 0) => new Date(2026, 0, 5, h, m).getTime();
  const shift = makeShift('09:00', '17:00', 10)!;
  const enter = (h: number, m = 0): Crossing => ({ kind: 'enter', at: at(h, m) });
  const leave = (h: number, m = 0): Crossing => ({ kind: 'leave', at: at(h, m) });

  // clock parsing, including the values that must NOT parse
  if (parseClock('09:00') !== 540) throw new Error('09:00 should be 540');
  if (parseClock('9:05') !== 545) throw new Error('single-digit hour should parse');
  for (const bad of [null, undefined, '', 'nine', '25:00', '09:70', 'x9:00']) {
    if (parseClock(bad) !== null) throw new Error(`"${bad}" must not parse`);
  }
  if (makeShift(null, '17:00') !== null) throw new Error('a half-configured shift is no shift');

  // on time
  let d = projectDay([enter(8, 55), leave(17, 30)], shift, at(18));
  if (d.state !== 'present') throw new Error(`08:55 arrival should be present, got ${d.state}`);
  if (d.lateBy !== 0) throw new Error('on-time arrival has no lateness');

  // inside the grace period is NOT late
  d = projectDay([enter(9, 8), leave(17, 5)], shift, at(18));
  if (d.state !== 'present') throw new Error('arrival inside grace must not be late');

  // past the grace period is late, and by how much past GRACE not past START
  d = projectDay([enter(9, 25), leave(17, 5)], shift, at(18));
  if (d.state !== 'late') throw new Error('09:25 should be late');
  if (d.lateBy !== 15) throw new Error(`lateBy should be 15 past grace, got ${d.lateBy}`);

  // left early
  d = projectDay([enter(9), leave(15)], shift, at(18));
  if (d.state !== 'left_early') throw new Error(`leaving at 15:00 should be left_early, got ${d.state}`);

  // leaving AFTER the shift end is not leaving early
  d = projectDay([enter(9), leave(17, 30)], shift, at(18));
  if (d.state !== 'present') throw new Error('leaving after the end is not early');

  // still inside at the end of the shift: present, not left_early
  d = projectDay([enter(9)], shift, at(18));
  if (d.state !== 'present') throw new Error('still inside is present');

  // THE RULE: no crossings before the shift ends is unknown, not absent
  d = projectDay([], shift, at(8, 30));
  if (d.state !== 'unknown') throw new Error('nobody is absent at 08:30 for a 09:00 shift');
  d = projectDay([], shift, at(10));
  if (d.state !== 'unknown') throw new Error('mid-shift with no data is unknown, not absent');
  // ...and only once the shift is over does it become a claim
  d = projectDay([], shift, at(18));
  if (d.state !== 'absent') throw new Error('no crossings after the shift ended is absent');

  // no shift configured: facts, no judgement
  d = projectDay([enter(11)], null, at(18));
  if (d.state !== 'present' || d.lateBy !== 0) throw new Error('no shift means no lateness');
  d = projectDay([], null, at(18));
  if (d.state !== 'unknown') throw new Error('no shift and no data is unknown');

  // time inside, including an open-ended stay measured to now
  d = projectDay([enter(9), leave(12), enter(13), leave(17)], shift, at(18));
  if (d.minutesInside !== 420) throw new Error(`expected 420 minutes inside, got ${d.minutesInside}`);
  d = projectDay([enter(9)], shift, at(12));
  if (d.minutesInside !== 180) throw new Error(`open stay should count to now, got ${d.minutesInside}`);
  // a stray leave with no matching enter must not produce negative time
  d = projectDay([leave(9)], shift, at(18));
  if (d.minutesInside !== 0) throw new Error('an unmatched leave is zero, never negative');

  // out-of-order input is sorted before folding
  const jumbled = projectDay([leave(17), enter(9)], shift, at(18));
  if (jumbled.minutesInside !== 480) throw new Error(`out-of-order crossings should fold to 480, got ${jumbled.minutesInside}`);

  // day filtering
  const spanning: Crossing[] = [
    { kind: 'enter', at: new Date(2026, 0, 4, 9).getTime() },
    { kind: 'enter', at: at(9) },
    { kind: 'leave', at: at(17) },
    { kind: 'enter', at: new Date(2026, 0, 6, 9).getTime() },
  ];
  if (crossingsForDay(spanning, at(12)).length !== 2) throw new Error('day filter should keep exactly that day');

  // the summary keeps unknown separate from absent
  const sum = summarise([
    projectDay([enter(9)], shift, at(18)),
    projectDay([enter(9, 30)], shift, at(18)),
    projectDay([], shift, at(18)),
    projectDay([], shift, at(10)),
    projectDay([enter(9), leave(15)], shift, at(18)),
  ]);
  if (sum.present !== 1 || sum.late !== 1 || sum.absent !== 1 || sum.unknown !== 1 || sum.leftEarly !== 1) {
    throw new Error(`summary wrong: ${JSON.stringify(sum)}`);
  }
  if (sum.absent + sum.unknown !== 2) throw new Error('unknown must never be folded into absent');

  // ── crossings derived from samples ──
  const zone = { lat: 12.9, lng: 77.6, radiusM: 150 };
  const near = (m: number) => ({ lat: 12.9 + m / 111_320, lng: 77.6 });
  const sample = (h: number, min: number, offsetM: number) =>
    ({ ...near(offsetM), ts: at(h, min) });

  // arrive, stay, leave
  let cr = crossingsFromSamples([
    sample(8, 50, 1000), sample(9, 0, 10), sample(12, 0, 20), sample(17, 30, 1000),
  ], zone);
  if (cr.length !== 2) throw new Error(`expected enter+leave, got ${JSON.stringify(cr)}`);
  if (cr[0].kind !== 'enter' || cr[1].kind !== 'leave') throw new Error('wrong crossing order');

  // starting INSIDE produces an enter, not a phantom leave
  cr = crossingsFromSamples([sample(9, 0, 10), sample(17, 0, 20)], zone);
  if (cr.length !== 1 || cr[0].kind !== 'enter') throw new Error('starting inside should be one enter');

  // starting OUTSIDE and never arriving produces nothing at all — not a 'leave'
  // from a place they were never seen to enter
  cr = crossingsFromSamples([sample(9, 0, 5000), sample(17, 0, 5000)], zone);
  if (cr.length !== 0) throw new Error(`never arriving should yield no crossings, got ${JSON.stringify(cr)}`);

  // boundary jitter must not produce a stream of arrivals: 160m is outside the
  // 150m radius but inside the exit margin, so it is still "inside"
  cr = crossingsFromSamples([
    sample(9, 0, 10), sample(9, 5, 160), sample(9, 10, 10), sample(9, 15, 160),
  ], zone);
  if (cr.length !== 1) throw new Error(`jitter produced ${cr.length} crossings, expected 1`);

  // clearing the margin IS a leave
  cr = crossingsFromSamples([sample(9, 0, 10), sample(17, 0, 400)], zone);
  if (cr.length !== 2 || cr[1].kind !== 'leave') throw new Error('clearing the margin should leave');

  // out-of-order samples are sorted first
  cr = crossingsFromSamples([sample(17, 0, 400), sample(9, 0, 10)], zone);
  if (cr.length !== 2 || cr[0].kind !== 'enter') throw new Error('samples must be sorted before folding');

  // no samples at all → no crossings → unknown, never absent
  if (crossingsFromSamples([], zone).length !== 0) throw new Error('no samples means no crossings');
  if (projectDay(crossingsFromSamples([], zone), shift, at(18)).state !== 'absent') {
    throw new Error('after the shift, no data is absent'); // and before it, unknown — asserted above
  }

  // end to end: samples → crossings → a late day
  const lateDay = projectDay(
    crossingsFromSamples([sample(8, 0, 5000), sample(9, 30, 10), sample(17, 30, 5000)], zone),
    shift, at(18),
  );
  if (lateDay.state !== 'late') throw new Error(`derived day should be late, got ${lateDay.state}`);

  for (const k of Object.keys(STATE_LABELS) as AttendanceState[]) {
    if (!STATE_LABELS[k]) throw new Error(`state ${k} has no label`);
  }

  // zone choice: the viewer's pick, else a workplace name, never a dead zone
  const zs = [
    { id: 'h', name: 'Home' },
    { id: 'o', name: 'Head Office' },
    { id: 'x', name: 'Old site', enabled: false },
    { id: 't', name: 'Pop-up', expiresAt: 1 },
  ];
  if (pickWorkZone(zs, null, 10)?.id !== 'o') throw new Error('a workplace-named zone beats the first zone');
  if (pickWorkZone(zs, 'h', 10)?.id !== 'h') throw new Error('the viewer\'s choice wins');
  if (pickWorkZone(zs, 'x', 10)?.id !== 'o') throw new Error('a disabled choice falls back');
  if (pickWorkZone(zs, 't', 10)?.id !== 'o') throw new Error('an expired choice falls back');
  if (pickWorkZone([{ id: 'a', name: 'Gate A' }], null)?.id !== 'a') throw new Error('no workplace name → first live zone');
  if (pickWorkZone([], 'a') !== null) throw new Error('no zones → null');
  if (liveZones(zs, 10).length !== 2) throw new Error('liveZones drops disabled and expired zones');

  console.log('spaces/attendance self-check OK');
}
