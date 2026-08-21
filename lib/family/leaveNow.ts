// lib/family/leaveNow.ts — "leave now" for a family trip.
//
// A trip already knows the destination and, once routed, how long the drive
// takes. The missing half is the one a family actually argues about: WHEN to
// walk out of the door to arrive on time. This computes that instant and how
// long is left until it, so a screen can show a countdown and a notification
// can fire at the right moment.
//
// Everything here is arithmetic over numbers the device already has — no
// network, no server, no new permission. The road duration comes from the
// route the trip already fetched.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/family/leaveNow.ts

/** Default cushion: traffic, parking, and finding the front door. */
export const DEFAULT_BUFFER_S = 5 * 60;
/** Fire the alert this long before the leave instant, so it is actionable. */
export const WARN_LEAD_S = 5 * 60;

export interface LeavePlan {
  /** Epoch ms the traveller should leave by. */
  leaveAt: number;
  /** Milliseconds from `now` until leaveAt. Negative once it has passed. */
  inMs: number;
  /** leaveAt is already behind us — leaving now arrives late. */
  late: boolean;
  /** Within WARN_LEAD_S of leaveAt (or past it): time to tell them. */
  warn: boolean;
}

/**
 * When to leave to arrive at `arriveBy`, given a road duration.
 *
 * Returns null when the inputs cannot answer the question — no arrival time,
 * or no routed duration. A guessed leave time is worse than none: a family
 * plans around it, and "leave at 6:40" derived from a straight-line distance
 * is a promise the roads never made. Same rule the ETA code follows.
 */
export function leavePlan(
  arriveBy: number | null | undefined,
  durationS: number | null | undefined,
  now: number,
  bufferS: number = DEFAULT_BUFFER_S,
): LeavePlan | null {
  if (arriveBy == null || !Number.isFinite(arriveBy)) return null;
  if (durationS == null || !Number.isFinite(durationS) || durationS < 0) return null;
  const buffer = Number.isFinite(bufferS) && bufferS >= 0 ? bufferS : DEFAULT_BUFFER_S;
  const leaveAt = arriveBy - (durationS + buffer) * 1000;
  const inMs = leaveAt - now;
  return {
    leaveAt,
    inMs,
    late: inMs < 0,
    warn: inMs <= WARN_LEAD_S * 1000,
  };
}

/** "in 12 min" · "now" · "8 min ago" — for the countdown row. */
export function formatLeaveIn(inMs: number): string {
  const min = Math.round(inMs / 60000);
  if (min === 0) return 'now';
  if (min > 0) return `in ${min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`}`;
  const past = -min;
  return `${past < 60 ? `${past} min` : `${Math.floor(past / 60)} h ${past % 60} min`} ago`;
}

/** The notification body — states the destination and the honest verdict. */
export function leaveNowText(destination: string, plan: LeavePlan): string {
  if (plan.late) return `Running late for ${destination} — leave now to get there as soon as you can`;
  const min = Math.max(0, Math.round(plan.inMs / 60000));
  if (min === 0) return `Leave now for ${destination}`;
  return `Leave in ${min} min for ${destination}`;
}

// ── self-check: `npx tsx lib/family/leaveNow.ts` ───────────────────────────
declare const require: any; declare const module: any;
if (typeof require !== 'undefined' && require.main === module) {
  const A = (c: boolean, m: string) => { if (!c) throw new Error('leaveNow: ' + m); };
  const now = 1_700_000_000_000;
  const M = 60_000;

  // 1. the basic arithmetic: arrive 60 min out, 20 min drive, 5 min buffer
  //    → leave in 35 min
  const p = leavePlan(now + 60 * M, 20 * 60, now)!;
  A(p != null, 'a routed trip with an arrival time yields a plan');
  A(Math.round(p.inMs / M) === 35, `expected 35 min, got ${Math.round(p.inMs / M)}`);
  A(!p.late && !p.warn, '35 minutes out is neither late nor warning');

  // 2. the buffer is real and configurable
  A(Math.round(leavePlan(now + 60 * M, 20 * 60, now, 0)!.inMs / M) === 40, 'no buffer → leave 40 min out');
  A(Math.round(leavePlan(now + 60 * M, 20 * 60, now, 15 * 60)!.inMs / M) === 25, 'a 15 min buffer eats 15 min');
  A(Math.round(leavePlan(now + 60 * M, 20 * 60, now, -5)!.inMs / M) === 35, 'a negative buffer falls back to the default');

  // 3. the warning window
  A(leavePlan(now + 26 * M, 20 * 60, now)!.warn === true, 'inside 5 min of leaving must warn');
  A(leavePlan(now + 40 * M, 20 * 60, now)!.warn === false, '15 min before leaving is not yet a warning');

  // 4. LATE is stated, never hidden — a family plans around this number
  const late = leavePlan(now + 10 * M, 20 * 60, now)!;
  A(late.late === true, 'a 20 min drive to a 10 min deadline is late');
  A(late.warn === true, 'late always warns');
  A(late.inMs < 0, 'a passed leave time is negative, not clamped to zero');

  // 5. REFUSES TO GUESS — the same rule the ETA code follows
  A(leavePlan(null, 1200, now) === null, 'no arrival time → no plan');
  A(leavePlan(now + 60 * M, null, now) === null, 'no routed duration → no plan (never straight-line it)');
  A(leavePlan(now + 60 * M, NaN, now) === null, 'a NaN duration must not produce a time');
  A(leavePlan(NaN, 1200, now) === null, 'a NaN arrival must not produce a time');
  A(leavePlan(now + 60 * M, -5, now) === null, 'a negative duration is not a route');

  // 6. formatting says what it means, in both directions
  A(formatLeaveIn(12 * M) === 'in 12 min', `got ${formatLeaveIn(12 * M)}`);
  A(formatLeaveIn(0) === 'now', 'zero is now');
  A(formatLeaveIn(-8 * M) === '8 min ago', `got ${formatLeaveIn(-8 * M)}`);
  A(formatLeaveIn(90 * M) === 'in 1 h 30 min', `got ${formatLeaveIn(90 * M)}`);
  A(formatLeaveIn(-75 * M) === '1 h 15 min ago', `got ${formatLeaveIn(-75 * M)}`);

  // 7. the notification body
  A(leaveNowText('Ramya Cafe', leavePlan(now + 26 * M, 20 * 60, now)!).includes('Leave in 1 min'),
    `body: ${leaveNowText('Ramya Cafe', leavePlan(now + 26 * M, 20 * 60, now)!)}`);
  A(leaveNowText('Ramya Cafe', late).includes('Running late'), 'a late plan says so plainly');
  A(leaveNowText('Ramya Cafe', leavePlan(now + 25 * M, 20 * 60, now)!) === 'Leave now for Ramya Cafe',
    'exactly at the leave instant reads "Leave now"');

  console.log('family/leaveNow self-check: OK');
}

export default {};
