// lib/callBackground.ts — call notification handlers that must be registered at
// JS-load time (before the React tree), so they fire even when the app is
// launched headless by a notification while killed.
//
// Imported for its side effects from app/_layout.tsx.

import notifee, { EventType } from '@notifee/react-native';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { cancelIncomingCall, displayIncomingCall } from './callNotification';
import { setPendingCall } from './ringTracker';

// 1. Notifee background events (app backgrounded or killed). Answer is handled
//    by launchActivity + getInitialNotification on app start; here we record the
//    intent and (for decline) clear the call.
notifee.onBackgroundEvent(async ({ type, detail }) => {
  const data: any = detail?.notification?.data;
  // Scheduled-message trigger fired while backgrounded/killed (#73) → send due
  // items best-effort (lazy require keeps the headless load path light).
  if (data?.type === 'scheduled_fire') {
    try { await require('./scheduledRunner').runDueScheduled(); } catch {}
    return;
  }
  // Location Lock: "Stop alarm" pressed on the exit-alarm notification while
  // backgrounded/killed (lazy require keeps the headless load path light).
  if (data?.type === 'lock-alarm') {
    if (type === EventType.ACTION_PRESS && detail?.pressAction?.id === 'lock-stop-alarm') {
      try { await require('./lock/background').silenceAlarmFromNotification(); } catch {}
    }
    return;
  }
  if (data?.type !== 'call') return;
  const id = detail?.pressAction?.id;
  if (type === EventType.ACTION_PRESS && id === 'decline') {
    setPendingCall({ action: 'decline', data });
    await cancelIncomingCall();
  } else if (type === EventType.ACTION_PRESS && id === 'answer') {
    setPendingCall({ action: 'answer', data });
  } else if (type === EventType.PRESS) {
    setPendingCall({ action: 'answer', data });
  }
});

// 2. Expo background notification task: a call push arriving while the app is
//    backgrounded/killed renders the Notifee full-screen call UI.
const CALL_BG_TASK = 'vc-call-bg-notif';
TaskManager.defineTask(CALL_BG_TASK, async ({ data, error }: any) => {
  if (error) return;
  try {
    const content = data?.notification?.request?.content ?? data?.notification?.data ?? data ?? {};
    const d = content?.data ?? content;
    if (d?.type === 'call' && d?.fromUid) {
      await displayIncomingCall({ fromUid: d.fromUid, callerName: d.callerName, callType: d.callType, chatId: d.chatId });
    }
  } catch {}
});
Notifications.registerTaskAsync(CALL_BG_TASK).catch(() => {});

export default {};
