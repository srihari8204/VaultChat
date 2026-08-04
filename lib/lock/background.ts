// lib/lock/background.ts — keep Location Lock protecting off-screen and after
// process death. Mirrors lib/family/background.ts: the task is defined at
// MODULE SCOPE (imported from app/_layout.tsx) so a headless OS wake can run
// it; everything it needs is read back from the persisted ActiveLock blob.
//
// Alarm delivery from a headless context is notification-driven: the JS alarm
// stack (expo-av / TTS / RN Vibration) needs an alive app, so out here the
// loud path is the notifee 'lock-alarm' channel — alarm-stream sound with
// loopSound, vibration pattern, and a full-screen intent that opens the app,
// where lockService.restore() takes over with the full in-app alarm.
//
// Grace time without timers: headless wakes are fix-driven, so the exit fix
// stamps `graceUntil` (lockEngine) and the alarm fires on the first subsequent
// fix that is still outside past the deadline. With the tight cadence below
// that adds at most a few seconds — and the in-app path uses real timers.

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  readActiveLock, saveActiveLock, addEvent, bumpAggregates,
} from './lockStore';
import { advanceActiveLock, persistAdvance, toZoneFix } from './lockEngine';
import { showLockAlarm, cancelLockAlarm, showBackInside } from './lockNotifications';

export const LOCK_BG_TASK = 'vc-location-lock-bg';

// When the app is alive, lockService's foreground watcher owns fix processing
// and this task (which then runs in the SAME JS context) must stand down —
// otherwise every fix would be double-counted. A headless launch gets a fresh
// context where this stays false.
let fgHandling = false;
export function setForegroundHandling(v: boolean): void { fgHandling = v; }

TaskManager.defineTask(LOCK_BG_TASK, async ({ data, error }: any) => {
  if (error || fgHandling) return;
  const locations: Location.LocationObject[] = data?.locations ?? [];
  if (!locations.length) return;

  let a = await readActiveLock();
  if (!a) return;                        // unlocked — task about to be stopped

  for (const loc of locations) {
    const r = advanceActiveLock(a, toZoneFix(loc));
    if (!r.accepted) continue;
    a = r.next;
    await persistAdvance(r);

    if (r.events.includes('return')) {
      if (a.alarmStartedAt) {
        await bumpAggregates(a.sessionId, { alarmMs: Date.now() - a.alarmStartedAt });
        await addEvent(a.sessionId, 'alarm_stop', a.snap.t, a.snap.rawDistance);
        a = { ...a, alarmStartedAt: null };
        await saveActiveLock(a);
      }
      await cancelLockAlarm();
      await showBackInside();
    }
  }

  // Outside past the grace deadline, not silenced, alarm not yet sounding →
  // raise (or refresh) the loud notification. Re-posting the same id updates
  // the distance and re-asserts the sound while the user keeps walking away.
  const now = Date.now();
  if (a.snap.state === 'outside' && !a.alarmSilenced && a.graceUntil != null && now >= a.graceUntil) {
    if (!a.alarmStartedAt) {
      a = { ...a, alarmStartedAt: now };
      await saveActiveLock(a);
      await addEvent(a.sessionId, 'alarm_start', now, a.snap.rawDistance);
    }
    if (a.alerts.repeat || now - (a.alarmStartedAt ?? now) < 10_000) {
      await showLockAlarm(Math.max(0, a.snap.rawDistance - a.radius));
    }
  }
});

export async function hasBackgroundPermission(): Promise<boolean> {
  try { return (await Location.getBackgroundPermissionsAsync()).status === 'granted'; }
  catch { return false; }
}

/** Foreground first, then background — both platforms reject the reverse order. */
export async function requestBackgroundPermission(): Promise<boolean> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      const asked = await Location.requestForegroundPermissionsAsync();
      if (asked.status !== 'granted') return false;
    }
    return (await Location.requestBackgroundPermissionsAsync()).status === 'granted';
  } catch { return false; }
}

export async function isLockBackgroundRunning(): Promise<boolean> {
  try { return await Location.hasStartedLocationUpdatesAsync(LOCK_BG_TASK); }
  catch { return false; }
}

/**
 * Start kill-safe monitoring. Requires background permission; returns false
 * without it (the caller stays on the foreground watcher — a real, narrower
 * working state the arm flow warns about, not an error).
 */
export async function startLockBackground(): Promise<boolean> {
  if (!await hasBackgroundPermission()) return false;
  if (await isLockBackgroundRunning()) return true;
  await Location.startLocationUpdatesAsync(LOCK_BG_TASK, {
    // Tighter than family presence on purpose: a geofence exit at walking pace
    // must be caught within seconds, not the minute-scale presence cadence.
    accuracy: Location.Accuracy.High,
    timeInterval: 5_000,
    distanceInterval: 8,
    pausesUpdatesAutomatically: false,     // a parked phone must keep its fence
    activityType: Location.ActivityType.Fitness,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Location Locked',
      notificationBody: 'Monitoring your locked area',
      notificationColor: '#22C55E',
    },
  });
  return true;
}

export async function stopLockBackground(): Promise<void> {
  try { if (await isLockBackgroundRunning()) await Location.stopLocationUpdatesAsync(LOCK_BG_TASK); } catch {}
}

/**
 * "Stop alarm" pressed on the notification while the app is backgrounded or
 * killed (dispatched from callBackground.ts's single notifee background
 * handler). Mark the lock silenced so the task stops re-posting, record the
 * stop, and drop the loud notification. The lock itself stays armed.
 */
export async function silenceAlarmFromNotification(): Promise<void> {
  const a = await readActiveLock();
  if (a) {
    if (a.alarmStartedAt) {
      await bumpAggregates(a.sessionId, { alarmMs: Date.now() - a.alarmStartedAt });
      await addEvent(a.sessionId, 'alarm_stop', Date.now(), a.snap.rawDistance);
    }
    await saveActiveLock({ ...a, alarmSilenced: true, alarmStartedAt: null });
  }
  await cancelLockAlarm();
}

export default {};
