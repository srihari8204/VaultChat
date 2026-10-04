// components/finance/notifyIds.ts — which scheduled notifications a reminder
// row owns. Pure, so it can be asserted without expo-notifications.
//
// A reminder row has one `notif_id` column. A snoozed RECURRING reminder owns
// two notifications: its recurrence and tomorrow's one-off snooze. Both are
// stored comma-joined, recurrence first (possibly empty), so Done / Delete can
// cancel both and a second snooze replaces only the old snooze. OS notification
// ids are UUIDs and never contain a comma.

import type { ReminderFreq } from '../../db/reminders';

export function splitNotifIds(stored: string | null): string[] {
  return (stored ?? '').split(',').filter(Boolean);
}

export function snoozedNotifIds(
  freq: ReminderFreq, stored: string | null, snoozeId: string | null,
): { keep: string | null; cancel: string | null } {
  if (freq === 'once') {
    // A one-off has nothing to preserve: the snooze replaces it.
    return { keep: snoozeId, cancel: stored || null };
  }
  const [recurring = '', ...oldSnoozes] = (stored ?? '').split(',');
  const keep = snoozeId ? `${recurring},${snoozeId}` : (recurring || null);
  return { keep, cancel: oldSnoozes.filter(Boolean).join(',') || null };
}

/** The stored ids with the recurrence replaced by `recurringId`; snoozes are kept. */
export function withRecurrence(stored: string | null, recurringId: string): string {
  const [, ...snoozes] = (stored ?? '').split(',');
  return [recurringId, ...snoozes.filter(Boolean)].join(',');
}

/**
 * True when the reminder will not alert on its own schedule: a one-off with no
 * id, or a recurring reminder whose recurrence slot is empty. A snooze id alone
 * (",S1") does not make a recurring reminder scheduled — it fires once.
 */
export function isUnscheduled(freq: ReminderFreq, stored: string | null): boolean {
  if (freq === 'once') return splitNotifIds(stored).length === 0;
  return !(stored ?? '').split(',')[0];
}
