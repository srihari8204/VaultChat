// lib/finance/reminderSchedule.selftest.ts — run: npx tsx lib/finance/reminderSchedule.selftest.ts
//
// A recurring reminder's series must not drift when it is snoozed or when its
// day does not exist in every month.

import assert from 'node:assert/strict';
import { advanceAnchored, reminderOccurrences, anchorOf, osTriggerFor, phoneSkips, skipsSomePeriods, historyOccurrences } from './reminderSchedule';

let n = 0;
const eq = (label: string, a: unknown, b: unknown) => { assert.deepEqual(a, b, label); n++; };
const at = (y: number, m: number, d: number, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const ymd = (ms: number) => { const d = new Date(ms); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; };

const monthly5 = { id: 'm5', freq: 'monthly' as const, anchor_at: at(2026, 1, 5), status: 'active' };

// ── snooze does not move the series ──
// Snoozed on 5 Mar to 6 Mar 10:00; on 8 Mar the next due is 5 Apr, not 6 Apr.
{
  const snoozed = { ...monthly5, next_at: at(2026, 3, 6, 10) };
  const [m] = advanceAnchored([snoozed], at(2026, 3, 8, 12));
  eq('after a snooze the monthly series returns to day 5', ymd(m.next_at), [2026, 4, 5]);
  eq('and keeps its time of day', new Date(m.next_at).getHours(), 9);
  eq('a snooze still ahead is left alone', advanceAnchored([snoozed], at(2026, 3, 5, 12)), []);
  eq('a snooze due today is left alone (still due today)', advanceAnchored([snoozed], at(2026, 3, 6, 23)), []);
}

// ── day 31 comes back after a short month ──
{
  const d31 = { id: 'd31', freq: 'monthly' as const, anchor_at: at(2026, 1, 31), next_at: at(2026, 2, 28), status: 'active' };
  const [m] = advanceAnchored([d31], at(2026, 3, 2));
  eq('a day-31 reminder is due 31 Mar, not 28 Mar', ymd(m.next_at), [2026, 3, 31]);
  const april = advanceAnchored([{ ...d31, next_at: at(2026, 3, 31) }], at(2026, 4, 2));
  eq('and 30 Apr (clamped once, not carried)', ymd(april[0].next_at), [2026, 4, 30]);
}

// ── legacy rows (no anchor) behave as before ──
{
  const legacy = { id: 'l', freq: 'weekly' as const, next_at: at(2026, 3, 2), status: 'active' };
  eq('anchor falls back to next_at', anchorOf(legacy), at(2026, 3, 2));
  eq('legacy weekly advances by weeks', ymd(advanceAnchored([legacy], at(2026, 3, 10))[0].next_at), [2026, 3, 16]);
  eq('null anchor is a legacy row too', anchorOf({ next_at: 5, anchor_at: null }), 5);
}

// ── what never moves ──
eq('one-offs never move', advanceAnchored([{ id: 'o', freq: 'once', next_at: at(2026, 1, 1), status: 'active' }], at(2026, 6, 1)), []);
eq('done reminders never move', advanceAnchored([{ ...monthly5, next_at: at(2026, 1, 5), status: 'done' }], at(2026, 6, 1)), []);

// ── calendar occurrences ──
{
  const r = { ...monthly5, next_at: at(2026, 6, 5) };
  eq('an earlier month still shows the series (from the anchor)', reminderOccurrences(r, at(2026, 3, 1, 0), at(2026, 4, 1, 0)).map(ymd), [[2026, 3, 5]]);
  eq('nothing before the anchor', reminderOccurrences(r, at(2025, 12, 1, 0), at(2026, 1, 1, 0)), []);
  const snoozed = { ...monthly5, next_at: at(2026, 3, 6, 10) };
  eq('a snooze shows next to the regular occurrence',
    reminderOccurrences(snoozed, at(2026, 3, 1, 0), at(2026, 4, 1, 0)).map(ymd), [[2026, 3, 5], [2026, 3, 6]]);
  const once = { id: 'o', freq: 'once' as const, anchor_at: at(2026, 3, 1), next_at: at(2026, 3, 2), status: 'active' };
  eq('a snoozed one-off shows at its new time only', reminderOccurrences(once, at(2026, 3, 1, 0), at(2026, 4, 1, 0)).map(ymd), [[2026, 3, 2]]);
}

// ── the OS trigger follows the anchor, not max(now, anchor) ──
{
  // Picked for 5 Sep 09:00 (monthly), created on 4 Oct at 15:30: the app says
  // 5 Oct 09:00, so the phone must too — not "the 4th at 15:30 every month".
  const now = at(2026, 10, 4, 15, 30);
  const { trigger, firstAt, earlyAt } = osTriggerFor('monthly', at(2026, 9, 5), now);
  eq('monthly trigger is the anchor day and time', trigger, { type: 'monthly', day: 5, hour: 9, minute: 0 });
  eq('first alert is the next occurrence', ymd(firstAt), [2026, 10, 5]);
  eq('… at the anchor time', new Date(firstAt).getHours(), 9);
  eq('no early alert for a past anchor', earlyAt, null);
  // The trigger's day and time are the first alert's day and time.
  eq('trigger day = first alert day', new Date(firstAt).getDate(), (trigger as { day: number }).day);

  const daily = osTriggerFor('daily', at(2026, 9, 1, 7, 45), now);
  eq('daily: anchor time', daily.trigger, { type: 'daily', hour: 7, minute: 45 });
  eq('daily: tomorrow 07:45', ymd(daily.firstAt), [2026, 10, 5]);

  const weekly = osTriggerFor('weekly', at(2026, 9, 7, 18), now);   // a Monday
  eq('weekly: the anchor weekday (expo 1 = Sunday)', weekly.trigger, { type: 'weekly', weekday: 2, hour: 18, minute: 0 });
  eq('weekly: next Monday', ymd(weekly.firstAt), [2026, 10, 5]);

  const yearly = osTriggerFor('yearly', at(2025, 3, 15), now);
  eq('yearly: anchor month (0-based) and day', yearly.trigger, { type: 'yearly', month: 2, day: 15, hour: 9, minute: 0 });
  eq('yearly: next 15 Mar', ymd(yearly.firstAt), [2027, 3, 15]);

  // A day-31 anchor keeps day 31 in the trigger even when the next occurrence is clamped.
  const d31 = osTriggerFor('monthly', at(2026, 8, 31), at(2026, 9, 2));
  eq('day-31 trigger stays on day 31', (d31.trigger as { day: number }).day, 31);
  eq('… while the app series clamps to 30 Sep', ymd(d31.firstAt), [2026, 9, 30]);
  eq('… and the phone skips that date', phoneSkips({ freq: 'monthly', next_at: d31.firstAt, anchor_at: at(2026, 8, 31) }, d31.firstAt), true);

  // A one-off never fires in the past; a future one fires at its time.
  eq('once in the past fires a second from now', osTriggerFor('once', at(2026, 1, 1), now).trigger, { type: 'date', at: now + 1000 });
  eq('once in the future fires then', osTriggerFor('once', at(2026, 11, 1), now).trigger, { type: 'date', at: at(2026, 11, 1) });

  // A series anchored two months ahead: the phone has no start date, so it
  // also alerts on the 5th of the months before; the screen is told when.
  eq('anchor two months ahead alerts early from 5 Oct', ymd(osTriggerFor('monthly', at(2026, 12, 5), now).earlyAt!), [2026, 10, 5]);
  eq('anchor in the next period does not', osTriggerFor('monthly', at(2026, 11, 3), now).earlyAt, null);
  eq('a skipped month is not an early alert', osTriggerFor('monthly', at(2026, 12, 31), at(2026, 11, 2)).earlyAt, null);
  eq('daily three days ahead alerts from tomorrow', ymd(osTriggerFor('daily', at(2026, 10, 7), now).earlyAt!), [2026, 10, 5]);
}

// ── which periods the phone skips ──
eq('day 29+ monthly skips some months', [28, 29, 31].map(d => skipsSomePeriods('monthly', at(2026, 1, d))), [false, true, true]);
eq('29 Feb yearly skips three years in four', skipsSomePeriods('yearly', at(2028, 2, 29)), true);
eq('28 Feb yearly does not', skipsSomePeriods('yearly', at(2028, 2, 28)), false);
eq('daily never skips', skipsSomePeriods('daily', at(2026, 1, 31)), false);
eq('a leap-day yearly series is skipped on 28 Feb 2029',
  phoneSkips({ freq: 'yearly', next_at: 0, anchor_at: at(2028, 2, 29) }, at(2029, 2, 28)), true);
eq('… but not on 29 Feb 2032', phoneSkips({ freq: 'yearly', next_at: 0, anchor_at: at(2028, 2, 29) }, at(2032, 2, 29)), false);
// A snoozed day off the series has its own one-off alert: not "no phone alert".
// (Monthly on the 5th, snoozed to the 6th: 5 Oct unlabelled, 6 Oct too.)
{
  const snoozed = { freq: 'monthly' as const, next_at: at(2026, 10, 6), anchor_at: at(2026, 9, 5) };
  eq('a snoozed day off the series is not skipped', phoneSkips(snoozed, at(2026, 10, 6)), false);
  eq('… nor is the series day it was snoozed from', phoneSkips(snoozed, at(2026, 10, 5)), false);
  const d31Snoozed = { freq: 'monthly' as const, next_at: at(2026, 9, 30), anchor_at: at(2026, 8, 31) };
  eq('a clamped series day that is also next_at is still skipped', phoneSkips(d31Snoozed, at(2026, 9, 30)), true);
}

// ── done reminders keep their history ──
{
  const done = { ...monthly5, next_at: at(2026, 4, 5), status: 'done' };
  eq('a done reminder still shows in the months it ran', historyOccurrences(done, at(2026, 3, 1, 0), at(2026, 4, 1, 0)).map(ymd), [[2026, 3, 5]]);
  eq('… including the day it was last due', historyOccurrences(done, at(2026, 4, 1, 0), at(2026, 5, 1, 0)).map(ymd), [[2026, 4, 5]]);
  eq('… and not after it', historyOccurrences(done, at(2026, 5, 1, 0), at(2026, 6, 1, 0)), []);
  const active = { ...monthly5, next_at: at(2026, 4, 5) };
  eq('active reminders are unchanged', historyOccurrences(active, at(2026, 5, 1, 0), at(2026, 6, 1, 0)).map(ymd), [[2026, 5, 5]]);
}

// ── "Start then instead": re-anchoring at earlyAt removes the early alert ──
// reminders.tsx offers to start a series at its first early alert. That is a
// fix only if the re-anchored series has no early alert of its own, keeps the
// same phone trigger, and its first date IS that alert.
{
  const now = at(2026, 10, 4, 15, 30);
  const cases: [Parameters<typeof osTriggerFor>[0], number][] = [
    ['monthly', at(2026, 12, 5)], ['monthly', at(2027, 3, 31)], ['weekly', at(2026, 10, 25)],
    ['daily', at(2026, 10, 7)], ['yearly', at(2028, 10, 4, 9)], ['yearly', at(2032, 2, 29)],
  ];
  for (const [freq, anchor] of cases) {
    const first = osTriggerFor(freq, anchor, now);
    assert.ok(first.earlyAt != null, `${freq} ${ymd(anchor)} has an early alert`);
    const moved = osTriggerFor(freq, first.earlyAt!, now);
    eq(`${freq} ${ymd(anchor).join('-')}: started at its early alert, none is left`, moved.earlyAt, null);
    eq(`${freq} ${ymd(anchor).join('-')}: … the phone trigger is unchanged`, moved.trigger, first.trigger);
    eq(`${freq} ${ymd(anchor).join('-')}: … and the first date is that alert`, moved.firstAt, first.earlyAt);
  }
}

console.log(`reminderSchedule: ${n} assertions passed`);
