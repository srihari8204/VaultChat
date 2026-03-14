/**
 * VaultChat — Real Push + Local Notifications
 * Uses expo-notifications
 * Works in native build
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

// Configure how notifications appear
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge:  true,
    shouldShowBanner: true,
    shouldShowList:   true,
  }),
});

// -- Request permission --------------------------------------------------------
export const requestNotificationPermission = async (): Promise<boolean> => {
  if (!Device.isDevice) {
    console.warn('Notifications only work on physical device or emulator');
    return false;
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('messages', {
      name:               'Messages',
      importance:         Notifications.AndroidImportance.MAX,
      vibrationPattern:   [0, 250, 250, 250],
      lightColor:         '#4A9FFF',
      sound:              'default',
      showBadge:          true,
    });

    await Notifications.setNotificationChannelAsync('calls', {
      name:               'Calls',
      importance:         Notifications.AndroidImportance.MAX,
      vibrationPattern:   [0, 500],
      lightColor:         '#10B981',
      sound:              'default',
    });
  }

  return true;
};

// -- Get push token ------------------------------------------------------------
export const getPushToken = async (): Promise<string | null> => {
  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data;
  } catch (e) {
    console.error('Push token error:', e);
    return null;
  }
};

// -- Send local notification (new message) ------------------------------------
export const notifyNewMessage = async (
  senderName: string,
  preview: string = 'New encrypted message'
): Promise<void> => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title:    senderName,
      body:     preview,          // Never show actual content — privacy first
      sound:    'default',
      badge:    1,
      data:     { type: 'message' },
      categoryIdentifier: 'messages',
    },
    trigger: null, // show immediately
  });
};

// -- Send local notification (incoming call) -----------------------------------
export const notifyIncomingCall = async (callerName: string): Promise<void> => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title:    `?? ${callerName}`,
      body:     'Incoming VaultChat call',
      sound:    'default',
      data:     { type: 'call' },
      categoryIdentifier: 'calls',
    },
    trigger: null,
  });
};

// -- Clear all notifications ---------------------------------------------------
export const clearAllNotifications = async (): Promise<void> => {
  await Notifications.dismissAllNotificationsAsync();
  await Notifications.setBadgeCountAsync(0);
};

// -- Listen for notification tap -----------------------------------------------
export const onNotificationTap = (
  callback: (data: any) => void
): (() => void) => {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    callback(response.notification.request.content.data);
  });
  return () => sub.remove();
};
