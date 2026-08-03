/**
 * withCryptoCore — Expo config plugin for the Rust crypto core (Phase 1).
 *
 * When the Rust toolchain (cargo + cargo-ndk) is available at prebuild time:
 *   - copies plugins/crypto-core-android → android/crypto-core (a library
 *     module whose gradle task cargo-ndk-builds libcrypto_core.a per ABI and
 *     whose CMake links it + the Nitro C++ wrapper into libvaultcrypto.so)
 *   - registers the module in settings.gradle + app dependencies
 *   - inserts System.loadLibrary("vaultcrypto") into MainApplication.onCreate
 *     (guarded — a failed load logs a warning; JS then stays on the TS backend)
 *
 * When the toolchain is MISSING: warns and changes NOTHING. The app builds
 * without native crypto and services/crypto/index.ts keeps the TS backend.
 *
 * Toolchain setup (one-time):
 *   rustup + `cargo install cargo-ndk` + `rustup target add
 *   aarch64-linux-android armv7-linux-androideabi i686-linux-android
 *   x86_64-linux-android`
 *
 * Run: expo prebuild --clean
 */
const {
  withDangerousMod,
  withMainApplication,
  withAppBuildGradle,
  withSettingsGradle,
} = require('@expo/config-plugins');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MODULE = 'crypto-core';
const TEMPLATE = 'crypto-core-android';

function rustToolchainAvailable() {
  try {
    execSync('cargo ndk --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = function withCryptoCore(config) {
  if (!rustToolchainAvailable()) {
    // P3.3: this skip used to be a single easily-missed console.warn — the
    // audit found release builds silently shipping pure-JS crypto because the
    // build machine lacked cargo-ndk. Make it impossible to miss, and give CI
    // a hard-fail switch: CRYPTO_CORE_REQUIRED=1 turns the skip into an error.
    const msg =
      '[withCryptoCore] cargo/cargo-ndk NOT FOUND — the Rust crypto core will NOT be built.\n' +
      '  ┌──────────────────────────────────────────────────────────────────────┐\n' +
      '  │  THIS BUILD SHIPS PURE-JS CRYPTO (slower ratchet/KDFs on the JS      │\n' +
      '  │  thread). Fine for dev; NOT what you want in a release build.        │\n' +
      '  └──────────────────────────────────────────────────────────────────────┘\n' +
      '  Fix (one-time): install rustup; `cargo install cargo-ndk`;\n' +
      '  `rustup target add aarch64-linux-android armv7-linux-androideabi \\\n' +
      '     i686-linux-android x86_64-linux-android`; then prebuild again.\n' +
      '  CI: set CRYPTO_CORE_REQUIRED=1 to make this a build FAILURE instead of a skip.';
    if (process.env.CRYPTO_CORE_REQUIRED === '1') {
      throw new Error(msg);
    }
    console.warn(msg);
    return config;
  }

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'plugins', TEMPLATE);
      const dest = path.join(cfg.modRequest.platformProjectRoot, MODULE);
      fs.cpSync(src, dest, { recursive: true });
      return cfg;
    },
  ]);

  config = withSettingsGradle(config, (cfg) => {
    const include = `include ':${MODULE}'`;
    if (!cfg.modResults.contents.includes(include)) {
      cfg.modResults.contents += `\n${include}\n`;
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    const dep = `implementation project(':${MODULE}')`;
    if (!cfg.modResults.contents.includes(dep)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        (m) => `${m}\n    ${dep}`,
      );
    }
    return cfg;
  });

  config = withMainApplication(config, (cfg) => {
    const load = 'System.loadLibrary("vaultcrypto")';
    if (!cfg.modResults.contents.includes(load)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /super\.onCreate\(\)/,
        `super.onCreate()\n    try { ${load} } catch (t: Throwable) { android.util.Log.w("CryptoCore", "native crypto unavailable — TS fallback", t) }`,
      );
    }
    return cfg;
  });

  return config;
};
