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

import { nextOccurrence, occurrencesBetween, startOfDay, type ReminderFreq } from '../../utils/financeRules';

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
