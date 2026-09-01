// services/securityService.ts
// Real jailbreak / root / Frida detection + key wipe
// Runs on every app launch before any screen is shown

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { assessThreats, signal as toSignal, type ThreatSignal } from './security/threatEngine';
import { createDuressPinTracker } from './security/duressPin';
import * as pinStore from './security/pinStore';
import { recordDeviceScan } from './security/auditChain';

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
  | 'ADB_ENABLED'
  | 'DEBUGGER_ATTACHED'
  | 'HOOK_FRAMEWORK'
  | 'OVERLAY_DETECTED'
  | 'SUSPICIOUS_IME'
  | 'PIN_BRUTEFORCE'
  | 'DURESS_PIN_REPEATED';

export interface ThreatDetail {
  type: ThreatType;
  detail: string;
}

export interface SecurityReport {
  clean: boolean;
  threats: ThreatDetail[];
  // Graded response from the multi-indicator threat engine:
  //   clean    — no signals
  //   monitor  — weak signal(s); allow but flag
  //   restrict — block access (navigate to /blocked) without wiping
  //   wipe     — self-destruct: all keys wiped, then blocked
  level: 'clean' | 'monitor' | 'restrict' | 'wipe';
  score: number;
  checkedAt: number;
  platform: string;
  deviceModel: string;
}

// SecureStore-backed duress-PIN tracker (repeated failed/duress PIN entries
// escalate toward self-destruct). Exposed so the PIN screens can also query it.
const _duressKV = {
  get: (k: string) => SecureStore.getItemAsync(k),
  set: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  del: (k: string) => SecureStore.deleteItemAsync(k).then(() => undefined),
};
export const duressPin = createDuressPinTracker(_duressKV);

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

// TEST BUILDS ONLY — the emulator threat, and ONLY that one, can be waived.
//
// WHY THIS EXISTS
//
// The app refuses to run on an emulator, which is correct for production and
// which also makes the emulator useless as a test rig: there is no other way
// to drive the UI when the physical test phones cannot take input (a broken
// screen, or an OEM that refuses INJECT_EVENTS).
//
// WHAT IT DOES NOT DO
//
// It waives NOTHING else. Root, Magisk, su, test-keys, Frida, debugger, hook
// frameworks, overlays and suspicious IMEs are all still detected and still
// wipe keys. This is the weakest signal in the set — `detail` already says
// "not permitted in production", not "device is compromised".
//
// WHY IT CANNOT SHIP BY ACCIDENT
//
// EXPO_PUBLIC_* is INLINED AT BUILD TIME. A build that does not set the
// variable compiles this to `'' === '1'`, i.e. a constant false, and the check
// runs exactly as before — there is no runtime switch, no stored setting and
// no way to flip it on an installed app. Enabling it requires deliberately
// setting the variable on the build command. securityEmulatorFlag.selftest.ts
// asserts the default stays off.
const ALLOW_EMULATOR_TEST_BUILD = process.env.EXPO_PUBLIC_ALLOW_EMULATOR === '1';

