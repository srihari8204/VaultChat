// components/finance/notify.ts — thin wrapper over expo-notifications for the
// finance reminders. Supports one-shot and truly recurring local notifications
// (daily / weekly / monthly / yearly) via calendar triggers.

import * as Notifications from 'expo-notifications';
import type { ReminderFreq } from '../../db/reminders';
import { splitNotifIds } from './notifyIds';

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

/** Build the expo-notifications trigger for a frequency anchored at `at`. */
function triggerFor(freq: ReminderFreq, at: number): any {
  const d = new Date(Math.max(Date.now() + 1000, at));
  const hour = d.getHours(), minute = d.getMinutes();
  switch (freq) {
    case 'daily':   return { type: 'daily', hour, minute };
    // expo weekday: 1 = Sunday … 7 = Saturday
    case 'weekly':  return { type: 'weekly', weekday: d.getDay() + 1, hour, minute };
    case 'monthly': return { type: 'monthly', day: d.getDate(), hour, minute };
    case 'yearly':  return { type: 'yearly', month: d.getMonth() + 1, day: d.getDate(), hour, minute };
    default:        return { date: d };   // 'once'
  }
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
