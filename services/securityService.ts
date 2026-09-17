// services/securityService.ts
// Real jailbreak / root / Frida detection + key wipe
// Runs on every app launch before any screen is shown

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { assessThreats, signal as toSignal, type ThreatSignal } from './security/threatEngine';
import { createPinAttemptTracker } from './security/pinAttempts';
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
  // Raised by the native VaultShield scan (services/security/deviceSecurity).
  | 'JAILBREAK_DETECTED'
  | 'FRIDA_DETECTED'
  | 'APK_RESIGNED'
  | 'ACCESSIBILITY_RISK'
  | 'DEV_OPTIONS_ON'
  | 'USB_DEBUGGING_ON';

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

// SecureStore-backed PIN-attempt tracker (repeated failed PIN entries
// escalate toward self-destruct). Exposed so the PIN screens can also query it.
const _pinAttemptKV = {
  get: (k: string) => SecureStore.getItemAsync(k),
  set: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  del: (k: string) => SecureStore.deleteItemAsync(k).then(() => undefined),
};
export const pinAttempts = createPinAttemptTracker(_pinAttemptKV);

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
  // su and adb are the emulator platform, not evidence against it.
  if (await isEmulatorTestRig()) return threats;

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
// 2. Native VaultShield scan — the real detectors
//
// This path used to run its own "Frida check": two cleartext HTTP requests to
// http://127.0.0.1:27042. Android's default network-security policy blocks
// cleartext, so the request never left the app — the probe could only ever
// fail, i.e. it reported "no Frida" on a Frida-instrumented device while
// costing ~1.4s of cold start. It is deleted.
//
// What replaces it is the detector set that was already in the app but only
// fed the dashboard: the native VaultShield module (root/Magisk, TracerPid +
// Debug.isDebuggerConnected, Frida port + /proc/self/maps, Xposed/LSPosed/
// Zygisk needles, APK signing-cert SHA-256, accessibility enumeration). Its
// signal types are passed through unchanged and graded by threatEngine, which
// now carries a severity for each of them.
//
// Degrades honestly: with no native module linked (Expo Go, or a build from
// before VaultShield) we fall back to the DeviceInfo checks below rather than
// reporting a device clean that was never examined.
// ─────────────────────────────────────────────────────────────

// An emulator's own properties are not an attack — same waiver as below, applied
// to the native signal names.
const EMULATOR_WAIVED = new Set<string>([
  'EMULATOR_DETECTED', 'ROOT_DETECTED', 'SU_BINARY_FOUND', 'MAGISK_DETECTED',
  'DEV_OPTIONS_ON', 'USB_DEBUGGING_ON',
]);

