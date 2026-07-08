// lib/scheduledRunner.ts — fires local scheduled messages at their time (#73).
//
// Two mechanisms, because Android background timing is best-effort:
//   1. A Notifee TIMESTAMP trigger (AlarmManager-backed) wakes us at sendAt.
//   2. A catch-up sweep on app start + foreground sends anything overdue.
// The send itself goes through chatService.sendMessage, which encrypts for the
// recipient at THAT moment (forward secrecy). A trusted-time guard blocks a
// forward device clock from firing early.

import { Platform } from 'react-native';
import notifee, { TriggerType, AndroidImportance } from '@notifee/react-native';
import { sendMessage } from './chatService';
import {
  listScheduled, dueScheduled, cancelScheduled, type ScheduledItem,
} from './scheduledQueue';
import { isDueByTrustedTime, serverNow, syncServerTime } from './serverTime';

const CHANNEL_ID = 'vaultchat_scheduled';
let running = false;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try { await notifee.createChannel({ id: CHANNEL_ID, name: 'Scheduled messages', importance: AndroidImportance.LOW }); } catch {}
}

/** Ask the OS to wake us at sendAt (fires even if backgrounded). */
export async function registerTrigger(item: ScheduledItem): Promise<void> {
  try {
    if (item.sendAt <= Date.now()) return;    // already due — the sweep handles it
    await ensureChannel();
    await notifee.createTriggerNotification(
      {
        id: `sched-${item.id}`,
        title: 'Scheduled message',
        body: 'Delivering your scheduled message…',
        android: { channelId: CHANNEL_ID, importance: AndroidImportance.LOW, pressAction: { id: 'default' } },
        data: { type: 'scheduled_fire', itemId: item.id },
      },
      { type: TriggerType.TIMESTAMP, timestamp: item.sendAt, alarmManager: { allowWhileIdle: true } },
    );
  } catch {}
}

export async function cancelTrigger(id: string): Promise<void> {
  try { await notifee.cancelTriggerNotification(`sched-${id}`); } catch {}
}

/** Send one due item behind the trusted-time guard, then remove it. */
async function fireOne(item: ScheduledItem): Promise<boolean> {
  if (!(await isDueByTrustedTime(item.sendAt))) return false;   // device clock ran ahead → wait
  try {
    await sendMessage(item.chatId, item.content, (item.type as any) || 'text', { meta: item.meta });
    await cancelScheduled(item.id);
    await cancelTrigger(item.id);
    return true;
  } catch {
    return false;                                               // retry on next sweep
  }
}

/** Send everything whose time has passed. Serialised so overlapping sweeps
 *  (start + foreground + trigger) can't double-send. */
export async function runDueScheduled(): Promise<number> {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    await syncServerTime();
    const due = await dueScheduled(serverNow());
    for (const item of due) { if (await fireOne(item)) sent++; }
  } catch {}
  finally { running = false; }
  return sent;
}

/** Re-arm OS triggers for all pending items (some OEMs clear alarms on force-stop). */
export async function rearmAllTriggers(): Promise<void> {
  try { for (const it of await listScheduled()) await registerTrigger(it); } catch {}
}

export default { registerTrigger, cancelTrigger, runDueScheduled, rearmAllTriggers };
