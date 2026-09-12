// lib/notificationActions.ts — reply and mark-as-read from the notification.
//
// AUDIT F6. Notifications were read-only: every message required opening the
// app, which on a busy group is the difference between a messenger people keep
// and one they mute. The delivery plumbing was already strong — background sync
// when killed, a Notifee foreground service, per-chat mute, custom sounds — so
// the hard part was done and only the affordance was missing.
//
// HOW THE TWO DELIVERY PATHS BOTH GET IT
// --------------------------------------
// Message notifications reach a device two ways, and this covers both because
// both are displayed by expo-notifications:
//
//   push        the server sends an Expo push with categoryId "message"
//               (chatsSendExpoPush in chats_helpers.go);
//   no-GMS      lib/messageNotifications raises it locally with the same
//               category.
//
// A category registered once at boot attaches the actions to whichever arrives.
//
// THE REPLY GOES THROUGH THE DURABLE OUTBOX, not through a direct send. That is
// the difference between a reply that works and one that silently vanishes:
// enqueueText persists first and flushes after, so a reply typed on a train
// sends when signal returns, and the message is encrypted by the same seam as
// every other send rather than by a second, lesser path.
//
// WHAT THIS CANNOT DO, stated rather than discovered later: when the app has
// been KILLED, Android hands the action response to the process that starts as
// a result, so the reply is enqueued at next launch rather than at the moment
// it was typed. It is not lost — it is queued — but it is not instant. Making
// it instant needs a native headless task, which is a larger change than the
// affordance itself.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { markRead } from './chatService';
import { enqueueText } from './messageQueue';
import { markSeen } from './messageNotifications';

export const MESSAGE_CATEGORY = 'message';
export const ACTION_REPLY = 'reply';
export const ACTION_MARK_READ = 'mark_read';

let registered = false;

/**
 * Attach the actions to the "message" category. Idempotent, and never throws —
 * a device that refuses the category still shows the notification, just without
 * the buttons, which is exactly the behaviour before this existed.
 */
export async function registerMessageActions(): Promise<void> {
  if (registered || Platform.OS === 'web') return;
  registered = true;
  try {
    await Notifications.setNotificationCategoryAsync(MESSAGE_CATEGORY, [
      {
        identifier: ACTION_REPLY,
        buttonTitle: 'Reply',
        textInput: { submitButtonTitle: 'Send', placeholder: 'Message' },
        options: {
          // The whole point is not to open the app. Opening it to send a reply
          // is the behaviour this replaces.
          opensAppToForeground: false,
        },
      },
      {
        identifier: ACTION_MARK_READ,
        buttonTitle: 'Mark as read',
        options: { opensAppToForeground: false },
      },
    ]);
  } catch {
    // Older OS, an unsupported platform, or a permissions state that refuses
    // categories. The notification still arrives and still opens on tap.
  }
}

/** The text the user typed, whichever key this platform used for it. */
function replyText(response: Notifications.NotificationResponse): string {
  const anyResponse = response as any;
  const raw = anyResponse?.userText ?? anyResponse?.notification?.userText ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Handle a notification ACTION. Returns true when it consumed the response, so
 * the caller must not also run its tap-to-open routing — a reply that opens the
 * chat as a side effect is not a reply from the notification.
 *
 * Never throws: this runs inside a system callback, where an exception is a
 * crash the user cannot explain and did not cause.
 */
export async function handleMessageAction(
  response: Notifications.NotificationResponse,
): Promise<boolean> {
  const action = response?.actionIdentifier;
  if (action !== ACTION_REPLY && action !== ACTION_MARK_READ) return false;

  const data: any = response?.notification?.request?.content?.data ?? {};
  const chatId = typeof data.chatId === 'string' ? data.chatId : '';
  if (!chatId) return true; // consumed: there is nothing to open either

  try {
    if (action === ACTION_REPLY) {
      const text = replyText(response);
      // An empty reply is a user who opened the input and thought better of it.
      // Sending nothing is correct; sending an empty message is not.
      if (text) await enqueueText(chatId, text);
    } else {
      // Mark-as-read has two halves and they are independent. The local one
      // stops the notification resurfacing on this device; the server one tells
      // the sender. A failed server call must not undo the local one — the user
      // has read it either way.
      const upTo = Number(data.messageId ?? data.msgId ?? 0);
      if (Number.isFinite(upTo) && upTo > 0) {
        await markSeen(chatId, upTo);
        try { await markRead(chatId, upTo); } catch {}
      }
      try { await Notifications.dismissNotificationAsync(response.notification.request.identifier); } catch {}
    }
  } catch {
    // Swallowed deliberately. enqueueText already persisted before anything
    // that can fail, so a throw here means the flush failed, and the flush
    // retries on its own.
  }
  return true;
}

export default { registerMessageActions, handleMessageAction, MESSAGE_CATEGORY };
