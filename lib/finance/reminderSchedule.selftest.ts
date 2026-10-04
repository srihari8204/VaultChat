// lib/finance/reminderSchedule.selftest.ts — run: npx tsx lib/finance/reminderSchedule.selftest.ts
//
// A recurring reminder's series must not drift when it is snoozed or when its
// day does not exist in every month.

import assert from 'node:assert/strict';
import { advanceAnchored, reminderOccurrences, anchorOf } from './reminderSchedule';

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

console.log(`reminderSchedule: ${n} assertions passed`);
