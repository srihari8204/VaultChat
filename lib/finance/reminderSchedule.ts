// lib/finance/reminderSchedule.ts — where a finance reminder's series is
// anchored, and what moves along it. Pure; asserted by
// lib/finance/reminderSchedule.selftest.ts.
//
// A reminder row has `next_at` (when it is next due, shown and counted as
// "due today") and `anchor_at` (the first occurrence the user picked). The
// recurrence is always counted from the ANCHOR. Counting it from `next_at`, as
// utils/financeRules advanceReminders does, let two things move the series:
//   - a snooze writes next_at = tomorrow, and the following advance then
//     counted a monthly reminder from tomorrow: the 5th became the 6th;
//   - a day-31 monthly reminder advanced to 28 Feb, and every later month was
//     counted from the 28th, so it never came back to day 31.
// Rows written before anchor_at existed fall back to their next_at.

import { nextOccurrence, occurrence, occurrencesBetween, startOfDay, type ReminderFreq } from '../../utils/financeRules';

export interface ScheduledReminder {
  id: string; freq: ReminderFreq; next_at: number; anchor_at?: number | null; status: string;
}

/** The series' first occurrence (legacy rows: their next_at). */
export const anchorOf = (r: Pick<ScheduledReminder, 'next_at' | 'anchor_at'>): number => r.anchor_at ?? r.next_at;

/**
 * Recurring reminders whose `next_at` is on an earlier day than `now`, moved
 * to the first occurrence of their anchored series from the start of today —
 * so a daily 9am reminder still counts as due today at 10am. A next_at that is
 * today or later (including a snooze) is left alone; one-offs and done
 * reminders never move.
 */
export function advanceAnchored(rows: ScheduledReminder[], now: number): { id: string; next_at: number }[] {
  const today = startOfDay(now);
  const out: { id: string; next_at: number }[] = [];
  for (const r of rows) {
    if (r.status !== 'active' || r.freq === 'once' || r.next_at >= today) continue;
    const next = nextOccurrence(r.freq, anchorOf(r), today);
    if (next !== r.next_at) out.push({ id: r.id, next_at: next });
  }
  return out;
}

/**
 * The reminder's times in [from, to) for the calendar: every occurrence of the
 * anchored series (so earlier months show it from the anchor on, not only from
 * the current next_at), plus a snoozed next_at that is not itself one.
 */
export function reminderOccurrences(r: ScheduledReminder, from: number, to: number): number[] {
  const inRange = (t: number) => t >= from && t < to;
  if (r.freq === 'once') return inRange(r.next_at) ? [r.next_at] : [];
  const out = occurrencesBetween(r.freq, anchorOf(r), from, to);
  if (inRange(r.next_at) && !out.includes(r.next_at)) {
    out.push(r.next_at);
    out.sort((a, b) => a - b);
  }
  return out;
}

/**
 * Done reminders keep their history: the series up to the time it was last
 * due (its next_at when it was marked done), so a completed monthly reminder
 * still shows in the months it ran. Active reminders: reminderOccurrences.
 */
export function historyOccurrences(r: ScheduledReminder, from: number, to: number): number[] {
  if (r.status === 'active') return reminderOccurrences(r, from, to);
  return reminderOccurrences({ ...r, status: 'active' }, from, Math.min(to, r.next_at + 1));
}

/**
 * True when the phone will not alert on this occurrence. Calendar triggers
 * repeat on the anchor's own day number: a day-31 monthly reminder fires only
 * in 31-day months and a 29 February yearly one only in leap years, while the
 * app's series clamps to the month's last day (30 Apr, 28 Feb). Only series
 * dates can be skipped: a snoozed day off the series alerts on its own.
 */
export function phoneSkips(r: Pick<ScheduledReminder, 'freq' | 'next_at' | 'anchor_at'>, at: number): boolean {
  if (r.freq !== 'monthly' && r.freq !== 'yearly') return false;
  // A snoozed next_at that is not one of the series' own dates has its own
  // one-off alert (the snooze schedules it), so it is not skipped.
  if (at === r.next_at && !occurrencesBetween(r.freq, anchorOf(r), at, at + 1).includes(at)) return false;
  return new Date(at).getDate() !== new Date(anchorOf(r)).getDate();
}

/** True when a series anchored here has periods with no phone alert. */
export function skipsSomePeriods(freq: ReminderFreq, anchor: number): boolean {
  const d = new Date(anchor);
  if (freq === 'monthly') return d.getDate() > 28;
  if (freq === 'yearly') return d.getMonth() === 1 && d.getDate() === 29;
  return false;
}

/** The OS notification trigger for a reminder, as plain data (components/finance/notify maps it). */
export type OsTrigger =
  | { type: 'date'; at: number }
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'weekly'; weekday: number; hour: number; minute: number }
  | { type: 'monthly'; day: number; hour: number; minute: number }
  | { type: 'yearly'; month: number; day: number; hour: number; minute: number };

/**
 * The OS trigger for a series anchored at `anchor`, and when it first fires.
 * A recurring trigger is built from the ANCHOR's day and time, so the phone
 * alerts on the same days and at the same time the app shows: a monthly
 * reminder anchored on the 5th at 09:00 and created on the 4th at 15:30 first
 * alerts on the 5th at 09:00 (it used to be built from max(now, anchor), so it
 * alerted on the 4th at 15:30 every month). `firstAt` is the series' next
 * occurrence after `now`. A one-off fires at its time, never in the past.
 *
 * A calendar trigger has no start date, so a series anchored more than one
 * period ahead also alerts in the periods before its anchor: `earlyAt` is the
 * first such alert (null when there is none), for the screen to say so.
 */
export function osTriggerFor(freq: ReminderFreq, anchor: number, now: number): { trigger: OsTrigger; firstAt: number; earlyAt: number | null } {
  const soon = now + 1000;
  if (freq === 'once') {
    const at = Math.max(soon, anchor);
    return { trigger: { type: 'date', at }, firstAt: at, earlyAt: null };
  }
  const a = new Date(anchor);
  const hour = a.getHours(), minute = a.getMinutes();
  const firstAt = nextOccurrence(freq, anchor, soon);
  let earlyAt: number | null = null;
  for (let k = -1; k >= -20000; k--) {
    const at = occurrence(freq, anchor, k);
    if (at < soon) break;
    if (!phoneSkips({ freq, next_at: anchor, anchor_at: anchor }, at)) earlyAt = at;
  }
  let trigger: OsTrigger;
  switch (freq) {
    case 'daily': trigger = { type: 'daily', hour, minute }; break;
    // expo weekday: 1 = Sunday … 7 = Saturday
    case 'weekly': trigger = { type: 'weekly', weekday: a.getDay() + 1, hour, minute }; break;
    case 'monthly': trigger = { type: 'monthly', day: a.getDate(), hour, minute }; break;
    // expo yearly month uses Date ranges: 0 = January … 11 = December
    default: trigger = { type: 'yearly', month: a.getMonth(), day: a.getDate(), hour, minute };
  }
  return { trigger, firstAt, earlyAt };
}
