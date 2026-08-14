// withVaultChatHeadlessSync — register the headless background-sync service.
//
// com.vaultchat.app.sync.VaultChatSyncService runs lib/syncBackground.ts when a
// chat FCM message arrives and the app is not foregrounded: it drains the delta
// through the existing sync engine and acknowledges delivery only once the rows
// are on disk. Without the manifest entry Android cannot start it, and a chat
// push goes back to being a notification that syncs nothing — the sender stuck
// on ONE TICK until the recipient opens the app.
//
// A config plugin rather than an edit to android/AndroidManifest.xml because
// android/ is gitignored prebuild output; a direct edit is undone by the next
// `expo prebuild` (same reasoning as withMainActivityNewIntent.js).
//
// No intent-filter and not exported: it is started explicitly by
// VaultCallMessagingService, never by anything outside the app.

const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const SERVICE = 'com.vaultchat.app.sync.VaultChatSyncService';
const KOTLIN = 'VaultChatSyncService.kt';

// Place the Kotlin source. android/ is prebuild OUTPUT, so the file has to be
// copied in from plugins/android/ on every prebuild — the same arrangement
// withVaultChatCalls.js uses for the call classes. Registering the service in
// the manifest without shipping its class would leave a manifest entry
// pointing at nothing, and every chat push would fail to start it.
function withSyncKotlin(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const from = path.join(cfg.modRequest.projectRoot, 'plugins', 'android', KOTLIN);
    if (!fs.existsSync(from)) {
      throw new Error(`withVaultChatHeadlessSync: missing plugins/android/${KOTLIN}`);
    }
    const destDir = path.join(
      cfg.modRequest.platformProjectRoot,
      'app', 'src', 'main', 'java', 'com', 'vaultchat', 'app', 'sync',
    );
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(from, path.join(destDir, KOTLIN));
    return cfg;
  }]);
}

module.exports = function withVaultChatHeadlessSync(config) {
  config = withSyncKotlin(config);
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (!app) {
      throw new Error('withVaultChatHeadlessSync: no <application> in the manifest');
    }
    app.service = app.service || [];
    if (!app.service.some((s) => s.$ && s.$['android:name'] === SERVICE)) {
      app.service.push({ $: { 'android:name': SERVICE, 'android:exported': 'false' } });
    }
    return cfg;
  });
};
