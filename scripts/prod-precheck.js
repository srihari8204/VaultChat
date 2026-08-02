#!/usr/bin/env node
// Pre-flight check for production builds.
// Verifies SERVER_URL points to production, version is bumped, secrets aren't tracked.
// Exit non-zero on any failure so CI/release scripts can stop the pipeline.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const fail = [];
const warn = [];

function read(p) {
  return fs.readFileSync(path.join(root, p), 'utf8');
}

// 1. SERVER_URL must be production https URL (uncommented), local must be commented.
try {
  const cfg = read('constants/server.ts');
  const lines = cfg.split('\n').map(l => l.trim());
  const active = lines.filter(l => l.startsWith('export const SERVER_URL'));
  if (active.length !== 1) {
    fail.push(`constants/server.ts: expected exactly 1 active SERVER_URL, found ${active.length}`);
  } else if (!/https:\/\//.test(active[0])) {
    fail.push(`constants/server.ts: SERVER_URL must use https for production. Current: ${active[0]}`);
  } else if (/10\.|192\.168\.|127\.0\.0\.1|localhost/.test(active[0])) {
    fail.push(`constants/server.ts: SERVER_URL points to a local address. Current: ${active[0]}`);
  }
} catch (e) {
  fail.push(`Cannot read constants/server.ts: ${e.message}`);
}

// 2. app.json: version + android.versionCode must be present and consistent.
try {
  const appJson = JSON.parse(read('app.json'));
  const pkgJson = JSON.parse(read('package.json'));
  if (!appJson.expo.version) fail.push('app.json: expo.version missing');
  if (!appJson.expo.android?.versionCode) fail.push('app.json: expo.android.versionCode missing');
  if (appJson.expo.version !== pkgJson.version) {
    warn.push(`Version mismatch: app.json=${appJson.expo.version}, package.json=${pkgJson.version}`);
  }
  if (!appJson.expo.android?.package) fail.push('app.json: expo.android.package missing');
  if (!appJson.expo.ios?.bundleIdentifier) fail.push('app.json: expo.ios.bundleIdentifier missing');
} catch (e) {
  fail.push(`Cannot parse app.json: ${e.message}`);
}

// 3. google-services.json must exist for Android prod build.
if (!fs.existsSync(path.join(root, 'google-services.json'))) {
  fail.push('google-services.json missing — Android Firebase build will fail');
}

// 4. Backend serviceAccountKey.json must not be committed.
try {
  const tracked = execSync('git ls-files vaultchat-backend/serviceAccountKey.json vaultchat-backend/.env', {
    cwd: root, encoding: 'utf8',
  }).trim();
  if (tracked) fail.push(`Secret files are tracked by git:\n${tracked}`);
} catch {
  warn.push('git not available — cannot verify secrets are git-ignored');
}

// 5. Sentry DSN should be set (warn only).
try {
  const appJson = JSON.parse(read('app.json'));
  const sentryPlugin = (appJson.expo.plugins || []).find(p => Array.isArray(p) && p[0] === '@sentry/react-native/expo');
  if (sentryPlugin && !sentryPlugin[1]?.organization) {
    warn.push('Sentry plugin present but organization not configured');
  }
} catch { /* already reported above */ }

// 6. EAS project id present.
try {
  const appJson = JSON.parse(read('app.json'));
  if (!appJson.expo.extra?.eas?.projectId) fail.push('app.json: expo.extra.eas.projectId missing — EAS builds will fail');
} catch { /* already reported */ }

