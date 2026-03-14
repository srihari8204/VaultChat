// services/notificationService.ts
// Real push notifications â€” Expo Push API + Firebase Messaging
//
// What this does:
//   1. Registers device for push on login â†’ saves token to Firestore
//   2. sendPushToUser() â€” called from chat.tsx on every message send
//   3. Tap on notification â†’ opens the exact chat it came from
//   4. Foreground notifications â€” shows banner even when app is open
//   5. Badge count â€” increments on receive, resets on chat open

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';
import { Router } from 'expo-router';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Foreground notification behaviour
// Show alert + sound + badge even when app is in foreground
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge:  true,
    shouldShowBanner: true,
    shouldShowList:   true,
  }),
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 1. Register device for push notifications
//    Call this once after successful login / OTP confirm
//    Saves the Expo push token to Firestore under users/{uid}
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function registerForPushNotifications(): Promise<string | null> {
  // Push notifications only work on real physical devices
  if (!Device.isDevice) {
    console.log('[Push] Skipping â€” not a physical device');
    return null;
  }

  // Request permission
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('[Push] Permission denied by user');
    return null;
  }

  // Create Android notification channel
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('vaultchat_messages', {
      name:             'VaultChat Messages',
      importance:       Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor:       '#00D4AA',
      sound:            'default',
      enableVibrate:    true,
      showBadge:        true,
      lockscreenVisibility:
        Notifications.AndroidNotificationVisibility.PRIVATE, // hides preview on lock screen
    });

    await Notifications.setNotificationChannelAsync('vaultchat_calls', {
      name:       'VaultChat Calls',
      importance: Notifications.AndroidImportance.MAX,
      sound:      'default',
    });
  }

  // Get Expo push token
  let token: string | null = null;
  try {
    const response = await Notifications.getExpoPushTokenAsync({
      projectId: '144570a3-de88-48f0-b7e1-ecda63618199', // EAS project ID
    });
    token = response.data;
    console.log('[Push] Token registered:', token);
  } catch (e) {
    console.error('[Push] Failed to get token:', e);
    return null;
  }

  // Save token to Firestore so other users can send to this device
  const uid = auth().currentUser?.uid;
  if (uid && token) {
    await firestore()
      .collection('users')
      .doc(uid)
      .set(
        {
          pushToken:      token,
          pushPlatform:   Platform.OS,
          pushUpdatedAt:  firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  return token;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 2. Send push notification to a chat participant
//    Called from chat.tsx after every successful Firestore write
//
//    chatId    â€” the Firestore chat document ID
//    chatName  â€” display name shown in notification title
//    preview   â€” message preview text (we always send generic text,
//                never the actual message content for privacy)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function sendPushToUser(
  chatId:    string,
  chatName:  string,
  preview:   string = 'ðŸ” New encrypted message',
): Promise<void> {
  try {
    const myUid = auth().currentUser?.uid;
    if (!myUid) return;

    // 1. Get the chat document to find the other participant(s)
    const chatDoc = await firestore()
      .collection('chats')
      .doc(chatId)
      .get();

    if (!chatDoc.exists) return;

    const participants: string[] = chatDoc.data()?.participants || [];
    const recipients = participants.filter(p => p !== myUid);

    if (recipients.length === 0) return;

    // 2. Get push tokens for all recipients
    const tokenPromises = recipients.map(uid =>
      firestore().collection('users').doc(uid).get()
    );
    const userDocs = await Promise.all(tokenPromises);

    const tokens: string[] = userDocs
      .map(doc => doc.data()?.pushToken)
      .filter(Boolean) as string[];

    if (tokens.length === 0) {
      console.log('[Push] No tokens found for recipients');
      return;
    }

    // 3. Send via Expo Push API
    //    We NEVER send the actual message content in the push â€”
    //    only a generic notification. The app decrypts from Firestore.
    const messages = tokens.map(to => ({
      to,
      title:     `ðŸ” ${chatName}`,
      body:      preview,          // Always generic â€” never plaintext
      data:      { chatId, type: 'message' },
      sound:     'default',
      channelId: 'vaultchat_messages',
      badge:     1,
      // Lock screen visibility â€” show notification but hide preview
      // on Android lock screen for privacy
    }));

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();

    // Check for errors in response
    if (result.data) {
      const errors = Array.isArray(result.data)
        ? result.data.filter((r: any) => r.status === 'error')
        : [];
      if (errors.length > 0) {
        console.warn('[Push] Some tokens failed:', errors);
        // Clean up expired tokens from Firestore
        for (const err of errors) {
          if (err.details?.error === 'DeviceNotRegistered') {
            await removeExpiredToken(err.details.expoPushToken);
          }
        }
      }
    }
  } catch (e) {
    // Push failure must NEVER block the send flow
    console.warn('[Push] sendPushToUser failed (non-critical):', e);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 3. Send call notification (incoming call alert)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function sendCallNotification(
  chatId:   string,
  callerName: string,
  callType: 'video' | 'voice',
): Promise<void> {
  try {
    const myUid = auth().currentUser?.uid;
    if (!myUid) return;

    const chatDoc = await firestore().collection('chats').doc(chatId).get();
    const participants: string[] = chatDoc.data()?.participants || [];
    const recipients = participants.filter(p => p !== myUid);

    const userDocs = await Promise.all(
      recipients.map(uid => firestore().collection('users').doc(uid).get())
    );
    const tokens = userDocs
      .map(doc => doc.data()?.pushToken)
      .filter(Boolean) as string[];

    if (tokens.length === 0) return;

    const icon = callType === 'video' ? 'ðŸ“¹' : 'ðŸ“ž';

    await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map(to => ({
        to,
        title:     `${icon} Incoming ${callType} call`,
        body:      `${callerName} is calling...`,
        data:      { chatId, type: callType === 'video' ? 'videocall' : 'voicecall', callerName },
        sound:     'default',
        channelId: 'vaultchat_calls',
        priority:  'high',
      }))),
    });
  } catch (e) {
    console.warn('[Push] sendCallNotification failed:', e);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 4. Setup notification tap listeners
//    Call this once in _layout.tsx
//    When user taps a notification â†’ navigates to the right chat
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function setupNotificationListeners(router: Router): () => void {
  // Listener A â€” notification received while app is OPEN (foreground)
  const foregroundSub = Notifications.addNotificationReceivedListener(notification => {
    const data = notification.request.content.data;
    console.log('[Push] Foreground notification:', data);
    // We don't navigate here â€” user is already in the app
    // The Firestore listener in chat.tsx will update messages automatically
  });

  // Listener B â€” user TAPS a notification (app in background or closed)
  const tapSub = Notifications.addNotificationResponseReceivedListener(response => {
    const data = response.notification.request.content.data as {
      chatId?: string;
      type?: string;
      callerName?: string;
    };

    if (!data?.chatId) return;

    if (data.type === 'message') {
      // Navigate to the specific chat
      router.push({
        pathname: '/chat',
        params: { chatId: data.chatId },
      });
    } else if (data.type === 'videocall') {
      router.push({
        pathname: '/videocall',
        params: { chatId: data.chatId, name: data.callerName || '' },
      });
    } else if (data.type === 'voicecall') {
      router.push({
        pathname: '/voicecall',
        params: { chatId: data.chatId, name: data.callerName || '' },
      });
    }
  });

  // Return cleanup function â€” call this in useEffect return
  return () => {
    foregroundSub.remove();
    tapSub.remove();
  };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 5. Handle notification that LAUNCHED the app from killed state
//    Call this once in _layout.tsx useEffect
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function handleInitialNotification(router: Router): Promise<void> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (!response) return;

  const data = response.notification.request.content.data as {
    chatId?: string;
    type?: string;
    callerName?: string;
  };

  if (!data?.chatId) return;

  // Small delay to let navigation stack fully mount
  setTimeout(() => {
    if (data.type === 'message') {
      router.push({
        pathname: '/chat',
        params: { chatId: data.chatId },
      });
    }
  }, 500);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 6. Badge management
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function clearBadge(): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {}
}

export async function incrementBadge(): Promise<void> {
  try {
    const current = await Notifications.getBadgeCountAsync();
    await Notifications.setBadgeCountAsync(current + 1);
  } catch {}
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 7. Remove expired push token from Firestore
//    Called when Expo Push API returns DeviceNotRegistered
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function removeExpiredToken(expiredToken: string): Promise<void> {
  try {
    const snap = await firestore()
      .collection('users')
      .where('pushToken', '==', expiredToken)
      .get();

    for (const doc of snap.docs) {
      await doc.ref.update({
        pushToken: firestore.FieldValue.delete(),
      });
    }
    console.log('[Push] Removed expired token');
  } catch (e) {
    console.warn('[Push] Failed to remove expired token:', e);
  }
}
