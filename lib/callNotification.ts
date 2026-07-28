// lib/callNotification.ts — full-screen incoming-call notification via Notifee.
//
// Shows a lock-screen, full-screen-intent call UI (Answer/Decline) that fires
// even when the app is backgrounded or killed — the WhatsApp behaviour. The
// caller's high-priority push (server) wakes the device; this renders the UI.

import { Platform } from 'react-native';
import notifee, {
  AndroidImportance, AndroidCategory, AndroidVisibility,
} from '@notifee/react-native';

const CALL_ID = 'incoming-call';

export type CallNotifData = {
  fromUid: string;
  callerName?: string;
  callType?: string;   // 'audio' | 'video'
  chatId?: string;
};

export async function ensureCallChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await notifee.createChannel({
      id: 'calls',
      name: 'Calls',
      importance: AndroidImportance.HIGH,
      sound: 'default',
      vibration: true,
      vibrationPattern: [300, 600, 300, 600],
      bypassDnd: true,
      visibility: AndroidVisibility.PUBLIC,
    });
  } catch {}
}

/** Display (or refresh) the full-screen incoming-call notification. */
export async function displayIncomingCall(d: CallNotifData): Promise<void> {
  if (Platform.OS === 'web' || !d?.fromUid) return;
  await ensureCallChannel();
  try {
    await notifee.displayNotification({
      id: CALL_ID,
      title: d.callerName || 'Incoming call',
      body: d.callType === 'video' ? 'Incoming video call' : 'Incoming voice call',
      data: {
        type: 'call', fromUid: d.fromUid, callerName: d.callerName || '',
        callType: d.callType || 'audio', chatId: d.chatId || '',
      },
      android: {
        channelId: 'calls',
        category: AndroidCategory.CALL,
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PUBLIC,
        ongoing: true,
        autoCancel: false,
        loopSound: true,
        lightUpScreen: true,
        // The key bit: launches our activity full-screen over the lock screen.
        fullScreenAction: { id: 'default', launchActivity: 'default' },
        pressAction: { id: 'answer', launchActivity: 'default' },
        actions: [
          { title: 'Decline', pressAction: { id: 'decline' } },
          { title: 'Answer',  pressAction: { id: 'answer', launchActivity: 'default' } },
        ],
        timeoutAfter: 45000,   // auto-dismiss if unanswered
      },
    });
  } catch {}
}

export async function cancelIncomingCall(): Promise<void> {
  try { await notifee.cancelNotification(CALL_ID); } catch {}
}

export default {};
