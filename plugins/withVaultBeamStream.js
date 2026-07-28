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
 * No new manifest entries: it needs only INTERNET (already granted to every RN
 * app by the base manifest) and app-private file storage. Android-first — iOS
 * background large transfers are a later phase (URLSession handoff).
 *
 * Run: expo prebuild --clean   (the plugin runs during prebuild)
 */
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const VB_PKG = `${PKG}.vaultbeam`;
const KOTLIN = ['VaultBeamStreamModule.kt', 'VaultBeamStreamPackage.kt'];

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

module.exports = function withVaultBeamStream(config) {
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  return config;
};
