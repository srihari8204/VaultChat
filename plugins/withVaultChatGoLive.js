/**
 * withVaultChatGoLive — Expo config plugin for GO LIVE BROADCASTING.
 *
 * A SEPARATE plugin from withVaultChatCalls, and it touches nothing that one
 * owns. Calling keeps its own service, its own package, its own notification
 * channel and its own manifest entries; this adds a parallel set for
 * broadcasting.
 *
 * Android:
 *  - <service> GoLiveForegroundService (microphone|camera|mediaProjection)
 *  - copies plugins/android/golive/*.kt into com.vaultchat.app.golive
 *  - registers GoLivePackage in MainApplication
 *
 * WHY A FOREGROUND SERVICE AT ALL
 * -------------------------------
 * Two failures, both silent from the host's side:
 *
 *  1. Android 10+ refuses MediaProjection.createVirtualDisplay() unless a
 *     foreground service of type mediaProjection is running. Without one the
 *     screen track publishes, subscribers subscribe, and the encoder emits
 *     `encoded=0 size=0x0` — no frames at all. Go Live screen share simply
 *     could not work.
 *  2. Android 12+ revokes mic and camera capture seconds after the app is
 *     backgrounded. A host who checks a message mid-stream goes silent and
 *     black while the banner still reads LIVE to every viewer.
 *
 * CallForegroundService already solves both FOR CALLS — but it is started by the
 * call lifecycle and is not running during a broadcast, and its notification
 * reads "VaultChat call • in progress". Reusing it would mean teaching the call
 * lifecycle about broadcasts, which is the coupling this whole change removes.
 *
 * No new PERMISSIONS are declared: FOREGROUND_SERVICE,
 * FOREGROUND_SERVICE_MICROPHONE, FOREGROUND_SERVICE_CAMERA,
 * FOREGROUND_SERVICE_MEDIA_PROJECTION, POST_NOTIFICATIONS and WAKE_LOCK are all
 * already requested by withVaultChatCalls, and permissions are per-app, not
 * per-service. Re-declaring them would be duplication with no effect.
 *
 * iOS: nothing. Broadcasting a device screen on iOS needs a Broadcast Upload
 * Extension (a separate binary target with its own bundle id and app group),
 * which cannot be added from a config plugin's manifest edits. Camera and
 * microphone broadcasting work on iOS today; screen share does not, and
 * docs/GOLIVE_DEPLOY.md records that as outstanding rather than pretending
 * otherwise.
 *
 * Run: expo prebuild --clean   (the plugin runs during prebuild)
 */
const { withAndroidManifest, withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const GOLIVE_PKG = `${PKG}.golive`;
const KOTLIN = ['GoLiveForegroundService.kt', 'GoLiveModule.kt', 'GoLivePackage.kt'];

function withGoLiveService(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app.service = app.service || [];
    const name = `${GOLIVE_PKG}.GoLiveForegroundService`;
    // Find-or-create, then ALWAYS assign. Returning early on a name match would
    // make this mod write-once: android/ is prebuild output that a plain
    // `expo prebuild` keeps, so a service added by an older version of this
    // plugin would hold its original foregroundServiceType forever and a change
    // to the line below would reach fresh trees only. The failure mode is the
    // silent one documented underneath, which is the worst kind to make
    // un-fixable without --clean.
    let svc = app.service.find((s) => s.$['android:name'] === name);
    if (!svc) { svc = { $: { 'android:name': name } }; app.service.push(svc); }

    Object.assign(svc.$, {
        'android:exported': 'false',
        // mediaProjection MUST be declared here even though the service only
        // ADDS it at runtime, once the host actually shares. Android validates
        // the runtime type against the manifest, so a type absent here can
        // never be added later — the service would sit at camera|microphone and
        // screen capture would produce nothing, which is the exact failure this
        // plugin exists to prevent.
        'android:foregroundServiceType': 'microphone|camera|mediaProjection',
    });
    return cfg;
  });
}

function withGoLiveKotlin(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, 'plugins', 'android', 'golive');
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...GOLIVE_PKG.split('.'),
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

function withGoLivePackageRegistration(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(`${GOLIVE_PKG}.GoLivePackage()`)) return cfg; // already registered
    const add = `add(${GOLIVE_PKG}.GoLivePackage())`;

    // Appended AFTER CallPackage where possible, so the diff against a
    // prebuild that predates Go Live is one added line in a known place.
    if (src.includes(`add(${PKG}.calls.CallPackage())`)) {
      src = src.replace(`add(${PKG}.calls.CallPackage())`, `add(${PKG}.calls.CallPackage())\n              ${add}`);
    } else if (src.includes('// add(MyReactNativePackage())')) {
      src = src.replace('// add(MyReactNativePackage())', `// add(MyReactNativePackage())\n              ${add}`);
    } else if (src.includes('.packages.apply {')) {
      src = src.replace('.packages.apply {', `.packages.apply {\n              ${add}`);
    } else if (/val\s+packages\s*=\s*PackageList\(this\)\.packages/.test(src)) {
      src = src.replace(/(val\s+packages\s*=\s*PackageList\(this\)\.packages)/, `$1\n      packages.${add}`);
    } else {
      console.warn(
        `[withVaultChatGoLive] could not auto-register GoLivePackage — add \`packages.${add}\` to MainApplication.getPackages() manually`,
      );
      return cfg;
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

module.exports = function withVaultChatGoLive(config) {
  config = withGoLiveService(config);
  config = withGoLiveKotlin(config);
  config = withGoLivePackageRegistration(config);
  return config;
};
