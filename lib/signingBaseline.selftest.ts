// lib/signingBaseline.selftest.ts — run: npx tsx lib/signingBaseline.selftest.ts
//
// EXPECTED_SIGNING_SHA256 must equal the certificate the release APK is ACTUALLY
// signed with. Nothing else in the build enforces that, and when it drifted the
// app bricked itself:
//
//   keystore regenerated 2026-10-10, constant not rotated with it
//     -> the release build's own VaultShield scan sees a signature it does not
//        recognise -> APK_RESIGNED (weight 70, confidence 1.0) -> critical
//     -> `wipe` -> wipeAllKeys() destroys session keys, ratchet state and the
//        Vault PIN -> router.replace('/blocked'), with the back button disabled
//
// On EVERY launch including the very first, for EVERY user. The app is
// unusable and the keys are gone before anyone can read the message explaining
// why. Caught on a physical handset 2026-10-13, not by any test — hence this.
//
// WHY IT COMPARES AGAINST THE APK AND NOT THE KEYSTORE
// ----------------------------------------------------
// The keystore is what you MEANT to sign with; the APK is what you DID. They
// differ exactly when this bug happens — a stale signingConfig, a build that
// fell back to debug signing, a keystore replaced without a rebuild. Reading
// keystore.properties would have agreed with itself and still shipped the brick.
// So the artifact is the authority, and the keystore is not consulted at all
// (it is gitignored and absent on CI anyway).
//
// SKIPS, LOUDLY, when there is no built APK or no apksigner — this must not
// fail a machine that has not built Android. A skip is reported as a skip, never
// as a pass, because "nothing to check" and "checked and fine" are different
// facts and conflating them is how the original bug survived.

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_SIGNING_SHA256 } from '../services/security/deviceSecurity/nativeMap';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APK = join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

let failures = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function skip(name: string, why: string) {
  skipped++;
  console.log(`  — SKIP ${name}  (${why})`);
}

console.log('\nrelease signing baseline');

// ── 1. shape, which is checkable with no Android toolchain at all ────────────
check('EXPECTED_SIGNING_SHA256 is 64 lowercase hex characters',
  /^[0-9a-f]{64}$/.test(EXPECTED_SIGNING_SHA256),
  `got ${JSON.stringify(EXPECTED_SIGNING_SHA256)} — strip the colons and lowercase it`);

// The debug certificate this constant was wrongly set to. Pinning it as a
// NEGATIVE is the cheapest protection against someone "restoring" it from an
// old diff, and it is also the value that was wrong in caddy/public/assetlinks.json.
// `as string` widens the const's literal type: without it tsc rejects the
// comparison as "no overlap", which is tsc being right about today and wrong
// about the thing this guards — someone pasting the old value back in.
check('the baseline is not the stale debug certificate',
  (EXPECTED_SIGNING_SHA256 as string) !== '5fc197fc3f09f684c6861b7e5876be5824d4aacbbc26cc309fd64a97dc791a59',
  'this is the debug cert that bricked the 2026-10-13 release build');

// ── 2. the real check: does it match the artifact? ───────────────────────────
function findApksigner(): string | null {
  const home = process.env.LOCALAPPDATA || process.env.HOME || '';
  for (const base of [join(home, 'Android', 'Sdk'), process.env.ANDROID_HOME ?? '', process.env.ANDROID_SDK_ROOT ?? '']) {
    const bt = base && join(base, 'build-tools');
    if (!bt || !existsSync(bt)) continue;
    // Newest build-tools first.
    for (const v of readdirSync(bt).sort().reverse()) {
      for (const exe of ['apksigner.bat', 'apksigner']) {
        const p = join(bt, v, exe);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

if (!existsSync(APK)) {
  skip('baseline matches the built release APK', 'no release APK built on this machine');
} else {
  const apksigner = findApksigner();
  if (!apksigner) {
    skip('baseline matches the built release APK', 'apksigner not found in any Android SDK build-tools');
  } else {
    let out = '';
    try {
      // shell: true because apksigner ships as a .bat on Windows and Node will
      // not exec a batch file directly. Both paths are quoted for the spaces
      // that are all but guaranteed in a Windows SDK path.
      out = execFileSync(`"${apksigner}"`, ['verify', '--print-certs', `"${APK}"`],
        { encoding: 'utf8', maxBuffer: 8 << 20, shell: true });
    } catch (e: any) {
      out = String(e?.stdout ?? '');
    }
    const m = out.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/);
    if (!m) {
      check('apksigner reported a Signer #1 SHA-256 digest', false,
        'could not parse apksigner output — is the APK signed at all?');
    } else {
      const actual = m[1].toLowerCase();
      check('EXPECTED_SIGNING_SHA256 matches the APK it will ship in',
        actual === EXPECTED_SIGNING_SHA256,
        `APK is signed ${actual} but the app expects ${EXPECTED_SIGNING_SHA256} — `
        + 'a release built from this tree would wipe its own keys and show /blocked on first launch');
      // The signer must also not be a debug certificate, whatever the constant says.
      const dn = (out.match(/Signer #1 certificate DN:\s*(.+)/) ?? [])[1] ?? '';
      check('the release APK is not signed with a debug certificate',
        !/CN=Android Debug/i.test(dn), `signer DN is ${dn.trim()}`);
    }
  }
}

console.log(`\n  ${failures} failed, ${skipped} skipped`);
console.log(failures === 0 ? 'ALL PASSED ✓\n' : `${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
