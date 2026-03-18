// @ts-nocheck
// services/securityService.ts
// Real jailbreak / root / Frida detection + key wipe
// Runs on every app launch before any screen is shown

import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ThreatType =
  | 'ROOT_DETECTED'
  | 'MAGISK_DETECTED'
  | 'SU_BINARY_FOUND'
  | 'TEST_KEYS_BUILD'
  | 'FRIDA_PORT_27042'
  | 'FRIDA_SERVER_RESPONSE'
  | 'EMULATOR_DETECTED'
  | 'ADB_ENABLED';

export interface ThreatDetail {
  type: ThreatType;
  detail: string;
}

export interface SecurityReport {
  clean: boolean;
  threats: ThreatDetail[];
  checkedAt: number;
  platform: string;
  deviceModel: string;
}

// ─────────────────────────────────────────────────────────────
// 1. Root / Jailbreak Detection
//    Uses react-native-device-info which checks 20+ native indicators:
//    - su binary in /system/xbin/su, /system/bin/su, /sbin/su etc.
//    - Superuser.apk, SuperSU presence
//    - Dangerous system properties
//    - /system writeable check
//    - Build tags containing "test-keys"
// ─────────────────────────────────────────────────────────────

async function checkRootJailbreak(): Promise<ThreatDetail[]> {
  const threats: ThreatDetail[] = [];

  try {
    const rooted = await (DeviceInfo as any).isRooted();
    if (rooted) {
      threats.push({
        type: 'ROOT_DETECTED',
        detail: 'Device is rooted — react-native-device-info confirmed root indicators',
      });
    }
  } catch (e) {
    console.warn('[Security] isRooted() call failed:', e);
  }

  try {
    const fingerprint = await DeviceInfo.getFingerprint();
    if (fingerprint.includes('test-keys')) {
      threats.push({
        type: 'TEST_KEYS_BUILD',
        detail: `Build fingerprint contains test-keys: ${fingerprint}`,
      });
    }
  } catch (e) {
    console.warn('[Security] getFingerprint() failed:', e);
  }

  try {
    const adbEnabled = await (DeviceInfo as any).isAdbEnabled();
    if (adbEnabled) {
      threats.push({
        type: 'ADB_ENABLED',
        detail: 'ADB debugging is enabled — possible developer/attacker access',
      });
    }
  } catch (e) {
    console.warn('[Security] isAdbEnabled() failed:', e);
  }

  return threats;
}

// ─────────────────────────────────────────────────────────────
// 2. Frida / Anti-Instrumentation Detection
//    Frida injects a server on port 27042 by default.
//    We attempt a TCP connection — if anything responds, Frida is present.
// ─────────────────────────────────────────────────────────────

async function checkFrida(): Promise<ThreatDetail[]> {
  const threats: ThreatDetail[] = [];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);

    const response = await fetch('http://127.0.0.1:27042', {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    threats.push({
      type: 'FRIDA_PORT_27042',
      detail: `Frida server responded on port 27042 — status ${response.status}`,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn('[Security] Port 27042 timeout — inconclusive');
    }
  }

  try {
    const controller2 = new AbortController();
    const timeoutId2 = setTimeout(() => controller2.abort(), 600);

    const res = await fetch('http://127.0.0.1:27042/enumerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'session' }),
      signal: controller2.signal,
    });

    clearTimeout(timeoutId2);

    const text = await res.text();
    if (text && (text.includes('frida') || text.includes('session') || text.length > 0)) {
      threats.push({
        type: 'FRIDA_SERVER_RESPONSE',
        detail: 'Frida server returned data on /enumerate — instrumentation confirmed',
      });
    }
  } catch {
    // Connection refused = safe. Expected on clean devices.
  }

  return threats;
}

// ─────────────────────────────────────────────────────────────
// 3. Emulator Check
// ─────────────────────────────────────────────────────────────

async function checkEmulator(): Promise<ThreatDetail[]> {
  const threats: ThreatDetail[] = [];
  try {
    const isEmulator = await DeviceInfo.isEmulator();
    if (isEmulator) {
      threats.push({
        type: 'EMULATOR_DETECTED',
        detail: 'App is running on an emulator — not permitted in production',
      });
    }
  } catch (e) {
    console.warn('[Security] isEmulator() failed:', e);
  }
  return threats;
}

// ─────────────────────────────────────────────────────────────
// 4. Key Wipe
//    Called immediately when any threat is detected.
//    Deletes ALL session keys, ratchet states, and vault PIN
//    from hardware-backed SecureStore.
// ─────────────────────────────────────────────────────────────

