/**
 * withVaultChatCalls — Expo config plugin for production call reliability.
 *
 * Android:
 *  - permissions (FOREGROUND_SERVICE[_MICROPHONE|_CAMERA], POST_NOTIFICATIONS,
 *    USE_FULL_SCREEN_INTENT, WAKE_LOCK, battery/lock-screen)
 *  - <service> CallForegroundService (foregroundServiceType microphone|camera)
 *  - <service> VaultCallMessagingService (FCM MESSAGING_EVENT)
 *  - <receiver> CallActionReceiver
 *  - copies the Kotlin sources from plugins/android into the app package
 *  - registers CallPackage in MainApplication
 *
 * iOS:
 *  - background modes: voip, audio (CallKit/PushKit). The PushKit/CallKit Swift
 *    glue is documented in CALLS_README.md (manual AppDelegate addition) since a
 *    robust automated Swift patch is brittle; iOS is secondary for this app.
 *
 * Run: expo prebuild --clean   (the plugin runs during prebuild)
 */
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
  withInfoPlist,
  AndroidConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.vaultchat.app';
const CALLS_PKG = `${PKG}.calls`;
const KOTLIN = ['CallForegroundService.kt', 'VaultCallMessagingService.kt', 'CallModule.kt', 'CallPackage.kt'];

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.DISABLE_KEYGUARD',
  'android.permission.RECEIVE_BOOT_COMPLETED',
];

function withPermissions(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const existing = new Set(manifest['uses-permission'].map((p) => p.$['android:name']));
    for (const name of PERMISSIONS) {
      if (!existing.has(name)) manifest['uses-permission'].push({ $: { 'android:name': name } });
    }
    return cfg;
  });
}

function withServices(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    app.receiver = app.receiver || [];

    const hasService = (name) => app.service.some((s) => s.$['android:name'] === name);
    const hasReceiver = (name) => app.receiver.some((s) => s.$['android:name'] === name);

    if (!hasService(`${CALLS_PKG}.CallForegroundService`)) {
      app.service.push({
        $: {
          'android:name': `${CALLS_PKG}.CallForegroundService`,
          'android:exported': 'false',
          'android:foregroundServiceType': 'microphone|camera',
        },
      });
    }
    if (!hasService(`${CALLS_PKG}.VaultCallMessagingService`)) {
      app.service.push({
        $: { 'android:name': `${CALLS_PKG}.VaultCallMessagingService`, 'android:exported': 'false' },
        'intent-filter': [{ action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }] }],
      });
    }
    if (!hasReceiver(`${CALLS_PKG}.CallActionReceiver`)) {
      app.receiver.push({
        $: { 'android:name': `${CALLS_PKG}.CallActionReceiver`, 'android:exported': 'false' },
      });
    }
    return cfg;
  });
}

function withKotlinSources(config) {
  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, 'plugins', 'android');
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', ...CALLS_PKG.split('.'),
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
    if (!src.includes('CallPackage()')) {
      // Kotlin MainApplication: add to the PackageList getPackages() result.
      // Most Expo templates expose: override fun getPackages(): List<ReactPackage> {
      //   val packages = PackageList(this).packages
      //   // add(MyReactNativePackage())
      //   return packages
      // }
      if (src.includes('PackageList(this).packages')) {
        src = src.replace(
          /(val packages\s*=\s*PackageList\(this\)\.packages)/,
          `$1\n      packages.add(${CALLS_PKG}.CallPackage())`,
        );
      } else if (src.includes('return packages')) {
        src = src.replace(/return packages/, `packages.add(${CALLS_PKG}.CallPackage())\n      return packages`);
      }
      cfg.modResults.contents = src;
    }
    return cfg;
  });
}

function withIosVoip(config) {
  return withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || []);
    modes.add('voip');
    modes.add('audio');
    modes.add('remote-notification');
    cfg.modResults.UIBackgroundModes = Array.from(modes);
    return cfg;
  });
}

module.exports = function withVaultChatCalls(config) {
  config = withPermissions(config);
  config = withServices(config);
  config = withKotlinSources(config);
  config = withPackageRegistration(config);
  config = withIosVoip(config);
  return config;
};