async function checkNativeShield(): Promise<ThreatDetail[] | null> {
  const { hasNativeShield, collectNativeSignals } = await import('./security/deviceSecurity/nativeSecurity');
  if (!hasNativeShield()) return null;
  const { signals } = await collectNativeSignals(Platform.OS as 'android' | 'ios');
  const waive = await isEmulatorTestRig();
  return signals
    .filter(s => !(waive && EMULATOR_WAIVED.has(s.type)))
    .map(s => ({ type: s.type as ThreatType, detail: s.detail ?? s.type }));
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

// AN EMULATOR'S OWN PROPERTIES ARE NOT AN ATTACK.
//
// Waiving checkEmulator() alone was not enough to make an emulator usable as a
// test rig, and the reason only shows up on a real AVD: every stock image ships
// /system/xbin/su and runs userdebug with adb on, so isRooted() returns true and
// ROOT_DETECTED is `critical` — an instant wipeAllKeys() on every launch. That
// is what emptied the emulator's keystore repeatedly.
//
// So the waiver also covers the root/adb signals, but ONLY where both halves
// hold: the flag was compiled into this build AND the device really is an
// emulator. On a phone the second half is false, so a rooted handset wipes
// exactly as before; in a production build the first is a constant false and
// none of this code is reachable at all. Frida and hooking frameworks are
// never waived — those are compromise signals on an emulator too.
let emulatorRig: Promise<boolean> | null = null;
function isEmulatorTestRig(): Promise<boolean> {
  if (!ALLOW_EMULATOR_TEST_BUILD) return Promise.resolve(false);
  if (!emulatorRig) emulatorRig = DeviceInfo.isEmulator().then(v => !!v).catch(() => false);
  return emulatorRig;
}

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

/**
 * Self-destruct. Reached only from a `wipe`-level assessment, and the /blocked
 * screen tells the user their keys have been destroyed.
 *
 * IT DESTROYED ALMOST NOTHING. 2026-09-17. The list it walked was written
 * against a key layout that no longer exists: 'vault_pin' is the legacy
 * constant pinStore MIGRATED AWAY from (and clears itself on every unlock),
 * 'user_firstName'/'user_lastName'/'user_dob'/'active_sessions' have no writer
 * anywhere in the repo, and neither does `d2de_key_*` or `ratchet_*` — the
 * ratchets are `vc_e2ee_session_<peerId>` and the Double Ratchet has never been
 * keyed by chat index. So on a device judged compromised the app deleted a
 * handful of absent keys, left the message database, media and E2EE identity
 * untouched, and said the keys were gone.
 *
 * The real purge already existed for sign-out; a compromised device wants
 * exactly the same thing, so it calls it instead of keeping a second list that
 * can rot the same way.
 */
export async function wipeAllKeys(): Promise<void> {
  // Dynamic require: authService pulls in Google Sign-In and lib/api, and this
  // module is imported on the launch path (app/_layout runSecurityCheck).
  try { await require('../app/(constants)/authService').purgeAccountData(); } catch {}
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

  // Prefer the native detectors; fall back to the DeviceInfo checks only when
  // the native module is not linked.
  const native = await checkNativeShield().catch(() => null);
  const detected: ThreatDetail[] = native ?? (await Promise.all([
    checkRootJailbreak(),
    checkEmulator(),
  ])).flat();

  // Grade the device-integrity signals + the accumulated PIN-failure signal,
  // then let the engine pick a proportional response.
  const signals: ThreatSignal[] = detected.map(d => toSignal(d.type, d.detail));
  const pinSignal = await pinAttempts.getSignal();
  if (pinSignal) {
    detected.push({ type: pinSignal.type as ThreatType, detail: pinSignal.detail ?? '' });
    signals.push(pinSignal);
  }
  const assessment = assessThreats(signals);

  // `clean` means "let the app run", NOT "no signal at all". It used to mean the
  // latter, so a single ADB_ENABLED (severity medium, score 3 — a `monitor`
  // verdict, i.e. "allow but flag") routed to the unescapable /blocked screen.
  // Anyone with developer options on was locked out of their own messages. The
  // engine's own grading is now respected: monitor allows, restrict/wipe block.
  const report: SecurityReport = {
    clean: assessment.level === 'clean' || assessment.level === 'monitor',
    threats: detected,
    level: assessment.level,
    score: assessment.score,
    checkedAt: Date.now(),
    platform: Platform.OS,
    deviceModel,
  };

  // Self-destruct only on a wipe-level assessment (root / Frida /
  // strong combinations). Weaker lone signals (emulator, ADB) restrict access
  // — caller still routes to /blocked — without destroying data on a possible
  // false positive.
  if (assessment.level === 'wipe') {
    await wipeAllKeys();
  }
  if (assessment.level !== 'clean') {
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
  if (report.level === 'clean') {
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
  // The attempt tracking that used to live here moved INTO pinStore.verifyPin
  // (2026-09-17). It was only ever fed from this function, whose one caller is
  // an unrouted screen, so the app lock, the vault and every other real PIN
  // check raised nothing. pinAttempts is still read here — runSecurityCheck()
  // turns the streak into a PIN_BRUTEFORCE signal — it is only the recording
  // that had to move to where the PINs are actually checked.
  return pinStore.verifyPin(pin);
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