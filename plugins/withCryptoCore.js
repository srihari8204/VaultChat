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
    console.warn(
      '[withCryptoCore] cargo/cargo-ndk not found — native crypto core SKIPPED; ' +
        'the app will use the TS crypto backend. To enable: install rustup, ' +
        '`cargo install cargo-ndk`, `rustup target add aarch64-linux-android ' +
        'armv7-linux-androideabi i686-linux-android x86_64-linux-android`, then prebuild again.',
    );
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
