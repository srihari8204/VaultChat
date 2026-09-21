/**
 * withVaultBeamRust — Expo config plugin for the Rust-backed VaultBeam streaming
 * core (Phase 3). Cloned from withCryptoCore.js + withVaultBeamStream.js.
 *
 * The byte pipeline (positional file I/O + per-chunk AES-256-GCM + LAN TCP)
 * lives in the shared Rust crate services/vaultbeam/rust, reached through a thin
 * classic bridge module "VaultBeamStreamRust". Only the marshaling shim + block
 * HTTP is per-platform.
 *
 * ANDROID (gated on cargo + cargo-ndk):
 *   - copies plugins/vaultbeam-core-android → android/vaultbeam-core (a library
 *     module whose gradle task cargo-ndk-builds libvaultbeam_core.a per ABI and
 *     whose CMake links it + the JNI bridge into libvaultbeamnative.so)
 *   - registers ':vaultbeam-core' in settings.gradle + app dependencies
 *   - registers VaultBeamStreamRustPackage in MainApplication.getPackages()
 *     (the module companion loads libvaultbeamnative only if JS actually asks
 *     for the Rust backend)
 *   Absent toolchain → NOTHING changes; the Kotlin VaultBeamStream fallback
 *   (plugins/withVaultBeamStream.js) stays and lib/vaultBeamStreamNative.ts uses it.
 *
 * IOS (gated on the prebuilt xcframework):
 *   - copies plugins/vaultbeam-core-ios → ios/VaultBeamCore (Swift + ObjC bridge
 *     + VaultBeamCore.xcframework + podspec)
 *   - adds `pod 'VaultBeamCore', :path => './VaultBeamCore'` to the Podfile
 *   Build the framework FIRST: `bash services/vaultbeam/rust/build-ios-xcframework.sh`
 *   (produces plugins/vaultbeam-core-ios/VaultBeamCore.xcframework). Missing →
 *   iOS is skipped and JS stays relay-only on iOS.
 *
 * Toolchain setup (one-time):
 *   rustup + `cargo install cargo-ndk`
 *   Android: `rustup target add aarch64-linux-android armv7-linux-androideabi
 *            i686-linux-android x86_64-linux-android`
 *   iOS:     `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
 *            then run build-ios-xcframework.sh (macOS + Xcode).
 *
 * Selection is runtime: set EXPO_PUBLIC_VAULTBEAM_NATIVE_BACKEND=rust to use it
 * (default 'kotlin'); lib/vaultBeamStreamNative.ts falls back automatically if
 * the Rust module is absent or incomplete.
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

const AND_MODULE = 'vaultbeam-core';
const AND_TEMPLATE = 'vaultbeam-core-android';
const AND_PACKAGE = 'com.vaultchat.vaultbeamcore.VaultBeamStreamRustPackage';
const IOS_TEMPLATE = 'vaultbeam-core-ios';
const IOS_POD = 'VaultBeamCore';

function has(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

function withAndroid(config) {
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'plugins', AND_TEMPLATE);
      const dest = path.join(cfg.modRequest.platformProjectRoot, AND_MODULE);
      fs.cpSync(src, dest, { recursive: true });
      return cfg;
    },
  ]);

  config = withSettingsGradle(config, (cfg) => {
    const include = `include ':${AND_MODULE}'`;
    if (!cfg.modResults.contents.includes(include)) cfg.modResults.contents += `\n${include}\n`;
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    const dep = `implementation project(':${AND_MODULE}')`;
    if (!cfg.modResults.contents.includes(dep)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/, (m) => `${m}\n    ${dep}`);
    }
    return cfg;
  });

  config = withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;

    // 0) Undo what an OLDER version of THIS plugin wrote.
    //
    // Until 4fd0a6d this mod injected a guarded
    // `System.loadLibrary("vaultbeamnative")` into onCreate (added in f0ec0c2).
    // It stopped: VaultBeamStreamRustModule's companion loads the library
    // lazily, only if JS actually asks for the Rust backend, so an eager load
    // in Application.onCreate is pure cold-start cost on every single launch.
    //
    // Removing the emitter was NOT enough. android/ is gitignored prebuild
    // output that a plain `expo prebuild` preserves, so every tree generated
    // before that commit still carries the line and no prebuild will ever take
    // it away — `--clean` (~25 min) was the only escape. This strip is the
    // durable half of that removal; lib/call/minimize.selftest.ts asserts the
    // line is absent, and until now that assertion could only be satisfied by
    // hand-editing generated output, which does not travel between machines.
    //
    // No-op on a tree that never had it, which is every tree built from
    // current source.
    src = src.replace(
      /^[ \t]*(?:try \{ )?System\.loadLibrary\("vaultbeamnative"\)[^\n]*\n/gm, '');

    // 1) Register the ReactPackage (same insertion points as withVaultBeamStream).
    if (!src.includes(`${AND_PACKAGE}()`)) {
      const add = `add(${AND_PACKAGE}())`;
      if (src.includes('// add(MyReactNativePackage())')) {
        src = src.replace('// add(MyReactNativePackage())', `// add(MyReactNativePackage())\n              ${add}`);
      } else if (src.includes('.packages.apply {')) {
        src = src.replace('.packages.apply {', `.packages.apply {\n              ${add}`);
      } else if (/val\s+packages\s*=\s*PackageList\(this\)\.packages/.test(src)) {
        src = src.replace(/(val\s+packages\s*=\s*PackageList\(this\)\.packages)/, `$1\n      packages.${add}`);
      } else {
        console.warn(`[withVaultBeamRust] could not auto-register VaultBeamStreamRustPackage — add \`packages.${add}\` to MainApplication.getPackages() manually`);
      }
    }

    cfg.modResults.contents = src;
    return cfg;
  });

  return config;
}

function withIos(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'plugins', IOS_TEMPLATE);
      const xcframework = path.join(src, 'VaultBeamCore.xcframework');
      if (!fs.existsSync(xcframework)) {
        console.warn(
          '[withVaultBeamRust] plugins/vaultbeam-core-ios/VaultBeamCore.xcframework not found — ' +
            'iOS Rust module SKIPPED (relay-only on iOS). Build it first: ' +
            '`bash services/vaultbeam/rust/build-ios-xcframework.sh` (macOS + Xcode).',
        );
        return cfg;
      }
      const dest = path.join(cfg.modRequest.platformProjectRoot, IOS_POD);
      fs.cpSync(src, dest, { recursive: true });

      // Add the pod to the Podfile (pod install happens after prebuild).
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (fs.existsSync(podfile)) {
        let contents = fs.readFileSync(podfile, 'utf8');
        const line = `pod '${IOS_POD}', :path => './${IOS_POD}'`;
        if (!contents.includes(line)) {
          // Insert just after the target's `use_expo_modules!` or the target line.
          contents = contents.replace(/(use_expo_modules!\s*\n)/, (m) => `${m}  ${line}\n`);
          if (!contents.includes(line)) {
            console.warn(`[withVaultBeamRust] could not auto-add the pod — add \`${line}\` to your Podfile target manually`);
          } else {
            fs.writeFileSync(podfile, contents);
          }
        }
      }
      return cfg;
    },
  ]);
}

module.exports = function withVaultBeamRust(config) {
  if (!has('cargo --version')) {
    console.warn(
      '[withVaultBeamRust] cargo not found — Rust VaultBeam core SKIPPED (Android keeps ' +
        'the Kotlin VaultBeamStream module; iOS is relay-only). Install rustup to enable.',
    );
    return config;
  }

  if (has('cargo ndk --version')) {
    config = withAndroid(config);
  } else {
    console.warn(
      '[withVaultBeamRust] cargo-ndk not found — Android Rust module SKIPPED (Kotlin ' +
        'VaultBeamStream stays). `cargo install cargo-ndk` + `rustup target add ' +
        'aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.',
    );
  }

  config = withIos(config);
  return config;
};