// ── 7. Native FCM must stay wired. ────────────────────────────────────
// This is the highest-value gate in the file. The Firebase JS SDKs were removed
// (they had zero importers), and the thing that makes calls ring on a KILLED
// device is entirely separate: the native firebase-messaging Gradle dependency
// added by our own config plugin, plus google-services.json placed by Expo's
// default chain from app.json's android.googleServicesFile. If any of those
// three drift apart the app still builds, still passes tests, and simply stops
// ringing when killed — a silent failure of the most valuable feature.
try {
  const plugin = read('plugins/withVaultChatCalls.js');
  if (!/com\.google\.firebase:firebase-messaging/.test(plugin)) {
    fail.push('withVaultChatCalls.js: native firebase-messaging dependency missing — killed-app calls will NOT ring');
  }
  const appJson = JSON.parse(read('app.json'));
  if (!appJson.expo.android?.googleServicesFile) {
    fail.push('app.json: android.googleServicesFile missing — google-services plugin will not be applied');
  }
} catch (e) {
  fail.push(`Cannot verify native FCM wiring: ${e.message}`);
}

// ── 8. iOS `voip` background mode must match the CallKit reality. ──────
// Declaring voip without a PushKit/CallKit implementation is an App Review
// rejection trigger AND causes iOS to revoke VoIP privileges when a push
// arrives unreported. The two must move together, so verify they agree.
try {
  const plugin = read('plugins/withVaultChatCalls.js');
  const m = plugin.match(/const\s+IOS_CALLKIT_IMPLEMENTED\s*=\s*(true|false)/);
  if (!m) {
    warn.push('withVaultChatCalls.js: IOS_CALLKIT_IMPLEMENTED gate not found — voip mode is unguarded');
  } else if (m[1] === 'true') {
    const ios = read('lib/call/native/ios.ts');
    if (/canRingWhenKilled:\s*false/.test(ios)) {
      fail.push('IOS_CALLKIT_IMPLEMENTED=true but lib/call/native/ios.ts still reports canRingWhenKilled:false — these must flip together');
    }
  }
} catch (e) {
  warn.push(`Cannot verify iOS voip gate: ${e.message}`);
}

// ── 9. Play device-filtering guards must not silently regress. ─────────
// android.permission.NFC implies android.hardware.nfc as REQUIRED, which hides
// the app from every non-NFC device on Play. It was carried unused for a long
// time. SYSTEM_ALERT_WINDOW is a Play restricted permission. Re-adding either,
// or dropping the uses-feature plugin, is invisible at build time and only
// shows up as a shrinking device-availability count.
try {
  const appJson = JSON.parse(read('app.json'));
  const perms = appJson.expo.android?.permissions || [];
  for (const banned of ['android.permission.NFC', 'android.permission.SYSTEM_ALERT_WINDOW']) {
    if (perms.includes(banned)) {
      fail.push(`app.json: ${banned} is back. It was removed as unused — NFC implies REQUIRED nfc hardware and hides the app from non-NFC devices on Play.`);
    }
  }
  const plugins = (appJson.expo.plugins || []).map(p => (Array.isArray(p) ? p[0] : p));
  if (!plugins.includes('./plugins/withAndroidFeatures.js')) {
    fail.push('app.json: ./plugins/withAndroidFeatures.js not registered — implied hardware features revert to REQUIRED and Play will filter devices');
  }
} catch (e) {
  warn.push(`Cannot verify Android feature guards: ${e.message}`);
}

// ── 10. Unvalidated call engine must not ship on by accident. ─────────
try {
  const flags = read('constants/flags.ts');
  if (/export const CALL_ENGINE_V2\s*=\s*true/.test(flags)) {
    warn.push('CALL_ENGINE_V2 is ON. Confirm it passed the CALLS_README.md OEM matrix on real devices (background audio, ring while KILLED, lock-screen ring) before releasing.');
  }
} catch { /* flags file covered elsewhere */ }

const reset = '\x1b[0m', red = '\x1b[31m', yellow = '\x1b[33m', green = '\x1b[32m';
console.log('\nVaultChat production pre-check\n──────────────────────────────');
warn.forEach(w => console.log(`${yellow}WARN${reset}  ${w}`));
fail.forEach(f => console.log(`${red}FAIL${reset}  ${f}`));
if (fail.length === 0) {
  console.log(`${green}OK${reset}    All production gates passed.`);
  process.exit(0);
}
console.log(`\n${fail.length} blocker(s), ${warn.length} warning(s).`);
process.exit(1);