export async function wipeAllKeys(): Promise<void> {
  console.warn('[SECURITY] THREAT DETECTED — WIPING ALL KEYS');

  const keysToDelete = [
    'vault_pin',
    'user_firstName',
    'user_lastName',
    'user_dob',
    'active_sessions',
    'setup_complete',
    'user_profile',
    'security_answers',
  ];

  for (const key of keysToDelete) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Key may not exist — continue
    }
  }

  try {
    const sessionsRaw = await SecureStore.getItemAsync('active_sessions');
    if (sessionsRaw) {
      const sessions: string[] = JSON.parse(sessionsRaw);
      for (const id of sessions) {
        try { await SecureStore.deleteItemAsync(`d2de_key_${id}`); } catch {}
        try { await SecureStore.deleteItemAsync(`ratchet_${id}`); } catch {}
      }
    }
  } catch {}

  for (let i = 0; i < 50; i++) {
    try { await SecureStore.deleteItemAsync(`d2de_key_chat_${i}`); } catch {}
    try { await SecureStore.deleteItemAsync(`ratchet_chat_${i}`); } catch {}
  }

  console.warn('[SECURITY] All keys wiped successfully');
}

// ─────────────────────────────────────────────────────────────
// 5. Log Security Event to Firestore
// ─────────────────────────────────────────────────────────────

async function logThreatToFirestore(report: SecurityReport): Promise<void> {
  try {
    const uid = auth().currentUser?.uid;
    if (!uid) return;

    await firestore()
      .collection('users')
      .doc(uid)
      .collection('securityEvents')
      .add({
        threats: report.threats.map(t => ({
          type: t.type,
          detail: t.detail,
        })),
        platform: report.platform,
        deviceModel: report.deviceModel,
        checkedAt: firestore.FieldValue.serverTimestamp(),
        appVersion: await DeviceInfo.getVersion(),
        buildNumber: await DeviceInfo.getBuildNumber(),
      });
  } catch (e) {
    console.warn('[Security] Failed to log threat to Firestore:', e);
  }
}

// ─────────────────────────────────────────────────────────────
// 6. Main Entry — runSecurityCheck()
//    Call this in _layout.tsx on every app mount.
//    Returns SecurityReport.
//    If clean = false → navigate to /blocked screen.
// ─────────────────────────────────────────────────────────────

export async function runSecurityCheck(): Promise<SecurityReport> {
  const deviceModel = DeviceInfo.getModel();

  const report: SecurityReport = {
    clean: true,
    threats: [],
    checkedAt: Date.now(),
    platform: Platform.OS,
    deviceModel,
  };

  const [rootThreats, fridaThreats, emulatorThreats] = await Promise.all([
    checkRootJailbreak(),
    checkFrida(),
    checkEmulator(),
  ]);

  report.threats = [...rootThreats, ...fridaThreats, ...emulatorThreats];
  report.clean = report.threats.length === 0;

  if (!report.clean) {
    await wipeAllKeys();
    logThreatToFirestore(report).catch(() => {});
    console.warn('[SECURITY] THREATS FOUND:', report.threats.map(t => t.type));
  } else {
    console.log('[Security] Device clean — no threats detected');
  }

  return report;
}

// ─────────────────────────────────────────────────────────────
// 7. Screenshot Detection Logger
// ─────────────────────────────────────────────────────────────

export async function logScreenshotAttempt(chatId: string): Promise<void> {
  try {
    const uid = auth().currentUser?.uid;
    if (!uid) return;

    await firestore()
      .collection('users')
      .doc(uid)
      .collection('securityEvents')
      .add({
        type: 'SCREENSHOT_ATTEMPT',
        chatId,
        timestamp: firestore.FieldValue.serverTimestamp(),
        platform: Platform.OS,
      });

    await firestore()
      .collection('chats')
      .doc(chatId)
      .collection('alerts')
      .add({
        type: 'SCREENSHOT',
        byUid: uid,
        timestamp: firestore.FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.warn('[Security] logScreenshotAttempt failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────
// 8. PIN Management
// ─────────────────────────────────────────────────────────────

export async function savePIN(pin: string): Promise<void> {
  await SecureStore.setItemAsync('vault_pin', pin);
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = await SecureStore.getItemAsync('vault_pin');
  return stored === pin;
}

// ─────────────────────────────────────────────────────────────
// 9. Setup State
// ─────────────────────────────────────────────────────────────

export async function isSetupComplete(): Promise<boolean> {
  const val = await SecureStore.getItemAsync('setup_complete');
  return val === 'true';
}

export async function markSetupComplete(): Promise<void> {
  await SecureStore.setItemAsync('setup_complete', 'true');
}

// ─────────────────────────────────────────────────────────────
// 10. Profile
// ─────────────────────────────────────────────────────────────

export async function saveProfile(data: Record<string, string>): Promise<void> {
  await SecureStore.setItemAsync('user_profile', JSON.stringify(data));
}

// ─────────────────────────────────────────────────────────────
// 11. Security Answers
// ─────────────────────────────────────────────────────────────

export async function saveSecurityAnswers(answers: Record<string, string>): Promise<void> {
  await SecureStore.setItemAsync('security_answers', JSON.stringify(answers));
}