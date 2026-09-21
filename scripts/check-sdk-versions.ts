#!/usr/bin/env node
/**
 * scripts/check-sdk-versions.ts — fail the build on a LiveKit version drift.
 *
 * WHY THIS EXISTS
 * ---------------
 * @livekit/react-native is a PATCH LAYER over livekit-client: it replaces
 * internals so a browser library can run on React Native. That only works
 * against the version it was built for. When npm resolved `^2.19.0` to 2.21.0,
 * the drift produced a failure that was extremely expensive to diagnose:
 *
 *   server: "mediaTrack published"        — publishing genuinely worked
 *   client: "Sender does not belong to this peer connection"
 *           "negotiation timed out"       — then an endless reconnect loop
 *
 * Nothing in that points at a dependency. It looks like a network fault, and it
 * cost an evening of chasing ICE, TURN and the SFU before the versions were
 * compared. A two-line check would have said it immediately.
 *
 * Checked against node_modules, NOT just package.json: a lockfile or a nested
 * dependency can install something other than what the manifest asks for, and
 * that is precisely the case this is meant to catch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// The version @livekit/react-native@2.12.0 declares as its peer AND devDep.
// Raise this together with the SDK, never on its own.
const REQUIRED_CLIENT = '2.19.2';
const ROOT = path.join(__dirname, '..');

function installedVersion(pkg) {
  try {
    const packageJson = path.join(ROOT, 'node_modules', pkg, 'package.json');
    return JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
  } catch {
    return null;
  }
}

const client = installedVersion('livekit-client');
const rn = installedVersion('@livekit/react-native');
const webrtc = installedVersion('@livekit/react-native-webrtc');

// Not installed at all is fine — a checkout without node_modules, or a build
// that does not include the SFU. Only a MISMATCH is an error.
if (!client || !rn) {
  console.log('LiveKit SDK not installed — skipping version check.');
  process.exit(0);
}

if (client !== REQUIRED_CLIENT) {
  console.error(
    `\n  livekit-client is ${client}, but @livekit/react-native ${rn} needs exactly ${REQUIRED_CLIENT}.\n` +
    `\n  The RN SDK patches livekit-client internals; a mismatch does NOT fail loudly —` +
    `\n  it publishes media successfully server-side while the client reports` +
    `\n  "Sender does not belong to this peer connection" and reconnects forever.\n` +
    `\n  Fix:  npm install livekit-client@${REQUIRED_CLIENT} --save-exact\n` +
    `\n  The "overrides" block in package.json should prevent this; if it did not,` +
    `\n  a nested dependency is pulling its own copy — check with:` +
    `\n    npm ls livekit-client\n`,
  );
  process.exit(1);
}

// A second copy anywhere in the tree defeats the pin: the RN SDK may resolve to
// the nested one at runtime while the top level looks correct.
const nested = [];
(function walk(dir, depth) {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === 'livekit-client' && full !== path.join(ROOT, 'node_modules', 'livekit-client')) {
      nested.push(full);
    } else if (e.name === 'node_modules' || !e.name.startsWith('.')) {
      walk(full, depth + 1);
    }
  }
})(path.join(ROOT, 'node_modules'), 0);

if (nested.length) {
  console.error(`\n  Found ${nested.length} nested copy/copies of livekit-client:\n` +
    nested.map(n => `    ${path.relative(ROOT, n)}`).join('\n') +
    `\n\n  The pin only covers the top level. Add or check "overrides" in package.json.\n`);
  process.exit(1);
}

console.log(`LiveKit versions aligned: client ${client}, rn ${rn}, webrtc ${webrtc ?? 'n/a'}`);
