// components/finance/retriggerOnce.ts — runs the one-time anchored rebuild
// (./retrigger) with the real phone and database, once per user. Both the
// Reminders screen and the Calendar call it, so a user who only opens the
// Calendar also gets the rebuilt alerts.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { replaceReminderNotifId, type Reminder } from '../../db/reminders';
import { scheduleReminder, cancel, notificationsAllowed } from './notify';
import { retriggerFromAnchors, retriggerDoneKey } from './retrigger';

let running = false;

/** Resolves true when it rebuilt alerts this time (the caller re-reads the rows). */
export async function rebuildRecurringAlertsOnce(userId: string, rows: Reminder[]): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    const key = retriggerDoneKey(userId);
    if ((await AsyncStorage.getItem(key)) === '1') return false;
    // Never prompts: without permission it waits for a later visit.
    if (!(await notificationsAllowed())) return false;
    const all = await retriggerFromAnchors(rows, {
      allowed: notificationsAllowed,
      schedule: (title, freq, anchor) => scheduleReminder('Vault Finance', title, freq, anchor),
      swap: replaceReminderNotifId,
      cancel,
    });
    if (all) await AsyncStorage.setItem(key, '1');
    return true;
  } finally {
    running = false;
  }
}
