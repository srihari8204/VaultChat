/**
 * withVaultChatSync — Expo config plugin for the no-GMS background connection.
 *
 * lib/backgroundConnection.ts runs a Notifee foreground service (type dataSync)
 * to keep the socket alive on devices without Google Play Services. Android 14
 * (targetSdk 34+) requires the service to declare its foregroundServiceType AND
 * the app to hold the matching runtime permission, or startForeground() throws.
 *
 * Notifee already ships app.notifee.core.ForegroundService in its own manifest;
 * here we (a) ensure the FOREGROUND_SERVICE_DATA_SYNC permission and (b) merge
 * android:foregroundServiceType="dataSync" onto that service. No Kotlin — the
 * service itself is Notifee's.
 *
 * Run: expo prebuild --clean
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const NOTIFEE_SERVICE = 'app.notifee.core.ForegroundService';
const PERMS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
];

module.exports = function withVaultChatSync(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // tools: namespace (needed for tools:replace on the merged service attr).
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    // (a) permissions — idempotent.
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    for (const name of PERMS) {
      if (!manifest['uses-permission'].some((p) => p.$ && p.$['android:name'] === name)) {
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }

    // (b) set dataSync type on Notifee's foreground service (merge/replace).
    const app = manifest.application && manifest.application[0];
    if (app) {
      app.service = app.service || [];
      let svc = app.service.find((s) => s.$ && s.$['android:name'] === NOTIFEE_SERVICE);
      if (!svc) { svc = { $: { 'android:name': NOTIFEE_SERVICE } }; app.service.push(svc); }
      svc.$['android:foregroundServiceType'] = 'dataSync';
      svc.$['tools:replace'] = 'android:foregroundServiceType';
    }

    return cfg;
  });
};
