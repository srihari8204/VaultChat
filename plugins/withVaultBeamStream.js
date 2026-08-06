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
const { withDangerousMod, withMainApplication, withAndroidManifest } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const VB_PKG = `${PKG}.vaultbeam`;
const KOTLIN = [
  'VaultBeamStreamModule.kt',
  'VaultBeamStreamPackage.kt',
  // Android 14+ user-initiated data transfer job — see the service's own
  // comment for why transfers cannot stay on the shared dataSync service.
  'VaultBeamTransferJobService.kt',
  'VaultBeamJobModule.kt',
];

const JOB_SERVICE = `${VB_PKG}.VaultBeamTransferJobService`;

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
 * Manifest entries for the user-initiated data transfer job.
 *
 * Two things are mandatory or the scheduler refuses the job at runtime:
 *   - RUN_USER_INITIATED_JOBS (normal permission, granted at install)
 *   - the JobService declared with BIND_JOB_SERVICE, which is what lets the
 *     system — and only the system — start it.
 *
 * Both are idempotent, so re-running prebuild is safe.
 */
function withTransferJobManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const perm = 'android.permission.RUN_USER_INITIATED_JOBS';
    if (!manifest['uses-permission'].some((p) => p.$ && p.$['android:name'] === perm)) {
      manifest['uses-permission'].push({ $: { 'android:name': perm } });
    }

    const app = manifest.application && manifest.application[0];
    if (app) {
      app.service = app.service || [];
      let svc = app.service.find((s) => s.$ && s.$['android:name'] === JOB_SERVICE);
      if (!svc) { svc = { $: { 'android:name': JOB_SERVICE } }; app.service.push(svc); }
      svc.$['android:permission'] = 'android.permission.BIND_JOB_SERVICE';
      svc.$['android:exported'] = 'false';
      // Same process as the RN instance on purpose: the job's whole job is to
      // keep THAT process alive. A separate process would be kept alive while
      // the one doing the transfer was not.
    }

    return cfg;
  });
}

module.exports = function withVaultBeamStream(config) {
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  config = withTransferJobManifest(config);
  return config;
};
