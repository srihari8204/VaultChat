// lib/family/leaveNowAlarm.ts — the impure half of "leave now".
//
// Turns a LeavePlan into an OS alarm. Notifee's TIMESTAMP trigger is
// AlarmManager-backed with allowWhileIdle, which is the only mechanism that
// survives Doze — the same one scheduledRunner uses for scheduled messages,
// and for the same reason: a JS timer dies with the process, and this alert
// is worthless if it only fires when the app happens to be open.
//
// One alarm per space. Re-arming replaces it (same notification id), so a
// re-route or a changed arrival time never leaves two alarms racing.

import { Platform } from 'react-native';
import notifee, { TriggerType, AndroidImportance } from '@notifee/react-native';
import { leavePlan, leaveNowText, WARN_LEAD_S, type LeavePlan } from './leaveNow';

const CHANNEL_ID = 'vaultchat_leave_now';
const alarmId = (spaceId: string) => `leavenow-${spaceId}`;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Leave-now reminders',
      // HIGH, unlike the scheduled-message channel: this one is time-critical
      // by construction — a silent "leave now" that is noticed ten minutes
      // later is the same as no alert at all.
      importance: AndroidImportance.HIGH,
    });
  } catch {}
}

/**
 * Arm (or re-arm) the leave-now alert for a space.
 *
 * Fires WARN_LEAD_S before the leave instant so there is time to act. If that
 * moment has already passed the alert is shown immediately — being told late
 * is strictly better than not being told, and the copy says "running late"
 * rather than pretending.
 *
 * Returns the plan it armed for, or null when the inputs cannot answer the
 * question (no arrival time, or no routed duration) — in which case any
 * previous alarm is cancelled rather than left pointing at a stale time.
 */
export async function armLeaveNow(
  spaceId: string,
  destination: string,
  arriveBy: number | null,
  durationS: number | null,
  bufferS?: number,
): Promise<LeavePlan | null> {
  const plan = leavePlan(arriveBy, durationS, Date.now(), bufferS);
  await cancelLeaveNow(spaceId);
  if (!plan) return null;

  const fireAt = plan.leaveAt - WARN_LEAD_S * 1000;
  const body = leaveNowText(destination, plan);
  try {
    await ensureChannel();
    if (fireAt <= Date.now()) {
      // Already inside the window (or past it) — say so now.
      await notifee.displayNotification({
        id: alarmId(spaceId),
        title: 'Time to leave',
        body,
        android: { channelId: CHANNEL_ID, importance: AndroidImportance.HIGH, pressAction: { id: 'default' } },
        data: { type: 'leave_now', spaceId },
      });
      return plan;
    }
    await notifee.createTriggerNotification(
      {
        id: alarmId(spaceId),
        title: 'Time to leave',
        body,
        android: { channelId: CHANNEL_ID, importance: AndroidImportance.HIGH, pressAction: { id: 'default' } },
        data: { type: 'leave_now', spaceId },
      },
      { type: TriggerType.TIMESTAMP, timestamp: fireAt, alarmManager: { allowWhileIdle: true } },
    );
  } catch { /* an alarm we could not set must not break the trip */ }
  return plan;
}

/** Drop the alert — the trip ended, the arrival time was cleared, or we left. */
export async function cancelLeaveNow(spaceId: string): Promise<void> {
  try { await notifee.cancelTriggerNotification(alarmId(spaceId)); } catch {}
  try { await notifee.cancelNotification(alarmId(spaceId)); } catch {}
}

export default {};
