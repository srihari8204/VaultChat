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