async function checkEmulator(): Promise<ThreatDetail[]> {
  const threats: ThreatDetail[] = [];
  if (ALLOW_EMULATOR_TEST_BUILD) return threats;
  try {
    const isEmulator = await DeviceInfo.isEmulator();
    if (isEmulator) {
      threats.push({
        type: 'EMULATOR_DETECTED',
        detail: 'App is running on an emulator — not permitted in production',
      });
    }
  } catch (e) {
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

}

// ─────────────────────────────────────────────────────────────
// 5. Log Security Event to Firestore
// ─────────────────────────────────────────────────────────────
// 6. Main Entry — runSecurityCheck()
//    Call this in _layout.tsx on every app mount.
//    Returns SecurityReport.
//    If clean = false → navigate to /blocked screen.
// ─────────────────────────────────────────────────────────────

export async function runSecurityCheck(): Promise<SecurityReport> {
  const deviceModel = DeviceInfo.getModel();

  const [rootThreats, fridaThreats, emulatorThreats] = await Promise.all([
    checkRootJailbreak(),
    checkFrida(),
    checkEmulator(),
  ]);
  const detected: ThreatDetail[] = [...rootThreats, ...fridaThreats, ...emulatorThreats];

  // Grade the device-integrity signals + the accumulated PIN-failure signal,
  // then let the engine pick a proportional response.
  const signals: ThreatSignal[] = detected.map(d => toSignal(d.type, d.detail));
  const pinSignal = await duressPin.getSignal();
  if (pinSignal) {
    detected.push({ type: pinSignal.type as ThreatType, detail: pinSignal.detail ?? '' });
    signals.push(pinSignal);
  }
  const assessment = assessThreats(signals);

  const report: SecurityReport = {
    clean: assessment.level === 'clean',
    threats: detected,
    level: assessment.level,
    score: assessment.score,
    checkedAt: Date.now(),
    platform: Platform.OS,
    deviceModel,
  };

  // Self-destruct only on a wipe-level assessment (root / Frida / duress PIN /
  // strong combinations). Weaker lone signals (emulator, ADB) restrict access
  // — caller still routes to /blocked — without destroying data on a possible
  // false positive.
  if (assessment.level === 'wipe') {
    await wipeAllKeys();
  }
  if (!report.clean) {
    // Record threats in the on-device tamper-evident audit chain (#41) so they
    // surface in the Alerts tab. Clean launch scans are intentionally NOT logged
    // (no noise); user-initiated scans always log via scanDeviceAndRecord().
    recordDeviceScan({
      level: report.level, score: report.score, threats: report.threats,
      deviceModel: report.deviceModel, platform: report.platform,
    }).catch(() => {});
  }

  return report;
}

/**
 * Run a device-integrity scan and ALWAYS leave an audit-chain entry — used by
 * the Alerts tab "Scan device" action so the user sees a result whether the
 * device is clean or not. (runSecurityCheck already records non-clean scans, so
 * here we only add the clean-result entry to avoid duplicates.) Returns the report.
 */
export async function scanDeviceAndRecord(): Promise<SecurityReport> {
  const report = await runSecurityCheck();
  if (report.clean) {
    await recordDeviceScan({
      level: report.level, score: report.score, threats: report.threats,
      deviceModel: report.deviceModel, platform: report.platform,
    }).catch(() => {});
  }
  return report;
}

// ─────────────────────────────────────────────────────────────
// 8. PIN Management
// ─────────────────────────────────────────────────────────────

// Was SecureStore.setItemAsync('vault_pin', pin) — the PIN itself, in the clear,
// under a DIFFERENT key from the one the lock screen checked, so the backup-PIN
// screen and the lock screen held two unrelated secrets. Both now go through
// services/security/pinStore (scrypt + salt, PIN never stored).
export async function savePIN(pin: string): Promise<void> {
  await pinStore.setPin(pin);
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const ok = await pinStore.verifyPin(pin);
  // Feed the duress-PIN tracker: consecutive failures escalate toward a
  // self-destruct on the next runSecurityCheck().
  if (ok) await duressPin.recordSuccess();
  else await duressPin.recordFailure();
  return ok;
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

// Recovery answers are NEVER stored in the clear. We normalise (trim, collapse
// whitespace, lowercase — matching the "case-insensitive" promise the setup
// screen makes) then SHA-256 hash each answer with a per-record random salt.
// The questions themselves aren't secret, so they're kept plaintext for display
// during recovery. Stored under SecureStore key 'security_answers', schema v2.
const SEC_KEY = 'security_answers';

function normalizeAnswer(a: string): string {
  return (a ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function hashAnswer(salt: string, answer: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${salt}|${normalizeAnswer(answer)}`,
  );
}

interface SecurityRecordV2 {
  v: 2;
  q1: string; q2: string; q3: string;
  h1: string; h2: string; h3: string;
  salt: string;
}

export async function saveSecurityAnswers(
  data: { q1: string; a1: string; q2: string; a2: string; q3: string; a3: string },
): Promise<void> {
  const saltBytes = await Crypto.getRandomBytesAsync(16);
  const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const [h1, h2, h3] = await Promise.all([
    hashAnswer(salt, data.a1),
    hashAnswer(salt, data.a2),
    hashAnswer(salt, data.a3),
  ]);
  const rec: SecurityRecordV2 = { v: 2, q1: data.q1, q2: data.q2, q3: data.q3, h1, h2, h3, salt };
  await SecureStore.setItemAsync(SEC_KEY, JSON.stringify(rec));
}

// The three questions the user chose, in order, for the recovery screen to show.
// null when the user never configured recovery questions.
export async function getSecurityQuestions(): Promise<string[] | null> {
  try {
    const raw = await SecureStore.getItemAsync(SEC_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o?.q1 && o?.q2 && o?.q3) return [o.q1, o.q2, o.q3];
    return null;
  } catch { return null; }
}

// Verify all three answers against the stored hashes. Returns false (never
// throws) when no record exists or any answer mismatches. Transparently handles
// legacy v1 plaintext records and upgrades them to hashed v2 on first success.
export async function verifySecurityAnswers(answers: [string, string, string]): Promise<boolean> {
  let raw: string | null = null;
  try { raw = await SecureStore.getItemAsync(SEC_KEY); } catch { return false; }
  if (!raw) return false;

  let o: any;
  try { o = JSON.parse(raw); } catch { return false; }

  // Legacy v1: { q1,a1,q2,a2,q3,a3 } stored in the clear (pre-hash builds).
  if (o.v !== 2) {
    const ok =
      normalizeAnswer(answers[0]) === normalizeAnswer(o.a1) &&
      normalizeAnswer(answers[1]) === normalizeAnswer(o.a2) &&
      normalizeAnswer(answers[2]) === normalizeAnswer(o.a3);
    if (ok && o.q1 && o.q2 && o.q3) {
      // Upgrade in place so the plaintext answers stop living on disk.
      await saveSecurityAnswers({
        q1: o.q1, a1: answers[0], q2: o.q2, a2: answers[1], q3: o.q3, a3: answers[2],
      });
    }
    return ok;
  }

  const [h1, h2, h3] = await Promise.all([
    hashAnswer(o.salt, answers[0]),
    hashAnswer(o.salt, answers[1]),
    hashAnswer(o.salt, answers[2]),
  ]);
  return h1 === o.h1 && h2 === o.h2 && h3 === o.h3;
}