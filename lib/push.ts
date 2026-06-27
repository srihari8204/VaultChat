// Expo push token registration + notification listeners (Day 2).
//
// Flow on cold start / sign-in:
//   1. ensurePermissionAndChannel() — asks for notification permission,
//      configures the Android "default" channel
//   2. getExpoPushToken() — pulls the ExponentPushToken[...] for this device
//   3. registerPushToken() — POSTs it to /user/devices so the server can
//      address this device when a new message arrives
//
// Notification handling:
//   * Foreground notifications show via Notifications.setNotificationHandler
//   * Tap handler is wired in app/_layout.tsx via attachTapHandler() — it
//     reads notification.request.content.data.chatId and routes to /chat?id=...

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { api } from './api';

const EAS_PROJECT_ID = '144570a3-de88-48f0-b7e1-ecda63618199';

// Selectable notification sounds → one Android channel each. The sound files
// (note_*.wav) are bundled into res/raw by the expo-notifications plugin
// (app.json "sounds"). `channelId` is what the server sends in the push.
export const NOTIF_CHANNELS = [
  { id: 'default', name: 'Default', channelId: 'default', channelName: 'Messages',         sound: 'default' as const },
  { id: 'chime',   name: 'Chime',   channelId: 'chime',   channelName: 'Messages (Chime)', sound: 'note_chime.wav' },
  { id: 'bell',    name: 'Bell',    channelId: 'bell',    channelName: 'Messages (Bell)',  sound: 'note_bell.wav' },
];

// Show notifications even when the app is foregrounded (otherwise the
// system silently swallows them and the user sees nothing).
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // For a CALL push while the app is in the foreground, the live socket
    // already shows the in-app incoming-call screen — suppress the duplicate
    // notification + ringtone. When backgrounded/killed there's no socket, so
    // the OS shows it normally (that's what wakes the user).
    const data: any = notification.request.content.data;
    if (data?.type === 'call' && AppState.currentState === 'active') {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: false, shouldShowList: false };
    }
    return {
      shouldShowAlert:  true,
      shouldPlaySound:  true,
      shouldSetBadge:   false,
      shouldShowBanner: true,
      shouldShowList:   true,
    };
  },
});

let cachedToken: string | null = null;

export async function ensurePermissionAndChannel(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  // Android 8+ requires explicit notification channels for sound/vibration.
  // One channel per selectable sound — the server addresses the right channel
  // via the push payload's channelId (per-chat notification sound).
  if (Platform.OS === 'android') {
    for (const ch of NOTIF_CHANNELS) {
      try {
        await Notifications.setNotificationChannelAsync(ch.channelId, {
          name: ch.channelName,
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#6C63FF',
          sound: ch.sound,
        });
      } catch (err) {
        console.warn('[push] setNotificationChannel failed:', (err as any)?.message);
      }
    }
    // Dedicated high-urgency channel for incoming calls: MAX importance, ringer
    // loop, bypasses Do-Not-Disturb, shows fully on the lock screen.
    try {
      await Notifications.setNotificationChannelAsync('calls', {
        name: 'Calls',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 1000, 800, 1000, 800, 1000],
        lightColor: '#6C63FF',
        sound: 'default',
        bypassDnd: true,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        enableVibrate: true,
      });
    } catch (err) {
      console.warn('[push] calls channel failed:', (err as any)?.message);
    }
  }

  // Accept / Decline action buttons on the incoming-call notification.
  try {
    await Notifications.setNotificationCategoryAsync('incoming_call', [
      { identifier: 'accept',  buttonTitle: 'Accept',  options: { opensAppToForeground: true } },
      { identifier: 'decline', buttonTitle: 'Decline', options: { opensAppToForeground: false, isDestructive: true } },
    ]);
  } catch {}

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status: requested } = await Notifications.requestPermissionsAsync();
  return requested === 'granted';
}

export async function getExpoPushToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  if (cachedToken) return cachedToken;
  try {
    const token = await Notifications.getExpoPushTokenAsync({
      projectId: EAS_PROJECT_ID,
    });
    cachedToken = token.data;
    return cachedToken;
  } catch (err) {
    console.warn('[push] getExpoPushToken failed:', (err as any)?.message);
    return null;
  }
}

export async function registerPushToken(): Promise<void> {
  const granted = await ensurePermissionAndChannel();
  if (!granted) {
    console.log('[push] permission not granted — skipping registration');
    return;
  }
  const token = await getExpoPushToken();
  if (!token) return;

  try {
    const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    const deviceName =
      (Constants as any)?.deviceName ||
      (Constants as any)?.platform?.[platform]?.modelName ||
      undefined;
    const appVersion = (Constants?.expoConfig as any)?.version ?? undefined;

    await api('/user/devices', {
      method: 'POST',
      json: { pushToken: token, platform, deviceName, appVersion },
    });
    console.log('[push] token registered with backend');
  } catch (err) {
    console.warn('[push] register failed:', (err as any)?.message);
  }
}

/**
 * Best-effort de-register on sign-out so the previous account stops
 * getting push for the new account's messages.
 */
export async function unregisterPushToken(): Promise<void> {
  const token = cachedToken;
  if (!token) return;
  try {
    await api('/user/devices', { method: 'DELETE', json: { pushToken: token } });
  } catch {}
  cachedToken = null;
}

/**
 * Listen for notification taps and route to /chat?id=<chatId>.
 * Returns an unsubscribe function. Call from app/_layout.tsx so it
 * survives screen changes.
 */
export function attachTapHandler(
  onOpenChat: (chatId: string) => void,
  onCall?: (data: any, action: string) => void,
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data: any = response.notification.request.content.data;
    if (data?.type === 'call') { onCall?.(data, response.actionIdentifier); return; }
    if (data?.chatId) onOpenChat(String(data.chatId));
  });
  return () => sub.remove();
}

// Required by expo-router file-routing convention for default exports;
// lib/ isn't a route folder but we follow the same hygiene.
export default {};
