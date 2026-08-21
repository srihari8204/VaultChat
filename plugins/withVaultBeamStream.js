/**
 * withVaultBeamStream — Expo config plugin for the VaultBeam native streaming core.
 *
 * VaultBeam Tier-3 (R2 relay) moves up to 12 GB. The JS-heap path OOMs at ~2 GB,
 * so the byte pipeline (positional file I/O + per-chunk AES-256-GCM + block
 * HTTP PUT/GET) lives in a native module, VaultBeamStream. This plugin:
 *   - copies the Kotlin sources from plugins/android into the app package
 *     (com.vaultchat.app.vaultbeam)
 *   - registers VaultBeamStreamPackage in MainApplication.getPackages()
 *
 * It also declares VaultBeamForegroundService (type dataSync), which keeps the
 * JS transfer runtime alive while the app is backgrounded or the screen is
 * locked. Without it Android suspends the runtime and a transfer simply stops —
 * measured in production as a 2.24 GB send advancing 160 -> 224 blocks in eight
 * hours. FOREGROUND_SERVICE_DATA_SYNC is already declared in the base manifest,
 * so no new permission is added here.
 *
 * Android-first — iOS background large transfers are a later phase
 * (URLSession handoff).
 *
 * Run: expo prebuild --clean   (the plugin runs during prebuild)
 */
const { withDangerousMod, withMainApplication, withAndroidManifest } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const VB_PKG = `${PKG}.vaultbeam`;
const KOTLIN = ['VaultBeamStreamModule.kt', 'VaultBeamStreamPackage.kt', 'VaultBeamForegroundService.kt'];

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, 'plugins', 'android');
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...VB_PKG.split('.'),
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of KOTLIN) {
        const from = path.join(srcDir, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destDir, f));
      }
      return cfg;
    },
  ]);
}

function withPackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(`${VB_PKG}.VaultBeamStreamPackage()`)) return cfg; // already registered
    const add = `add(${VB_PKG}.VaultBeamStreamPackage())`;

    // Same insertion points as withVaultChatCalls (both are idempotent and the
    // `// add(MyReactNativePackage())` marker survives the first plugin's edit).
    if (src.includes('// add(MyReactNativePackage())')) {
      src = src.replace('// add(MyReactNativePackage())', `// add(MyReactNativePackage())\n              ${add}`);
    } else if (src.includes('.packages.apply {')) {
      src = src.replace('.packages.apply {', `.packages.apply {\n              ${add}`);
    } else if (/val\s+packages\s*=\s*PackageList\(this\)\.packages/.test(src)) {
      src = src.replace(/(val\s+packages\s*=\s*PackageList\(this\)\.packages)/, `$1\n      packages.${add}`);
    } else {
      console.warn(`[withVaultBeamStream] could not auto-register VaultBeamStreamPackage — add \`packages.${add}\` to MainApplication.getPackages() manually`);
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}


/**
 * Declare the transfer foreground service.
 *
 * exported=false: nothing outside the app may start or bind it. The service
 * carries no transfer state and accepts no target from an intent, but an
 * exported lifecycle-holder is still surface nobody needs.
 */
function withTransferService(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (!app) return cfg;
    app.service = app.service || [];
    const NAME = `${VB_PKG}.VaultBeamForegroundService`;
    if (app.service.some((s) => s?.$?.['android:name'] === NAME)) return cfg; // idempotent
    app.service.push({
      $: {
        'android:name': NAME,
        'android:exported': 'false',
        'android:foregroundServiceType': 'dataSync',
      },
    });
    return cfg;
  });
}

module.exports = function withVaultBeamStream(config) {
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  config = withTransferService(config);
  return config;
};
