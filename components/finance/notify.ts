// components/finance/notify.ts — thin wrapper over expo-notifications for the
// finance reminders. Supports one-shot and truly recurring local notifications
// (daily / weekly / monthly / yearly) via calendar triggers.

import * as Notifications from 'expo-notifications';
import type { ReminderFreq } from '../../db/reminders';
import { splitNotifIds } from './notifyIds';
import { osTriggerFor } from '../../lib/finance/reminderSchedule';

export { snoozedNotifIds } from './notifyIds';

let _asked = false;

export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    const cur = await Notifications.getPermissionsAsync();
    if (cur.granted) return true;
    if (_asked) return false;
    _asked = true;
    const req = await Notifications.requestPermissionsAsync();
    return req.granted;
  } catch { return false; }
}

/**
 * The expo-notifications trigger for a series anchored at `at`. The fields
 * come from lib/finance/reminderSchedule osTriggerFor: a recurring trigger is
 * built from the anchor's day and time, so the phone alerts when the app says
 * the reminder is due, even when the anchor is already in the past.
 */
function triggerFor(freq: ReminderFreq, at: number): any {
  const { trigger: t } = osTriggerFor(freq, at, Date.now());
  return t.type === 'date' ? { date: new Date(t.at) } : t;
}

/** Schedule a (possibly recurring) local notification. Returns its id, or null. */
export async function scheduleReminder(title: string, body: string, freq: ReminderFreq, at: number): Promise<string | null> {
  const ok = await ensureNotifyPermission();
  if (!ok) return null;
  try {
    return await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: triggerFor(freq, at) as any,   // trigger shape varies across versions
    });
  } catch { return null; }
}

/** One-shot at a specific time (used for snooze). */
export async function scheduleAt(title: string, body: string, at: number): Promise<string | null> {
  return scheduleReminder(title, body, 'once', at);
}

/** Cancel every notification a reminder row owns (see notifyIds.ts). */
export async function cancel(notifId: string | null): Promise<void> {
  for (const id of splitNotifIds(notifId)) {
    try { await Notifications.cancelScheduledNotificationAsync(id); } catch {}
  }
}
