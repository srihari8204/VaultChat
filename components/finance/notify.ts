// components/finance/notify.ts — thin wrapper over expo-notifications for the
// finance reminders. One-shot local notifications scheduled at a given time.

import * as Notifications from 'expo-notifications';

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

/** Schedule a local notification at `at` (epoch ms). Returns its id, or null. */
export async function scheduleAt(title: string, body: string, at: number): Promise<string | null> {
  const ok = await ensureNotifyPermission();
  if (!ok) return null;
  const when = Math.max(Date.now() + 1000, at);
  try {
    return await Notifications.scheduleNotificationAsync({
      content: { title, body },
      // Cast: trigger shape varies across expo-notifications versions.
      trigger: { date: new Date(when) } as any,
    });
  } catch { return null; }
}

export async function cancel(notifId: string | null): Promise<void> {
  if (!notifId) return;
  try { await Notifications.cancelScheduledNotificationAsync(notifId); } catch {}
}
