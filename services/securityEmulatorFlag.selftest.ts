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
//   * it must waive ONLY the emulator signal. Root/Frida/debugger/hook/overlay
//     are real compromise signals and must keep wiping keys.
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

// ── 2. it waives the emulator check ONLY ──────────────────────────────
{
  const i = code.indexOf('async function checkEmulator');
  const body = code.slice(i, i + 400);
  A(i >= 0 && /if \(ALLOW_EMULATOR_TEST_BUILD\) return threats;/.test(body),
    '2. the early return lives INSIDE checkEmulator');

  // The flag must appear exactly once, so it cannot be silently reused to
  // waive a second, more serious detector.
  const uses = (code.match(/ALLOW_EMULATOR_TEST_BUILD/g) || []).length;
  A(uses === 2, `2a. referenced exactly twice — one definition, one use (found ${uses})`);

  for (const fn of ['checkRoot', 'checkFrida']) {
    const j = code.indexOf(fn);
    if (j < 0) continue;
    const b = code.slice(j, j + 700);
    A(!/ALLOW_EMULATOR_TEST_BUILD/.test(b),
      `2b. ${fn} is NOT waived — root and Frida are real compromise signals`);
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
