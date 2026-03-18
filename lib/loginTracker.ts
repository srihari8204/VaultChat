// lib/loginTracker.ts — Login tracking + new device alert
// Called on every successful authentication
// Logs device info, alerts trusted contacts on new device

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Device from 'expo-device';

const KNOWN_DEVICES_KEY = 'vc_known_devices';

export interface LoginEntry {
  deviceName: string;
  platform: string;
  osVersion: string;
  brand: string;
  isNewDevice: boolean;
  loginAt: any;
  location?: string;
  ip?: string;
}

// Get device fingerprint
function getDeviceFingerprint(): string {
  return [
    Device.brand || 'unknown',
    Device.modelName || 'unknown',
    Device.osName || Platform.OS,
    Device.osVersion || 'unknown',
  ].join('|');
}

// Check if this is a new device
async function isNewDevice(): Promise<boolean> {
  const fp = getDeviceFingerprint();
  const raw = await AsyncStorage.getItem(KNOWN_DEVICES_KEY);
  const known: string[] = raw ? JSON.parse(raw) : [];
  if (known.includes(fp)) return false;
  // Add to known devices
  known.push(fp);
  await AsyncStorage.setItem(KNOWN_DEVICES_KEY, JSON.stringify(known));
  return true;
}

// Record login and alert if new device
export async function recordLogin(uid: string): Promise<void> {
  try {
    const firestore = (await import('@react-native-firebase/firestore')).default;
    const newDevice = await isNewDevice();

    const entry: any = {
      deviceName: Device.modelName || Device.deviceName || 'Unknown',
      platform: Platform.OS,
      osVersion: Device.osVersion || '',
      brand: Device.brand || '',
      isNewDevice: newDevice,
      loginAt: firestore.FieldValue.serverTimestamp(),
    };

    // Log to Firestore
    await firestore().collection('users').doc(uid)
      .collection('loginHistory').add(entry);

    // If new device, alert trusted contacts
    if (newDevice) {
      await alertTrustedContacts(uid, entry);
    }
  } catch (e) {
    console.warn('[LoginTracker] Error:', e);
  }
}

// Alert trusted contacts about new device login
async function alertTrustedContacts(uid: string, entry: any): Promise<void> {
  try {
    const firestore = (await import('@react-native-firebase/firestore')).default;
    const userDoc = await firestore().collection('users').doc(uid).get();
    const userData = userDoc.data();
    const trustedContacts: string[] = userData?.trustedContacts || [];
    const userName = userData?.name || 'Someone';

    for (const contactUid of trustedContacts) {
      try {
        await firestore().collection('users').doc(contactUid)
          .collection('alerts').add({
            type: 'new_device_login',
            fromUid: uid,
            fromName: userName,
            message: userName + ' logged in from a new device: ' + (entry.deviceName || 'Unknown') + ' (' + entry.platform + ')',
            deviceInfo: entry,
            createdAt: firestore.FieldValue.serverTimestamp(),
            read: false,
          });
      } catch {}
    }

    // Also create a security event
    await firestore().collection('users').doc(uid)
      .collection('securityEvents').add({
        type: 'new_device_login',
        device: entry.deviceName,
        platform: entry.platform,
        timestamp: firestore.FieldValue.serverTimestamp(),
      });
  } catch {}
}
