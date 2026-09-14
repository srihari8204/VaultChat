// services/securityEmulatorFlag.selftest.ts — the emulator waiver must stay off.
//
//   npx tsx services/securityEmulatorFlag.selftest.ts
//
// SCOPE: STRUCTURAL. Reads source. It proves the waiver is narrow and defaults
// to off; it does not run the detector.
//
// WHY THIS FILE EXISTS
//
// checkEmulator() can be waived so an emulator can be used as a test rig, which
// is the only way to drive the UI when the physical phones cannot take input.
// That is a deliberate hole in a security control, and a hole that ships is a
// vulnerability rather than a convenience. These checks are what stop it.
//
// The threat model for the flag itself:
//
//   * it must waive only what the emulator ITSELF explains. Every stock AVD
//     ships /system/xbin/su and runs userdebug with adb on, so isRooted() is
//     true there and ROOT_DETECTED is `critical` — the emulator wiped its own
//     keys on every launch even with the flag set. So root/adb are waived too,
//     but ONLY behind isEmulatorTestRig(), which needs the compiled-in flag AND
//     DeviceInfo.isEmulator(). On a phone the second half is false and a rooted
//     handset wipes exactly as before.
//   * Frida, hooks and the duress PIN are never waived — those are compromise
//     signals on an emulator too.
//   * it must be BUILD-TIME. EXPO_PUBLIC_* is inlined by Metro, so a build that
//     does not set it compiles to a constant false — there is no runtime
//     switch and nothing to flip on an installed app.
//   * it must be OFF unless someone deliberately sets it on the build command.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'services/securityService.ts'), 'utf8');
const code = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nEmulator waiver (test builds only)\n');

// ── 1. build-time, not runtime ────────────────────────────────────────
A(/process\.env\.EXPO_PUBLIC_ALLOW_EMULATOR === '1'/.test(code),
  "1. the flag is an EXPO_PUBLIC_* build-time constant — Metro inlines it, so a "
  + "build that does not set it compiles to a constant false");

A(!/AsyncStorage|SecureStore\.getItem[^\n]*ALLOW_EMULATOR|setAllowEmulator/.test(code),
  '1a. it is NOT readable from storage or settable at runtime — an installed '
  + 'app has no way to turn it on');

// ── 2. the waiver is narrow, and root is waived only ON AN EMULATOR ───
{
  const i = code.indexOf('async function checkEmulator');
  const body = code.slice(i, i + 400);
  A(i >= 0 && /if \(ALLOW_EMULATOR_TEST_BUILD\) return threats;/.test(body),
    '2. the early return lives INSIDE checkEmulator');

  // The raw flag must never be tested anywhere else: every other waiver has to
  // go through isEmulatorTestRig(), which also demands DeviceInfo.isEmulator().
  const uses = (code.match(/ALLOW_EMULATOR_TEST_BUILD/g) || []).length;
  A(uses === 3, '2a. the raw flag is referenced exactly three times — definition, '
    + `checkEmulator, and the isEmulatorTestRig guard (found ${uses})`);

  const r = code.indexOf('function isEmulatorTestRig');
  const rig = code.slice(r, r + 400);
  A(r >= 0 && /if \(!ALLOW_EMULATOR_TEST_BUILD\) return Promise\.resolve\(false\);/.test(rig),
    '2b. the rig needs the BUILD FLAG — without it a real device can never take '
    + 'this path');
  A(/DeviceInfo\.isEmulator\(\)/.test(rig) && /catch\(\(\)=>false\)/.test(rig.replace(/\s/g, '')),
    '2c. ...AND the device must really be an emulator, with a failed probe '
    + 'counting as "not an emulator" — the safe direction');

  {
    const j = code.indexOf('async function checkRootJailbreak');
    const b = code.slice(j, j + 700);
    A(j >= 0 && /if \(await isEmulatorTestRig\(\)\) return threats;/.test(b),
      '2d. checkRootJailbreak is waived only through the RIG, never the bare flag');
    A(!/ALLOW_EMULATOR_TEST_BUILD/.test(b),
      '2e. ...so a build flag alone cannot switch root detection off on a phone');
  }

  {
    // checkFrida USED to live here as a cleartext HTTP fetch to localhost:27042.
    // Android's network policy blocks that, so it could never fire — the Kotlin
    // module says so in its own comment. It was deleted rather than waived.
    // Detection now lives natively (VaultShieldModule.kt: raw-socket port probe
    // + /proc/self/maps needle scan), which is why this asserts its ABSENCE here
    // and its presence there. What must never come back is a JS Frida probe that
    // looks like a control and cannot run.
    A(code.indexOf('async function checkFrida') === -1,
      '2f. the dead JS checkFrida probe is gone — Frida detection is native');
    const kotlin = readFileSync(
      'android/app/src/main/java/com/vaultchat/app/vaultshield/VaultShieldModule.kt', 'utf8');
    A(/fridaPortOpen/.test(kotlin) && /fridaNeedles/.test(kotlin),
      '2g. ...and the native detector still probes the port AND scans maps');
    A(!/ALLOW_EMULATOR_TEST_BUILD|isEmulatorTestRig/.test(kotlin),
      '2h. ...and is not waived on an emulator — instrumentation is an attack there too');
  }
}

// ── 3. the wipe still exists ──────────────────────────────────────────
A(/export async function wipeAllKeys/.test(code),
  '3. key wipe is untouched — any REMAINING threat still wipes');

// ── 4. it is off by default in this working tree ──────────────────────
//
// A committed .env that sets it would ship the hole. Checked rather than
// assumed, because that is exactly how a test-only flag escapes.
{
  const envFiles = ['.env', '.env.local', '.env.production', 'eas.json', 'app.json']
    .map(f => join(ROOT, f)).filter(existsSync);
  const leaked = envFiles.filter(f =>
    /EXPO_PUBLIC_ALLOW_EMULATOR\s*[:=]\s*["']?1/.test(readFileSync(f, 'utf8')));
  A(leaked.length === 0,
    '4. no committed env/config turns it on'
    + (leaked.length ? ` — LEAKED IN: ${leaked.join(', ')}` : ''));
}

console.log(failed === 0
  ? '\nsecurityEmulatorFlag: all checks passed'
  : `\nsecurityEmulatorFlag: ${failed} FAILED`);
if (failed > 0) process.exit(1);
