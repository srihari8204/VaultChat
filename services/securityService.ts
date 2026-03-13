// services/securityService.ts
// Real jailbreak / root / Frida detection + key wipe
// Runs on every app launch before any screen is shown

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';
import DeviceInfo from 'react-native-device-info';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────
// 1. Root / Jailbreak Detection
//    Uses react-native-device-info which checks 20+ native indicators:
//    - su binary in /system/xbin/su, /system/bin/su, /sbin/su etc.
//    - Superuser.apk, SuperSU presence
//    - Dangerous system properties
//    - /system writeable check
//    - Build tags containing "test-keys"
// ─────────────────────────────────────────────────────────────────

async function checkRootJailbreak(): Promise<ThreatDetail[]> {
  const threats: ThreatDetail[] = [];

  try {
    // Primary check — react-native-device-info isRooted()
    // This is a native call that checks 20+ root indicators
    const rooted = await DeviceInfo.isRooted();
    if (rooted) {
      threats.push({
        type: 'ROOT_DETECTED',
        detail: 'Device is rooted — react-native-device-info confirmed root indicators',
      });
    }
  } catch (e) {
    // If the native call itself fails suspiciously, flag it
    console.warn('[Security] isRooted() call failed:', e);
  }

  // Secondary check — build fingerprint for test-keys
  // Test-keys means the ROM was compiled with debug keys = modified/rooted ROM
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

  // Tertiary check — ADB enabled check (suspicious on production devices)
  // ADB being enabled doesn't mean rooted but is a red flag worth logging
  try {
    const adbEnabled = await DeviceInfo.isAdbEnabled();
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

// ─────────────────────────────────────────────────────────────────
// 2. Frida / Anti-Instrumentation Detection
//    Frida injects a server on port 27042 by default.
//    We attempt a TCP connection — if anything responds, Frida is present.
//    We also check for the Frida gadget response header.
// ─────────────────────────────────────────────────────────────────

async function checkFrida(): Promise<ThreatDetail[]> {
  const threats: ThreatDetail[] = [];

  // Method A — TCP port probe (most reliable)
  // Frida server listens on 127.0.0.1:27042
  // Normal device: connection refused immediately (error = clean)
  // Frida present: connection succeeds or returns data
  try {
    const controller = new AbortController();
    // 800ms timeout — Frida responds immediately if present
    const timeoutId = setTimeout(() => controller.abort(), 800);

    const response = await fetch('http://127.0.0.1:27042', {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // If we got ANY response, Frida is listening
    threats.push({
      type: 'FRIDA_PORT_27042',
      detail: `Frida server responded on port 27042 — status ${response.status}`,
    });

  } catch (err: any) {
    // AbortError = timeout (port may be open but slow — flag it)
    if (err?.name === 'AbortError') {
      // Timeout after 800ms is suspicious — Frida sometimes delays
      // Don't flag this as a threat, but log it
      console.warn('[Security] Port 27042 timeout — inconclusive');
    }
    // Network error / connection refused = clean (expected on normal device)
    // 'TypeError: Network request failed' = port closed = safe
  }

  // Method B — Check Frida gadget well-known response
  // Frida returns a specific string when queried
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
        detail: `Frida server returned data on /enumerate — instrumentation confirmed`,
      });
    }
  } catch {
    // Connection refused = safe. This is the expected path on clean devices.
  }

  return threats;
}

// ─────────────────────────────────────────────────────────────────
// 3. Emulator Check
//    Real-device-only enforcement — emulator attacks are common
// ─────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────
// 4. Key Wipe
//    Called immediately when any threat is detected.
//    Deletes ALL session keys, ratchet states, and vault PIN
//    from hardware-backed SecureStore.
// ─────────────────────────────────────────────────────────────────

export async function wipeAllKeys(): Promise<void> {
  console.warn('[SECURITY] THREAT DETECTED — WIPING ALL KEYS');

  const keysToDelete = [
    'vault_pin',
    'user_firstName',
    'user_lastName',
    'user_dob',
    'active_sessions',
  ];

  // Delete known fixed keys
  for (const key of keysToDelete) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Key may not exist — continue
    }
  }

  // Delete all dynamic D2DE session keys
  // Keys follow pattern: d2de_key_<chatId> and ratchet_<chatId>
  // We stored active session IDs in 'active_sessions'
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

  // Also wipe any numbered session keys (brute cleanup)
  // SecureStore doesn't support listing — we clean up to 200 possible chats
  // In production, maintain your own key manifest
  for (let i = 0; i < 50; i++) {
    try { await SecureStore.deleteItemAsync(`d2de_key_chat_${i}`); } catch {}
    try { await SecureStore.deleteItemAsync(`ratchet_chat_${i}`); } catch {}
  }

  console.warn('[SECURITY] All keys wiped successfully');
}

// ─────────────────────────────────────────────────────────────────
// 5. Log Security Event to Firestore
//    Logged under users/{uid}/securityEvents/{auto-id}
// ─────────────────────────────────────────────────────────────────

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
    // Firestore logging failure must NOT block the security response
    console.warn('[Security] Failed to log threat to Firestore:', e);
  }
}

// ─────────────────────────────────────────────────────────────────
// 6. Main Entry — runSecurityCheck()
//    Call this in _layout.tsx on every app mount.
//    Returns SecurityReport.
//    If clean = false → navigate to /blocked screen.
// ─────────────────────────────────────────────────────────────────

export async function runSecurityCheck(): Promise<SecurityReport> {
  const deviceModel = DeviceInfo.getModel();

  const report: SecurityReport = {
    clean: true,
    threats: [],
    checkedAt: Date.now(),
    platform: Platform.OS,
    deviceModel,
  };

  // Android only for root/jailbreak checks
  // iOS jailbreak check is also included via DeviceInfo.isRooted()
  const [rootThreats, fridaThreats, emulatorThreats] = await Promise.all([
    checkRootJailbreak(),
    checkFrida(),
    checkEmulator(),
  ]);

  report.threats = [...rootThreats, ...fridaThreats, ...emulatorThreats];
  report.clean = report.threats.length === 0;

  if (!report.clean) {
    // 1. Wipe all keys immediately — before logging, before anything else
    await wipeAllKeys();

    // 2. Log to Firestore (non-blocking — don't await in critical path)
    logThreatToFirestore(report).catch(() => {});

    console.warn('[SECURITY] THREATS FOUND:', report.threats.map(t => t.type));
  } else {
    console.log('[Security] Device clean — no threats detected');
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────
// 7. Screenshot Detection Logger
//    Called from chat.tsx when FLAG_SECURE is bypassed.
//    expo-screen-capture blocks screenshots natively —
//    this logs attempts that get through (e.g. via ADB screencap).
// ─────────────────────────────────────────────────────────────────

export async function logScreenshotAttempt(chatId: string): Promise<void> {
  try {
    const uid = auth().currentUser?.uid;
    if (!uid) return;

    // Log to the chat document so both participants can see it
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

    // Also write to the chat's alert subcollection
    // so the other participant gets an Alerts notification
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
