// lib/family/notify.ts — OS notification for a Family Space alert (F4.2).
//
// Until now a family event only reached the in-app inbox, so a geofence
// crossing that happened while the user was looking at anything else surfaced
// nothing until they next opened Family Space. This raises the notification.
//
// SCOPE — read this before extending it:
//
//  * These notifications are raised IN-PROCESS from data this device has
//    already decrypted for the circle thread. That is the same trust boundary
//    the alert inbox and Today's Highlights already sit behind, and no new
//    plaintext reaches the server or the notification tray from a background
//    decrypt. lib/messageNotifications.ts is deliberately content-free for the
//    opposite case — a push arriving with nothing decrypted — and that rule is
//    NOT relaxed here.
//
//  * Kill-safe delivery is NOT this module. If the app process is gone, no JS
//    runs and nothing here fires; the user still gets the generic content-free
//    "new message" notification for the underlying system message. Waking a
//    dead app for a family event is F7.1 and needs the FCM path.
//
//  * We never notify a user about their own action. Geofences are evaluated on
//    the subject's own device, so without this guard every crossing would
//    notify the very person who just walked through it.

import { Platform } from 'react-native';
import notifee, { AndroidImportance, AndroidCategory, AndroidVisibility } from '@notifee/react-native';
import { type FamilyAlert } from './alerts';

export const FAMILY_CHANNEL_ID = 'family-alerts';
export const FAMILY_CRITICAL_CHANNEL_ID = 'family-critical';
export const EMERGENCY_CONNECT_ID = 'family-emergency-connect';

/** Emoji per alert kind — the tray has no room for an icon set. */
const GLYPH: Record<FamilyAlert['kind'], string> = {
  enter: '📍', leave: '🚪', sos: '🆘', checkin: '✅', battery: '🪫', sharing: '📡',
};

let channelsReady = false;

export async function ensureFamilyChannels(): Promise<void> {
  if (Platform.OS !== 'android' || channelsReady) return;
  try {
    await notifee.createChannel({
      id: FAMILY_CHANNEL_ID,
      name: 'Family Space',
      importance: AndroidImportance.DEFAULT,
      vibration: true,
    });
    await notifee.createChannel({
      id: FAMILY_CRITICAL_CHANNEL_ID,
      name: 'Family Space emergencies',
      importance: AndroidImportance.HIGH,
      vibration: true,
      vibrationPattern: [300, 600, 300, 600],
      bypassDnd: true,
      visibility: AndroidVisibility.PUBLIC,
    });
    channelsReady = true;
  } catch { /* channels are best-effort; displayNotification still degrades */ }
}

/**
 * Raise the OS notification for an alert. Best-effort by construction — a
 * family event must never fail because the tray refused it, so every path
 * swallows. Returns true when a notification was actually posted.
 */
export async function notifyFamilyAlert(alert: FamilyAlert, meId: string | null): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  // Never notify someone about themselves (see SCOPE above).
  if (meId && String(alert.actorId) === String(meId)) return false;
  // 'sharing' is bookkeeping, not news — it stays inbox-only.
  if (alert.kind === 'sharing') return false;

  const critical = alert.sev === 'critical';
  await ensureFamilyChannels();
  try {
    await notifee.displayNotification({
      // Same id per alert ⇒ a re-raise refreshes rather than stacks.
      id: `family-${alert.id}`,
      title: `${GLYPH[alert.kind] ?? '📍'} Family Space`,
      body: alert.text,
      data: { type: 'family-alert', circleId: alert.circleId, actorId: alert.actorId },
      android: {
        channelId: critical ? FAMILY_CRITICAL_CHANNEL_ID : FAMILY_CHANNEL_ID,
        importance: critical ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
        visibility: AndroidVisibility.PRIVATE,
        autoCancel: true,
        lightUpScreen: critical,
        pressAction: { id: 'open-family', launchActivity: 'default' },
      },
      // No `ios:` block on purpose: nothing else in this repo sets iOS-specific
      // notifee options, so there is no proven shape to copy. iOS takes the
      // defaults (which are correct for a normal alert) and the critical-alert
      // treatment is F7.3, where the entitlement is dealt with properly.
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Emergency Connect (F7.1, client half) — the loud, full-screen alert raised
 * when an escalation ladder runs out of reminders.
 *
 * Every option here is copied from `lib/lock/lockNotifications.ts:showLockAlarm`,
 * which is the one alarm surface in this repo already proven on device.
 * Inventing an option shape would be a poor trade: notifee cannot be
 * typechecked in this environment, and a rejected payload fails silently —
 * which for THIS notification means the emergency is simply never shown.
 *
 * WHAT THIS IS NOT: kill-safe delivery. Nothing here runs if the guardian's app
 * process is gone. The spec requires the alert to survive an app kill via the
 * native FCM path, and that needs the server to send a high-priority push when
 * an Emergency Connect is posted — server work, still open on 7.1.
 *
 * Fixed id: a repeat refreshes the same alert instead of stacking a second
 * siren on top of the first.
 */
export async function notifyEmergencyConnect(body: string, circleId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  await ensureFamilyChannels();
  try {
    await notifee.displayNotification({
      id: EMERGENCY_CONNECT_ID,
      title: '\u{1F6A8} Emergency Connect',
      body,
      data: { type: 'family-emergency', circleId },
      android: {
        channelId: FAMILY_CRITICAL_CHANNEL_ID,
        category: AndroidCategory.ALARM,
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PUBLIC,
        ongoing: true,
        autoCancel: false,
        loopSound: true,
        lightUpScreen: true,
        fullScreenAction: { id: 'default', launchActivity: 'default' },
        pressAction: { id: 'open-family-emergency', launchActivity: 'default' },
        actions: [{ title: 'Acknowledge', pressAction: { id: 'family-emergency-ack' } }],
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelEmergencyConnect(): Promise<void> {
  try { await notifee.cancelNotification(EMERGENCY_CONNECT_ID); } catch {}
}

export default {};
