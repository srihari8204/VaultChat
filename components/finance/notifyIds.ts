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
