// lib/groups/calendar.ts — shared group calendar logic (Groups & Circles, G4.3).
//
// WHY THE CALENDAR CANNOT RIDE THE MESSAGE SPINE LIKE TASKS DO
// Tasks fold a whole thread into a list, which is fine because a group's task
// list is small and always wanted in full. A calendar is asked "what is on in
// March?", and answering that from a message log means scanning every message
// ever sent. So events get their own table.
//
// WHAT THE SERVER LEARNS — the honest version
// A range query needs SOMETHING queryable in plaintext. Storing exact start
// times would tell the server "this family has an event on Tuesday at 15:00",
// which is a real disclosure for a product whose whole claim is that the server
// learns nothing. So the only plaintext column is a MONTH BUCKET: the server
// learns which months a group has events in, and nothing else. Title, notes,
// location and the exact time are all inside the encrypted payload, and the
// precise ordering happens here after decryption.
//
// Month bucketing costs nothing functionally, because "show me March" is
// exactly the query the UI makes.
//
// Recurring events carry a NULL bucket and are always fetched — there are few
// of them, and a weekly event would otherwise need a row in every month
// forever. They are expanded into occurrences on-device.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/calendar.ts

import type { Task } from './tasks';
import type { NotifPreview } from '../privacyPrefs';

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** The decrypted event. Everything here except the month bucket is E2EE at rest. */
export interface GroupEvent {
  id: string;
  title: string;
  notes?: string | null;
  location?: string | null;
  /** Epoch ms of the first (or only) occurrence. */
  startsAt: number;
  /** Duration in minutes; 0 for a marker with no length. */
  durationMin: number;
  allDay: boolean;
  recurrence: Recurrence;
  /** Stop repeating after this instant. null = forever. */
  repeatUntil: number | null;
  createdBy: string;
  /** Minutes before the start to remind. null = no reminder. */
  remindMin: number | null;
}

/** One materialised instance of an event on the calendar. */
export interface Occurrence {
  event: GroupEvent;
  startsAt: number;
  endsAt: number;
}

/** 'YYYY-MM' for an instant, in LOCAL time — the month the user sees it in. */
export function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Every month bucket a range touches, so the client can fetch exactly the rows
 * it needs. Inclusive of both ends.
 */
