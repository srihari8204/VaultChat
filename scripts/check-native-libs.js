#!/usr/bin/env node
/**
 * scripts/check-native-libs.js — fail the build when the Rust never made it in.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Rust crate in this repo reaches the app through an Expo config plugin,
 * and all three plugins open with the same gate:
 *
 *   try { execSync('cargo ndk --version', { stdio: 'ignore' }) }
 *   catch { console.warn(...); return config; }
 *
 * On a build machine without cargo-ndk that is a SILENT OMISSION. `prebuild`
 * writes no gradle module, patches no MainApplication, and reports no error.
 * The APK builds, installs and runs — and every native path degrades quietly:
 * NativeModules.TransportCore is undefined so the JS WebSocket carries CC-Wire,
 * the crypto core falls back to TypeScript, and navigation falls back to the JS
 * route matcher. Nothing in the app or the build log says the release lost its
 * native half.
 *
 * That is not hypothetical. plugins/withCryptoCore.js already carries the scar:
 * "this skip used to be a single easily-missed console.warn — the build machine
 * lacked cargo-ndk."
 *
 * A console.warn at prebuild time cannot fix this, because the person who needs
 * to see it is reading a CI log thousands of lines later. The guarantee has to
 * be checked against the ARTEFACT, which is what this does: open the APK the
 * build just produced and assert the shared objects are actually inside it.
 *
 * Checked against the APK and not against android/, for the same reason
 * check-sdk-versions.js reads node_modules rather than package.json: the
 * intermediate state can disagree with what ships, and it is what ships that
 * matters.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * The three .so files every complete release contains, and what is lost with
 * each. Named individually rather than counted so the error can say WHICH half
 * of the app went missing.
 */
const REQUIRED = {
  libtransportnative: 'CC-Wire native transport — the app falls back to the JS WebSocket',
  libvaultcrypto: 'crypto-core and nav-core — E2EE and navigation fall back to TypeScript',
  libvaultbeamnative: 'vaultbeam-core — large-file transfer falls back to the JS driver',
};

/** The ABI a release must carry. Every shipping device is arm64 today. */
const REQUIRED_ABI = 'arm64-v8a';

function findApk() {
  const dir = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release');
  if (!fs.existsSync(dir)) return null;
  const apks = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.apk'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return apks[0] ?? null;
}

/**
 * List an APK's entries.
 *
 * An APK is a zip, and Node ships no zip reader — so this shells out to the JDK
 * the build already required. `jar` is guaranteed present on any machine that
 * just ran gradle, which is the only machine this script runs on.
 */
function entries(apk) {
  const jar = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', 'jar')
    : 'jar';
  return execFileSync(jar, ['tf', apk], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
}

function main() {
  const apk = findApk();
  if (!apk) {
    console.error('check-native-libs: no release APK found — did assembleRelease run?');
    process.exit(1);
  }

  let listed;
  try {
    listed = entries(apk);
  } catch (e) {
    // Never pass silently on a tool failure: "could not check" and "checked and
    // it is fine" are different answers, and only one of them is safe to ship.
    console.error(`check-native-libs: could not read ${path.basename(apk)}: ${e.message}`);
    console.error('check-native-libs: refusing to report a release as verified when it was not read.');
    process.exit(1);
  }

  const missing = Object.keys(REQUIRED).filter(
    (lib) => !listed.some((e) => e === `lib/${REQUIRED_ABI}/${lib}.so`),
  );

  if (missing.length > 0) {
    console.error(`\ncheck-native-libs: ${path.basename(apk)} is missing native libraries.\n`);
    for (const lib of missing) {
      console.error(`  ${lib}.so — ${REQUIRED[lib]}`);
    }
    console.error(
      '\nThe usual cause is a build machine without cargo-ndk: the Expo config plugins\n' +
        'skip the native module with a console.warn and the build otherwise succeeds.\n' +
        'Check `cargo ndk --version`, then rerun the build from prebuild.\n',
    );
    process.exit(1);
  }

  console.log(
    `check-native-libs: ${path.basename(apk)} carries all ${Object.keys(REQUIRED).length} native libraries for ${REQUIRED_ABI}`,
  );
}

main();
