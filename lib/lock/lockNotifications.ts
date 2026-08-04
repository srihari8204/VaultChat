// lib/lock/lockNotifications.ts — Notifee surface for Location Lock.
//
// Three notifications, mirroring lib/callNotification.ts:
//  * STATUS  — silent ongoing "Location Locked" card while armed. Only shown
//              when the expo-location background task ISN'T running (that task
//              brings its own FGS notification; two would be noise).
//  * ALARM   — the kill-safe alert: HIGH importance, alarm-stream channel sound
//              (lock_siren in res/raw via the expo-notifications plugin),
//              loopSound + full-screen intent into the app, vibration pattern.
//              This is what wakes the user when the JS alarm can't (app dead).
//  * RETURN  — one green auto-dismissing "back inside the safe zone" note.

import { Platform } from 'react-native';
import notifee, {
  AndroidImportance, AndroidCategory, AndroidVisibility,
} from '@notifee/react-native';

export const LOCK_STATUS_ID = 'lock-status';
export const LOCK_ALARM_ID = 'lock-alarm';

export async function ensureLockChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await notifee.createChannel({
      id: 'lock-status',
      name: 'Location Lock',
      importance: AndroidImportance.LOW,
      vibration: false,
    });
    await notifee.createChannel({
      id: 'lock-alarm',
      name: 'Location Lock alarms',
      importance: AndroidImportance.HIGH,
      sound: 'lock_siren',                       // res/raw via app.json sounds list
      vibration: true,
      vibrationPattern: [300, 800, 300, 800],
      bypassDnd: true,
      visibility: AndroidVisibility.PUBLIC,
    });
  } catch {}
}

export async function showLockStatus(radius: number, state: string, distance: number): Promise<void> {
  if (Platform.OS === 'web') return;
  await ensureLockChannels();
  try {
    await notifee.displayNotification({
      id: LOCK_STATUS_ID,
      title: 'Location Locked',
      body: `Radius ${Math.round(radius)} m · ${Math.round(distance)} m from center · ${state.toUpperCase()}`,
      data: { type: 'lock-status' },
      android: {
        channelId: 'lock-status',
        ongoing: true,
        autoCancel: false,
        onlyAlertOnce: true,
        pressAction: { id: 'open-lock', launchActivity: 'default' },
      },
    });
  } catch {}
}

export async function hideLockStatus(): Promise<void> {
  try { await notifee.cancelNotification(LOCK_STATUS_ID); } catch {}
}

/** The loud, kill-safe exit alarm. Safe to re-post (same id refreshes). */
export async function showLockAlarm(distanceM: number): Promise<void> {
  if (Platform.OS === 'web') return;
  await ensureLockChannels();
  try {
    await notifee.displayNotification({
      id: LOCK_ALARM_ID,
      title: '⚠️ You have left the locked area',
      body: `${Math.round(distanceM)} m from the locked point — tap to navigate back`,
      data: { type: 'lock-alarm' },
      android: {
        channelId: 'lock-alarm',
        category: AndroidCategory.ALARM,
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PUBLIC,
        ongoing: true,
        autoCancel: false,
        loopSound: true,
        lightUpScreen: true,
        fullScreenAction: { id: 'default', launchActivity: 'default' },
        pressAction: { id: 'open-lock-alert', launchActivity: 'default' },
        actions: [{ title: 'Stop alarm', pressAction: { id: 'lock-stop-alarm' } }],
      },
    });
  } catch {}
}

export async function cancelLockAlarm(): Promise<void> {
  try { await notifee.cancelNotification(LOCK_ALARM_ID); } catch {}
}

export async function showBackInside(): Promise<void> {
  if (Platform.OS === 'web') return;
  await ensureLockChannels();
  try {
    await notifee.displayNotification({
      title: '✅ Back inside the safe zone',
      body: 'The alarm has stopped.',
      data: { type: 'lock-return' },
      android: {
        channelId: 'lock-status',
        autoCancel: true,
        timeoutAfter: 8000,
        pressAction: { id: 'open-lock', launchActivity: 'default' },
      },
    });
  } catch {}
}

export default {};
