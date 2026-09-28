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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { recordAlert, type FamilyAlert } from './alerts';

export const FAMILY_CHANNEL_ID = 'family-alerts';
export const FAMILY_CRITICAL_CHANNEL_ID = 'family-critical';
export const EMERGENCY_CONNECT_ID = 'family-emergency-connect';

/** Emoji per alert kind — the tray has no room for an icon set. */
const GLYPH: Record<FamilyAlert['kind'], string> = {
  enter: '📍', leave: '🚪', sos: '🆘', checkin: '✅', battery: '🪫', sharing: '📡',
  gps: '🛰️', offline: '📴', deviation: '↪️', announcement: '📢',
  overspeed: '🚨', longstop: '⏸️',
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

// ── iOS Critical Alerts capability (F7.3) ───────────────────────────────────
//
// A repeating critical alarm — one that sounds through silent mode and Focus —
// needs Apple's `com.apple.developer.usernotifications.critical-alerts`
// entitlement, which has to be granted by Apple before it can even appear in
// the app's entitlements. Until then iOS must degrade, and the spec is explicit
// that the degrade has to be RECORDED, not silent.
//
// SAFETY RULE for this whole section: the notification payload changes ONLY when
// the probe explicitly reports `enabled`. On every device today that is false,
// so the payload is byte-identical to what shipped before this code existed.
// A probe that throws, or returns something unexpected, degrades — it can never
// upgrade. That is what makes adding an unverifiable iOS option safe here.

export type CriticalAlertStatus = 'enabled' | 'disabled' | 'unsupported' | 'unknown';

const K_CRITICAL_STATUS = 'vc_family_critical_status';

let criticalCache: CriticalAlertStatus | null = null;
/** One degrade record per app session — the fact is worth logging, not spamming. */
let degradeRecorded = false;

/**
 * Read (never request) whether critical alerts are available.
 *
 * `getNotificationSettings` is read-only, so this cannot pop a permission
 * dialog in the middle of an emergency — which `requestPermission` would.
 */
export async function criticalAlertStatus(): Promise<CriticalAlertStatus> {
  if (criticalCache) return criticalCache;
  if (Platform.OS !== 'ios') { criticalCache = 'unsupported'; return criticalCache; }
  let next: CriticalAlertStatus = 'unknown';
  try {
    const settings: any = await notifee.getNotificationSettings();
    // notifee IOSNotificationSetting: 0 NOT_SUPPORTED, 1 DISABLED, 2 ENABLED.
    const v = settings?.ios?.criticalAlert;
    next = v === 2 ? 'enabled' : v === 1 ? 'disabled' : v === 0 ? 'unsupported' : 'unknown';
  } catch { next = 'unknown'; }
  criticalCache = next;
  try { await AsyncStorage.setItem(K_CRITICAL_STATUS, next); } catch {}
  return next;
}

/** Last known status without probing — for a settings/diagnostics surface. */
export async function lastCriticalAlertStatus(): Promise<CriticalAlertStatus> {
  if (criticalCache) return criticalCache;
  try {
    const raw = await AsyncStorage.getItem(K_CRITICAL_STATUS);
    return (raw as CriticalAlertStatus) || 'unknown';
  } catch { return 'unknown'; }
}

/** Test seam — the cache is process-lifetime, so tests and a re-check need this. */
export function resetCriticalAlertCache(): void { criticalCache = null; degradeRecorded = false; }

/**
 * Record, once per session, that an emergency was delivered WITHOUT the critical
 * channel. This is the spec's "records that the critical channel was
 * unavailable" — on Android it never fires, because the alarm channel there is
 * real (bypassDnd + ALARM category) rather than entitlement-gated.
 */
async function recordCriticalDegrade(circleId: string, status: CriticalAlertStatus): Promise<void> {
  if (degradeRecorded || Platform.OS !== 'ios') return;
  degradeRecorded = true;
  const why = status === 'disabled'
    ? 'the user has turned critical alerts off'
    : 'this build has no critical-alerts entitlement';
  await recordAlert({
    circleId, kind: 'sharing', actorId: 'system', actorName: 'VaultChat',
    text: `Emergency alerts are using the standard notification channel — ${why}. They will not sound through silent mode.`,
  }).catch(() => {});
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
  const critical = await criticalAlertStatus();
  if (critical !== 'enabled') await recordCriticalDegrade(circleId, critical);
  try {
    await notifee.displayNotification({
      id: EMERGENCY_CONNECT_ID,
      title: '\u{1F6A8} Emergency Connect',
      body,
      data: { type: 'family-emergency', circleId },
      // Only ever ADDED when Apple has granted the entitlement — see SAFETY RULE.
      // Without it the object is absent entirely, exactly as before, so this
      // cannot change how the alert behaves on any device shipping today.
      ...(critical === 'enabled'
        ? { ios: { critical: true, criticalVolume: 1.0, sound: 'default' } }
        : {}),
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
