// services/security/deviceSecurity/securityNotifications.ts — the "Security" channel.
//
// ⚠️ DEVICE-ONLY (uses @notifee/react-native + react-native): not run under the
// Node self-tests. Thin presentation adapter — it takes the notifications the
// pure notificationPolicy already DECIDED to send and displays them on a
// dedicated, user-tunable "Security" channel. All the "should we notify / is it
// still cooling down" logic lives in the tested core; this file only paints.
//
// Privacy: bodies are already written generic enough to be safe on a lock
// screen (specifics live inside the app), per the module's privacy model.

import { Platform } from 'react-native';
import type { SecurityNotification } from './notificationPolicy';

const CHANNEL_ID = 'vaultchat_security';
let channelReady = false;

// Guarded require mirrors lib/transferForeground.ts — never throws if the native
// module is absent (e.g. Expo Go), so a monitoring scan can't crash the app.
function nf(): { notifee: any; AndroidImportance: any } | null {
  try {
    const { default: notifee, AndroidImportance } = require('@notifee/react-native');
    return { notifee, AndroidImportance };
  } catch {
    return null;
  }
}

async function ensureChannel(notifee: any, AndroidImportance: any): Promise<void> {
  if (channelReady) return;
  channelReady = true;
  await notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Security alerts',
    description: 'Device-security warnings (root, instrumentation, risky settings).',
    importance: AndroidImportance.HIGH,
  }).catch(() => {});
}

/**
 * Present the decided notifications. Critical items alert with high importance;
 * warnings post quietly. Fire-and-forget safe: a missing native module or a
 * display error is swallowed so it never affects the scan or the UI.
 */
export async function presentSecurityNotifications(items: SecurityNotification[]): Promise<void> {
  if (!items.length) return;
  const mod = nf();
  if (!mod) return;               // no native notifee → dashboard/audit still have it
  const { notifee, AndroidImportance } = mod;

  try {
    await ensureChannel(notifee, AndroidImportance);
    for (const n of items) {
      await notifee.displayNotification({
        title: n.title,
        body: n.body,
        android: {
          channelId: CHANNEL_ID,
          importance: n.severity === 'critical' ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
          pressAction: { id: 'default', launchActivity: 'default' },
          smallIcon: 'ic_notification',
        },
        ...(Platform.OS === 'ios' ? { ios: { sound: n.severity === 'critical' ? 'default' : undefined } } : {}),
      }).catch(() => {});
    }
  } catch {
    // best-effort presentation only
  }
}
