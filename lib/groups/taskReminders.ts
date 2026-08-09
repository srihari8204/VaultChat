// lib/groups/taskReminders.ts — the OS half of task due-date reminders
// (Groups & Circles, G4.2).
//
// All the reasoning lives in reminders.ts, which is pure and self-checked. This
// file does only the two things that cannot be: talk to expo-notifications, and
// remember which handles it booked.
//
// The split matters because the scheduling rules are where the bugs would be —
// a reminder that fires for a task somebody else already completed, or that
// announces a title from before an edit. Those are decidable without a device,
// so they are decided without one.
//
// PER-GROUP BOOKKEEPING. The booked set is stored per group id, because the
// reconciler is driven by one group's task list at a time. A single global
// store would make every run look at the other groups' reminders as unwanted
// and cancel them.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import {
  planReminders, reminderText,
  type ScheduledReminder,
} from './reminders';
import type { Task } from './tasks';

const KEY = (groupId: string) => `vc_group_task_reminders_${groupId}`;

async function loadBooked(groupId: string): Promise<ScheduledReminder[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY(groupId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt bookkeeping means we no longer know what is booked. Returning
    // empty makes the reconciler re-book everything, which is noisy-but-correct;
    // throwing would leave reminders silently unmanaged forever.
    return [];
  }
}

async function saveBooked(groupId: string, rs: ScheduledReminder[]): Promise<void> {
  try { await AsyncStorage.setItem(KEY(groupId), JSON.stringify(rs)); }
  catch { /* a failed write costs a duplicate reminder, never a lost task */ }
}

/**
 * Bring this device's scheduled reminders in line with the group's task list.
 *
 * Safe to call on every screen focus: with an unchanged list it books nothing
 * and cancels nothing (see the idempotence check in reminders.ts).
 *
 * Never prompts for permission. This runs as a side effect of opening a screen,
 * and a permission dialog nobody asked for is how people deny notifications
 * outright. When permission is absent the plan is still recorded as booked-with-
 * no-handle, so the reconciler does not thrash trying to book on every focus.
 */
export async function syncTaskReminders(
  groupId: string,
  tasks: Task[],
  me: string | null,
  now: number = Date.now(),
): Promise<{ booked: number; cancelled: number }> {
  if (!groupId || !me) return { booked: 0, cancelled: 0 };

  const booked = await loadBooked(groupId);
  const plan = planReminders(tasks, booked, me, now);
  if (plan.cancel.length === 0 && plan.schedule.length === 0) {
    return { booked: 0, cancelled: 0 };
  }

  for (const notifId of plan.cancel) {
    if (!notifId) continue; // booked while permission was denied — nothing to cancel
    try { await Notifications.cancelScheduledNotificationAsync(notifId); } catch { /* already gone */ }
  }

  let granted = false;
  if (plan.schedule.length > 0) {
    try { granted = (await Notifications.getPermissionsAsync()).granted; } catch { granted = false; }
  }

  const kept = booked.filter((b) => !plan.cancel.includes(b.notifId));
  for (const r of plan.schedule) {
    let notifId = '';
    if (granted) {
      try {
        const { title, body } = reminderText(r);
        notifId = await Notifications.scheduleNotificationAsync({
          content: {
            title, body,
            // The root tap handler routes on chatId; a group's task thread IS
            // its chat, so tapping the reminder lands in the right place.
            data: { chatId: groupId, taskId: r.taskId, type: 'task_reminder' },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(r.fireAt),
          } as any,
        });
      } catch { notifId = ''; }
    }
    kept.push({ ...r, notifId });
  }

  await saveBooked(groupId, kept);
  return { booked: plan.schedule.length, cancelled: plan.cancel.length };
}

/** Drop every reminder for a group — used when leaving it. */
export async function clearTaskReminders(groupId: string): Promise<void> {
  for (const b of await loadBooked(groupId)) {
    if (!b.notifId) continue;
    try { await Notifications.cancelScheduledNotificationAsync(b.notifId); } catch { /* already gone */ }
  }
  try { await AsyncStorage.removeItem(KEY(groupId)); } catch { /* best effort */ }
}
