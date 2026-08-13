/**
 * withReleaseSigning — sign release builds with the real keystore.
 *
 * WHY A PLUGIN AND NOT android/app/build.gradle
 * ---------------------------------------------
 * `expo prebuild --clean` deletes and regenerates android/, so any signing
 * config edited into build.gradle by hand survives exactly until the next
 * build. A config plugin re-applies it every prebuild, which is the only way
 * this stays true.
 *
 * WHAT IT REPLACES
 * ----------------
 * Expo's template signs RELEASE builds with the DEBUG keystore. That is fine
 * for a test APK and wrong for anything you ship: every developer's debug key
 * is interchangeable, so a "release" build signed with it is not identifiable
 * as yours, and Play will not accept it.
 *
 * CREDENTIALS
 * -----------
 * Read from keystore.properties at the repo root, which is GITIGNORED. If the
 * file is absent the plugin is a NO-OP and the build falls back to debug
 * signing — so a fresh clone still builds without secrets, and CI fails loudly
 * at upload time rather than silently shipping a debug-signed artifact.
 *
 * The keystore itself is the one credential that cannot be regenerated after
 * your first Play upload: lose it and you cannot update the app, ever. Back up
 * vaultchat-release.jks and keystore.properties somewhere that is not this
 * machine.
 */
const { withAppBuildGradle, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PROPS = 'keystore.properties';

function readCreds(projectRoot) {
  const p = path.join(projectRoot, PROPS);
  if (!fs.existsSync(p)) return null;
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.VAULTCHAT_STORE_FILE || !out.VAULTCHAT_STORE_PASSWORD) return null;
  return out;
}

const withReleaseSigning = (config) => {
  // 1. Copy the keystore into android/app so Gradle resolves it relatively —
  //    an absolute Windows path in build.gradle breaks on any other machine.
  config = withDangerousMod(config, ['android', async (cfg) => {
    const creds = readCreds(cfg.modRequest.projectRoot);
    if (!creds) {
      console.warn('[withReleaseSigning] keystore.properties not found — release builds will use the DEBUG key.');
      return cfg;
    }
    const src = path.join(cfg.modRequest.projectRoot, creds.VAULTCHAT_STORE_FILE);
    if (!fs.existsSync(src)) {
      console.warn(`[withReleaseSigning] ${creds.VAULTCHAT_STORE_FILE} missing — release builds will use the DEBUG key.`);
      return cfg;
    }
    const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', path.basename(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return cfg;
  }]);

  // 2. Add the signingConfig and point buildTypes.release at it.
  config = withAppBuildGradle(config, (cfg) => {
    const creds = readCreds(cfg.modRequest.projectRoot);
    if (!creds || cfg.modResults.contents.includes('vaultchatRelease')) return cfg;

    const store = path.basename(creds.VAULTCHAT_STORE_FILE);
    const block = `
        vaultchatRelease {
            storeFile file('${store}')
            storePassword '${creds.VAULTCHAT_STORE_PASSWORD}'
            keyAlias '${creds.VAULTCHAT_KEY_ALIAS || 'vaultchat'}'
            keyPassword '${creds.VAULTCHAT_KEY_PASSWORD || creds.VAULTCHAT_STORE_PASSWORD}'
        }
`;
    // Insert into the existing signingConfigs { } block.
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /signingConfigs\s*\{/,
      (m) => m + block,
    );
    // Repoint release away from the debug key. Expo's template writes
    // `signingConfig signingConfigs.debug` inside buildTypes.release.
    cfg.modResults.contents = cfg.modResults.contents.replace(
      /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.vaultchatRelease',
    );
    return cfg;
  });

  return config;
};

module.exports = withReleaseSigning;