export function monthKeysInRange(from: number, to: number): string[] {
  if (to < from) return [];
  const out: string[] = [];
  const d = new Date(from);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  while (d.getTime() <= end.getTime()) {
    out.push(monthKey(d.getTime()));
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

/** The month bucket a row is stored under. Recurring events have none. */
export function bucketFor(e: Pick<GroupEvent, 'startsAt' | 'recurrence'>): string | null {
  return e.recurrence === 'none' ? monthKey(e.startsAt) : null;
}

/**
 * Add whole months to a date, CLAMPING the day into the target month.
 *
 * JavaScript does not do this: `new Date(2026,0,31).setMonth(1)` produces
 * 3 March, because "31 February" silently overflows. Likewise Feb 29 plus a
 * year lands on 1 March. Both are wrong for a calendar — a monthly event on the
 * 31st belongs on the 28th in February, and a 29 February birthday belongs on
 * the 28th in common years.
 */
function addMonthsClamped(anchor: Date, months: number): Date {
  const day = anchor.getDate();
  const n = new Date(anchor.getTime());
  n.setDate(1);                                   // avoid overflow while shifting
  n.setMonth(n.getMonth() + months);
  const daysInTarget = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
  n.setDate(Math.min(day, daysInTarget));
  return n;
}

/**
 * The nth occurrence, computed from the ANCHOR rather than by stepping from the
 * previous one. Stepping would compound the clamp: 31 Jan → 28 Feb → 28 Mar,
 * when the third occurrence should be 31 March. Anchoring keeps every
 * occurrence tied to the day the user actually chose.
 */
function nthOccurrence(anchor: Date, r: Recurrence, n: number): Date {
  switch (r) {
    case 'daily': { const d = new Date(anchor.getTime()); d.setDate(d.getDate() + n); return d; }
    case 'weekly': { const d = new Date(anchor.getTime()); d.setDate(d.getDate() + n * 7); return d; }
    case 'monthly': return addMonthsClamped(anchor, n);
    case 'yearly': return addMonthsClamped(anchor, n * 12);
    default: return new Date(anchor.getTime());
  }
}

/** Guard against a pathological repeat filling memory. */
export const MAX_OCCURRENCES = 500;

/**
 * Expand one event into the occurrences that fall inside [from, to].
 *
 * An occurrence counts as inside the window when it OVERLAPS it, not merely
 * when it starts inside — an all-day event running across a month boundary must
 * still appear on both months' views.
 */
export function expandEvent(e: GroupEvent, from: number, to: number): Occurrence[] {
  const durMs = Math.max(0, e.durationMin) * 60_000;
  const out: Occurrence[] = [];

  if (e.recurrence === 'none') {
    const end = e.startsAt + durMs;
    if (end >= from && e.startsAt <= to) out.push({ event: e, startsAt: e.startsAt, endsAt: end });
    return out;
  }

  const hardStop = e.repeatUntil == null ? to : Math.min(to, e.repeatUntil);
  const anchor = new Date(e.startsAt);

  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const s = nthOccurrence(anchor, e.recurrence, n).getTime();
    if (s > hardStop) break;
    const end = s + durMs;
    if (end >= from) out.push({ event: e, startsAt: s, endsAt: end });
  }
  return out;
}

/** Expand many events and return them in chronological order. */
export function occurrencesInRange(events: GroupEvent[], from: number, to: number): Occurrence[] {
  const all: Occurrence[] = [];
  for (const e of events) all.push(...expandEvent(e, from, to));
  return all.sort((a, b) => {
    if (a.startsAt !== b.startsAt) return a.startsAt - b.startsAt;
    // All-day events sort above timed ones at the same instant, which is how
    // every calendar app renders a day header.
    if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1;
    return a.event.title.localeCompare(b.event.title);
  });
}

/** Local-midnight bounds for a day, for the day view. */
export function dayBounds(ts: number): { from: number; to: number } {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const e = new Date(d.getTime()); e.setDate(e.getDate() + 1);
  return { from: d.getTime(), to: e.getTime() - 1 };
}

/** Local bounds for the calendar month containing ts. */
export function monthBounds(ts: number): { from: number; to: number } {
  const d = new Date(ts); d.setDate(1); d.setHours(0, 0, 0, 0);
  const e = new Date(d.getTime()); e.setMonth(e.getMonth() + 1);
  return { from: d.getTime(), to: e.getTime() - 1 };
}

/** When a reminder should fire, or null if the event has none. */
export function reminderAt(o: Occurrence): number | null {
  return o.event.remindMin == null ? null : o.startsAt - o.event.remindMin * 60_000;
}

/** How far ahead calendar reminders are booked; a later sync books the rest. */
export const REMINDER_HORIZON_MS = 30 * 86_400_000;

/**
 * Occurrences as items for the reminder reconciler (lib/groups/reminders.ts).
 * A shared event reminds every member, so each item targets `me`. The id is
 * per occurrence, so every repeat of a recurring event gets its own reminder,
 * and a moved or retitled event is re-booked by the reconciler's diff.
 */
export function eventReminderItems(occ: Occurrence[], me: string): Task[] {
  const out: Task[] = [];
  for (const o of occ) {
    const at = reminderAt(o);
    if (at == null) continue;
    out.push({
      id: `${o.event.id}@${o.startsAt}`, title: o.event.title, assignee: me, dueAt: at,
      done: false, updatedAt: 0, createdAt: 0, createdBy: o.event.createdBy, doneBy: null,
    });
  }
  return out;
}

/** Lock-screen text for an event reminder whose title must not be shown. */
export const GENERIC_EVENT_REMINDER = 'An event in your shared calendar is coming up';

/**
 * What an event reminder may say on this phone's lock screen. A shared event
 * reminds every member, so the title is often another member's words about
 * their own plans, readable by whoever holds this phone. It shows only for an
 * event this user created AND while the tray-privacy preference
 * (lib/privacyPrefs) allows names; everything else gets generic text.
 */
export function eventReminderTitle(
  item: Pick<Task, 'title' | 'createdBy'>, me: string, preview: NotifPreview,
): string {
  return item.createdBy === me && preview === 'name' ? item.title : GENERIC_EVENT_REMINDER;
}

// ── self-check ──
if (require.main === module) {
  const ev = (o: Partial<GroupEvent>): GroupEvent => ({
    id: 'e', title: 'T', startsAt: 0, durationMin: 60, allDay: false,
    recurrence: 'none', repeatUntil: null, createdBy: 'u', remindMin: null, ...o,
  });
  const at = (y: number, m: number, d: number, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();

  // 1. month keys
  if (monthKey(at(2026, 3, 15)) !== '2026-03') throw new Error('monthKey: ' + monthKey(at(2026, 3, 15)));
  const keys = monthKeysInRange(at(2026, 1, 20), at(2026, 3, 5));
  if (keys.join(',') !== '2026-01,2026-02,2026-03') throw new Error('range keys: ' + keys);
  if (monthKeysInRange(at(2026, 5, 1), at(2026, 5, 2)).length !== 1) throw new Error('single month');
  if (monthKeysInRange(at(2026, 5, 5), at(2026, 5, 1)).length !== 0) throw new Error('reversed range is empty');
  // a range crossing a year boundary must not skip December
  const yr = monthKeysInRange(at(2026, 12, 20), at(2027, 1, 5));
  if (yr.join(',') !== '2026-12,2027-01') throw new Error('year boundary: ' + yr);

  // 2. bucketing: one-off buckets, recurring does not
  if (bucketFor({ startsAt: at(2026, 3, 2), recurrence: 'none' }) !== '2026-03') throw new Error('one-off bucket');
  if (bucketFor({ startsAt: at(2026, 3, 2), recurrence: 'weekly' }) !== null) throw new Error('recurring must not bucket');

  // 3. a one-off inside / outside the window
  const march = monthBounds(at(2026, 3, 10));
  if (expandEvent(ev({ startsAt: at(2026, 3, 5) }), march.from, march.to).length !== 1) throw new Error('inside');
  if (expandEvent(ev({ startsAt: at(2026, 4, 5) }), march.from, march.to).length !== 0) throw new Error('outside');

  // 4. OVERLAP, not just start-inside: an event running across the boundary
  //    must appear in the month it spills into.
  const spill = ev({ startsAt: at(2026, 2, 28, 23, 0), durationMin: 180 }); // ends 02:00 on Mar 1
  if (expandEvent(spill, march.from, march.to).length !== 1) throw new Error('spill-over must appear in March');

  // 5. weekly expansion
  const weekly = ev({ startsAt: at(2026, 3, 2), recurrence: 'weekly' });
  const w = expandEvent(weekly, march.from, march.to);
  if (w.length !== 5) throw new Error('March 2026 has 5 Mondays from the 2nd: ' + w.length);
  if (new Date(w[1].startsAt).getDate() !== 9) throw new Error('weekly step should be +7 days');

  // 6. repeatUntil stops it
  const bounded = ev({ startsAt: at(2026, 3, 2), recurrence: 'weekly', repeatUntil: at(2026, 3, 16) });
  if (expandEvent(bounded, march.from, march.to).length !== 3) throw new Error('repeatUntil should cap occurrences');

  // 7. MONTHLY MUST CLAMP, not overflow. JS setMonth turns 31 Jan + 1 month
  //    into 3 March; a calendar must produce 28 Feb.
  const jan31 = ev({ startsAt: at(2026, 1, 31), recurrence: 'monthly' });
  const feb = monthBounds(at(2026, 2, 10));
  const f = expandEvent(jan31, feb.from, feb.to);
  if (f.length !== 1) throw new Error('should occur once in Feb, got ' + f.length);
  if (new Date(f[0].startsAt).getDate() !== 28) throw new Error('31 Jan monthly should clamp to 28 Feb 2026');

  // …and the clamp must NOT compound: the March occurrence is the 31st again,
  // not the 28th carried forward from February.
  const mar = monthBounds(at(2026, 3, 10));
  const m3 = expandEvent(jan31, mar.from, mar.to);
  if (m3.length !== 1 || new Date(m3[0].startsAt).getDate() !== 31) {
    throw new Error('monthly must re-anchor on the 31st in March, got ' + (m3[0] && new Date(m3[0].startsAt).getDate()));
  }

  // 8. yearly across a leap day: 29 Feb belongs on 28 Feb in a common year,
  //    not on 1 March as setFullYear would give.
  const leap = ev({ startsAt: at(2024, 2, 29), recurrence: 'yearly' });
  const y2025 = monthBounds(at(2025, 2, 10));
  const ly = expandEvent(leap, y2025.from, y2025.to);
  if (ly.length !== 1) throw new Error('leap-day yearly should land in Feb');
  if (new Date(ly[0].startsAt).getDate() !== 28) throw new Error('29 Feb should clamp to 28 Feb in a common year');
  // and returns to the 29th in the next leap year
  const y2028 = monthBounds(at(2028, 2, 10));
  const l28 = expandEvent(leap, y2028.from, y2028.to);
  if (!l28.length || new Date(l28[0].startsAt).getDate() !== 29) throw new Error('should return to 29 Feb in 2028');

  // 9. a runaway repeat is capped rather than exhausting memory
  const forever = ev({ startsAt: at(2000, 1, 1), recurrence: 'daily' });
  const wide = expandEvent(forever, at(2000, 1, 1), at(2030, 1, 1));
  if (wide.length > MAX_OCCURRENCES) throw new Error('expansion must be capped');

  // 10. ordering: chronological, all-day first within an instant
  const ordered = occurrencesInRange([
    ev({ id: 'b', title: 'B', startsAt: at(2026, 3, 4, 10) }),
    ev({ id: 'a', title: 'A', startsAt: at(2026, 3, 4, 10), allDay: true }),
    ev({ id: 'c', title: 'C', startsAt: at(2026, 3, 3, 10) }),
  ], march.from, march.to).map((o) => o.event.id);
  if (ordered.join(',') !== 'c,a,b') throw new Error('ordering wrong: ' + ordered);

  // 11. day bounds cover exactly one day
  const db = dayBounds(at(2026, 3, 10, 15));
  if (new Date(db.from).getDate() !== 10 || new Date(db.to).getDate() !== 10) throw new Error('day bounds');
  if (db.to - db.from !== 86_400_000 - 1) throw new Error('day should be 24h');

  // 12. reminders
  const occ = expandEvent(ev({ startsAt: at(2026, 3, 5, 9), remindMin: 30 }), march.from, march.to)[0];
  if (reminderAt(occ) !== at(2026, 3, 5, 8, 30)) throw new Error('reminder should be 30m before');
  if (reminderAt(expandEvent(ev({ startsAt: at(2026, 3, 5) }), march.from, march.to)[0]) !== null) {
    throw new Error('no reminder configured should be null');
  }

  console.log('groups/calendar self-check OK');
}
